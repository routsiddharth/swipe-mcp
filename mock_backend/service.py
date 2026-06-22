"""Business logic shared by the routers and the seeder.

Operates on plain dicts so it can build both seed data and live request data.
This is where documents get their computed amounts, serial numbers, hash ids and
payment status — mirroring what the real Swipe backend does server-side.
"""
from __future__ import annotations

import copy
from datetime import datetime
from typing import Optional

from . import ids
from .errors import SwipeError
from swipe_core import gst

_PAID_EPS = 0.01


def paginate(items: list, page=1, num_records="10") -> list:
    """Slice a list the way the API's page / num_records (max 100) params do."""
    try:
        n = min(int(num_records), 100)
    except (TypeError, ValueError):
        n = 10
    try:
        p = max(int(page), 1)
    except (TypeError, ValueError):
        p = 1
    start = (p - 1) * n
    return items[start:start + n]


def parse_date(date_str: Optional[str]) -> Optional[datetime]:
    """Parse a DD-MM-YYYY string; return None on anything unparseable."""
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%d-%m-%Y")
    except (TypeError, ValueError):
        return None


def filter_by_date_range(items: list, start_date, end_date, field: str) -> list:
    """Keep items whose `field` (a DD-MM-YYYY string) falls in [start, end].

    Inclusive on both ends; either bound may be omitted. An item whose date is
    missing or unparseable is kept (matching the routers' prior behaviour).
    """
    start, end = parse_date(start_date), parse_date(end_date)
    if start is None and end is None:
        return list(items)

    def in_range(item: dict) -> bool:
        dt = parse_date(item.get(field))
        if dt is None:
            return True
        return (start is None or dt >= start) and (end is None or dt <= end)

    return [item for item in items if in_range(item)]


# --------------------------------------------------------------------------- #
# Parties / items auto-creation (the real API auto-creates unknown ids)
# --------------------------------------------------------------------------- #
def _ensure_party(store, party: dict) -> None:
    pid = party["id"]
    bucket = store.vendors if party.get("type") == "vendor" else store.customers
    if pid in bucket:
        return
    record = {
        ("vendor_id" if party.get("type") == "vendor" else "customer_id"): pid,
        "name": party["name"],
        "phone": party.get("phone_number"),
        "email": party.get("email"),
        "gstin": party.get("gstin"),
        "company_name": party.get("company_name"),
        "billing_address": [party["billing_address"]] if party.get("billing_address") else [],
        "shipping_address": [party["shipping_address"]] if party.get("shipping_address") else [],
        "balance": 0.0,
    }
    bucket[pid] = record


def _ensure_item(store, item: dict) -> None:
    iid = item["id"]
    if iid in store.products:
        return
    store.products[iid] = {
        "item_id": iid,
        "name": item["name"],
        "selling_price": item.get("unit_price", 0),
        "purchase_price": 0.0,
        "tax_rate": item.get("tax_rate", 0),
        "unit": item.get("unit") or "OTH",
        "hsn_code": item.get("hsn_code"),
        "item_type": item.get("item_type", "Product"),
        "stock": 0.0,
    }


def _party_state(party: dict) -> Optional[str]:
    for key in ("shipping_address", "billing_address"):
        addr = party.get(key)
        if addr and addr.get("state"):
            return str(addr["state"]).upper()
    return None


