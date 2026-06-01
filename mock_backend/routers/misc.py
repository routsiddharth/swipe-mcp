"""Utility, inventory and subscription endpoints."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from .. import service
from ..errors import SwipeError, ok
from ..store import db

router = APIRouter(tags=["Utility / Inventory / Subscriptions"])


# --- Utility --------------------------------------------------------------- #
@router.get("/v2/utils/gstin/{gstin}")
async def get_gstin(gstin: str) -> dict:
    return ok("Details Fetched", service.lookup_gstin(db, gstin))


# --- Inventory ------------------------------------------------------------- #
class InventoryStockIn(BaseModel):
    item_id: str
    quantity: float
    type: Literal["in", "out"] = "in"
    warehouse_id: int = 1


@router.post("/v2/inventory/stock")
async def post_inventory_stock(payload: InventoryStockIn) -> dict:
    product = db.products.get(payload.item_id)
    if not product:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {payload.item_id} not found.", 404)
    delta = payload.quantity if payload.type == "in" else -payload.quantity
    new_stock = product.get("stock", 0) + delta
    if new_stock < 0:
        raise SwipeError("INSUFFICIENT_STOCK", "Stock cannot go below zero.")
    product["stock"] = new_stock
    return ok("Stock updated successfully", {"item_id": payload.item_id, "stock": new_stock})


@router.get("/v2/inventory/warehouses/list")
async def list_warehouses() -> dict:
    return ok("Details Fetched", db.warehouses)


# --- Subscriptions --------------------------------------------------------- #
@router.get("/v2/subscriptions/list")
async def list_subscriptions() -> dict:
    return ok("Details Fetched", list(db.subscriptions.values()))


@router.get("/v2/subscriptions/{subscription_hash_id}")
async def get_subscription(subscription_hash_id: str) -> dict:
    sub = db.subscriptions.get(subscription_hash_id)
    if not sub:
        raise SwipeError("SUBSCRIPTION_DETAILS_NOT_FOUND", "Subscription not found.", 404)
    return ok("Details Fetched", sub)
