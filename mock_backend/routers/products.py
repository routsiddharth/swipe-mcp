"""Product (item) endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter

from .. import service
from ..errors import SwipeError, ok
from ..schemas import CreateProductIn
from ..store import db

router = APIRouter(tags=["Product"])


def _record(p: dict) -> dict:
    """ItemListRecord shape."""
    return {
        "item_id": p["item_id"],
        "name": p["name"],
        "selling_price": p["selling_price"],
        "purchase_price": p.get("purchase_price", 0),
        "tax_rate": p.get("tax_rate", 0),
        "unit": p.get("unit"),
        "hsn_code": p.get("hsn_code"),
        "item_type": p.get("item_type", "Product"),
        "stock": p.get("stock", 0),
    }


@router.post("/v2/product")
async def add_product(payload: CreateProductIn) -> dict:
    if payload.item_id in db.products:
        raise SwipeError("PRODUCT_ALREADY_EXISTS", f"Item {payload.item_id} already exists.")
    db.products[payload.item_id] = {
        "item_id": payload.item_id,
        "name": payload.name,
        "selling_price": payload.selling_price,
        "purchase_price": payload.purchase_price,
        "tax_rate": payload.tax_rate,
        "cess_rate": payload.cess_rate,
        "unit": payload.unit,
        "hsn_code": payload.hsn_code,
        "item_type": payload.item_type,
        "stock": payload.opening_stock,
    }
    return ok("Item added successfully", {"item_id": payload.item_id})


@router.put("/v2/product")
async def update_product(payload: CreateProductIn) -> dict:
    existing = db.products.get(payload.item_id)
    if not existing:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {payload.item_id} not found.", 404)
    existing.update(
        {
            "name": payload.name,
            "selling_price": payload.selling_price,
            "purchase_price": payload.purchase_price,
            "tax_rate": payload.tax_rate,
            "cess_rate": payload.cess_rate,
            "unit": payload.unit,
            "hsn_code": payload.hsn_code,
            "item_type": payload.item_type,
        }
    )
    return ok("Item updated successfully", {"item_id": payload.item_id})


@router.get("/v2/product/list")
async def list_products(page: int = 1, num_records: str = "10", search: Optional[str] = None) -> dict:
    records = [_record(p) for p in db.products.values()]
    if search:
        s = search.lower()
        records = [r for r in records if s in (r["name"] or "").lower()]
    page_items = service.paginate(records, page, num_records)
    return ok("Details Fetched", page_items, total_records=len(records))


@router.get("/v2/product/{item_id}")
async def get_product(item_id: str) -> dict:
    p = db.products.get(item_id)
    if not p:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {item_id} not found.", 404)
    return ok("Details Fetched", _record(p))


@router.delete("/v2/product/{item_id}")
async def delete_product(item_id: str) -> dict:
    if item_id not in db.products:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {item_id} not found.", 404)
    del db.products[item_id]
    return ok("Item deleted successfully", {"item_id": item_id})
