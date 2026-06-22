"""Pure bank-statement → invoice matching engine.

This module contains no I/O. It scores parsed bank credits against outstanding
invoices and classifies each credit as a confident match, a near-match that
needs review, a split across several invoices, or no match at all (a refund,
salary, or transfer that must be left alone). Keeping it pure makes the matching
logic — the hard part of reconciliation — fully unit-testable offline.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

# Tokens that carry no identifying signal in a bank narration or a company name.
_STOPWORDS = {
    "pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "corp",
    "corporation", "industries", "solutions", "enterprises", "services", "the",
    "and", "neft", "imps", "rtgs", "upi", "cr", "dr", "ref", "payment", "pay",
    "txn", "ach", "from", "to",
}

# Company-suffix noise stripped before comparing a customer name to a narration.
_SUFFIX = re.compile(
    r"\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation)\b\.?", re.I
)

# Outcome labels.
CONFIDENT = "confident"
REVIEW = "review"
SPLIT = "split"
NONE = "none"


@dataclass(frozen=True)
class OutstandingInvoice:
    hash_id: str
    serial_number: str
    customer_name: str
    amount_pending: float
    document_date: str | None = None


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.casefold())


def _tokens(text: str) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9]+", " ", text.casefold()).split() if t]


def _significant(tokens: list[str]) -> list[str]:
    return [t for t in tokens if t not in _STOPWORDS and not t.isdigit()]


def _serial_in_narration(serial: str, narration: str) -> bool:
    """True if the invoice serial appears as a distinct token in the narration.

    Matches 'INV-7' against 'INV7 PAYMENT' but not against 'INV 06 2026' (June),
    by extracting alphanumeric ref-like tokens and comparing them squashed.
    """
    serial_sq = _squash(serial)
    if not serial_sq:
        return False
    candidates = re.findall(r"[A-Za-z]{0,6}-?\d{1,8}", narration)
    return any(_squash(c) == serial_sq for c in candidates)


def _payee_score(customer_name: str, narration: str) -> float:
    """0..1 fuzzy score that the narration names this customer."""
    clean_name = _SUFFIX.sub(" ", customer_name)
    name_tokens = _significant(_tokens(clean_name))
    if not name_tokens:
        return 0.0
    narration_sq = _squash(narration)
    hits = sum(1 for t in name_tokens if t in narration_sq)
    coverage = hits / len(name_tokens)
    # Fall back to a fuzzy ratio of the joined name against the narration so a
    # single-token or misspelled payee still scores something.
    fuzzy = SequenceMatcher(None, _squash(clean_name), narration_sq).ratio()
    return max(coverage, fuzzy * 0.6)


def _identity_score(credit_narration: str, credit_ref: str | None, inv: OutstandingInvoice) -> tuple[float, str]:
    """How strongly this credit *names* this invoice, ignoring amount."""
    haystack = f"{credit_narration} {credit_ref or ''}"
    ref_hit = bool(inv.serial_number) and _serial_in_narration(inv.serial_number, haystack)
    payee = _payee_score(inv.customer_name, haystack)
    score = payee
    reasons = []
    if ref_hit:
        score = max(score, 0.95)
        reasons.append(f"serial {inv.serial_number} in narration")
    if payee >= 0.6:
        reasons.append(f"payee ≈ {inv.customer_name}")
    reason = "; ".join(reasons) if reasons else "weak payee match"
    return score, reason


def _amount_eq(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


def match_credit(
    credit_amount: float,
    credit_narration: str,
    credit_ref: str | None,
    invoices: list[OutstandingInvoice],
    *,
    amount_tolerance: float = 1.0,
    identity_floor: float = 0.6,
) -> dict:
    """Classify a single credit against the outstanding invoices.

    Returns a structured dict: outcome, confidence, reason, and the proposed
    invoice apply-amounts. A credit is only ever booked when its payee or
    reference identifies an invoice — amount alone never books a credit, so
    refunds and salary deposits fall through to outcome 'none'.
    """
    scored = []
    for inv in invoices:
        score, reason = _identity_score(credit_narration, credit_ref, inv)
        if score >= identity_floor:
            scored.append((score, reason, inv))
    scored.sort(key=lambda x: -x[0])

    if not scored:
        return _result(NONE, 0.0, "no invoice payee or serial in narration", [])

    # Exact full settlement of a single identified invoice.
    exact = [s for s in scored if _amount_eq(credit_amount, s[2].amount_pending, 0.01)]
    if len(exact) == 1:
        score, reason, inv = exact[0]
        return _result(CONFIDENT, round(min(score, 0.99), 2),
                       f"amount = pending {inv.amount_pending:.2f}; {reason}",
                       [_apply(inv, inv.amount_pending)])
    if len(exact) > 1:
        return _result(REVIEW, 0.5,
                       "amount matches several identified invoices; choose one",
                       [_apply(s[2], s[2].amount_pending) for s in exact])

    # Split: one credit covering several identified invoices in full.
    total_pending = sum(s[2].amount_pending for s in scored)
    if len(scored) >= 2 and _amount_eq(credit_amount, total_pending, amount_tolerance):
        return _result(SPLIT, 0.8,
                       f"covers {len(scored)} invoices' pending in full",
                       [_apply(s[2], s[2].amount_pending) for s in scored])

    top_score, top_reason, top = scored[0]

    # Clean partial payment of the single best invoice.
    if credit_amount < top.amount_pending - 0.01:
        if len(scored) == 1 or top_score - scored[1][0] >= 0.2:
            return _result(CONFIDENT, round(min(top_score, 0.9), 2),
                           f"partial payment ({credit_amount:.2f} of {top.amount_pending:.2f}); {top_reason}",
                           [_apply(top, credit_amount)])
        return _result(REVIEW, 0.5, "partial amount fits more than one invoice", _candidates(scored))

    # Near-match within tolerance (a bank/UPI fee, say).
    near = [s for s in scored if _amount_eq(credit_amount, s[2].amount_pending, amount_tolerance)]
    if len(near) == 1:
        score, reason, inv = near[0]
        return _result(REVIEW, 0.55,
                       f"amount {credit_amount:.2f} ≈ pending {inv.amount_pending:.2f} (off by "
                       f"{abs(credit_amount - inv.amount_pending):.2f}); {reason}",
                       [_apply(inv, inv.amount_pending)])

    # Identified payee but the amount overshoots the pending balance.
    if credit_amount > top.amount_pending + amount_tolerance:
        return _result(REVIEW, 0.5,
                       f"amount {credit_amount:.2f} exceeds pending {top.amount_pending:.2f} for "
                       f"{top.customer_name}; possible overpayment or partial split",
                       _candidates(scored))

    return _result(REVIEW, 0.5, "identified payee but amount does not reconcile", _candidates(scored))


def match_credits(
    credits: list[dict],
    invoices: list[OutstandingInvoice],
    *,
    amount_tolerance: float = 1.0,
) -> list[dict]:
    """Match a batch of credits. Each credit dict has amount/narration/date/reference."""
    results = []
    for credit in credits:
        outcome = match_credit(
            float(credit["amount"]),
            str(credit.get("narration") or ""),
            credit.get("reference"),
            invoices,
            amount_tolerance=amount_tolerance,
        )
        outcome["credit"] = {
            "amount": round(float(credit["amount"]), 2),
            "narration": credit.get("narration"),
            "date": credit.get("date"),
            "reference": credit.get("reference"),
        }
        results.append(outcome)
    return results


def _apply(inv: OutstandingInvoice, amount: float) -> dict:
    return {
        "hash_id": inv.hash_id,
        "serial_number": inv.serial_number,
        "customer_name": inv.customer_name,
        "amount_pending": round(inv.amount_pending, 2),
        "apply_amount": round(amount, 2),
    }


def _candidates(scored) -> list[dict]:
    return [_apply(s[2], s[2].amount_pending) for s in scored[:5]]


def _result(outcome: str, confidence: float, reason: str, matches: list[dict]) -> dict:
    return {"outcome": outcome, "confidence": confidence, "reason": reason, "matches": matches}
