"""FastMCP tool definitions."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from .client import SwipeAPIError
from .config import ConfigurationError, SwipeConfig
from .models import BankCredit, BankDetails, InvoiceItem, PaymentMethod
from .service import SwipeService, SwipeServiceError

_service: SwipeService | None = None


@asynccontextmanager
async def lifespan(_: FastMCP):
    global _service
    try:
        yield
    finally:
        if _service is not None:
            await _service.close()
            _service = None


mcp = FastMCP(
    "Swipe",
    instructions=(
        "Read and write Swipe invoices, customers, products, payments, ledgers, "
        "and GSTIN records. Writes affect the configured mock or live account. "
        "Use customer IDs after resolving ambiguous names, and use an "
        "idempotency_key for every retriable write."
    ),
    lifespan=lifespan,
)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=True)
WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=True,
)


def get_service() -> SwipeService:
    global _service
    if _service is None:
        try:
            _service = SwipeService(SwipeConfig.from_env())
        except ConfigurationError as exc:
            raise ToolError(str(exc)) from exc
    return _service


async def run_tool(call):
    try:
        return await call
    except ToolError:
        raise
    except (SwipeServiceError, SwipeAPIError, ConfigurationError) as exc:
        raise ToolError(str(exc)) from exc


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def find_customer(query: str, limit: int = 10) -> dict[str, Any]:
    """Find customers by ID, name, company, or GSTIN and return ranked matches."""
    return await run_tool(get_service().find_customer(query, limit=max(1, min(limit, 25))))


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def list_customers(page: int = 1, limit: int = 50) -> dict[str, Any]:
    """List a bounded page of Swipe customers."""
    return await run_tool(
        get_service().list_customers(page=max(1, page), limit=max(1, min(limit, 100)))
    )


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def list_products(page: int = 1, limit: int = 50) -> dict[str, Any]:
    """List a bounded page of Swipe products and services."""
    return await run_tool(
        get_service().list_products(page=max(1, page), limit=max(1, min(limit, 100)))
    )


@mcp.tool(annotations=WRITE, structured_output=True)
async def create_invoice(
    items: list[InvoiceItem],
    customer_id: str | None = None,
    customer_name: str | None = None,
    due_days: int = 30,
    serial_number: str | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Create a GST-computed invoice.

    This writes to the configured Swipe account. Resolve ambiguous customer names
    first. Supply a stable idempotency_key when a caller may retry the request.
    """
    return await run_tool(
        get_service().create_invoice(
            items=items,
            customer_id=customer_id,
            customer_name=customer_name,
            due_days=max(0, min(due_days, 3650)),
            serial_number=serial_number,
            idempotency_key=idempotency_key,
        )
    )


@mcp.tool(annotations=WRITE, structured_output=True)
async def record_payment(
    document_ref: str,
    amount: float,
    method: PaymentMethod = "cash",
    bank_details: BankDetails | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """Record a payment against an exact invoice hash ID or serial number.

    This writes to the configured Swipe account. Live non-cash payments require
    real bank_details. Supply a stable idempotency_key for retriable requests.
    """
    return await run_tool(
        get_service().record_payment(
            document_ref=document_ref,
            amount=amount,
            method=method,
            bank_details=bank_details,
            idempotency_key=idempotency_key,
        )
    )


@mcp.tool(annotations=WRITE, structured_output=True)
async def reconcile(
    credits: list[BankCredit],
    dry_run: bool = True,
    method: PaymentMethod = "cash",
    bank_details: BankDetails | None = None,
    amount_tolerance: float = 1.0,
) -> dict[str, Any]:
    """Reconcile parsed bank-statement credits against outstanding Swipe invoices.

    Pass the credit (deposit) lines you extracted from the user's bank statement;
    this server does not read files. It pulls every invoice with a pending
    balance, then matches each credit on amount, payee name, and invoice serial,
    classifying it as: confident (book it), review (ambiguous/near-amount/
    overpayment — ask the user), split (one credit clears several invoices), or
    none (refund/salary/transfer — leave alone).

    dry_run=True (the default) only returns the proposed match table and writes
    NOTHING. Show it to the user, and only after they confirm call again with
    dry_run=False to record the confident and split matches (idempotently — a
    re-run never double-pays). review/none credits are never auto-recorded.
    Live non-cash payments require bank_details; method='cash' avoids that.
    """
    return await run_tool(
        get_service().reconcile(
            credits=credits,
            dry_run=dry_run,
            method=method,
            bank_details=bank_details,
            amount_tolerance=max(0.0, min(amount_tolerance, 100.0)),
        )
    )


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def list_invoices(
    status: str = "all",
    start_date: str | None = None,
    end_date: str | None = None,
    customer_id: str | None = None,
    page: int = 1,
    limit: int = 50,
) -> dict[str, Any]:
    """List invoices. Dates may be YYYY-MM-DD or DD-MM-YYYY."""
    allowed = {"all", "pending", "paid", "cancelled"}
    if status not in allowed:
        raise ToolError(f"status must be one of: {', '.join(sorted(allowed))}.")
    return await run_tool(
        get_service().list_invoices(
            status=status,
            start_date=start_date,
            end_date=end_date,
            customer_id=customer_id,
            page=max(1, page),
            limit=max(1, min(limit, 100)),
        )
    )


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def customer_outstanding(
    customer_id: str | None = None,
    customer_name: str | None = None,
) -> dict[str, Any]:
    """Return a resolved customer's outstanding balance and ledger."""
    return await run_tool(
        get_service().customer_outstanding(
            customer_id=customer_id, customer_name=customer_name
        )
    )


@mcp.tool(annotations=READ_ONLY, structured_output=True)
async def lookup_gstin(gstin: str) -> dict[str, Any]:
    """Validate and look up a 15-character Indian GSTIN."""
    return await run_tool(get_service().lookup_gstin(gstin))
