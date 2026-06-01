"""Unit tests for the GST engine, anchored to the spec's worked examples."""
import pytest

from mock_backend import gst
from mock_backend.errors import SwipeError


def test_spec_advanced_example():
    # spec/partner.yaml L370: qty 10 x 100, 10% discount, tax 18 + cess 10.
    r = gst.compute_line_item(
        quantity=10, unit_price=100, tax_rate=18, cess_rate=10, discount_percent=10
    )
    assert r["net_amount"] == 900.0
    assert r["tax_amount"] == 252.0
    assert r["total_amount"] == 1152.0
    assert r["price_with_tax"] == 128.0


def test_spec_einvoice_example_with_flat_discount():
    # spec/partner.yaml L490: qty 1 x 100, flat discount 10, tax 18.
    r = gst.compute_line_item(
        quantity=1, unit_price=100, tax_rate=18, discount_amount=10
    )
    assert r["net_amount"] == 90.0
    assert r["tax_amount"] == 16.2
    assert r["total_amount"] == 106.2
    assert r["discount_percent"] == 10.0  # reverse-calculated from the amount


def test_no_discount_no_tax():
    r = gst.compute_line_item(quantity=2, unit_price=50, tax_rate=0)
    assert r["net_amount"] == 100.0
    assert r["tax_amount"] == 0.0
    assert r["total_amount"] == 100.0


def test_invalid_tax_rate_rejected():
    with pytest.raises(SwipeError) as exc:
        gst.compute_line_item(quantity=1, unit_price=100, tax_rate=17)
    assert exc.value.error_code == "INVALID_TAX_RATE"


def test_split_gst_intra_vs_inter_state():
    assert gst.split_gst(252.0, intra_state=True) == {"cgst": 126.0, "sgst": 126.0, "igst": 0.0}
    assert gst.split_gst(252.0, intra_state=False) == {"cgst": 0.0, "sgst": 0.0, "igst": 252.0}


def test_document_totals_with_round_off():
    items = [gst.compute_line_item(quantity=3, unit_price=33.33, tax_rate=18)]
    totals = gst.compute_document_totals(items, round_off=True, intra_state=True)
    # Total should be a whole number when round_off is on.
    assert totals["total_amount"] == round(totals["total_amount"])
    assert totals["tax_breakup"]["cgst"] + totals["tax_breakup"]["sgst"] == totals["tax_amount"]


def test_document_extra_discount_does_not_change_tax():
    items = [gst.compute_line_item(quantity=1, unit_price=1000, tax_rate=18)]
    base = gst.compute_document_totals(items)
    discounted = gst.compute_document_totals(items, extra_discount=100)
    assert discounted["tax_amount"] == base["tax_amount"]
    assert discounted["total_amount"] == gst.money(base["total_amount"] - 100)


def test_discount_cannot_exceed_line_value():
    # discount_amount larger than gross must clamp, not produce negative net.
    r = gst.compute_line_item(quantity=1, unit_price=100, tax_rate=18, discount_amount=150)
    assert r["net_amount"] == 0.0
    assert r["total_amount"] == 0.0
    assert r["discount_amount"] == 100.0
    assert r["discount_percent"] == 100.0


def test_discount_percent_over_100_clamps():
    r = gst.compute_line_item(quantity=2, unit_price=50, tax_rate=0, discount_percent=150)
    assert r["net_amount"] == 0.0
    assert r["discount_percent"] == 100.0


def test_invalid_cess_rate_rejected():
    with pytest.raises(SwipeError) as exc:
        gst.compute_line_item(quantity=1, unit_price=100, tax_rate=18, cess_rate=150)
    assert exc.value.error_code == "INVALID_TAX_RATE"
