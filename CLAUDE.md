# CONTEXT.md — working notes for the Swipe Partner API MCP server

> My distilled, verified-against-the-spec working reference. The brief lives in
> the project prompt; this file is what I've actually confirmed from the live
> docs (fetched 2026-06-01). When in doubt, the authoritative source is the
> OpenAPI spec, saved locally (see "Local copies" below).

## The goal in one line
Ship a public MCP server wrapping Swipe's Partner API so an LLM agent can drive
Swipe in natural language. It's a hiring artifact (target: eng role at Swipe).
Quality of a few tools > breadth. Must run fully in **mock mode without a key**.

## Minimal arc to build first
look up an entity (customer) → create an invoice → list / inspect invoices.
Use **v2** endpoints only. Build outward only if worth it.

## Non-negotiables (the actual hiring bar)
- Crisp MCP tool descriptions + JSON schemas (an agent calls correctly only if
  the tool is well described).
- **GST line-item math correct & unit-tested** — the main thing the wrapper
  earns its keep on. Verifiable offline.
- Idempotency on writes (no double-create on agent retry).
- Validation + error messages mapped from Swipe error codes.
- Never commit a key; read from env. Single mock/live toggle.
- README honest: nothing is live-validated yet; everything is built-to-spec.

---

## Confirmed API facts (from live docs, 2026-06-01)

- **Base URL:** `https://app.getswipe.in/api/partner`
- **Auth:** HTTP Bearer (JWT) — `Authorization: Bearer <token>`. Key is
  generated in the Swipe dashboard's "API Integration" section.
- **Rate limit:** docs don't state a number (brief said ~100 calls/day free).
  Only relevant once a key exists.
- The `openapi.json` at `/api-reference/openapi.json` is a broken Mintlify
  "plant store" placeholder — **ignore it**. Use `partner.yaml`.

### Authoritative source URLs
- Spec (use this): https://developers.getswipe.in/api-reference/partner.yaml
- Doc index: https://developers.getswipe.in/llms.txt
- Intro/auth/webhooks: https://developers.getswipe.in/introduction
- References (tax/TDS/TCS/states): https://developers.getswipe.in/api-reference/references
- Error codes: https://developers.getswipe.in/api-reference/error-codes
- Per-resource human guides: customer.md, document.md, product.md, payment.md,
  einvoices.md, ewaybills.md, subscriptions.md, webhooks.md (under root)
- ToS check before publishing; contact api@getswipe.in.

### Local copies
- Full `partner.yaml` (243.5KB) saved at:
  `~/.claude/projects/-Users-siddharthrout-Desktop-Projects-swipe/77b4dcac-dfbe-4265-b035-ce2d268bcd5f/tool-results/webfetch-1780268111945-j5radm.bin`
  → **read this for exact schema/math semantics before implementing** (WebFetch
  summaries are lossy; the example in the guide page is internally inconsistent
  — see "GST math" warning below).

---

## Endpoints (v2 — the ones we care about)

Both v1 and v2 exist; **use v2**.

| Method | Path | Use |
|---|---|---|
| POST | `/v2/doc` | Create a document (invoice etc.) — the hard one |
| GET  | `/v2/doc/list` | List documents (filters below) |
| GET  | `/v2/doc/{doc_hash_id}` | Get a document |
| PUT  | `/v2/doc/{doc_hash_id}` | Edit a document |
| DELETE | `/v2/doc/{doc_hash_id}` | Cancel a document |
| GET  | `/v2/doc/pdf/{doc_hash_id}` | Document PDF |
| POST | `/v2/customer` | Add customer |
| PUT  | `/v2/customer` | Update customer |
| GET  | `/v2/customer/{customer_id}` | Get customer |
| DELETE | `/v2/customer/{customer_id}` | Delete customer |
| GET  | `/v2/customer/list` | List customers |
| POST | `/v2/customer/list` | Update customer mapping |
| GET  | `/v2/customer/ledger` | Customer payment ledger |
| POST | `/v2/payment` | Record payment |
| GET  | `/v2/payment/list` | List payments |
| POST/PUT/GET/DELETE | `/v2/product...` | Items CRUD + `/v2/product/list` |
| POST/PUT/GET/DELETE | `/v2/vendor...` | Vendors CRUD + `/v2/vendor/list`, `/v2/vendor/ledger` |
| GET  | `/v2/subscriptions/list`, `/v2/subscriptions/{id}` | Subscriptions (read) |
| POST | `/v2/ewaybill/{doc_hash_id}` | Create eway bill |
| GET  | `/v2/ewaybill/pdf/{doc_hash_id}` | Eway bill PDF |
| POST | `/v2/inventory/stock` | Stock in/out |
| GET  | `/v2/inventory/warehouses/list` | Warehouses |
| GET  | `/v2/utils/gstin/{gstin}` | GSTIN lookup/validate |

