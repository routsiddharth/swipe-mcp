#!/usr/bin/env python3
"""Generate a mock HDFC Bank statement (HTML) for the MCP reconciliation demo.

Why this exists: the headline demo for the Swipe MCP server is *bank-statement
reconciliation* — Claude reads this statement, matches incoming credits against
outstanding Swipe invoices, and records the payments. So the statement must be
INR (to match the ₹ invoices) and must contain credits that line up with the
demo invoices' pending balances:

  • ₹30,000  from "Acme Industries Pvt Ltd"  → clears the Acme invoice (₹30,000 pending)
  • ₹11,800  from "Initech LLP"              → clears INV-7 in full

Everything else is realistic personal-account noise, plus one refund credit that
is deliberately NOT an invoice payment (so the matching has to be selective).

Layout is modelled on a real statement (Chase reference in the repo root): an
account/summary block followed by a Date / Narration / Withdrawal / Deposit /
Balance transaction table.

Run:  python demo/generate_bank_statement.py
Then render to PDF with Chrome headless (see demo/README or the build step).
"""
from __future__ import annotations

from decimal import Decimal
from pathlib import Path

D = Decimal


def money(v: Decimal) -> str:
    """Indian-grouping rupee format: 1,84,250.00 (lakh/crore separators)."""
    neg = v < 0
    v = abs(v)
    whole, frac = divmod(int(round(v * 100)), 100)
    s = str(whole)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        # group the head in 2s, right to left
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        parts.insert(0, head)
        s = ",".join(parts) + "," + tail
    out = f"{s}.{frac:02d}"
    return f"-{out}" if neg else out


# --- account meta -----------------------------------------------------------
ACCOUNT = {
    "bank": "HDFC BANK",
    "branch": "Koramangala, Bengaluru - 560034",
    "ifsc": "HDFC0001234",
    "name": "SIDDHARTH ROUT",
    "address": ["No. 42, 3rd Cross, 5th Block", "Koramangala, Bengaluru, Karnataka 560034"],
    "account_no": "50100247383218",
    "account_type": "SAVINGS ACCOUNT",
    "period": "01 May 2026 to 10 June 2026",
    "currency": "INR",
}

OPENING = D("184250.00")

# (date, narration, ref_no, withdrawal, deposit)
TXNS = [
    ("02-05-2026", "UPI-SWIGGY-swiggy@hdfcbank-payment", "451200345012", D("642.00"), None),
    ("03-05-2026", "UPI-AMAZON PAY INDIA-amazonpay@apl", "451200456123", D("1299.00"), None),
    ("05-05-2026", "NEFT CR-CITIN0000001-NOVA SOFTWARE PVT LTD-SALARY MAY 2026", "N089251234567", None, D("95000.00")),
    ("06-05-2026", "UPI-ZOMATO LTD-zomato@hdfcbank", "451300567234", D("458.50"), None),
    ("07-05-2026", "ACH D-HDFC LIFE INSURANCE-PREMIUM", "ACH2605071122", D("3200.00"), None),
    ("10-05-2026", "UPI-BESCOM-bescom.bnglr@sbi-ELECTRICITY", "451400678345", D("2145.00"), None),
    ("12-05-2026", "IMPS-613212345678-HOUSE RENT-RAVI KUMAR", "613212345678", D("35000.00"), None),
    ("15-05-2026", "UPI-BIGBASKET-bbnow@ybl", "451500789456", D("2870.25"), None),
    ("18-05-2026", "UPI-IRCTC-irctc@sbi-TICKET", "451600890567", D("1540.00"), None),
    ("20-05-2026", "ATM CASH WDL-HDFC ATM KORAMANGALA", "ATM26052001", D("10000.00"), None),
    ("22-05-2026", "UPI-NETFLIX-netflix@razorpay", "451700901678", D("649.00"), None),
    ("25-05-2026", "UPI-AMAZON PAY INDIA-REFUND ORDER 408-23", "451800112789", None, D("1299.00")),
    ("28-05-2026", "UPI-JIO RECHARGE-jio@hdfcbank", "451900223890", D("399.00"), None),
    ("31-05-2026", "BANK CHARGES-SMS ALERT+GST", "CHG2605310001", D("177.00"), None),
    ("02-06-2026", "UPI-UBER INDIA-uber@hdfcbank", "452000334901", D("286.40"), None),
    ("06-06-2026", "NEFT CR-HDFC0000123-ACME INDUSTRIES PVT LTD-INV 06 2026", "N123456789012", None, D("30000.00")),
    ("09-06-2026", "IMPS-615412345678-INITECH LLP-INV7 PAYMENT", "615412345678", None, D("11800.00")),
    ("10-06-2026", "UPI-SWIGGY-swiggy@hdfcbank-payment", "452100445012", D("730.00"), None),
]


def build_rows() -> tuple[list[dict], Decimal, Decimal, Decimal]:
    bal = OPENING
    total_dr = D("0.00")
    total_cr = D("0.00")
    rows = []
    for date, narr, ref, dr, cr in TXNS:
        if dr is not None:
            bal -= dr
            total_dr += dr
        if cr is not None:
            bal += cr
            total_cr += cr
        # highlight the two invoice-payment credits for the demo
        highlight = cr is not None and ("ACME INDUSTRIES" in narr or "INITECH LLP" in narr)
        rows.append({
            "date": date, "narr": narr, "ref": ref,
            "dr": money(dr) if dr is not None else "",
            "cr": money(cr) if cr is not None else "",
            "bal": money(bal), "highlight": highlight,
        })
    return rows, total_dr, total_cr, bal