def _payment_status(total: float, paid: float, cancelled: bool) -> str:
    if cancelled:
        return "cancelled"
    return "paid" if paid + _PAID_EPS >= total else "pending"


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
def build_document(store, data: dict) -> dict:
    """Validate, compute and store a document. Returns the stored record."""
    document_type = data.get("document_type", "invoice")
    # Deep copy so the document keeps an immutable snapshot of the party; a later
    # edit to the customer/vendor master must not rewrite historical documents.
    party = copy.deepcopy(data["party"])
    serial_number = data.get("serial_number")

    # Duplicate serial guard (idempotency aid + matches the API error).
    if serial_number:
        for doc in store.documents.values():
            if doc["serial_number"] == serial_number and doc["document_type"] == document_type:
                raise SwipeError(
                    "DUPLICATE_DOC_SERIAL_NUMBER",
                    f"A {document_type} with serial number {serial_number} already exists.",
                )

    if data.get("tds_id") and data.get("tcs_id"):
        raise SwipeError(
            "CAN_NOT_APPLY_TDS_AND_TCS_TOGETHER",
            "TDS and TCS cannot both be applied to a single document.",
        )

    _ensure_party(store, party)

    company_state = (store.company.get("state") or "").upper()
    party_state = _party_state(party)
    intra_state = party_state is None or party_state == company_state

    computed_items = []
    for raw in data["items"]:
        _ensure_item(store, raw)
        calc = gst.compute_line_item(
            quantity=raw["quantity"],
            unit_price=raw["unit_price"],
            tax_rate=raw.get("tax_rate", 0) or 0,
            cess_rate=raw.get("cess_rate", 0) or 0,
            discount_percent=raw.get("discount_percent"),
            discount_amount=raw.get("discount_amount"),
        )
        computed_items.append(
            {
                "id": raw["id"],
                "name": raw["name"],
                "item_type": raw.get("item_type", "Product"),
                "quantity": raw["quantity"],
                "unit_price": raw["unit_price"],
                "tax_rate": raw.get("tax_rate", 0) or 0,
                "cess_rate": raw.get("cess_rate", 0) or 0,
                "hsn_code": raw.get("hsn_code"),
                "unit": raw.get("unit"),
                "description": raw.get("description"),
                **calc,
            }
        )

    totals = gst.compute_document_totals(
        computed_items,
        extra_discount=data.get("extra_discount", 0) or 0,
        charges_and_deductions=data.get("charges_and_deductions"),
        round_off=data.get("round_off", False),
        intra_state=intra_state,
    )

    hash_id = ids.new_hash_id()
    serial_number = serial_number or store.next_serial(document_type)

    # Validate payments BEFORE registering them: a rejected request must not
    # leave orphan payment records in the store.
    payment_inputs = data.get("payments", []) or []
    amount_paid = gst.money(sum(p["amount"] for p in payment_inputs))
    total = totals["total_amount"]
    if amount_paid - _PAID_EPS > total:
        raise SwipeError(
            "AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT",
            f"Payments ({amount_paid}) exceed the document total ({total}).",
        )

    payment_records = [
        _make_payment(
            store,
            hash_id=hash_id,
            serial_number=serial_number,
            customer=party,
            amount=p["amount"],
            method=p.get("method", "cash"),
            payment_date=p.get("payment_date") or data["document_date"],
            notes=p.get("notes"),
        )
        for p in payment_inputs
    ]

    doc = {
        "hash_id": hash_id,
        "serial_number": serial_number,
        "document_type": document_type,
        "document_date": data["document_date"],
        "due_date": data.get("due_date"),
        "party": party,
        "items": computed_items,
        "reference": data.get("reference"),
        "notes": data.get("notes"),
        "terms": data.get("terms"),
        "einvoice": data.get("einvoice", False),
        "is_export": data.get("is_export", False),
        "is_created_by_recurring": 0,
        "cancelled": False,
        "amount_paid": gst.money(amount_paid),
        "amount_pending": gst.money(max(total - amount_paid, 0)),
        "payment_status": _payment_status(total, amount_paid, False),
        "payments": [p["payment_id"] for p in payment_records],
        **totals,
    }
    if data.get("einvoice"):
        doc["irn"] = ids.fake_irn()
        doc["qr_code"] = "data:image/png;base64,MOCKQRCODE=="
    store.documents[hash_id] = doc
    return doc


def cancel_document(store, hash_id: str) -> dict:
    doc = store.documents.get(hash_id)
    if not doc:
        raise SwipeError("INVALID_HASH_ID", f"No document with hash id {hash_id}.", status_code=404)
    doc["cancelled"] = True
    doc["payment_status"] = "cancelled"
    return doc


