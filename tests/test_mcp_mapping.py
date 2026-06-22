from swipe_mcp.mapping import build_invoice, serial_number_v2
from swipe_mcp.models import InvoiceItem


CUSTOMER = {
    "customer_id": "CUST001",
    "name": "Acme Industries",
    "gstin": "36AAACA1111A1Z1",
    "billing_address": [
        {
            "addr_id_v2": "bCUST001",
            "address_line1": "Acme HQ",
            "address_line2": "",
            "city": "Hyderabad",
            "state": "36-TELANGANA",
            "country": "India",
            "pincode": "500032",
        }
    ],
}


def test_live_invoice_mapping_uses_v2_serial_and_computed_gst():
    body, preview = build_invoice(
        customer={
            "id": "CUST001",
            "name": "Acme Industries",
            "raw": CUSTOMER,
        },
        customer_detail=CUSTOMER,
        items=[
            InvoiceItem(
                item_id="ITEM005",
                name="Consulting",
                quantity=2,
                unit_price=1000,
                tax_rate=18,
                item_type="Service",
            )
        ],
        company_state="TELANGANA",
        due_days=15,
        serial_number="MCP-123456789",
        live=True,
    )

    assert "serial_number" not in body
    assert body["serial_number_v2"] == {
        "prefix": "MCP-",
        "doc_number": 123456789,
        "suffix": "",
    }
    assert body["items"][0]["net_amount"] == 2000
    assert body["items"][0]["tax_amount"] == 360
    assert body["items"][0]["total_amount"] == 2360
    assert preview["tax_mode"] == "CGST+SGST"
    assert preview["totals"]["tax_breakup"] == {
        "cgst": 180,
        "sgst": 180,
        "igst": 0,
    }


def test_live_serial_requires_numeric_document_number():
    try:
        serial_number_v2("NO-DIGITS")
    except ValueError as exc:
        assert "numeric document number" in str(exc)
    else:
        raise AssertionError("expected ValueError")
