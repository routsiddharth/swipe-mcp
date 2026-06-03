"""Product (item) endpoints.

Thin HTTP layer over ``service`` — no direct store access here.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter

from .. import service
from ..errors import ok
from ..schemas import CreateProductIn
from ..store import db

router = APIRouter(tags=["Product"])


@router.post("/v2/product")
async def add_product(payload: CreateProductIn) -> dict:
    return ok("Item added successfully", service.add_product(db, payload.model_dump()))


@router.put("/v2/product")
async def update_product(payload: CreateProductIn) -> dict:
    return ok("Item updated successfully", service.update_product(db, payload.model_dump()))


@router.get("/v2/product/list")
async def list_products(page: int = 1, num_records: str = "10", search: Optional[str] = None) -> dict:
    records = service.list_products(db, search=search)
    return ok("Details Fetched", service.paginate(records, page, num_records), total_records=len(records))


@router.get("/v2/product/{item_id}")
async def get_product(item_id: str) -> dict:
    return ok("Details Fetched", service.get_product(db, item_id))


@router.delete("/v2/product/{item_id}")
async def delete_product(item_id: str) -> dict:
    return ok("Item deleted successfully", service.delete_product(db, item_id))
