"""Document endpoints (create / list / get / edit / cancel / pdf)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query, Response

from .. import pdf, service
from ..errors import SwipeError, ok
from ..schemas import CreateDocumentIn
from ..store import db

router = APIRouter(tags=["Document"])


def _parse(date_str: Optional[str]) -> Optional[datetime]:
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%d-%m-%Y")
    except ValueError:
        return None


@router.post("/v2/doc")
async def create_document(payload: CreateDocumentIn) -> dict:
    doc = service.build_document(db, payload.model_dump())
    return ok("Document created successfully", service.create_response(doc))


@router.get("/v2/doc/list")
async def list_documents(
    document_type: str = Query("invoice"),
    start_date: str = Query(...),
    end_date: str = Query(...),
    payment_status: str = "all",
    num_records: str = "10",
    page: int = 1,
    customer_id: Optional[str] = None,
) -> dict:
    start, end = _parse(start_date), _parse(end_date)

    docs = [d for d in db.documents.values() if d["document_type"] == document_type]
    if customer_id:
        docs = [d for d in docs if d["party"]["id"] == customer_id]
    if payment_status and payment_status != "all":
        docs = [d for d in docs if d["payment_status"] == payment_status]
    if start or end:
        def in_range(d):
            dt = _parse(d["document_date"])
            if dt is None:
                return True
            return (start is None or dt >= start) and (end is None or dt <= end)
        docs = [d for d in docs if in_range(d)]

    docs.sort(key=lambda d: _parse(d["document_date"]) or datetime.min)
    total = len(docs)
    page_docs = service.paginate(docs, page, num_records)
    transactions = [service.transaction_view(db, d) for d in page_docs]
    return ok("Details Fetched", {"transactions": transactions, "total_records": total})


@router.get("/v2/doc/pdf/{doc_hash_id}")
async def get_document_pdf(doc_hash_id: str) -> Response:
    doc = db.documents.get(doc_hash_id)
    if not doc:
        raise SwipeError("INVALID_HASH_ID", f"No document with hash id {doc_hash_id}.", 404)
    lines = [
        f"Document: {doc['document_type']}  {doc['serial_number']}",
        f"Date: {doc['document_date']}",
        f"Party: {doc['party']['name']}",
        f"Net: {doc['net_amount']}   Tax: {doc['tax_amount']}",
        f"Total: {doc['total_amount']}   Status: {doc['payment_status']}",
    ]
    body = pdf.simple_pdf("Demo Traders Pvt Ltd", lines)
    return Response(
        content=body,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{doc["serial_number"]}.pdf"'},
    )


@router.get("/v2/doc/{doc_hash_id}")
async def get_document(doc_hash_id: str) -> dict:
    doc = db.documents.get(doc_hash_id)
    if not doc:
        raise SwipeError("INVALID_HASH_ID", f"No document with hash id {doc_hash_id}.", 404)
    return ok("Details Fetched", service.document_detail(db, doc))


@router.put("/v2/doc/{doc_hash_id}")
async def edit_document(doc_hash_id: str, payload: CreateDocumentIn) -> dict:
    old = db.documents.get(doc_hash_id)
    if not old:
        raise SwipeError("INVALID_HASH_ID", f"No document with hash id {doc_hash_id}.", 404)

    # Build the replacement FIRST. If it raises (bad tax rate, over-payment,
    # etc.) the original document is left completely untouched. We let the new
    # doc auto-assign a serial so it doesn't collide with the still-present
    # original via the duplicate-serial guard; we restore the original serial
    # below once the build has succeeded.
    data = payload.model_dump()
    data.pop("serial_number", None)
    new = service.build_document(db, data)

    # Success — atomically swap the original out.
    for pid in old["payments"]:
        db.payments.pop(pid, None)
    del db.documents[doc_hash_id]
    db.documents.pop(new["hash_id"], None)
    new["hash_id"] = doc_hash_id
    new["serial_number"] = old["serial_number"]
    for pid in new["payments"]:
        db.payments[pid]["document_hash_id"] = doc_hash_id
        db.payments[pid]["document_serial_number"] = old["serial_number"]
    db.documents[doc_hash_id] = new
    return ok("Document updated successfully", service.create_response(new))


@router.delete("/v2/doc/{doc_hash_id}")
async def cancel_document(doc_hash_id: str) -> dict:
    service.cancel_document(db, doc_hash_id)
    return ok("Document cancelled successfully", {"hash_id": doc_hash_id})
