"""Payment endpoints (record / list)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter

from .. import service
from ..errors import ok
from ..schemas import RecordPaymentIn
from ..store import db

router = APIRouter(tags=["Payment"])


@router.post("/v2/payment")
async def record_payment(payload: RecordPaymentIn) -> dict:
    rec = service.record_payment(db, payload.model_dump())
    return ok("Payment Recorded", {"payment_id": rec["payment_id"]})


@router.get("/v2/payment/list")
async def list_payments(
    customer_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    num_records: str = "10",
    page: int = 1,
) -> dict:
    def parse(s):
        try:
            return datetime.strptime(s, "%d-%m-%Y")
        except (TypeError, ValueError):
            return None

    payments = list(db.payments.values())
    if customer_id:
        payments = [p for p in payments if p.get("customer_id") == customer_id]
    start, end = parse(start_date), parse(end_date)
    if start or end:
        def in_range(p):
            dt = parse(p.get("payment_date"))
            if dt is None:
                return True
            return (start is None or dt >= start) and (end is None or dt <= end)
        payments = [p for p in payments if in_range(p)]

    total = len(payments)
    page_items = service.paginate(payments, page, num_records)
    models = [
        {
            "payment_id": p["payment_id"],
            "amount": p["amount"],
            "method": p["method"],
            "payment_date": p["payment_date"],
            "customer_name": p.get("customer_name"),
            "customer_id": p.get("customer_id"),
            "document_serial_number": p.get("document_serial_number"),
            "notes": p.get("notes"),
        }
        for p in page_items
    ]
    return ok("Details Fetched", {"payments": models, "total_records": total})
