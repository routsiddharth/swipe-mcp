# DETAILS — Bank-statement reconciliation (flagship MCP feature)

> **Status: implemented (June 21, 2026).** Shipped as a 9th MCP tool,
> `reconcile`, backed by a pure, unit-tested matcher in `swipe_mcp/reconcile.py`.
> The host (Claude Desktop) parses the statement into credit rows; the tool does
> the matching and the idempotent writes. `dry_run=True` is the default (preview,
> no writes); `dry_run=False` records the confident/split matches. Tested offline
> only (pure matcher + mock-backend write round-trip); not yet exercised against
> a live account.

> The headline capability of the Swipe MCP server: an agent reads a bank
> statement, matches the incoming credits against outstanding Swipe invoices,
> and records the payments — flipping invoices from *pending* to *paid*. This is
> the one demo that is **structurally impossible inside SwipeAI**, because a
> walled in-app assistant cannot see the user's bank file. It is what makes Swipe
> a node in the user's whole agent workspace rather than a destination.

## The problem it solves

Every business does this manually, every month: open the bank statement, scan
the credits that landed, and tick each one off against the invoice it paid, then
mark that invoice settled in the billing tool. It is tedious, error-prone, and
exactly the kind of judgement-plus-busywork task an agent should own.

The hard part is **not** transcription — it is **matching messy bank data to the
right invoice**: payee names buried in garbled UPI/IMPS strings, partial
payments, one deposit covering several invoices, amounts off by a bank fee, and
credits that are *not* invoice payments at all (refunds, salary, transfers).

## What the feature does (end to end)

```
   bank statement (PDF/CSV)            Swipe (via MCP)
   ─────────────────────────          ─────────────────────────
   credits that landed        ──┐
                                 ├─►  match each credit to an
   outstanding invoices       ──┘     outstanding invoice
   (amount_pending > 0)               (amount · date · payee · ref)
                                          │
                                          ▼
                                   proposed payments (preview)
                                          │  ← user confirms
                                          ▼
                                   record_payment ×N  (idempotent)
                                          │
                                          ▼
                                   invoices → paid / part-paid
```

1. **Ingest the statement.** In an MCP host (e.g. Claude Desktop) the user
   attaches the statement, or another MCP (filesystem) hands over the file. The
   agent extracts the credit lines: date, amount, narration/reference.
2. **Pull what's owed.** The agent calls `list_invoices(status: unpaid)` /
   `customer_outstanding` to get every invoice with a pending balance.
3. **Match.** For each credit, find the best invoice candidate (see *Matching
   logic* below). Each match gets a **confidence** and a reason.
4. **Preview (dry-run).** The agent returns a table of proposed payments —
   credit → invoice, amount, confidence — **without writing anything**. Anything
   ambiguous is surfaced as "needs review," not silently guessed.
5. **Confirm → record.** On user approval, the agent calls `record_payment` for
   each confirmed match. Writes are **idempotent**, so a retry never
   double-records.
6. **Result.** Invoices move to *paid* / *partially paid*; the agent reports a
   running "₹X reconciled, ₹Y still outstanding."

## Matching logic

Each bank credit is scored against each outstanding invoice on:

- **Amount** — exact match on `amount_pending` is strongest; a near match (within
  a small tolerance, e.g. a bank/UPI fee) is a candidate flagged for review;
  amounts larger than one invoice trigger a **split** across multiple invoices.
- **Payee** — fuzzy match of the customer name against the narration string
  (`"NEFT CR-HDFC0000123-ACME INDUSTRIES PVT LTD-INV 06 2026"` → *Acme
  Industries*). Tolerant of suffixes (Pvt Ltd / LLP), casing, and embedded refs.
- **Reference** — an invoice serial in the narration (`INV7`, `INV-7`) is a
  strong direct signal.
- **Date** — the credit date should fall on/after the invoice date; closer is
  better, used as a tie-breaker.

Outcomes per credit:

| Outcome | Condition | Action |
|---|---|---|
| **Confident match** | amount + payee/ref agree | propose `record_payment` |
| **Needs review** | amount near-match, or 2+ plausible invoices | surface for user choice |
| **Split** | one credit ≥ several invoices' pending | propose multiple payments |
| **No match** | refund / salary / transfer / unknown payee | **leave alone**, report as unmatched |

Selectivity is the point: correctly **not** booking a credit (a refund, a salary
deposit) is as important as booking the real ones.

## Tools involved

Reconciliation orchestrates the MCP server's existing tools — it is the agent
chaining them, backed by one helper:

- `list_invoices(status)` / `customer_outstanding(...)` — fetch what's owed.
- `record_payment(amount, method?, document_ref?)` — settle a matched invoice
  (resolves a serial/`"last"` → hash first). **Idempotent** via an optional key.
- `reconcile(credits[], dry_run=true, method="cash", bank_details?, amount_tolerance=1.0)`
  *(implemented)* — takes parsed bank credits, returns the scored match table
  (confident / review / split / none) plus a summary, **without writing**. With
  `dry_run=false` (after confirm) it records the confident/split matches via the
  same idempotent `record_payment` path; review/none credits are never
  auto-booked. `method` defaults to `cash` so the demo write needs no bank
  details; pass a real `method` + `bank_details` to record the actual mode (live
  non-cash requires them). The matcher is a pure function, so confidence
  classification is unit-tested offline.

> Statement parsing itself (PDF/CSV → credit rows) is done by the host/model or a
> filesystem MCP, not by Swipe — the Swipe MCP's job starts at "here are the
> credits."

## Safety & trust

- **Dry-run first, always.** The proposal is shown before any write. A wrong
  guess is visibly catchable, never silently committed.
- **Confirm on write.** The MCP host surfaces each `record_payment` call;
  nothing settles without approval.
- **Idempotent writes.** Re-running reconciliation on the same statement does not
  double-pay — matched credits dedupe on an idempotency key.
- **Overpayment guard.** Payments exceeding `amount_pending` are rejected
  (`AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT`) rather than forced through.
- **No silent live→mock fallback.** Reconciliation against a live account only
  ever writes to the live account.

## The demo

Assets live in `demo/`:

- `bank_statement.pdf` — a mock HDFC Bank statement (INR, account holder
  Siddharth Rout) generated by `demo/generate_bank_statement.py`.
- It seeds two reconcilable credits, highlighted in the statement:
  - **₹30,000 — Acme Industries Pvt Ltd** → clears the Acme invoice's ₹30,000
    pending balance.
  - **₹11,800 — Initech LLP (INV-7)** → clears INV-7 in full.
- It also includes a **₹1,299 Amazon refund** credit as a deliberate non-match,
  plus realistic personal-account noise (salary, rent, UPI spend), so the
  matching demonstrably does real work.

Demo script:

> *"Here's my bank statement. Reconcile it against my outstanding Swipe invoices
> and record the payments."*

The agent reads the statement, proposes: *Acme ₹30,000 → INV (Acme), Initech
₹11,800 → INV-7*, ignores the refund, shows the preview, and on confirm records
both — Acme goes to *paid*, INV-7 goes to *paid*. End state: *"₹41,800
reconciled across 2 invoices; ₹0 of the matched credits left unapplied; 1 credit
(refund) ignored."*

## Why it matters (positioning)

- **Differentiation:** SwipeAI reads and writes, but only inside Swipe. This
  composes Swipe with the user's *bank data* — cross-app work a walled assistant
  cannot do.
- **Engineering signal:** it exercises the hard parts of the brief at once —
  correct GST-aware amounts, idempotent writes, error mapping, entity
  resolution, and confirm-on-write trust — in a task with obvious real-world
  value.

## Out of scope (v1)

- Auto-parsing arbitrary bank PDF layouts (rely on host/filesystem MCP or CSV).
- Unattended/scheduled reconciliation (interactive only; scheduling is Agent SDK
  territory — see `PLAN.md`).
- Multi-currency statements (INR only, matching Swipe's Indian invoices).