Likely MVP tool set: `find_customer` (GET list / get), `create_invoice`
(POST /v2/doc), `list_invoices` (GET /v2/doc/list), `get_invoice`
(GET /v2/doc/{id}), `record_payment` (POST /v2/payment), `lookup_gstin`.

---

## Create Document — `POST /v2/doc` (the core schema)

**Required:** `document_type`, `document_date` (DD-MM-YYYY), `party`, `items`.

`document_type` enum (per partner.yaml v2): `invoice`, `purchase`,
`pro_forma_invoice`, `estimate`, `sales_return`, `purchase_return`,
`delivery_challan`, `purchase_order`.
⚠️ The document.md guide page listed a *different* set (incl. `subscription`)
and a deprecated `customer` field — trust **partner.yaml**, not the guide.

Spec schema name: **`BaseDocumentV2`** (yaml ~L5630). Required: `document_date`,
`document_type`, `items`, `party`.

**`party`** (schema `Party`, yaml ~L3244; replaces legacy `customer`):
required `id`, `name`, `type` (`customer`|`vendor`). Optional `country_code`,
`phone_number`, `company_name`, `email`, `gstin`, `billing_address`,
`shipping_address` (AddressV2). New IDs auto-create the party; existing IDs
won't overwrite master data.

`document_type` enum **for create** (`BaseDocumentV2`, L5653): `invoice`,
`subscription`, `pro_forma_invoice`, `estimate`, `sales_return`,
`purchase_return`, `delivery_challan`, `purchase`. ⚠️ Differs from the
`/v2/doc/list` query enum (L1829), which has `purchase_order` and no
`subscription`. Party `type` gates which doc types are allowed: `customer` →
invoice/sales_return/estimate/pro_forma_invoice/delivery_challan; `vendor` →
purchase/purchase_order/purchase_return.

**`items[]`** (schema `DocItemV2`, yaml L5808) — required per item:
`id`, `name`, `item_type` (`Product`|`Service`), `quantity`, `unit_price`
(excl tax), `price_with_tax` (incl tax), `net_amount`, `total_amount`.
Optional: `tax_rate` (%), `discount_percent`, `discount_amount` (flat, ignored
if `discount_percent` given), `description`, `hsn_code` (len 4/6/8),
`unit` (GST UQC), `category`, `custom_columns[]`. ⚠️ `cess_rate` is NOT in the
DocItemV2 schema but the spec's own example sends it (L375) and the math uses
it — accept it optionally. `unit_price` is always tax-EXCLUSIVE (there is no
`is_amount_with_tax` toggle in v2).

**Doc-level optional fields — actual `BaseDocumentV2` (L5630), no invented ones:**
- `serial_number` (auto if omitted) / `serial_number_v2` ({prefix, doc_number,
  suffix}), `due_date`, `reference`, `notes`, `terms`.
- `extra_discount` (number, doc-level adjustment — **does NOT affect tax**),
  `round_off` (bool, default false), `warehouse_id` (int).
- `payments[]` (`PaymentV2`), `bank_details` (display only, no payment linked),
  `tds_id` (int), `tcs_id` (int) — never both (CAN_NOT_APPLY_TDS_AND_TCS_TOGETHER).
- `charges_and_deductions[]` (`AdditionalChargesDeductionsV2`: id, name, amount,
  tax_rate, sac_code, type ∈ `charge`|`deduction`).
