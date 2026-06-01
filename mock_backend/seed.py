"""Seed data: enough breadth to exercise every endpoint and most filters.

Covers multiple customers/vendors/products, documents across types and payment
statuses (paid / pending / cancelled), intra- and inter-state GST, an export
invoice, an e-invoice, charges, and a subscription.
"""
from __future__ import annotations

from . import service


def _addr(line1, city, state, pincode):
    return {
        "address_line1": line1,
        "address_line2": "",
        "city": city,
        "state": state,
        "country": "India",
        "pincode": pincode,
    }


def populate(store) -> None:
    # The mock business (seller). State drives intra/inter-state GST.
    store.company = {
        "name": "Demo Traders Pvt Ltd",
        "gstin": "36AABCD1234E1Z5",
        "state": "TELANGANA",
        "address": _addr("Plot 12, HITEC City", "Hyderabad", "TELANGANA", "500081"),
    }

    # ---- Customers -------------------------------------------------------- #
    customers = [
        ("CUST001", "Acme Industries", "Acme Industries Pvt Ltd", "36AAACA1111A1Z1",
         "9000000001", "ops@acme.example", "TELANGANA", "Hyderabad", "500032", 0.0),
        ("CUST002", "Globex Corporation", "Globex Corp", "29AAACG2222B1Z2",
         "9000000002", "accounts@globex.example", "KARNATAKA", "Bengaluru", "560001", 5000.0),
        ("CUST003", "Initech Solutions", "Initech LLP", "27AAACI3333C1Z3",
         "9000000003", "billing@initech.example", "MAHARASHTRA", "Mumbai", "400001", 0.0),
        ("CUST004", "Umbrella Retail", "", "",
         "9000000004", "hello@umbrella.example", "TELANGANA", "Hyderabad", "500001", 1200.0),
        ("CUST005", "Wayne Exports", "Wayne Exports Ltd", "07AAACW5555E1Z5",
         "9000000005", "trade@wayne.example", "DELHI", "New Delhi", "110001", 0.0),
    ]
    for cid, name, company, gstin, phone, email, state, city, pin, bal in customers:
        store.customers[cid] = {
            "customer_id": cid,
            "name": name,
            "phone": phone,
            "email": email,
            "gstin": gstin,
            "company_name": company,
            "billing_address": [_addr(f"{name} HQ", city, state, pin)],
            "shipping_address": [_addr(f"{name} Warehouse", city, state, pin)],
            "balance": bal,
        }

    # ---- Vendors ---------------------------------------------------------- #
    vendors = [
        ("VEND001", "Raw Materials Co", "33AAACR6666F1Z6", "8000000001", "TAMIL NADU", "Chennai", "600001"),
        ("VEND002", "Packaging Supplies Ltd", "36AAACP7777G1Z7", "8000000002", "TELANGANA", "Hyderabad", "500004"),
        ("VEND003", "Logistics Partners", "24AAACL8888H1Z8", "8000000003", "GUJARAT", "Ahmedabad", "380001"),
    ]
    for vid, name, gstin, phone, state, city, pin in vendors:
        store.vendors[vid] = {
            "vendor_id": vid,
            "name": name,
            "phone": phone,
            "email": None,
            "gstin": gstin,
            "company_name": name,
            "billing_address": [_addr(f"{name} Office", city, state, pin)],
            "shipping_address": [],
            "balance": 0.0,
        }

    # ---- Products --------------------------------------------------------- #
    products = [
        ("ITEM001", "Steel Bolt M8", 12.0, 8.0, 18, 0, "Product", "PCS", "73181500", 5000),
        ("ITEM002", "Aluminium Sheet 2mm", 450.0, 320.0, 18, 0, "Product", "SQM", "76069100", 800),
        ("ITEM003", "Industrial Lubricant 5L", 1200.0, 900.0, 28, 12, "Product", "BTL", "27101980", 150),
        ("ITEM004", "Safety Gloves", 80.0, 45.0, 5, 0, "Product", "PAR", "61169300", 2000),
        ("ITEM005", "Consulting (per hour)", 2500.0, 0.0, 18, 0, "Service", "OTH", "998311", 0),
        ("ITEM006", "Annual Maintenance Contract", 50000.0, 0.0, 18, 0, "Service", "OTH", "998719", 0),
        ("ITEM007", "Packaging Box (large)", 35.0, 22.0, 12, 0, "Product", "PCS", "48191000", 10000),
        ("ITEM008", "Organic Rice 25kg", 1500.0, 1200.0, 0, 0, "Product", "BAG", "10063020", 400),
    ]
    for iid, name, sp, pp, tax, cess, itype, unit, hsn, stock in products:
        store.products[iid] = {
            "item_id": iid,
            "name": name,
            "selling_price": sp,
            "purchase_price": pp,
            "tax_rate": tax,
            "cess_rate": cess,
            "unit": unit,
            "hsn_code": hsn,
            "item_type": itype,
            "stock": stock,
        }

    # ---- Known GSTINs (for the lookup endpoint) --------------------------- #
    store.gstins["36AABCD1234E1Z5"] = {
        "gstin": "36AABCD1234E1Z5", "legal_name": "DEMO TRADERS PRIVATE LIMITED",
        "trade_name": "Demo Traders", "address": "HITEC City, Hyderabad, Telangana",
        "state": "TELANGANA", "pincode": "500081", "status": "Active",
        "registration_date": "01-07-2017", "taxpayer_type": "Regular",
    }
    store.gstins["29AAACG2222B1Z2"] = {
        "gstin": "29AAACG2222B1Z2", "legal_name": "GLOBEX CORPORATION",
        "trade_name": "Globex", "address": "MG Road, Bengaluru, Karnataka",
        "state": "KARNATAKA", "pincode": "560001", "status": "Active",
        "registration_date": "12-09-2018", "taxpayer_type": "Regular",
    }

    # ---- Warehouses ------------------------------------------------------- #
    store.warehouses = [
        {"warehouse_id": 1, "name": "Main Warehouse", "city": "Hyderabad", "state": "TELANGANA"},
        {"warehouse_id": 2, "name": "Bengaluru Hub", "city": "Bengaluru", "state": "KARNATAKA"},
    ]

    # ---- Documents -------------------------------------------------------- #
    _seed_documents(store)

    # ---- Subscriptions ---------------------------------------------------- #
    store.subscriptions["SUBINV001"] = {
        "subscription_hash_id": "SUBINV001",
        "customer": {"id": "CUST002", "name": "Globex Corporation"},
        "repeat": 1,
        "repeat_type": "months",
        "start_time": "01-01-2024",
        "end_time": "31-12-2024",
        "status": "active",
        "amount": 59000.0,
    }