def create_response(doc: dict) -> dict:
    return {
        "hash_id": doc["hash_id"],
        "serial_number": doc["serial_number"],
        "irn": doc.get("irn", ""),
        "qr_code": doc.get("qr_code", ""),
    }


def transaction_view(store, doc: dict) -> dict:
    """TransactionListModelV2 shape used by /v2/doc/list."""
    party = doc["party"]
    return {
        "hash_id": doc["hash_id"],
        "serial_number": doc["serial_number"],
        "document_type": doc["document_type"],
        "document_date": doc["document_date"],
        "due_date": doc.get("due_date"),
        "customer": {
            "id": party["id"],
            "name": party["name"],
            "country_code": party.get("country_code"),
            "phone_number": party.get("phone_number"),
            "company_name": party.get("company_name"),
            "email": party.get("email"),
            "gstin": party.get("gstin"),
        },
        "net_amount": doc["net_amount"],
        "tax_amount": doc["tax_amount"],
        "total_amount": doc["total_amount"],
        "total_discount": doc["total_discount"],
        "amount_paid": doc["amount_paid"],
        "amount_pending": doc["amount_pending"],
        "payment_status": doc["payment_status"],
        "reference": doc.get("reference"),
        "notes": doc.get("notes"),
        "terms": doc.get("terms"),
        "is_created_by_recurring": doc.get("is_created_by_recurring", 0),
        "payments": [_payment_brief(store, pid) for pid in doc.get("payments", [])],
    }


def document_detail(store, doc: dict) -> dict:
    """Fuller view for GET /v2/doc/{hash_id} — includes line items + tax breakup."""
    view = transaction_view(store, doc)
    view.update(
        {
            "items": doc["items"],
            "tax_breakup": doc["tax_breakup"],
            "extra_discount": doc["extra_discount"],
            "round_off": doc["round_off"],
            "einvoice": doc.get("einvoice", False),
            "irn": doc.get("irn", ""),
        }
    )
    return view


def get_document(store, hash_id: str) -> dict:
    """Fetch a document or raise INVALID_HASH_ID (the one place that knows the code)."""
    doc = store.documents.get(hash_id)
    if not doc:
        raise SwipeError("INVALID_HASH_ID", f"No document with hash id {hash_id}.", status_code=404)
    return doc


def query_documents(store, *, document_type: str, payment_status: str = "all",
                    customer_id: Optional[str] = None, start_date=None, end_date=None) -> list:
    """Filtered, date-sorted documents for /v2/doc/list (pagination is the caller's job)."""
    docs = [d for d in store.documents.values() if d["document_type"] == document_type]
    if customer_id:
        docs = [d for d in docs if d["party"]["id"] == customer_id]
    if payment_status and payment_status != "all":
        docs = [d for d in docs if d["payment_status"] == payment_status]
    docs = filter_by_date_range(docs, start_date, end_date, "document_date")
    docs.sort(key=lambda d: parse_date(d["document_date"]) or datetime.min)
    return docs


def replace_document(store, hash_id: str, data: dict) -> dict:
    """Edit a document: build the replacement FIRST, then atomically swap.

    If the build raises (bad tax rate, over-payment, ...) the original document
    is left completely untouched — no partial write. The replacement keeps the
    original's hash id and serial number.
    """
    old = get_document(store, hash_id)
    data = dict(data)
    # Let the new doc auto-assign a serial so it doesn't collide with the still
    # present original via the duplicate-serial guard; restore it after success.
    data.pop("serial_number", None)
    new = build_document(store, data)

    for pid in old["payments"]:
        store.payments.pop(pid, None)
    del store.documents[hash_id]
    store.documents.pop(new["hash_id"], None)
    new["hash_id"] = hash_id
    new["serial_number"] = old["serial_number"]
    for pid in new["payments"]:
        store.payments[pid]["document_hash_id"] = hash_id
        store.payments[pid]["document_serial_number"] = old["serial_number"]
    store.documents[hash_id] = new
    return new


