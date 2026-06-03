/* Contract-test harness (run by tests/test_gst_contract.py).

   Loads the REAL frontend engine (frontend/engine.js) under minimal browser
   shims, runs its computeInvoice() — the client-side GST preview — over the
   shared fixtures in gst_fixtures.json, and prints the results as JSON on
   stdout. The Python side runs the same fixtures through mock_backend/gst.py
   and asserts the two agree, so the "client mirror of gst.py" can never drift
   silently. */
"use strict";
const fs = require("fs");
const path = require("path");

// --- minimal browser shims so engine.js loads headless ------------------- //
process.on("unhandledRejection", () => {}); // boot()'s offline fetch rejects; fine
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { search: "", origin: "http://localhost", href: "http://localhost/" };
global.fetch = () => Promise.reject(new Error("no-network-in-contract-test"));
global.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
global.window.addEventListener = () => {};
global.window.dispatchEvent = () => {};

require(path.join(__dirname, "..", "frontend", "engine.js"));
const E = global.window.SwipeEngine;

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "gst_fixtures.json"), "utf8"));

const out = fixtures.map((fx) => {
  E.SELLER.state = fx.seller_state; // E.SELLER is the live object computeInvoice reads
  const lines = fx.lines.map((l) => ({
    qty: l.quantity,
    rate: l.unit_price,
    gst: l.tax_rate || 0,
    cess: l.cess_rate || 0,
    discountPercent: l.discount_percent,
    discountAmount: l.discount_amount,
  }));
  const inv = E.computeInvoice(lines, { state: fx.customer_state });
  return { name: fx.name, net: inv.net, tax: inv.tax, grand: inv.grand, intra: inv.intra, breakup: inv.breakup };
});

process.stdout.write(JSON.stringify(out));
