/* Smoke test for the tool registry (run by tests/test_tools_smoke.py).

   Loads frontend/engine.js + frontend/tools.js headless, seeds a little
   reference data, and drives window.SwipeTools.dispatch() the way app.jsx does
   — proving the tool seam works without React or a backend. The interface IS
   the test surface: feed {tool, args, ctx}, assert the returned plan. Prints
   "OK" on success or throws (non-zero exit) on the first failed assertion. */
"use strict";
const path = require("path");
const assert = require("assert");

// --- browser shims ------------------------------------------------------- //
process.on("unhandledRejection", () => {});
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { search: "", origin: "http://localhost", href: "http://localhost/" };
global.fetch = () => Promise.reject(new Error("no-network"));
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
global.window.addEventListener = () => {};
global.window.dispatchEvent = () => {};

require(path.join(__dirname, "..", "frontend", "engine.js"));
require(path.join(__dirname, "..", "frontend", "tools.js"));
const E = global.window.SwipeEngine;
const T = global.window.SwipeTools;

// --- seed reference data (boot() couldn't, being offline) ---------------- //
E.SELLER.state = "TELANGANA";
E.CUSTOMERS.push({ id: "CUST001", name: "Acme Industries", gstin: "36AAAA0000A1Z5", state: "KARNATAKA", stateCode: "29", company: "", phone: "", email: "" });
E.PRODUCTS.push({ id: "ITEM005", name: "Consulting", item_type: "Service", rate: 2500, gst: 18, cess: 0, unit: "hrs", hsn: "9983" });

function makeCtx(text, docs = [], draft = null) {
  let _draft = draft, _docs = docs, _last = docs[docs.length - 1] || null;
  return {
    text,
    draft: _draft,
    history: [],
    getDraft: () => _draft, setDraft: (d) => { _draft = d; },
    getDocs: () => _docs, setDocs: (d) => { _docs = d; },
    getLastDoc: () => _last, setLastDoc: (d) => { _last = d; },
    patch: () => {},
  };
}

(async () => {
  // 1) schemas() is the single LLM tool source, and engine reads from it ----
  const schemas = T.schemas();
  assert.strictEqual(schemas.length, 8, "expected 8 tool schemas");
  const names = schemas.map((s) => s.function.name);
  assert.deepStrictEqual(
    names,
    ["create_invoice", "record_payment", "list_invoices", "customer_outstanding", "lookup_gstin", "list_customers", "list_products", "reply"],
    "schema names/order drifted"
  );

  // 2) create_invoice via the regex-style route (no structured items) -------
  const create = await T.dispatch("create_invoice", { gstin: undefined }, makeCtx("invoice Acme ₹50,000 for consulting, 18% GST, due in 15 days"));
  assert.strictEqual(create.isWrite, true, "create should be a write");
  assert.strictEqual(create.card.type, "invoice", "create should yield an invoice card");
  assert.strictEqual(create.draft.customer.id, "CUST001", "should resolve Acme");
  assert.strictEqual(create.card.props.inv.grand, 59000, "₹50k @18% inter-state = ₹59,000");
  assert.strictEqual(create.card.props.inv.intra, false, "TELANGANA seller vs KARNATAKA customer = inter-state");
  assert.strictEqual(create.trace.length, 4, "create emits 4 trace steps");
  assert.strictEqual(typeof create.onCommit, "function", "create exposes onCommit");

  // 3) edit_draft amends the pending draft (regex fallback path) ------------
  const edited = await T.dispatch("edit_draft", {}, makeCtx("make it 28% GST", [], create.draft));
  assert.strictEqual(edited.card.props.inv.grand, 64000, "₹50k @28% = ₹64,000");

  // 4) record_payment resolves "it" to the last doc & validates balance -----
  const doc = { hash_id: "H1", serial: "INV-1", customerId: "CUST001", customerName: "Acme Industries", net: 50000, tax: 9000, grand: 59000, paid: 0, date: "01-06-2026" };
  const pay = await T.dispatch("record_payment", { amount: 20000, method: "upi" }, makeCtx("record a ₹20,000 UPI payment against it", [doc]));
  assert.strictEqual(pay.isWrite, true, "payment is a write");
  assert.strictEqual(pay.card.type, "payment", "payment card");
  assert.strictEqual(pay.card.props.amount, 20000, "payment amount carried through");

  // 5) overpayment is caught at preview (honest, no false checkmark) --------
  const over = await T.dispatch("record_payment", { amount: 999999, method: "cash" }, makeCtx("pay it off", [doc]));
  assert.strictEqual(over.isWrite, false, "overpayment should clarify, not offer a write");
  assert.strictEqual(over.card, null, "overpayment clarify has no card/confirm");
  assert.ok(/outstanding balance/.test(over.intro), "overpayment explains the balance");

  // 6) list_products is offline-capable and renders a products card --------
  const prods = await T.dispatch("list_products", {}, makeCtx("show me products"));
  assert.strictEqual(prods.card.type, "products", "products card");
  assert.strictEqual(prods.card.props.products.length, 1, "one seeded product");

  // 7) reply + unknown + alias routing -------------------------------------
  const reply = await T.dispatch("reply", { message: "hi there" }, makeCtx("hi"));
  assert.strictEqual(reply.intro, "hi there");
  const unknown = await T.dispatch("totally_unknown_tool", {}, makeCtx("???"));
  assert.ok(/run Swipe in plain English/.test(unknown.intro), "unknown falls back to help");
  const aliased = await T.dispatch("gstin_lookup", { gstin: "" }, makeCtx("look up gstin"));
  assert.ok(/GSTIN/.test(aliased.intro), "gstin_lookup alias routes to lookup_gstin (clarify when no GSTIN)");

  process.stdout.write("OK");
})().catch((e) => { console.error(e); process.exit(1); });
