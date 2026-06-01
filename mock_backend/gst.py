"""GST line-item and document math — the core value of the wrapper.

The real Swipe API computes and validates these amounts server-side. We
replicate that here so the mock behaves like production and so the calculation
can be unit-tested in isolation (tests/test_gst.py), without any API access.

Rules verified against the worked examples in spec/partner.yaml:
  discount       = discount_amount, OR (quantity * unit_price) * discount_percent/100
  net_amount     = quantity * unit_price - discount
  tax_amount     = net_amount * (tax_rate + cess_rate) / 100     # tax on POST-discount net
  total_amount   = net_amount + tax_amount
  price_with_tax = unit_price * (1 + (tax_rate + cess_rate)/100) # per unit, tax-inclusive

Spec example (L370): qty 10 x 100, 10% disc, tax 18 + cess 10 -> net 900,
tax 252, total 1152, price_with_tax 128.  (See tests.)
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from .errors import SwipeError

# GST slabs Swipe accepts (percent). Anything else -> INVALID_TAX_RATE.
VALID_TAX_RATES = {0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28}


def money(value: float) -> float:
    """Round to 2 decimal places, half-up (currency rounding)."""
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def validate_tax_rate(tax_rate: float) -> None:
    if tax_rate not in VALID_TAX_RATES:
        raise SwipeError(
            "INVALID_TAX_RATE",
            f"Tax rate {tax_rate} is not a valid GST rate. "
            f"Allowed: {sorted(VALID_TAX_RATES)}.",
        )


def compute_line_item(
    *,
    quantity: float,
    unit_price: float,
    tax_rate: float = 0.0,
    cess_rate: float = 0.0,
    discount_percent: Optional[float] = None,
    discount_amount: Optional[float] = None,
) -> dict:
    """Return the full set of derived amounts for one line item."""
    validate_tax_rate(tax_rate)
    if not 0 <= cess_rate <= 100:
        raise SwipeError("INVALID_TAX_RATE", f"Cess rate {cess_rate} must be between 0 and 100.")
    rate = tax_rate + cess_rate
    gross = quantity * unit_price

    # discount_percent wins if provided; otherwise use the flat discount_amount.
    if discount_percent:
        discount = gross * discount_percent / 100
    elif discount_amount:
        discount = float(discount_amount)
    else:
        discount = 0.0
    # A discount can never exceed the line value or be negative.
    discount = max(0.0, min(discount, gross))
    # Report the effective percent (spec reverse-calculates it from the amount).
    disc_pct = (discount / gross * 100) if gross else 0.0

    net = gross - discount
    tax = net * rate / 100
    total = net + tax
    price_with_tax = unit_price * (1 + rate / 100)

    return {
        "net_amount": money(net),
        "tax_amount": money(tax),
        "total_amount": money(total),
        "price_with_tax": money(price_with_tax),
        "discount_amount": money(discount),
        "discount_percent": round(disc_pct, 4),
    }


def split_gst(tax_amount: float, intra_state: bool) -> dict:
    """Split total tax into CGST/SGST (intra-state) or IGST (inter-state)."""
    if intra_state:
        cgst = money(tax_amount / 2)
        return {"cgst": cgst, "sgst": money(tax_amount - cgst), "igst": 0.0}
    return {"cgst": 0.0, "sgst": 0.0, "igst": money(tax_amount)}


def compute_document_totals(
    computed_items: list[dict],
    *,
    extra_discount: float = 0.0,
    charges_and_deductions: Optional[list[dict]] = None,
    round_off: bool = False,
    intra_state: bool = True,
) -> dict:
    """Roll line items up into document totals.

    `extra_discount` is a flat doc-level adjustment that reduces the payable
    total but does NOT change tax (per the spec). Charges/deductions add or
    subtract an amount plus their own tax.
    """
    net = sum(i["net_amount"] for i in computed_items)
    tax = sum(i["tax_amount"] for i in computed_items)
    total_discount = sum(i["discount_amount"] for i in computed_items)

    charge_total = 0.0
    charge_tax = 0.0
    for c in charges_and_deductions or []:
        sign = 1 if c.get("type", "charge") == "charge" else -1
        amount = float(c.get("amount", 0))
        charge_total += sign * amount
        charge_tax += sign * (amount * float(c.get("tax_rate", 0)) / 100)

    tax_total = tax + charge_tax
    pre_round = net + tax_total + charge_total - extra_discount

    if round_off:
        rounded = round(pre_round)
        round_off_value = money(rounded - pre_round)
        total = float(rounded)
    else:
        round_off_value = 0.0
        total = money(pre_round)

    return {
        "net_amount": money(net),
        "tax_amount": money(tax_total),
        "total_discount": money(total_discount),
        "extra_discount": money(extra_discount),
        "charges_total": money(charge_total),
        "round_off": round_off_value,
        "total_amount": total,
        "tax_breakup": split_gst(money(tax_total), intra_state),
    }
