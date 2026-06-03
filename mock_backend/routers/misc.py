"""Utility, inventory and subscription endpoints.

Thin HTTP layer over ``service`` — no direct store access here.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from .. import service
from ..errors import ok
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
    result = service.adjust_stock(db, item_id=payload.item_id, quantity=payload.quantity, type=payload.type)
    return ok("Stock updated successfully", result)


@router.get("/v2/inventory/warehouses/list")
async def list_warehouses() -> dict:
    return ok("Details Fetched", service.list_warehouses(db))


# --- Subscriptions --------------------------------------------------------- #
@router.get("/v2/subscriptions/list")
async def list_subscriptions() -> dict:
    return ok("Details Fetched", service.list_subscriptions(db))


@router.get("/v2/subscriptions/{subscription_hash_id}")
async def get_subscription(subscription_hash_id: str) -> dict:
    return ok("Details Fetched", service.get_subscription(db, subscription_hash_id))
