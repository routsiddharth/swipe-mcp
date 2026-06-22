"""Contract test: the frontend's GST preview must match the backend gst.py.

The frontend re-implements the GST math in JS (frontend/engine.js
``computeInvoice``) so the invoice preview is instant and offline. That mirror
could silently drift from the authoritative ``swipe_core/gst.py`` — and a
drift would only surface as a wrong invoice *after* the user confirms.

This test feeds the SAME fixtures (tests/gst_fixtures.json) to both: the JS side
runs via tests/gst_contract.js under Node, the Python side runs gst.py here, and
the two results must be identical. gst.py stays the single source of truth.
"""
import json
import pathlib
import shutil
import subprocess

import pytest

from swipe_core import gst

ROOT = pathlib.Path(__file__).resolve().parent
FIXTURES = json.loads((ROOT / "gst_fixtures.json").read_text())


def _backend_compute(fx: dict) -> dict:
    """Run a fixture through gst.py the way service.build_document does."""
    items = [
        gst.compute_line_item(
            quantity=line["quantity"],
            unit_price=line["unit_price"],
            tax_rate=line.get("tax_rate", 0) or 0,
            cess_rate=line.get("cess_rate", 0) or 0,
            discount_percent=line.get("discount_percent"),
            discount_amount=line.get("discount_amount"),
        )
        for line in fx["lines"]
    ]
    intra = fx["customer_state"].upper() == fx["seller_state"].upper()
    totals = gst.compute_document_totals(items, intra_state=intra)
    bk = totals["tax_breakup"]
    breakup = (
        [{"label": "CGST", "amount": bk["cgst"]}, {"label": "SGST", "amount": bk["sgst"]}]
        if intra
        else [{"label": "IGST", "amount": bk["igst"]}]
    )
    return {
        "net": totals["net_amount"],
        "tax": totals["tax_amount"],
        "grand": totals["total_amount"],
        "intra": intra,
        "breakup": breakup,
    }


def test_frontend_gst_preview_matches_backend():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed — cannot run the JS side of the contract test")

    proc = subprocess.run(
        [node, str(ROOT / "gst_contract.js")],
        capture_output=True,
        text=True,
        cwd=str(ROOT.parent),
    )
    assert proc.returncode == 0, f"node harness failed:\n{proc.stderr}"
    js_results = json.loads(proc.stdout)
    assert len(js_results) == len(FIXTURES)

    for fx, js in zip(FIXTURES, js_results):
        expected = _backend_compute(fx)
        actual = {k: js[k] for k in ("net", "tax", "grand", "intra", "breakup")}
        assert actual == expected, (
            f"GST drift between frontend and backend for fixture '{fx['name']}':\n"
            f"  frontend (engine.js): {actual}\n"
            f"  backend  (gst.py):    {expected}"
        )