# --------------------------------------------------------------------------- #
# Payments
# --------------------------------------------------------------------------- #
def _make_payment(store, *, hash_id, serial_number, customer, amount, method,
                  payment_date, notes) -> dict:
    pid = ids.new_payment_id()
    rec = {
        "payment_id": pid,
        "amount": gst.money(amount),
        "method": method,
        "payment_date": payment_date,
        "customer_id": customer.get("id"),
        "customer_name": customer.get("name"),
        "document_hash_id": hash_id,
        "document_serial_number": serial_number,
        "notes": notes,
    }
    store.payments[pid] = rec
    return rec


def _payment_brief(store, pid: str) -> dict:
    rec = store.payments.get(pid, {})
    return {
        "amount": rec.get("amount"),
        "method": rec.get("method"),
        "payment_date": rec.get("payment_date"),
        "notes": rec.get("notes"),
    }


def record_payment(store, data: dict) -> dict:
    """Record a payment against an existing document, updating its status."""
    doc = None
    if data.get("doc_hash_id"):
        doc = store.documents.get(data["doc_hash_id"])
    elif data.get("serial_number"):
        doc = next(
            (d for d in store.documents.values() if d["serial_number"] == data["serial_number"]),
            None,
        )
    if not doc:
        raise SwipeError(
            "INVALID_HASH_ID",
            "Document not found. Provide a valid doc_hash_id or serial_number.",
            status_code=404,
        )
    if doc["cancelled"]:
        raise SwipeError("BAD_REQUEST", "Cannot record a payment on a cancelled document.")

    new_paid = doc["amount_paid"] + gst.money(data["amount"])
    if new_paid - _PAID_EPS > doc["total_amount"]:
        raise SwipeError(
            "AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT",
            f"Payment would exceed the pending amount ({doc['amount_pending']}).",
        )

    rec = _make_payment(
        store,
        hash_id=doc["hash_id"],
        serial_number=doc["serial_number"],
        customer=doc["party"],
        amount=data["amount"],
        method=data.get("method", "cash"),
        payment_date=data.get("payment_date") or doc["document_date"],
        notes=data.get("notes"),
    )
    doc["payments"].append(rec["payment_id"])
    doc["amount_paid"] = gst.money(new_paid)
    doc["amount_pending"] = gst.money(max(doc["total_amount"] - new_paid, 0))
    doc["payment_status"] = _payment_status(doc["total_amount"], new_paid, False)
    return rec


def payment_view(p: dict) -> dict:
    """GetPaymentV2 shape used by /v2/payment/list."""
    return {
        "payment_id": p["payment_id"],
        "amount": p["amount"],
        "method": p["method"],
        "payment_date": p["payment_date"],
        "customer_name": p.get("customer_name"),
        "customer_id": p.get("customer_id"),
        "document_serial_number": p.get("document_serial_number"),
        "notes": p.get("notes"),
    }


def query_payments(store, *, customer_id: Optional[str] = None,
                   start_date=None, end_date=None) -> list:
    """Filtered payments for /v2/payment/list (pagination is the caller's job)."""
    payments = list(store.payments.values())
    if customer_id:
        payments = [p for p in payments if p.get("customer_id") == customer_id]
    return filter_by_date_range(payments, start_date, end_date, "payment_date")


# --------------------------------------------------------------------------- #
# Customers / Vendors CRUD (all store access goes through here, not the routers)
# --------------------------------------------------------------------------- #
def _party_record(data: dict, id_key: str) -> dict:
    pid = data[id_key]
    return {
        id_key: pid,
        "name": data["name"],
        "phone": data.get("phone"),
        "email": data.get("email"),
        "gstin": data.get("gstin"),
        "company_name": data.get("company_name"),
        "billing_address": data.get("billing_address") or [],
        "shipping_address": data.get("shipping_address") or [],
        "balance": data.get("opening_balance", 0.0),
    }


