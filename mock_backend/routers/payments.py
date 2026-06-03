"""Payment endpoints (record / list).

Thin HTTP layer over ``service`` — no direct store access here.
"""
from __future__ import annotations

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
    payments = service.query_payments(db, customer_id=customer_id, start_date=start_date, end_date=end_date)
    total = len(payments)
    models = [service.payment_view(p) for p in service.paginate(payments, page, num_records)]
    return ok("Details Fetched", {"payments": models, "total_records": total})
