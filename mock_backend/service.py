"""Business logic shared by the routers and the seeder.

Operates on plain dicts so it can build both seed data and live request data.
This is where documents get their computed amounts, serial numbers, hash ids and
payment status — mirroring what the real Swipe backend does server-side.
"""
from __future__ import annotations

import copy
from typing import Optional

from . import gst, ids
from .errors import SwipeError

_PAID_EPS = 0.01


def paginate(items: list, page=1, num_records="10") -> list:
    """Slice a list the way the API's page / num_records (max 100) params do."""
    try:
        n = min(int(num_records), 100)
    except (TypeError, ValueError):
        n = 10
    try:
        p = max(int(page), 1)
    except (TypeError, ValueError):
        p = 1
    start = (p - 1) * n
    return items[start:start + n]


# --------------------------------------------------------------------------- #
# Parties / items auto-creation (the real API auto-creates unknown ids)
# --------------------------------------------------------------------------- #
def _ensure_party(store, party: dict) -> None:
    pid = party["id"]
    bucket = store.vendors if party.get("type") == "vendor" else store.customers
    if pid in bucket:
        return
    record = {
        ("vendor_id" if party.get("type") == "vendor" else "customer_id"): pid,
        "name": party["name"],
        "phone": party.get("phone_number"),
        "email": party.get("email"),
        "gstin": party.get("gstin"),
        "company_name": party.get("company_name"),
        "billing_address": [party["billing_address"]] if party.get("billing_address") else [],
        "shipping_address": [party["shipping_address"]] if party.get("shipping_address") else [],
        "balance": 0.0,
    }
    bucket[pid] = record


def _ensure_item(store, item: dict) -> None:
    iid = item["id"]
    if iid in store.products:
        return
    store.products[iid] = {
        "item_id": iid,
        "name": item["name"],
        "selling_price": item.get("unit_price", 0),
        "purchase_price": 0.0,
        "tax_rate": item.get("tax_rate", 0),
        "unit": item.get("unit") or "OTH",
        "hsn_code": item.get("hsn_code"),
        "item_type": item.get("item_type", "Product"),
        "stock": 0.0,
    }


def _party_state(party: dict) -> Optional[str]:
    for key in ("shipping_address", "billing_address"):
        addr = party.get(key)
        if addr and addr.get("state"):
            return str(addr["state"]).upper()
    return None