def list_customers(store, *, search: Optional[str] = None,
                   customer_id: Optional[str] = None) -> list:
    records = list(store.customers.values())
    if customer_id:
        records = [c for c in records if c["customer_id"] == customer_id]
    if search:
        s = search.lower()
        records = [c for c in records if s in (c["name"] or "").lower()
                   or s in (c.get("company_name") or "").lower()]
    return records


def get_customer(store, customer_id: str) -> dict:
    cust = store.customers.get(customer_id)
    if not cust:
        raise SwipeError("CUSTOMER_NOT_FOUND", f"Customer {customer_id} not found.", 404)
    return cust


def add_customer(store, data: dict) -> dict:
    cid = data["customer_id"]
    if cid in store.customers:
        raise SwipeError("BAD_REQUEST", f"Customer {cid} already exists.")
    store.customers[cid] = _party_record(data, "customer_id")
    return {"customer_id": cid}


def update_customer(store, data: dict) -> dict:
    cid = data["customer_id"]
    existing = get_customer(store, cid)
    existing.update(
        {
            "name": data["name"],
            "phone": data.get("phone"),
            "email": data.get("email"),
            "gstin": data.get("gstin"),
            "company_name": data.get("company_name"),
        }
    )
    if data.get("billing_address"):
        existing["billing_address"] = data["billing_address"]
    if data.get("shipping_address"):
        existing["shipping_address"] = data["shipping_address"]
    return {"customer_id": cid}


def delete_customer(store, customer_id: str) -> dict:
    get_customer(store, customer_id)
    del store.customers[customer_id]
    return {"customer_id": customer_id}


def list_vendors(store, *, search: Optional[str] = None) -> list:
    records = list(store.vendors.values())
    if search:
        s = search.lower()
        records = [v for v in records if s in (v["name"] or "").lower()]
    return records


def get_vendor(store, vendor_id: str) -> dict:
    vendor = store.vendors.get(vendor_id)
    if not vendor:
        raise SwipeError("BAD_REQUEST", f"Vendor {vendor_id} not found.", 404)
    return vendor


def add_vendor(store, data: dict) -> dict:
    vid = data["vendor_id"]
    if vid in store.vendors:
        raise SwipeError("BAD_REQUEST", f"Vendor {vid} already exists.")
    store.vendors[vid] = _party_record(data, "vendor_id")
    return {"vendor_id": vid}


def delete_vendor(store, vendor_id: str) -> dict:
    get_vendor(store, vendor_id)
    del store.vendors[vendor_id]
    return {"vendor_id": vendor_id}


# --------------------------------------------------------------------------- #
# Products / Inventory CRUD
# --------------------------------------------------------------------------- #
def product_record(p: dict) -> dict:
    """ItemListRecord shape returned by the product read endpoints."""
    return {
        "item_id": p["item_id"],
        "name": p["name"],
        "selling_price": p["selling_price"],
        "purchase_price": p.get("purchase_price", 0),
        "tax_rate": p.get("tax_rate", 0),
        "cess_rate": p.get("cess_rate", 0),
        "unit": p.get("unit"),
        "hsn_code": p.get("hsn_code"),
        "item_type": p.get("item_type", "Product"),
        "stock": p.get("stock", 0),
    }


def list_products(store, *, search: Optional[str] = None) -> list:
    records = [product_record(p) for p in store.products.values()]
    if search:
        s = search.lower()
        records = [r for r in records if s in (r["name"] or "").lower()]
    return records


def get_product(store, item_id: str) -> dict:
    p = store.products.get(item_id)
    if not p:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {item_id} not found.", 404)
    return product_record(p)