def render_html() -> str:
    rows, total_dr, total_cr, closing = build_rows()
    a = ACCOUNT

    tx_rows = "\n".join(
        f'<tr class="{ "hl" if r["highlight"] else "" }">'
        f'<td class="date">{r["date"]}</td>'
        f'<td class="narr">{r["narr"]}<span class="ref">Ref {r["ref"]}</span></td>'
        f'<td class="num">{r["dr"]}</td>'
        f'<td class="num cr">{r["cr"]}</td>'
        f'<td class="num bal">{r["bal"]}</td>'
        f'</tr>'
        for r in rows
    )

    addr = "<br>".join(a["address"])
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Statement of Account — {a['name']}</title>
<style>
  @page {{ size: A4; margin: 14mm 12mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; font-size: 10.5px; margin: 0; }}
  .head {{ display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #004c8f; padding-bottom: 10px; }}
  .bank {{ font-size: 22px; font-weight: 800; color: #004c8f; letter-spacing: .5px; }}
  .bank small {{ display: block; font-size: 9px; font-weight: 600; color: #c8102e; letter-spacing: 2px; margin-top: 2px; }}
  .branch {{ font-size: 9.5px; color: #555; margin-top: 6px; line-height: 1.5; }}
  .stmt-title {{ text-align: right; }}
  .stmt-title h1 {{ font-size: 13px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px; }}
  .stmt-title .period {{ font-size: 9.5px; color: #555; }}
  .meta {{ display: flex; justify-content: space-between; margin-top: 14px; gap: 24px; }}
  .meta .box {{ font-size: 9.8px; line-height: 1.7; }}
  .meta .box b {{ display: inline-block; min-width: 92px; color: #555; font-weight: 600; }}
  .holder {{ font-weight: 700; font-size: 11px; }}
  .summary {{ display: flex; gap: 0; margin: 16px 0 12px; border: 1px solid #d8dde3; border-radius: 6px; overflow: hidden; }}
  .summary div {{ flex: 1; padding: 9px 12px; border-right: 1px solid #e6eaef; }}
  .summary div:last-child {{ border-right: none; }}
  .summary .lbl {{ font-size: 8.6px; text-transform: uppercase; letter-spacing: .6px; color: #6b7280; }}
  .summary .val {{ font-size: 13px; font-weight: 700; margin-top: 3px; }}
  .summary .val.cr {{ color: #0a7d33; }}
  .summary .val.dr {{ color: #c8102e; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 6px; }}
  thead th {{ background: #004c8f; color: #fff; font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
             padding: 6px 8px; text-align: left; }}
  thead th.num {{ text-align: right; }}
  tbody td {{ padding: 6px 8px; border-bottom: 1px solid #eef1f4; vertical-align: top; }}
  tbody tr:nth-child(even) {{ background: #fafbfc; }}
  td.date {{ white-space: nowrap; color: #333; }}
  td.narr {{ font-size: 9.6px; }}
  td.narr .ref {{ display: block; color: #9aa3ad; font-size: 8.4px; margin-top: 1px; }}
  td.num {{ text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }}
  td.cr {{ color: #0a7d33; }}
  td.bal {{ font-weight: 600; }}
  tr.hl {{ background: #fff7e6 !important; }}
  tr.hl td {{ border-bottom-color: #ffe2a8; }}
  .open-row td, .close-row td {{ font-weight: 700; background: #eef3f8; }}
  .foot {{ margin-top: 14px; font-size: 8.4px; color: #8a929b; line-height: 1.6; border-top: 1px solid #e6eaef; padding-top: 8px; }}
</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="bank">{a['bank']}<small>WE UNDERSTAND YOUR WORLD</small></div>
      <div class="branch">{a['branch']}<br>IFSC: {a['ifsc']}</div>
    </div>
    <div class="stmt-title">
      <h1>Statement of Account</h1>
      <div class="period">{a['period']}</div>
    </div>
  </div>

  <div class="meta">
    <div class="box">
      <div class="holder">{a['name']}</div>
      <div>{addr}</div>
    </div>
    <div class="box">
      <div><b>Account No</b> {a['account_no']}</div>
      <div><b>Account Type</b> {a['account_type']}</div>
      <div><b>Currency</b> {a['currency']}</div>
      <div><b>Statement Date</b> 10 June 2026</div>
    </div>
  </div>

  <div class="summary">
    <div><div class="lbl">Opening Balance</div><div class="val">₹ {money(OPENING)}</div></div>
    <div><div class="lbl">Total Credits</div><div class="val cr">₹ {money(total_cr)}</div></div>
    <div><div class="lbl">Total Debits</div><div class="val dr">₹ {money(total_dr)}</div></div>
    <div><div class="lbl">Closing Balance</div><div class="val">₹ {money(closing)}</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:62px">Date</th>
        <th>Narration</th>
        <th class="num" style="width:78px">Withdrawal (₹)</th>
        <th class="num" style="width:78px">Deposit (₹)</th>
        <th class="num" style="width:90px">Balance (₹)</th>
      </tr>
    </thead>
    <tbody>
      <tr class="open-row"><td colspan="4">Opening Balance</td><td class="num">{money(OPENING)}</td></tr>
      {tx_rows}
      <tr class="close-row"><td colspan="4">Closing Balance</td><td class="num">{money(closing)}</td></tr>
    </tbody>
  </table>

  <div class="foot">
    This is a system-generated statement and does not require a signature.
    *** MOCK / DEMO STATEMENT — not a real bank document; generated for the Swipe MCP reconciliation demo. ***<br>
    Registered Office: HDFC Bank Ltd. Closing balance reflects transactions posted up to the statement date.
  </div>
</body>
</html>"""


if __name__ == "__main__":
    out = Path(__file__).parent / "bank_statement.html"
    out.write_text(render_html(), encoding="utf-8")
    print(f"Wrote {out}")