def _payment_status(total: float, paid: float, cancelled: bool) -> str:
    if cancelled:
        return "cancelled"
    return "paid" if paid + _PAID_EPS >= total else "pending"


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
def build_document(store, data: dict) -> dict:
    """Validate, compute and store a document. Returns the stored record."""
    document_type = data.get("document_type", "invoice")
    # Deep copy so the document keeps an immutable snapshot of the party; a later
    # edit to the customer/vendor master must not rewrite historical documents.
    party = copy.deepcopy(data["party"])
    serial_number = data.get("serial_number")

    # Duplicate serial guard (idempotency aid + matches the API error).
    if serial_number:
        for doc in store.documents.values():
            if doc["serial_number"] == serial_number and doc["document_type"] == document_type:
                raise SwipeError(
                    "DUPLICATE_DOC_SERIAL_NUMBER",
                    f"A {document_type} with serial number {serial_number} already exists.",
                )

    if data.get("tds_id") and data.get("tcs_id"):
        raise SwipeError(
            "CAN_NOT_APPLY_TDS_AND_TCS_TOGETHER",
            "TDS and TCS cannot both be applied to a single document.",
        )

    _ensure_party(store, party)

    company_state = (store.company.get("state") or "").upper()
    party_state = _party_state(party)
    intra_state = party_state is None or party_state == company_state

    computed_items = []
    for raw in data["items"]:
        _ensure_item(store, raw)
        calc = gst.compute_line_item(
            quantity=raw["quantity"],
            unit_price=raw["unit_price"],
            tax_rate=raw.get("tax_rate", 0) or 0,
            cess_rate=raw.get("cess_rate", 0) or 0,
            discount_percent=raw.get("discount_percent"),
            discount_amount=raw.get("discount_amount"),
        )
        computed_items.append(
            {
                "id": raw["id"],
                "name": raw["name"],
                "item_type": raw.get("item_type", "Product"),
                "quantity": raw["quantity"],
                "unit_price": raw["unit_price"],
                "tax_rate": raw.get("tax_rate", 0) or 0,
                "cess_rate": raw.get("cess_rate", 0) or 0,
                "hsn_code": raw.get("hsn_code"),
                "unit": raw.get("unit"),
                "description": raw.get("description"),
                **calc,
            }
        )

    totals = gst.compute_document_totals(
        computed_items,
        extra_discount=data.get("extra_discount", 0) or 0,
        charges_and_deductions=data.get("charges_and_deductions"),
        round_off=data.get("round_off", False),
        intra_state=intra_state,
    )

    hash_id = ids.new_hash_id()
    serial_number = serial_number or store.next_serial(document_type)

    # Validate payments BEFORE registering them: a rejected request must not
    # leave orphan payment records in the store.
    payment_inputs = data.get("payments", []) or []
    amount_paid = gst.money(sum(p["amount"] for p in payment_inputs))
    total = totals["total_amount"]
    if amount_paid - _PAID_EPS > total:
        raise SwipeError(
            "AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT",
            f"Payments ({amount_paid}) exceed the document total ({total}).",
        )

    payment_records = [
        _make_payment(
            store,
            hash_id=hash_id,
            serial_number=serial_number,
            customer=party,
            amount=p["amount"],
            method=p.get("method", "cash"),
            payment_date=p.get("payment_date") or data["document_date"],
            notes=p.get("notes"),
        )
        for p in payment_inputs
    ]

    doc = {
        "hash_id": hash_id,
        "serial_number": serial_number,
        "document_type": document_type,
        "document_date": data["document_date"],
        "due_date": data.get("due_date"),
        "party": party,
        "items": computed_items,
        "reference": data.get("reference"),
        "notes": data.get("notes"),
        "terms": data.get("terms"),
        "einvoice": data.get("einvoice", False),
        "is_export": data.get("is_export", False),
        "is_created_by_recurring": 0,
        "cancelled": False,
        "amount_paid": gst.money(amount_paid),
        "amount_pending": gst.money(max(total - amount_paid, 0)),
        "payment_status": _payment_status(total, amount_paid, False),
        "payments": [p["payment_id"] for p in payment_records],
        **totals,
    }
    if data.get("einvoice"):
        doc["irn"] = ids.fake_irn()
        doc["qr_code"] = "data:image/png;base64,MOCKQRCODE=="
    store.documents[hash_id] = doc
    return doc


def cancel_document(store, hash_id: str) -> dict:
    doc = store.documents.get(hash_id)
    if not doc:
        raise SwipeError("INVALID_HASH_ID", f"No document with hash id {hash_id}.", status_code=404)
    doc["cancelled"] = True
    doc["payment_status"] = "cancelled"
    return doc


def create_response(doc: dict) -> dict:
    return {
        "hash_id": doc["hash_id"],
        "serial_number": doc["serial_number"],
        "irn": doc.get("irn", ""),
        "qr_code": doc.get("qr_code", ""),
    }


def transaction_view(store, doc: dict) -> dict:
    """TransactionListModelV2 shape used by /v2/doc/list."""
    party = doc["party"]
    return {
        "hash_id": doc["hash_id"],
        "serial_number": doc["serial_number"],
        "document_type": doc["document_type"],
        "document_date": doc["document_date"],
        "due_date": doc.get("due_date"),
        "customer": {
            "id": party["id"],
            "name": party["name"],
            "country_code": party.get("country_code"),
            "phone_number": party.get("phone_number"),
            "company_name": party.get("company_name"),
            "email": party.get("email"),
            "gstin": party.get("gstin"),
        },
        "net_amount": doc["net_amount"],
        "tax_amount": doc["tax_amount"],
        "total_amount": doc["total_amount"],
        "total_discount": doc["total_discount"],
        "amount_paid": doc["amount_paid"],
        "amount_pending": doc["amount_pending"],
        "payment_status": doc["payment_status"],
        "reference": doc.get("reference"),
        "notes": doc.get("notes"),
        "terms": doc.get("terms"),
        "is_created_by_recurring": doc.get("is_created_by_recurring", 0),
        "payments": [_payment_brief(store, pid) for pid in doc.get("payments", [])],
    }


def document_detail(store, doc: dict) -> dict:
    """Fuller view for GET /v2/doc/{hash_id} — includes line items + tax breakup."""
    view = transaction_view(store, doc)
    view.update(
        {
            "items": doc["items"],
            "tax_breakup": doc["tax_breakup"],
            "extra_discount": doc["extra_discount"],
            "round_off": doc["round_off"],
            "einvoice": doc.get("einvoice", False),
            "irn": doc.get("irn", ""),
        }
    )
    return view