def add_product(store, data: dict) -> dict:
    iid = data["item_id"]
    if iid in store.products:
        raise SwipeError("PRODUCT_ALREADY_EXISTS", f"Item {iid} already exists.")
    store.products[iid] = {
        "item_id": iid,
        "name": data["name"],
        "selling_price": data["selling_price"],
        "purchase_price": data.get("purchase_price", 0.0),
        "tax_rate": data.get("tax_rate", 0.0),
        "cess_rate": data.get("cess_rate", 0.0),
        "unit": data.get("unit"),
        "hsn_code": data.get("hsn_code"),
        "item_type": data.get("item_type", "Product"),
        "stock": data.get("opening_stock", 0.0),
    }
    return {"item_id": iid}


def update_product(store, data: dict) -> dict:
    iid = data["item_id"]
    existing = store.products.get(iid)
    if not existing:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {iid} not found.", 404)
    existing.update(
        {
            "name": data["name"],
            "selling_price": data["selling_price"],
            "purchase_price": data.get("purchase_price", 0.0),
            "tax_rate": data.get("tax_rate", 0.0),
            "cess_rate": data.get("cess_rate", 0.0),
            "unit": data.get("unit"),
            "hsn_code": data.get("hsn_code"),
            "item_type": data.get("item_type", "Product"),
        }
    )
    return {"item_id": iid}


def delete_product(store, item_id: str) -> dict:
    if item_id not in store.products:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {item_id} not found.", 404)
    del store.products[item_id]
    return {"item_id": item_id}


def adjust_stock(store, *, item_id: str, quantity: float, type: str = "in") -> dict:
    product = store.products.get(item_id)
    if not product:
        raise SwipeError("ITEM_NOT_FOUND", f"Item {item_id} not found.", 404)
    delta = quantity if type == "in" else -quantity
    new_stock = product.get("stock", 0) + delta
    if new_stock < 0:
        raise SwipeError("INSUFFICIENT_STOCK", "Stock cannot go below zero.")
    product["stock"] = new_stock
    return {"item_id": item_id, "stock": new_stock}


def list_warehouses(store) -> list:
    return store.warehouses


def list_subscriptions(store) -> list:
    return list(store.subscriptions.values())


def get_subscription(store, subscription_hash_id: str) -> dict:
    sub = store.subscriptions.get(subscription_hash_id)
    if not sub:
        raise SwipeError("SUBSCRIPTION_DETAILS_NOT_FOUND", "Subscription not found.", 404)
    return sub


# --------------------------------------------------------------------------- #
# Ledger & GSTIN
# --------------------------------------------------------------------------- #
def build_ledger(store, party_id: str) -> dict:
    """A simple running-balance ledger for a customer/vendor."""
    txns = []
    balance = 0.0
    docs = sorted(
        (d for d in store.documents.values() if d["party"]["id"] == party_id),
        key=lambda d: d["document_date"],
    )
    for d in docs:
        balance += d["total_amount"]
        txns.append(
            {
                "date": d["document_date"],
                "particulars": d["serial_number"],
                "type": d["document_type"],
                "debit": d["total_amount"],
                "credit": 0.0,
                "balance": gst.money(balance),
            }
        )
        if d["amount_paid"]:
            balance -= d["amount_paid"]
            txns.append(
                {
                    "date": d["document_date"],
                    "particulars": f"Payment for {d['serial_number']}",
                    "type": "payment",
                    "debit": 0.0,
                    "credit": d["amount_paid"],
                    "balance": gst.money(balance),
                }
            )
    return {"opening_balance": 0.0, "closing_balance": gst.money(balance), "transactions": txns}


def lookup_gstin(store, gstin: str) -> dict:
    if gstin in store.gstins:
        return store.gstins[gstin]
    # Synthesize a plausible response for unknown (well-formed) GSTINs.
    if len(gstin) != 15:
        raise SwipeError("BAD_REQUEST", "GSTIN must be 15 characters.")
    return {
        "gstin": gstin,
        "legal_name": "MOCK ENTERPRISES PRIVATE LIMITED",
        "trade_name": "Mock Enterprises",
        "address": "Hyderabad, Telangana",
        "state": "TELANGANA",
        "pincode": "500032",
        "status": "Active",
        "registration_date": "01-07-2017",
        "taxpayer_type": "Regular",
    }