def _party_from_customer(store, cid):
    c = store.customers[cid]
    addr = c["billing_address"][0] if c["billing_address"] else None
    return {
        "id": cid, "type": "customer", "name": c["name"],
        "company_name": c["company_name"], "gstin": c["gstin"],
        "phone_number": c["phone"], "email": c["email"],
        "billing_address": addr, "shipping_address": addr,
    }


def _party_from_vendor(store, vid):
    v = store.vendors[vid]
    addr = v["billing_address"][0] if v["billing_address"] else None
    return {
        "id": vid, "type": "vendor", "name": v["name"],
        "company_name": v["company_name"], "gstin": v["gstin"],
        "phone_number": v["phone"], "billing_address": addr, "shipping_address": addr,
    }


def _item(store, iid, quantity, discount_percent=None):
    p = store.products[iid]
    return {
        "id": iid, "name": p["name"], "item_type": p["item_type"],
        "quantity": quantity, "unit_price": p["selling_price"],
        "tax_rate": p["tax_rate"], "cess_rate": p.get("cess_rate", 0),
        "hsn_code": p["hsn_code"], "unit": p["unit"],
        "discount_percent": discount_percent,
    }


def _seed_documents(store) -> None:
    # 1. Intra-state invoice, fully paid.
    service.build_document(store, {
        "document_type": "invoice", "document_date": "05-01-2024", "due_date": "20-01-2024",
        "party": _party_from_customer(store, "CUST001"),
        "items": [_item(store, "ITEM001", 100), _item(store, "ITEM004", 50)],
        "payments": [{"amount": 5616.0, "method": "upi"}],
    })
    # 2. Inter-state invoice (Karnataka), partially -> pending.
    service.build_document(store, {
        "document_type": "invoice", "document_date": "10-02-2024", "due_date": "25-02-2024",
        "party": _party_from_customer(store, "CUST002"),
        "items": [_item(store, "ITEM006", 1)],
        "payments": [{"amount": 20000.0, "method": "netBanking"}],
    })
    # 3. Inter-state invoice (Maharashtra), unpaid, with a discount + charge.
    service.build_document(store, {
        "document_type": "invoice", "document_date": "01-03-2024", "due_date": "16-03-2024",
        "party": _party_from_customer(store, "CUST003"),
        "items": [_item(store, "ITEM002", 10, discount_percent=10), _item(store, "ITEM003", 5)],
        "charges_and_deductions": [
            {"id": 1, "name": "Freight", "amount": 1000, "tax_rate": 18, "type": "charge"}
        ],
        "round_off": True,
    })
    # 4. Estimate (intra-state).
    service.build_document(store, {
        "document_type": "estimate", "document_date": "12-03-2024",
        "party": _party_from_customer(store, "CUST004"),
        "items": [_item(store, "ITEM007", 500), _item(store, "ITEM008", 20)],
    })
    # 5. Cancelled invoice.
    cancelled = service.build_document(store, {
        "document_type": "invoice", "document_date": "15-03-2024",
        "party": _party_from_customer(store, "CUST004"),
        "items": [_item(store, "ITEM001", 10)],
    })
    service.cancel_document(store, cancelled["hash_id"])
    # 6. Export invoice with e-invoice (Wayne Exports).
    service.build_document(store, {
        "document_type": "invoice", "document_date": "20-03-2024", "due_date": "20-04-2024",
        "party": _party_from_customer(store, "CUST005"),
        "items": [_item(store, "ITEM006", 2)],
        "einvoice": True, "is_export": True,
    })
    # 7. Purchase from a vendor.
    service.build_document(store, {
        "document_type": "purchase", "document_date": "08-01-2024",
        "party": _party_from_vendor(store, "VEND001"),
        "items": [_item(store, "ITEM002", 50)],
        "payments": [{"amount": 26550.0, "method": "cheque"}],
    })
