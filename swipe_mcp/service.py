"""Business logic behind the MCP tool adapters."""
from __future__ import annotations

import asyncio
import hashlib
import re
from datetime import date, datetime
from difflib import SequenceMatcher
from typing import Any, Awaitable, Callable

from swipe_core.errors import SwipeError as GSTError

from .client import SwipeAPIError, SwipeClient
from .config import ConfigurationError, SwipeConfig, normalize_state
from .mapping import build_invoice, build_payment, normalize_customer, normalize_product
from .models import BankCredit, BankDetails, InvoiceItem, PaymentMethod
from .reconcile import (
    CONFIDENT,
    SPLIT,
    OutstandingInvoice,
    match_credits,
)


class SwipeServiceError(RuntimeError):
    pass


class SwipeService:
    def __init__(
        self,
        config: SwipeConfig,
        *,
        client: SwipeClient | None = None,
    ):
        self.config = config
        self.client = client or SwipeClient(config)
        self._cache: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def close(self) -> None:
        await self.client.close()

    async def list_customers(self, *, page: int = 1, limit: int = 50) -> dict:
        records, total = await self.client.list_customers(page=page, limit=limit)
        customers = [
            public_customer(normalize_customer(record))
            for record in records
            if normalize_customer(record).get("id") is not None
        ]
        return {"customers": customers, "page": page, "returned": len(customers), "total": total}

    async def find_customer(self, query: str, *, limit: int = 10) -> dict:
        query = query.strip()
        if not query:
            raise SwipeServiceError("Customer query cannot be empty.")
        customers = [normalize_customer(x) for x in await self.client.all_customers()]
        matches = rank_customers(query, [x for x in customers if x.get("id") is not None])
        return {
            "query": query,
            "matches": [
                {**public_customer(customer), "match_score": round(score, 3)}
                for score, customer in matches[:limit]
            ],
        }

    async def list_products(self, *, page: int = 1, limit: int = 50) -> dict:
        records, total = await self.client.list_products(page=page, limit=limit)
        products = [
            normalize_product(record)
            for record in records
            if normalize_product(record).get("id") is not None
        ]
        return {"products": products, "page": page, "returned": len(products), "total": total}

    async def list_invoices(
        self,
        *,
        status: str = "all",
        start_date: str | None = None,
        end_date: str | None = None,
        customer_id: str | None = None,
        page: int = 1,
        limit: int = 50,
    ) -> dict:
        start = api_date(start_date, default="01-01-2000")
        end = api_date(end_date, default="31-12-2099")
        records, total = await self.client.list_invoices(
            start_date=start,
            end_date=end,
            status=status,
            customer_id=customer_id,
            page=page,
            limit=limit,
        )
        return {
            "invoices": records,
            "filters": {
                "status": status,
                "start_date": start,
                "end_date": end,
                "customer_id": customer_id,
            },
            "page": page,
            "returned": len(records),
            "total": total,
        }

    async def create_invoice(
        self,
        *,
        items: list[InvoiceItem],
        customer_id: str | None = None,
        customer_name: str | None = None,
        due_days: int = 30,
        serial_number: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        if not items:
            raise SwipeServiceError("At least one invoice item is required.")
        if not customer_id and not customer_name:
            raise SwipeServiceError("Provide customer_id or customer_name.")
        if idempotency_key and not serial_number:
            serial_number = invoice_serial_for_key(idempotency_key)

        async def operation() -> dict:
            if idempotency_key and serial_number:
                existing = await self._find_invoice_by_serial(serial_number)
                if existing:
                    return {
                        "created": False,
                        "idempotent_replay": True,
                        "invoice": existing,
                    }

            customer = await self._resolve_customer(customer_id, customer_name)
            detail = await self.client.get_customer(str(customer["id"]))
            if self.config.mode == "live":
                company_state = self.config.require_company_state()
            else:
                company = await self.client.mock_company()
                company_state = normalize_state(company.get("state"))
                if not company_state:
                    raise SwipeServiceError("The mock backend did not return a company state.")

            try:
                body, preview = build_invoice(
                    customer=customer,
                    customer_detail=detail,
                    items=items,
                    company_state=company_state,
                    due_days=due_days,
                    serial_number=serial_number,
                    live=self.config.mode == "live",
                )
            except (ValueError, GSTError) as exc:
                raise SwipeServiceError(str(exc)) from exc

            try:
                created = await self.client.create_document(body)
            except SwipeAPIError as exc:
                if idempotency_key and exc.code == "DUPLICATE_DOC_SERIAL_NUMBER" and serial_number:
                    existing = await self._find_invoice_by_serial(serial_number)
                    if existing:
                        return {
                            "created": False,
                            "idempotent_replay": True,
                            "invoice": existing,
                            "preview": preview,
                        }
                raise

            hash_id = created.get("hash_id")
            verification_error = None
            if hash_id:
                try:
                    detail_result = await self.client.get_document(hash_id)
                except SwipeAPIError as exc:
                    # The POST already succeeded. Return its identifiers instead
                    # of turning a verification failure into a dangerous retry.
                    detail_result = created
                    verification_error = str(exc)
            else:
                detail_result = created
            return {
                "created": True,
                "idempotent_replay": False,
                "invoice": detail_result,
                "preview": preview,
                "verification_error": verification_error,
            }

        return await self._run_idempotent("invoice", idempotency_key, operation)

    async def record_payment(
        self,
        *,
        document_ref: str,
        amount: float,
        method: PaymentMethod = "cash",
        bank_details: BankDetails | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        if amount <= 0:
            raise SwipeServiceError("Payment amount must be greater than zero.")
        if self.config.mode == "live" and method != "cash" and bank_details is None:
            raise SwipeServiceError(
                "Live non-cash payments require bank_details "
                "(account_number, IFSC, bank_name, and branch)."
            )

        async def operation() -> dict:
            marker = payment_marker(idempotency_key) if idempotency_key else None
            if marker:
                existing = await self._find_payment_marker(marker)
                if existing:
                    return {
                        "recorded": False,
                        "idempotent_replay": True,
                        "payment": existing,
                    }

            document = await self._resolve_document(document_ref)
            pending = number(document.get("amount_pending"))
            if pending is not None and amount > pending + 0.01:
                raise SwipeServiceError(
                    f"Payment {amount:.2f} exceeds outstanding balance {pending:.2f}."
                )

            try:
                body = build_payment(
                    document=document,
                    amount=amount,
                    method=method,
                    bank_details=bank_details.model_dump() if bank_details else None,
                    marker=marker,
                    live=self.config.mode == "live",
                )
            except ValueError as exc:
                raise SwipeServiceError(str(exc)) from exc

            payment = await self.client.record_payment(body)
            verification_error = None
            try:
                updated = await self.client.get_document(document["hash_id"])
            except SwipeAPIError as exc:
                # As above, the mutation already landed. Preserve a successful
                # result so a caller does not blindly repeat the payment.
                updated = document
                verification_error = str(exc)
            return {
                "recorded": True,
                "idempotent_replay": False,
                "payment": payment,
                "invoice": {
                    "hash_id": updated.get("hash_id"),
                    "serial_number": updated.get("serial_number"),
                    "payment_status": updated.get("payment_status"),
                    "amount_paid": updated.get("amount_paid"),
                    "amount_pending": updated.get("amount_pending"),
                },
                "verification_error": verification_error,
            }

        return await self._run_idempotent("payment", idempotency_key, operation)

    async def customer_outstanding(
        self,
        *,
        customer_id: str | None = None,
        customer_name: str | None = None,
    ) -> dict:
        customer = await self._resolve_customer(customer_id, customer_name)
        ledger = await self.client.customer_ledger(
            str(customer["id"]), start_date="01-01-2000", end_date="31-12-2099"
        )
        if self.config.mode == "live":
            outstanding = -float(ledger.get("closing_balance") or 0)
            transactions = ledger.get("ledger") or []
        else:
            outstanding = float(ledger.get("closing_balance") or 0)
            transactions = ledger.get("transactions") or []
        return {
            "customer": public_customer(customer),
            "outstanding": round(outstanding, 2),
            "transactions": transactions,
        }

    async def reconcile(
        self,
        *,
        credits: list[BankCredit],
        dry_run: bool = True,
        method: PaymentMethod = "cash",
        bank_details: BankDetails | None = None,
        amount_tolerance: float = 1.0,
    ) -> dict:
        if not credits:
            raise SwipeServiceError("Provide at least one bank credit to reconcile.")
        if not dry_run and self.config.mode == "live" and method != "cash" and bank_details is None:
            raise SwipeServiceError(
                "Live non-cash payments require bank_details. Pass bank_details, or "
                "use method='cash' for the reconciliation write."
            )

        invoices = await self._outstanding_invoices()
        results = match_credits(
            [c.model_dump() for c in credits], invoices, amount_tolerance=amount_tolerance
        )

        if not dry_run:
            for result in results:
                if result["outcome"] not in {CONFIDENT, SPLIT}:
                    result["recorded"] = []
                    continue
                recorded = []
                for match in result["matches"]:
                    key = reconcile_key(result["credit"], match["hash_id"])
                    payment = await self.record_payment(
                        document_ref=match["hash_id"],
                        amount=match["apply_amount"],
                        method=method,
                        bank_details=bank_details,
                        idempotency_key=key,
                    )
                    recorded.append(
                        {
                            "serial_number": match["serial_number"],
                            "amount": match["apply_amount"],
                            "idempotent_replay": payment.get("idempotent_replay", False),
                            "payment_status": (payment.get("invoice") or {}).get("payment_status"),
                        }
                    )
                result["recorded"] = recorded

        return {
            "dry_run": dry_run,
            "mode": self.config.mode,
            "outstanding_invoices": len(invoices),
            "results": results,
            "summary": reconcile_summary(results, dry_run=dry_run),
            "note": (
                "Preview only — no payments were recorded. Review the matches, then "
                "re-run with dry_run=false to record the confident and split matches."
                if dry_run
                else "Confident and split matches were recorded; review/none credits were left untouched."
            ),
        }

    async def _outstanding_invoices(self) -> list[OutstandingInvoice]:
        transactions = await self.client.all_invoices(
            start_date="01-01-2000", end_date="31-12-2099", status="pending"
        )
        invoices: list[OutstandingInvoice] = []
        for txn in transactions:
            pending = number(txn.get("amount_pending"))
            if pending is None or pending <= 0.009:
                continue
            customer = txn.get("customer") or txn.get("party") or {}
            invoices.append(
                OutstandingInvoice(
                    hash_id=str(txn.get("hash_id") or ""),
                    serial_number=str(txn.get("serial_number") or ""),
                    customer_name=str(customer.get("name") or customer.get("company_name") or ""),
                    amount_pending=pending,
                    document_date=txn.get("document_date"),
                )
            )
        return invoices

    async def lookup_gstin(self, gstin: str) -> dict:
        normalized = re.sub(r"\s+", "", gstin).upper()
        if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]", normalized):
            raise SwipeServiceError("GSTIN must be a valid 15-character GSTIN.")
        data = await self.client.lookup_gstin(normalized)
        billing = data.get("billing") if isinstance(data.get("billing"), dict) else {}
        return {
            **data,
            "gstin": data.get("gstin") or normalized,
            "state": normalize_state(data.get("state") or billing.get("state")),
        }

    async def _resolve_customer(
        self, customer_id: str | None, customer_name: str | None
    ) -> dict:
        customers = [
            normalize_customer(x)
            for x in await self.client.all_customers()
            if normalize_customer(x).get("id") is not None
        ]
        if customer_id:
            exact = [x for x in customers if str(x["id"]).casefold() == customer_id.casefold()]
            if len(exact) == 1:
                return exact[0]
            raise SwipeServiceError(
                f"Customer ID '{customer_id}' was not found. Call find_customer first."
            )
        assert customer_name is not None
        ranked = rank_customers(customer_name, customers)
        if not ranked or ranked[0][0] < 0.55:
            raise SwipeServiceError(
                f"No confident customer match for '{customer_name}'. Call find_customer first."
            )
        top_score = ranked[0][0]
        tied = [customer for score, customer in ranked if abs(score - top_score) < 0.03]
        if len(tied) > 1:
            names = ", ".join(f"{x['name']} ({x['id']})" for x in tied[:5])
            raise SwipeServiceError(
                f"Customer name '{customer_name}' is ambiguous: {names}. Use customer_id."
            )
        return ranked[0][1]

    async def _resolve_document(self, reference: str) -> dict:
        reference = reference.strip()
        if not reference:
            raise SwipeServiceError("document_ref cannot be empty.")
        try:
            direct = await self.client.get_document(reference)
            if direct:
                return direct
        except SwipeAPIError as exc:
            if exc.code not in {"INVALID_HASH_ID", "404"}:
                raise

        invoices = await self.client.all_invoices(
            start_date="01-01-2000", end_date="31-12-2099"
        )
        exact = [
            x
            for x in invoices
            if str(x.get("serial_number") or "").casefold() == reference.casefold()
        ]
        if len(exact) == 1:
            hash_id = exact[0].get("hash_id")
            return await self.client.get_document(hash_id) if hash_id else exact[0]
        raise SwipeServiceError(
            f"Invoice '{reference}' was not found by hash ID or exact serial number."
        )

    async def _find_invoice_by_serial(self, serial_number: str) -> dict | None:
        today = date.today().strftime("%d-%m-%Y")
        invoices = await self.client.all_invoices(
            start_date=today, end_date=today
        )
        # The production API currently omits cancelled documents from
        # payment_status=all, despite the documented enum. Search them
        # explicitly so a retry cannot reuse a cancelled serial.
        if self.config.mode == "live":
            invoices.extend(
                await self.client.all_invoices(
                    start_date=today, end_date=today, status="cancelled"
                )
            )
        for invoice in invoices:
            if str(invoice.get("serial_number") or "").casefold() == serial_number.casefold():
                hash_id = invoice.get("hash_id")
                return await self.client.get_document(hash_id) if hash_id else invoice
        return None

    async def _find_payment_marker(self, marker: str) -> dict | None:
        payments, _ = await self.client.list_payments(
            start_date=date.today().strftime("%d-%m-%Y"),
            end_date=date.today().strftime("%d-%m-%Y"),
            limit=100,
        )
        for payment in payments:
            notes = " ".join(
                str(payment.get(key) or "")
                for key in ("notes", "exclusive_notes")
            )
            if marker in notes:
                return payment
        return None

    async def _run_idempotent(
        self,
        namespace: str,
        idempotency_key: str | None,
        operation: Callable[[], Awaitable[dict]],
    ) -> dict:
        if not idempotency_key:
            return await operation()
        cache_key = f"{self.config.mode}:{namespace}:{idempotency_key}"
        if cache_key in self._cache:
            return {**self._cache[cache_key], "idempotent_replay": True}
        lock = self._locks.setdefault(cache_key, asyncio.Lock())
        async with lock:
            if cache_key in self._cache:
                return {**self._cache[cache_key], "idempotent_replay": True}
            result = await operation()
            self._cache[cache_key] = result
            return result


def rank_customers(query: str, customers: list[dict]) -> list[tuple[float, dict]]:
    needle = clean_text(query)
    ranked: list[tuple[float, dict]] = []
    for customer in customers:
        fields = [
            str(customer.get("id") or ""),
            str(customer.get("name") or ""),
            str(customer.get("company_name") or ""),
            str(customer.get("gstin") or ""),
        ]
        normalized = [clean_text(x) for x in fields if x]
        score = 0.0
        for field in normalized:
            if needle == field:
                score = max(score, 1.0)
            elif needle and needle in field:
                score = max(score, 0.9 if field.startswith(needle) else 0.8)
            else:
                score = max(score, SequenceMatcher(None, needle, field).ratio())
        ranked.append((score, customer))
    return sorted(ranked, key=lambda pair: (-pair[0], str(pair[1].get("name") or "")))


def clean_text(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.casefold()).split())