- `company_shipping_address`, `company_billing_address` (`ShippingAddressV2`).
  The **party's** own `shipping_address`/`billing_address` carry the customer
  side. CGST/SGST vs IGST = company state vs party (place-of-supply) state.
- `einvoice` (bool), `is_export`+`export_invoice_details`, `is_multi_currency`,
  `is_subscription`+`subscription_details`, `convert`, `custom_headers[]`.

`ShippingAddressV2`/`AddressV2`: `address_line1/2`, `city`, `pincode`, `state`
(enum of 38 Indian states + OTHER TERRITORY — see yaml L3348), `country`,
`addr_id`/`addr_id_v2` (reuse/update existing address by id).

⚠️ **`payments[].method` enum (v2, authoritative, schema `PaymentV2` L5927):**
`cash`, `card`, `upi`, `netBanking`, `cheque`, `emi`. (Note `netBanking` is
camelCase even though the rest of v2 is snake_case. The earlier WebFetch
summary that said `net_banking`/`wallet`/`bank_transfer` was WRONG.)
`PaymentV2` fields: `amount` (req), `method` (req), `notes`, `bank_details`,
`payment_date` (DD-MM-YYYY, called `payment_date` on `GetPaymentV2`).

**Create response** (schema `DocCreateResponseV2` → `DocCreateData`, L6420) —
**snake_case**: `{ success, message, error_code, errors,
data: { hash_id, serial_number, irn, qr_code } }`.  ⚠️ the data key is
**`hash_id`** (NOT `doc_hash_id`). Error shape: `{ success:false, error_code,
message, errors:{} }`. (camelCase `hashId`/`serialNumber` was the v1 shape.)

### ✅ GST line-item math — RESOLVED, and it reconciles
My earlier "inconsistent example" flag was wrong — it came from a garbled
WebFetch *summary* of the guide. The **real spec examples reconcile exactly**.
Verified formulas (DocItemV2 descriptions + worked examples in the yaml):

```
discount        = discount_amount  OR  (quantity × unit_price) × discount_percent/100
net_amount      = quantity × unit_price − discount
tax_amount      = net_amount × (tax_rate + cess_rate) / 100      # tax on POST-discount net
total_amount    = net_amount + tax_amount
price_with_tax  = unit_price × (1 + (tax_rate + cess_rate)/100)  # per-unit, tax-inclusive
```
Worked check (yaml "advanced" example, L370): qty 10 × ₹100 = 1000, disc 10% →
100, net 900; (18%+10% cess)=28% of 900 = **252** tax; total **1152**;
price_with_tax 100×1.28 = **128**. ✅ All match.
Second check (e-invoice example, L490): qty 1 × 100, disc 10 flat → net 90,
18% → 16.2 tax, total 106.2. ✅

Still to decide in the calc unit (these are wrapper policy, not spec gaps):
- `is_amount_with_tax=true` path: back out net from a tax-inclusive unit_price.
- CGST/SGST split vs IGST: determined by `place_of_supply` vs company state.
  The wrapper computes the *total* tax; send `place_of_supply` and let Swipe
  split for display (or compute the split ourselves for the mock).
- `round_off` behavior (round final doc total to nearest rupee, carry delta).
- `discount_level=document` + `extra_discount` interaction with per-item tax.
This calc is the deliverable's centerpiece — a small, pure, unit-tested module.

---

## List Documents — `GET /v2/doc/list`
Query: `document_type` (req, default invoice), `start_date`+`end_date` (req,
DD-MM-YYYY), `payment_status` (all|pending|paid|cancelled, default all),
`num_records` (string, max 100, default '10'), `page` (int, default 1),
`customer_id` (optional).
Response (schema `ListTransactionsV2` → `ListTransactionData`, L6481):
`{ success, message, error_code, errors, data: { transactions: [...],
total_records: int } }`. Each `TransactionListModelV2` (L6514): `hash_id`,
`serial_number`, `document_date`, `due_date`, `customer` (`CustomerV2`:
id/name/country_code/phone_number/company_name/email/gstin), `net_amount`,
`tax_amount`, `total_amount`, `total_discount`, `amount_paid`,
`amount_pending`, `payment_status` (paid|pending|cancelled), `payments[]`,
`reference`, `notes`, `terms`, `is_created_by_recurring`.

