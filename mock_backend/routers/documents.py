"""Document endpoints (create / list / get / edit / cancel / pdf).

Thin HTTP layer over ``service`` — filtering, the atomic edit-swap and all store
access live there.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query, Response

from .. import pdf, service
from ..errors import ok
from ..schemas import CreateDocumentIn
from ..store import db

router = APIRouter(tags=["Document"])


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
    docs = service.query_documents(
        db,
        document_type=document_type,
        payment_status=payment_status,
        customer_id=customer_id,
        start_date=start_date,
        end_date=end_date,
    )
    total = len(docs)
    page_docs = service.paginate(docs, page, num_records)
    transactions = [service.transaction_view(db, d) for d in page_docs]
    return ok("Details Fetched", {"transactions": transactions, "total_records": total})


@router.get("/v2/doc/pdf/{doc_hash_id}")
async def get_document_pdf(doc_hash_id: str) -> Response:
    doc = service.get_document(db, doc_hash_id)
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
    doc = service.get_document(db, doc_hash_id)
    return ok("Details Fetched", service.document_detail(db, doc))


@router.put("/v2/doc/{doc_hash_id}")
async def edit_document(doc_hash_id: str, payload: CreateDocumentIn) -> dict:
    new = service.replace_document(db, doc_hash_id, payload.model_dump())
    return ok("Document updated successfully", service.create_response(new))


@router.delete("/v2/doc/{doc_hash_id}")
async def cancel_document(doc_hash_id: str) -> dict:
    service.cancel_document(db, doc_hash_id)
    return ok("Document cancelled successfully", {"hash_id": doc_hash_id})
