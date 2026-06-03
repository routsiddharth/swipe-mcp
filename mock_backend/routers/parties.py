"""Customer and vendor endpoints (they share the same shape).

Thin HTTP layer: validate via Pydantic, call ``service``, wrap the response.
All store access lives in ``service`` so the store stays substitutable.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from .. import service
from ..errors import ok
from ..schemas import CreateCustomerIn, CreateVendorIn
from ..store import db

router = APIRouter(tags=["Customer / Vendor"])


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #
@router.post("/v2/customer")
async def add_customer(payload: CreateCustomerIn) -> dict:
    return ok("Customer added successfully", service.add_customer(db, payload.model_dump()))


@router.put("/v2/customer")
async def update_customer(payload: CreateCustomerIn) -> dict:
    return ok("Customer updated successfully", service.update_customer(db, payload.model_dump()))


@router.get("/v2/customer/list")
async def list_customers(
    page: int = 1,
    num_records: str = "10",
    search: Optional[str] = None,
    customer_id: Optional[str] = None,
) -> dict:
    records = service.list_customers(db, search=search, customer_id=customer_id)
    return ok("Details Fetched", service.paginate(records, page, num_records), total_records=len(records))


@router.get("/v2/customer/ledger")
async def customer_ledger(customer_id: str = Query(...)) -> dict:
    service.get_customer(db, customer_id)  # 404s if unknown
    return ok("Details Fetched", service.build_ledger(db, customer_id))


@router.get("/v2/customer/{customer_id}")
async def get_customer(customer_id: str) -> dict:
    return ok("Details Fetched", service.get_customer(db, customer_id))


@router.delete("/v2/customer/{customer_id}")
async def delete_customer(customer_id: str) -> dict:
    return ok("Customer deleted successfully", service.delete_customer(db, customer_id))


# --------------------------------------------------------------------------- #
# Vendors
# --------------------------------------------------------------------------- #
@router.post("/v2/vendor")
async def add_vendor(payload: CreateVendorIn) -> dict:
    return ok("Vendor added successfully", service.add_vendor(db, payload.model_dump()))


@router.get("/v2/vendor/list")
async def list_vendors(page: int = 1, num_records: str = "10", search: Optional[str] = None) -> dict:
    records = service.list_vendors(db, search=search)
    return ok("Details Fetched", service.paginate(records, page, num_records), total_records=len(records))


@router.get("/v2/vendor/ledger")
async def vendor_ledger(vendor_id: str = Query(...)) -> dict:
    service.get_vendor(db, vendor_id)  # 404s if unknown
    return ok("Details Fetched", service.build_ledger(db, vendor_id))


@router.get("/v2/vendor/{vendor_id}")
async def get_vendor(vendor_id: str) -> dict:
    return ok("Details Fetched", service.get_vendor(db, vendor_id))


@router.delete("/v2/vendor/{vendor_id}")
async def delete_vendor(vendor_id: str) -> dict:
    return ok("Vendor deleted successfully", service.delete_vendor(db, vendor_id))
