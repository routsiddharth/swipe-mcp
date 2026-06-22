"""Normalize Swipe records and build GST-complete invoice requests."""
from __future__ import annotations

import hashlib
import re
from datetime import date, timedelta
from typing import Any

from swipe_core.gst import compute_document_totals, compute_line_item

from .config import normalize_state
from .models import InvoiceItem, PaymentMethod

GST_STATE_CODES = {
    "01": "JAMMU AND KASHMIR", "02": "HIMACHAL PRADESH", "03": "PUNJAB",
    "04": "CHANDIGARH", "05": "UTTARAKHAND", "06": "HARYANA", "07": "DELHI",
    "08": "RAJASTHAN", "09": "UTTAR PRADESH", "10": "BIHAR", "11": "SIKKIM",
    "12": "ARUNACHAL PRADESH", "13": "NAGALAND", "14": "MANIPUR", "15": "MIZORAM",
    "16": "TRIPURA", "17": "MEGHALAYA", "18": "ASSAM", "19": "WEST BENGAL",
    "20": "JHARKHAND", "21": "ODISHA", "22": "CHHATTISGARH", "23": "MADHYA PRADESH",
    "24": "GUJARAT", "26": "DADRA AND NAGAR HAVELI AND DAMAN AND DIU",
    "27": "MAHARASHTRA", "29": "KARNATAKA", "30": "GOA", "31": "LAKSHADWEEP",
    "32": "KERALA", "33": "TAMIL NADU", "34": "PUDUCHERRY",
    "35": "ANDAMAN AND NICOBAR ISLANDS", "36": "TELANGANA",
    "37": "ANDHRA PRADESH", "38": "LADAKH",
}


def normalize_customer(raw: dict) -> dict:
    billing = _first_address(raw.get("billing_address"))
    shipping = _first_address(raw.get("shipping_address"))
    gstin = str(raw.get("gstin") or "").upper()
    state = normalize_state(
        (billing or {}).get("state")
        or (shipping or {}).get("state")
        or GST_STATE_CODES.get(gstin[:2], "")
    )
    return {
        "id": raw.get("customer_id") if raw.get("customer_id") is not None else raw.get("id"),
        "name": str(raw.get("name") or "").strip(),
        "company_name": str(raw.get("company_name") or "").strip(),
        "phone": raw.get("phone") or raw.get("phone_number"),
        "email": raw.get("email"),
        "gstin": gstin,
        "state": state,
        "billing_address": billing,
        "shipping_address": shipping,
        "raw": raw,
    }


def normalize_product(raw: dict) -> dict:
    return {
        "id": raw.get("item_id") if raw.get("item_id") is not None else raw.get("id"),
        "name": raw.get("name"),
        "unit_price": (
            raw.get("selling_price")
            if raw.get("selling_price") is not None
            else raw.get("unit_price")
        ),
        "tax_rate": raw.get("tax_rate", 0),
        "cess_rate": raw.get("cess_rate", 0),
        "unit": raw.get("unit"),
        "hsn_code": raw.get("hsn_code"),
        "item_type": raw.get("item_type", "Product"),
    }


def build_invoice(
    *,
    customer: dict,
    customer_detail: dict,
    items: list[InvoiceItem],
    company_state: str,
    due_days: int,
    serial_number: str | None = None,
    live: bool,
) -> tuple[dict, dict]:
    base_customer = customer
    detail_customer = normalize_customer(customer_detail or customer.get("raw", {}))
    customer = {
        **base_customer,
        **{
            key: value
            for key, value in detail_customer.items()
            if value not in (None, "", [])
        },
    }
    customer["id"] = detail_customer.get("id") or base_customer.get("id")
    customer["name"] = detail_customer.get("name") or base_customer.get("name")
    party_state = customer.get("state") or GST_STATE_CODES.get(
        str(customer.get("gstin") or "")[:2], ""
    )
    party_state = normalize_state(party_state)
    if not party_state:
        raise ValueError(
            "The customer's state could not be determined. Add a billing address "
            "or GSTIN in Swipe before creating this invoice."
        )

    company_state = normalize_state(company_state)
    intra_state = party_state == company_state
    computed_items: list[dict] = []
    api_items: list[dict] = []

    for item in items:
        values = item.model_dump()
        computed = compute_line_item(
            quantity=item.quantity,
            unit_price=item.unit_price,
            tax_rate=item.tax_rate,
            cess_rate=item.cess_rate,
            discount_percent=item.discount_percent,
        )
        item_id = item.item_id or stable_item_id(item.name, item.item_type)
        api_item = {
            "id": item_id,
            "name": item.name.strip(),
            "item_type": item.item_type,
            "quantity": item.quantity,
            "unit_price": item.unit_price,
            "tax_rate": item.tax_rate,
            "cess_rate": item.cess_rate,
            "discount_percent": item.discount_percent,
            **computed,
        }
        for key in ("unit", "hsn_code", "description"):
            if values.get(key):
                api_item[key] = values[key]
        api_items.append(api_item)
        computed_items.append(api_item)

    totals = compute_document_totals(computed_items, intra_state=intra_state)
    today = date.today()
    party = {
        "id": str(customer["id"]),
        "type": "customer",
        "name": customer["name"],
    }
    optional_party = {
        "gstin": customer.get("gstin"),
        "company_name": customer.get("company_name"),
        "phone_number": customer.get("phone"),
        "email": customer.get("email"),
    }
    party.update({key: value for key, value in optional_party.items() if value})

    billing = customer.get("billing_address")
    shipping = customer.get("shipping_address") or billing
    party["billing_address"] = _api_address(
        billing, customer_id=str(customer["id"]), kind="b", fallback_state=party_state, live=live
    )
    party["shipping_address"] = _api_address(
        shipping, customer_id=str(customer["id"]), kind="s", fallback_state=party_state, live=live
    )

    body = {
        "document_type": "invoice",
        "document_date": today.strftime("%d-%m-%Y"),
        "due_date": (today + timedelta(days=due_days)).strftime("%d-%m-%Y"),
        "party": party,
        "items": api_items,
    }
    if serial_number:
        if live:
            body["serial_number_v2"] = serial_number_v2(serial_number)
        else:
            body["serial_number"] = serial_number

    preview = {
        "customer": {"id": customer["id"], "name": customer["name"], "state": party_state},
        "company_state": company_state,
        "tax_mode": "CGST+SGST" if intra_state else "IGST",
        "items": api_items,
        "totals": totals,
        "due_date": body["due_date"],
    }
    return body, preview


