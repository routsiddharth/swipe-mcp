// Build-time generator for frontend/config.js — the Node twin of
// scripts/gen_frontend_config.py, used by Vercel (its build image always has
// Node). config.js is git-ignored, so a git-triggered deploy has to recreate it
// from the project's environment variables.
//
// Only NON-SECRET deploy settings are written (they ship to the browser):
//   SWIPE_API_BASE      URL of the mock backend (e.g. the Fly app)
//   SWIPE_SELLER_STATE  optional: business state for the CGST/SGST-vs-IGST split
//   SWIPE_SELLER_GSTIN  optional
// The Swipe key and the OpenRouter key are deliberately NEVER written here —
// the Swipe key is user-entered, and the OpenRouter key lives on the backend.
import { writeFileSync } from "node:fs";

const apiBase = (process.env.SWIPE_API_BASE || "").trim();
const sellerState = (process.env.SWIPE_SELLER_STATE || "").trim();
const sellerGstin = (process.env.SWIPE_SELLER_GSTIN || "").trim();

const lines = [
  "/* Auto-generated at build by scripts/gen_config.mjs — do not commit. */",
  "/* WARNING: anything set here ships to the browser and is publicly readable. */",
  "/* No Swipe key and no OpenRouter key by design (see the script header).     */",
];
if (apiBase) lines.push(`window.SWIPE_API_BASE = ${JSON.stringify(apiBase)};`);
if (sellerState) lines.push(`window.SWIPE_SELLER_STATE = ${JSON.stringify(sellerState)};`);
if (sellerGstin) lines.push(`window.SWIPE_SELLER_GSTIN = ${JSON.stringify(sellerGstin)};`);

writeFileSync("frontend/config.js", lines.join("\n") + "\n");
console.log(`wrote frontend/config.js (api_base=${apiBase || "default"}, seller_state=${sellerState || "unset"})`);
