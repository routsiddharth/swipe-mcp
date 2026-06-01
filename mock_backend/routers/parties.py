"""Customer and vendor endpoints (they share the same shape)."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from .. import service
from ..errors import SwipeError, ok
from ..schemas import CreateCustomerIn, CreateVendorIn
from ..store import db

router = APIRouter(tags=["Customer / Vendor"])


def _addr_list(addresses) -> list:
    return [a.model_dump() for a in addresses]


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #
@router.post("/v2/customer")
async def add_customer(payload: CreateCustomerIn) -> dict:
    if payload.customer_id in db.customers:
        raise SwipeError("BAD_REQUEST", f"Customer {payload.customer_id} already exists.")
    db.customers[payload.customer_id] = {
        "customer_id": payload.customer_id,
        "name": payload.name,
        "phone": payload.phone,
        "email": payload.email,
        "gstin": payload.gstin,
        "company_name": payload.company_name,
        "billing_address": _addr_list(payload.billing_address),
        "shipping_address": _addr_list(payload.shipping_address),
        "balance": payload.opening_balance,
    }
    return ok("Customer added successfully", {"customer_id": payload.customer_id})


@router.put("/v2/customer")
async def update_customer(payload: CreateCustomerIn) -> dict:
    existing = db.customers.get(payload.customer_id)
    if not existing:
        raise SwipeError("CUSTOMER_NOT_FOUND", f"Customer {payload.customer_id} not found.", 404)
    existing.update(
        {
            "name": payload.name,
            "phone": payload.phone,
            "email": payload.email,
            "gstin": payload.gstin,
            "company_name": payload.company_name,
        }
    )
    if payload.billing_address:
        existing["billing_address"] = _addr_list(payload.billing_address)
    if payload.shipping_address:
        existing["shipping_address"] = _addr_list(payload.shipping_address)
    return ok("Customer updated successfully", {"customer_id": payload.customer_id})


@router.get("/v2/customer/list")
async def list_customers(
    page: int = 1,
    num_records: str = "10",
    search: Optional[str] = None,
    customer_id: Optional[str] = None,
) -> dict:
    records = list(db.customers.values())
    if customer_id:
        records = [c for c in records if c["customer_id"] == customer_id]
    if search:
        s = search.lower()
        records = [c for c in records if s in (c["name"] or "").lower()
                   or s in (c.get("company_name") or "").lower()]
    page_items = service.paginate(records, page, num_records)
    return ok("Details Fetched", page_items, total_records=len(records))


@router.get("/v2/customer/ledger")
async def customer_ledger(customer_id: str = Query(...)) -> dict:
    if customer_id not in db.customers:
        raise SwipeError("CUSTOMER_NOT_FOUND", f"Customer {customer_id} not found.", 404)
    return ok("Details Fetched", service.build_ledger(db, customer_id))


@router.get("/v2/customer/{customer_id}")
async def get_customer(customer_id: str) -> dict:
    cust = db.customers.get(customer_id)
    if not cust:
        raise SwipeError("CUSTOMER_NOT_FOUND", f"Customer {customer_id} not found.", 404)
    return ok("Details Fetched", cust)


@router.delete("/v2/customer/{customer_id}")
async def delete_customer(customer_id: str) -> dict:
    if customer_id not in db.customers:
        raise SwipeError("CUSTOMER_NOT_FOUND", f"Customer {customer_id} not found.", 404)
    del db.customers[customer_id]
    return ok("Customer deleted successfully", {"customer_id": customer_id})


# --------------------------------------------------------------------------- #
# Vendors
# --------------------------------------------------------------------------- #
@router.post("/v2/vendor")
async def add_vendor(payload: CreateVendorIn) -> dict:
    if payload.vendor_id in db.vendors:
        raise SwipeError("BAD_REQUEST", f"Vendor {payload.vendor_id} already exists.")
    db.vendors[payload.vendor_id] = {
        "vendor_id": payload.vendor_id,
        "name": payload.name,
        "phone": payload.phone,
        "email": payload.email,
        "gstin": payload.gstin,
        "company_name": payload.company_name,
        "billing_address": _addr_list(payload.billing_address),
        "shipping_address": _addr_list(payload.shipping_address),
        "balance": payload.opening_balance,
    }
    return ok("Vendor added successfully", {"vendor_id": payload.vendor_id})


@router.get("/v2/vendor/list")
async def list_vendors(page: int = 1, num_records: str = "10", search: Optional[str] = None) -> dict:
    records = list(db.vendors.values())
    if search:
        s = search.lower()
        records = [v for v in records if s in (v["name"] or "").lower()]
    page_items = service.paginate(records, page, num_records)
    return ok("Details Fetched", page_items, total_records=len(records))


@router.get("/v2/vendor/ledger")
async def vendor_ledger(vendor_id: str = Query(...)) -> dict:
    if vendor_id not in db.vendors:
        raise SwipeError("BAD_REQUEST", f"Vendor {vendor_id} not found.", 404)
    return ok("Details Fetched", service.build_ledger(db, vendor_id))


@router.get("/v2/vendor/{vendor_id}")
async def get_vendor(vendor_id: str) -> dict:
    vendor = db.vendors.get(vendor_id)
    if not vendor:
        raise SwipeError("BAD_REQUEST", f"Vendor {vendor_id} not found.", 404)
    return ok("Details Fetched", vendor)


@router.delete("/v2/vendor/{vendor_id}")
async def delete_vendor(vendor_id: str) -> dict:
    if vendor_id not in db.vendors:
        raise SwipeError("BAD_REQUEST", f"Vendor {vendor_id} not found.", 404)
    del db.vendors[vendor_id]
    return ok("Vendor deleted successfully", {"vendor_id": vendor_id})