def build_payment(
    *,
    document: dict,
    amount: float,
    method: PaymentMethod,
    bank_details: dict | None = None,
    marker: str | None = None,
    live: bool,
) -> dict:
    """Build the Swipe wire body for recording a payment against a document.

    Mirrors build_invoice: the live and mock APIs want different shapes, and that
    request-wire divergence lives here, not in the service. Raises ValueError if
    a live payment cannot find the customer id (the service maps it to a friendly
    error, exactly as it does for build_invoice).
    """
    if live:
        customer = document.get("customer") or document.get("party") or {}
        customer_id = customer.get("id") or customer.get("customer_id")
        if not customer_id:
            raise ValueError("The invoice does not contain a customer ID.")
        body: dict[str, Any] = {
            "amount": amount,
            "customer": customer_id,
            "payment_date": date.today().strftime("%d-%m-%Y"),
            "payment_mode": live_payment_method(method),
            "documents": [{"hash_id": document["hash_id"], "amount_paying": amount}],
        }
        if bank_details:
            body["bank_details"] = bank_details
        if marker:
            body["exclusive_notes"] = marker
        return body

    body = {
        "doc_hash_id": document["hash_id"],
        "amount": amount,
        "method": mock_payment_method(method),
    }
    if marker:
        body["notes"] = marker
    return body


def live_payment_method(method: PaymentMethod) -> str:
    return {
        "cash": "Cash",
        "upi": "UPI",
        "card": "Card",
        "cheque": "Cheque",
        "net_banking": "Net Banking",
        "emi": "EMI",
    }[method]


def mock_payment_method(method: PaymentMethod) -> str:
    return "netBanking" if method == "net_banking" else method


def stable_item_id(name: str, item_type: str) -> str:
    slug = re.sub(r"[^A-Z0-9]+", "-", name.upper()).strip("-")[:24] or "ITEM"
    digest = hashlib.sha256(f"{item_type}:{name}".encode()).hexdigest()[:8].upper()
    return f"MCP-{slug}-{digest}"


def serial_number_v2(serial_number: str) -> dict:
    """Convert a human serial into Swipe's required v2 serial structure."""
    match = re.fullmatch(r"(.*?)(\d+)(\D*)", serial_number.strip())
    if not match:
        raise ValueError(
            "Live serial numbers must contain a numeric document number, "
            "for example MCP-12345."
        )
    prefix, number, suffix = match.groups()
    return {"prefix": prefix, "doc_number": int(number), "suffix": suffix}


def _first_address(value: Any) -> dict | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return None


def _api_address(
    address: dict | None,
    *,
    customer_id: str,
    kind: str,
    fallback_state: str,
    live: bool,
) -> dict:
    address = address or {}
    result = {
        "address_line1": address.get("address_line1") or ("NA" if live else ""),
        "address_line2": address.get("address_line2") or "",
        "city": address.get("city") or ("NA" if live else ""),
        "state": normalize_state(address.get("state")) or fallback_state,
        "country": address.get("country") or "India",
        "pincode": str(address.get("pincode") or ("000000" if live else "")),
    }
    if live:
        result["addr_id_v2"] = address.get("addr_id_v2") or f"{kind}{customer_id}"
    return result
