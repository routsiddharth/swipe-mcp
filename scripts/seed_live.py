"""Seed a LIVE Swipe account with demo master data + a little history.

Talks **directly** to the real Partner API (server-to-server, so no CORS/proxy
needed). Mirrors the offline mock's seed (mock_backend/seed.py) so the same
customer/product ids the frontend's NLU expects (CUST001, ITEM005, …) exist on
the live account and the golden-path prompts resolve.

Usage:
    python scripts/seed_live.py            # master data (customers/vendors/products)
    python scripts/seed_live.py --docs      # a few sample invoices (assumes master done)
    python scripts/seed_live.py --all       # master data + sample invoices

Reads the key from SWIPE_API_KEY (or the repo-root .env). Idempotent-ish: it
prints each call's result and keeps going on failure, so re-running after a
partial seed is safe. Standard calls only (no e-invoice) to keep credit use low.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx

BASE = os.getenv("SWIPE_LIVE_BASE_URL", "https://app.getswipe.in/api/partner").rstrip("/")


def _load_key() -> str:
    key = os.getenv("SWIPE_API_KEY", "").strip()
    if not key:
        env = Path(__file__).resolve().parent.parent / ".env"
        if env.is_file():
            for line in env.read_text().splitlines():
                if line.strip().startswith("SWIPE_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not key:
        sys.exit("SWIPE_API_KEY not set (env or .env).")
    return key


def _addr(line1, city, state, pincode, addr_id):
    # The live API requires a client-supplied addr_id_v2 (alphanumeric, <=16
    # chars) to create/identify a new address.
    return {
        "addr_id_v2": addr_id,
        "address_line1": line1, "address_line2": "", "city": city,
        "state": state, "country": "India", "pincode": pincode,
    }


# ---- data (mirrors mock_backend/seed.py) ----------------------------------- #
CUSTOMERS = [
    ("CUST001", "Acme Industries", "Acme Industries Pvt Ltd", "36AAACA1111A1Z1",
     "9000000001", "ops@acme.example", "TELANGANA", "Hyderabad", "500032"),
    ("CUST002", "Globex Corporation", "Globex Corp", "29AAACG2222B1Z2",
     "9000000002", "accounts@globex.example", "KARNATAKA", "Bengaluru", "560001"),
    ("CUST003", "Initech Solutions", "Initech LLP", "27AAACI3333C1Z3",
     "9000000003", "billing@initech.example", "MAHARASHTRA", "Mumbai", "400001"),
    ("CUST004", "Umbrella Retail", "", "",
     "9000000004", "hello@umbrella.example", "TELANGANA", "Hyderabad", "500001"),
    ("CUST005", "Wayne Exports", "Wayne Exports Ltd", "07AAACW5555E1Z5",
     "9000000005", "trade@wayne.example", "DELHI", "New Delhi", "110001"),
]

VENDORS = [
    ("VEND001", "Raw Materials Co", "33AAACR6666F1Z6", "8000000001", "TAMIL NADU", "Chennai", "600001"),
    ("VEND002", "Packaging Supplies Ltd", "36AAACP7777G1Z7", "8000000002", "TELANGANA", "Hyderabad", "500004"),
    ("VEND003", "Logistics Partners", "24AAACL8888H1Z8", "8000000003", "GUJARAT", "Ahmedabad", "380001"),
]

# (id, name, selling_price, tax_rate, cess_rate, item_type, unit, hsn)
PRODUCTS = [
    ("ITEM001", "Steel Bolt M8", 12.0, 18, 0, "Product", "PCS", "73181500"),
    ("ITEM002", "Aluminium Sheet 2mm", 450.0, 18, 0, "Product", "SQM", "76069100"),
    ("ITEM003", "Industrial Lubricant 5L", 1200.0, 28, 12, "Product", "BTL", "27101980"),
    ("ITEM004", "Safety Gloves", 80.0, 5, 0, "Product", "PAR", "61169300"),
    ("ITEM005", "Consulting (per hour)", 2500.0, 18, 0, "Service", "OTH", "998311"),
    ("ITEM006", "Annual Maintenance Contract", 50000.0, 18, 0, "Service", "OTH", "998719"),
    ("ITEM007", "Packaging Box (large)", 35.0, 12, 0, "Product", "PCS", "48191000"),
    ("ITEM008", "Organic Rice 25kg", 1500.0, 0, 0, "Product", "BAG", "10063020"),
]


def _result(tag: str, r: httpx.Response) -> dict:
    try:
        body = r.json()
    except Exception:
        body = {"raw": r.text[:200]}
    ok = r.status_code < 400 and body.get("success", True) is not False
    mark = "ok " if ok else "ERR"
    msg = body.get("message") or body.get("error_code") or ""
    print(f"  [{mark}] {tag:<28} HTTP {r.status_code}  {msg}")
    return body


def seed_master(client: httpx.Client) -> None:
    print("Customers:")
    for cid, name, company, gstin, phone, email, state, city, pin in CUSTOMERS:
        body = {
            "customer_id": cid, "name": name, "phone": phone, "email": email,
            "gstin": gstin, "company_name": company,
            "billing_address": [_addr(f"{name} HQ", city, state, pin, f"b{cid}")],
            "shipping_address": [_addr(f"{name} Warehouse", city, state, pin, f"s{cid}")],
        }
        _result(f"{cid} {name}", client.post(f"{BASE}/v2/customer", json=body))

    print("Vendors:")
    for vid, name, gstin, phone, state, city, pin in VENDORS:
        body = {
            "vendor_id": vid, "name": name, "phone": phone, "gstin": gstin,
            "company_name": name,
            # Unlike the customer endpoint, the vendor endpoint wants a single
            # address object here (not a list).
            "billing_address": _addr(f"{name} Office", city, state, pin, f"b{vid}"),
        }
        _result(f"{vid} {name}", client.post(f"{BASE}/v2/vendor", json=body))

    print("Products:")
    for iid, name, sp, tax, cess, itype, unit, hsn in PRODUCTS:
        rate = tax + cess
        body = {
            "id": iid, "name": name, "item_type": itype,
            "quantity": 0, "unit_price": sp,
            "price_with_tax": round(sp * (1 + rate / 100.0), 2),
            "tax_rate": tax, "cess_rate": cess, "unit": unit, "hsn_code": hsn,
        }
        _result(f"{iid} {name}", client.post(f"{BASE}/v2/product", json=body))


# ---- documents (mirror a slice of mock_backend/seed.py) -------------------- #
# (customer_id, [(item_id, qty, discount_percent)], days_due)
DOCS = [
    ("CUST001", [("ITEM001", 100, 0), ("ITEM004", 50, 0)], 15),   # intra-state (Telangana)
    ("CUST002", [("ITEM006", 1, 0)], 15),                          # inter-state (Karnataka)
    ("CUST003", [("ITEM005", 4, 0)], 15),                          # inter-state (Maharashtra)
]
# Note: the live API rejects the discount_percent + cess combination with
# "Error in calculating the document amount" (its own amount check is stricter
# than the spec). The golden-path flows don't use discounts, so seed entries are
# kept discount-free; the offline mock still exercises the discount math.
_PROD = {p[0]: p for p in PRODUCTS}            # id -> tuple
_CUST = {c[0]: c for c in CUSTOMERS}           # id -> tuple


def _money(v: float) -> float:
    return round(v + 1e-9, 2)


def seed_docs(client: httpx.Client) -> None:
    print("Documents:")
    for cid, lines, due_days in DOCS:
        c = _CUST[cid]
        _, name, company, gstin, phone, email, state, city, pin = c
        items = []
        for iid, qty, disc in lines:
            _, pname, sp, tax, cess, itype, unit, hsn = _PROD[iid]
            rate = tax + cess
            gross = qty * sp
            d = gross * disc / 100.0
            net = gross - d
            taxamt = net * rate / 100.0
            items.append({
                "id": iid, "name": pname, "item_type": itype,
                "quantity": qty, "unit_price": sp, "tax_rate": tax, "cess_rate": cess,
                "hsn_code": hsn, "unit": unit, "discount_percent": disc,
                "net_amount": _money(net), "tax_amount": _money(taxamt),
                "total_amount": _money(net + taxamt),
                "price_with_tax": _money(sp * (1 + rate / 100.0)),
            })
        addr = {
            "addr_id_v2": f"d{cid}", "address_line1": f"{name} HQ", "address_line2": "",
            "city": city, "state": state, "country": "India", "pincode": pin,
        }
        body = {
            "document_type": "invoice",
            "document_date": "01-06-2026",
            "party": {
                "id": cid, "type": "customer", "name": name, "gstin": gstin or None,
                "company_name": company or None, "phone_number": phone, "email": email,
                "billing_address": addr, "shipping_address": addr,
            },
            "items": items,
        }
        _result(f"invoice for {name}", client.post(f"{BASE}/v2/doc", json=body))


def main() -> None:
    key = _load_key()
    do_master = "--docs" not in sys.argv
    do_docs = "--docs" in sys.argv or "--all" in sys.argv
    print(f"Seeding LIVE Swipe account at {BASE}\n")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    with httpx.Client(headers=headers, timeout=30.0) as client:
        if do_master:
            seed_master(client)
        if do_docs:
            seed_docs(client)
    print("\nDone.")


if __name__ == "__main__":
    main()