# --------------------------------------------------------------------------- #
# Payments
# --------------------------------------------------------------------------- #
def _make_payment(store, *, hash_id, serial_number, customer, amount, method,
                  payment_date, notes) -> dict:
    pid = ids.new_payment_id()
    rec = {
        "payment_id": pid,
        "amount": gst.money(amount),
        "method": method,
        "payment_date": payment_date,
        "customer_id": customer.get("id"),
        "customer_name": customer.get("name"),
        "document_hash_id": hash_id,
        "document_serial_number": serial_number,
        "notes": notes,
    }
    store.payments[pid] = rec
    return rec


def _payment_brief(store, pid: str) -> dict:
    rec = store.payments.get(pid, {})
    return {
        "amount": rec.get("amount"),
        "method": rec.get("method"),
        "payment_date": rec.get("payment_date"),
        "notes": rec.get("notes"),
    }


def record_payment(store, data: dict) -> dict:
    """Record a payment against an existing document, updating its status."""
    doc = None
    if data.get("doc_hash_id"):
        doc = store.documents.get(data["doc_hash_id"])
    elif data.get("serial_number"):
        doc = next(
            (d for d in store.documents.values() if d["serial_number"] == data["serial_number"]),
            None,
        )
    if not doc:
        raise SwipeError(
            "INVALID_HASH_ID",
            "Document not found. Provide a valid doc_hash_id or serial_number.",
            status_code=404,
        )
    if doc["cancelled"]:
        raise SwipeError("BAD_REQUEST", "Cannot record a payment on a cancelled document.")

    new_paid = doc["amount_paid"] + gst.money(data["amount"])
    if new_paid - _PAID_EPS > doc["total_amount"]:
        raise SwipeError(
            "AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT",
            f"Payment would exceed the pending amount ({doc['amount_pending']}).",
        )

    rec = _make_payment(
        store,
        hash_id=doc["hash_id"],
        serial_number=doc["serial_number"],
        customer=doc["party"],
        amount=data["amount"],
        method=data.get("method", "cash"),
        payment_date=data.get("payment_date") or doc["document_date"],
        notes=data.get("notes"),
    )
    doc["payments"].append(rec["payment_id"])
    doc["amount_paid"] = gst.money(new_paid)
    doc["amount_pending"] = gst.money(max(doc["total_amount"] - new_paid, 0))
    doc["payment_status"] = _payment_status(doc["total_amount"], new_paid, False)
    return rec


# --------------------------------------------------------------------------- #
# Ledger & GSTIN
# --------------------------------------------------------------------------- #
def build_ledger(store, party_id: str) -> dict:
    """A simple running-balance ledger for a customer/vendor."""
    txns = []
    balance = 0.0
    docs = sorted(
        (d for d in store.documents.values() if d["party"]["id"] == party_id),
        key=lambda d: d["document_date"],
    )
    for d in docs:
        balance += d["total_amount"]
        txns.append(
            {
                "date": d["document_date"],
                "particulars": d["serial_number"],
                "type": d["document_type"],
                "debit": d["total_amount"],
                "credit": 0.0,
                "balance": gst.money(balance),
            }
        )
        if d["amount_paid"]:
            balance -= d["amount_paid"]
            txns.append(
                {
                    "date": d["document_date"],
                    "particulars": f"Payment for {d['serial_number']}",
                    "type": "payment",
                    "debit": 0.0,
                    "credit": d["amount_paid"],
                    "balance": gst.money(balance),
                }
            )
    return {"opening_balance": 0.0, "closing_balance": gst.money(balance), "transactions": txns}


def lookup_gstin(store, gstin: str) -> dict:
    if gstin in store.gstins:
        return store.gstins[gstin]
    # Synthesize a plausible response for unknown (well-formed) GSTINs.
    if len(gstin) != 15:
        raise SwipeError("BAD_REQUEST", "GSTIN must be 15 characters.")
    return {
        "gstin": gstin,
        "legal_name": "MOCK ENTERPRISES PRIVATE LIMITED",
        "trade_name": "Mock Enterprises",
        "address": "Hyderabad, Telangana",
        "state": "TELANGANA",
        "pincode": "500032",
        "status": "Active",
        "registration_date": "01-07-2017",
        "taxpayer_type": "Regular",
    }