## Get Customer — `GET /v2/customer/{customer_id}`
Response `data`: `{ id, name, phone_number, email, country_code, company_name,
gstin, billing_address, shipping_address, custom_fields? }`.

---

## Reference data (from references page)
- **TDS IDs** (apply on Net Amount unless noted): 1=192A 10%, 2=193 10%,
  3=194 10%, 4/5=194A 10%, 6/7=194C 1%, 8/9=194D/DA 5%, 10=194EE 10%,
  11=194F 20%, 16=194IA 1%, 30=194Q 0.1% (on Total), 49=111A 15%,
  52=194O 0.1%.
- **TCS IDs** (mostly on Total): 35=206C(IH) 0.1%, 36=206C 1%, 37=206C 2.5%,
  43=206C 1%, 46=206C(1G)(a) 5% (Net), 48=206C 20% (Net).
- **Rule:** `CAN_NOT_APPLY_TDS_AND_TCS_TOGETHER` — never both on one doc.
- **States:** 38 entries (Delhi, Gujarat, Maharashtra, Karnataka, Tamil Nadu,
  Telangana, etc.). Need exact codes from yaml for CGST/SGST vs IGST decision.
- **Tax rates / GST UQC units / currency IDs:** pull exact ID lists from the
  yaml when implementing (WebFetch summary was partial here).

## Error codes (map these to friendly messages)
Auth: `UNAUTHORIZED`, `FORBIDDEN`. General: `BAD_REQUEST`, `UNKNOWN_ERROR`.
Doc/customer notables: `CUSTOMER_NOT_FOUND`, `INVALID_CUSTOMER_ID`,
`ITEM_NOT_FOUND`, `DUPLICATE_DOC_SERIAL_NUMBER`, `INVALID_TAX_RATE`,
`CAN_NOT_APPLY_TDS_AND_TCS_TOGETHER`, `AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT`,
`FORBIDDEN_USING_BACK_DATE`, `INSUFFICIENT_STOCK`, `MISSING_BANK_ACCOUNT`,
`BANK_DETAILS_MISSING_NON_CASH`, `INVALID_HASH_ID`, `HASH_ID_MISSING`.
E-invoice errors surface as `PORTAL_ERROR_{code}`. HTTP statuses not documented.

## Webhooks (if we add a listener)
Two event categories: **Document** (create/update/status/cancel) and
**Inventory** (stock movements). Signed with HMAC-SHA256 in `X-Signature`.
Verify raw body against webhook secret, constant-time compare:
```python
expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
return hmac.compare_digest(signature, expected)
```

---

## Open questions — status after reading the yaml
1. ✅ GST math semantics — resolved (formulas above; tax on post-discount net,
   cess added to rate, total = net + tax). Remaining: `is_amount_with_tax` path,
   round_off, CGST/SGST-vs-IGST split (driven by `place_of_supply`).
2. ✅ Create-response casing — v2 is **snake_case** (`doc_hash_id`,
   `serial_number`). camelCase was v1.
3. ⬜ Full tax-rate ID table, GST UQC unit list, state codes, currency IDs —
   still need exact lists; pull from `spec/partner.yaml` + references page when
   building the reference-data module / enums.
4. ✅ `party` vs `customer` — v2 `BaseDocumentV2` requires `party` (`Party`
   schema, type customer|vendor). `customer` is the v1 field. Use `party`.
5. ⬜ Idempotency — no idempotency-key field seen in v2 create. Plan: client-side
   dedupe (hash of request → cache returned doc_hash_id within a TTL, and/or use
   a caller-supplied `serial_number` so a retry hits DUPLICATE_DOC_SERIAL_NUMBER
   rather than double-creating). Confirm with a live key later.

## Mock-mode design intent
- Single env toggle (e.g. `SWIPE_MODE=mock|live`, key from `SWIPE_API_TOKEN`).
- Mock responses match spec response **shapes** (derive from yaml, don't invent).
- Same tool surface in both modes; mock is the default so it runs key-free in ~30s.