def public_customer(customer: dict) -> dict:
    return {
        "id": customer.get("id"),
        "name": customer.get("name"),
        "company_name": customer.get("company_name"),
        "gstin": customer.get("gstin"),
        "state": customer.get("state"),
        "email": customer.get("email"),
        "phone": customer.get("phone"),
    }


def api_date(value: str | None, *, default: str) -> str:
    if value is None:
        return default
    value = value.strip()
    for pattern in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, pattern).strftime("%d-%m-%Y")
        except ValueError:
            continue
    raise SwipeServiceError("Dates must use YYYY-MM-DD or DD-MM-YYYY.")


def invoice_serial_for_key(key: str) -> str:
    # Swipe's live API rejects the deprecated serial_number string and requires
    # serial_number_v2 {prefix, doc_number, suffix}. Keep the deterministic
    # document number compact enough for portal validation.
    number = int(hashlib.sha256(key.encode()).hexdigest()[:12], 16) % 900_000_000
    return f"MCP-{number + 100_000_000}"


def payment_marker(key: str) -> str:
    return "swipe-mcp-idem:" + hashlib.sha256(key.encode()).hexdigest()[:24]


def reconcile_key(credit: dict, hash_id: str) -> str:
    """Deterministic idempotency key so re-running a statement never double-pays."""
    seed = f"{credit.get('narration')}|{credit.get('amount')}|{credit.get('date')}|{hash_id}"
    return "reconcile-" + hashlib.sha256(seed.encode()).hexdigest()[:24]


def reconcile_summary(results: list[dict], *, dry_run: bool) -> dict:
    counts = {"confident": 0, "review": 0, "split": 0, "none": 0}
    matched_amount = 0.0
    for result in results:
        counts[result["outcome"]] = counts.get(result["outcome"], 0) + 1
        if result["outcome"] in {"confident", "split"}:
            matched_amount += sum(m["apply_amount"] for m in result["matches"])
    summary = {
        "credits": len(results),
        "by_outcome": counts,
        "auto_applicable": counts["confident"] + counts["split"],
        "matched_amount": round(matched_amount, 2),
    }
    if not dry_run:
        summary["recorded_payments"] = sum(
            len(result.get("recorded", [])) for result in results
        )
    return summary


def number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
