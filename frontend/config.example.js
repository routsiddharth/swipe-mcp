/* ============================================================================
   Swipe Agent — deployment config (TEMPLATE)
   ----------------------------------------------------------------------------
   Copy this to `config.js` and fill in your key, OR generate it from an
   environment variable at deploy time:

       SWIPE_API_KEY=... python scripts/gen_frontend_config.py

   `config.js` is git-ignored (it holds a secret). `index.html` loads it before
   engine.js; whatever it sets here becomes the default the app boots with, so
   the agent always uses your key without anyone pasting it into the UI.

   Leaving config.js absent is fine — the app falls back to the in-app
   Connection panel / mock mode.

   ⚠️ SECURITY: this file ships to the browser, so EVERY value below is publicly
   readable by anyone who loads the page (view-source / network tab). Fine for a
   single-account demo; for anything public, proxy the keys through a backend.
============================================================================ */
// Your Swipe Partner API key (from Swipe dashboard → API Integration).
window.SWIPE_API_TOKEN = "PASTE_YOUR_SWIPE_API_KEY_HERE";
// "live" drives your real Swipe account; "mock" uses the local FastAPI mock.
window.SWIPE_MODE = "live";
// Your business's state — needed for a correct CGST/SGST-vs-IGST split in live
// mode (the live API has no company endpoint to read it from). Optional; if
// omitted the invoice card flags the split as assumed.
window.SWIPE_SELLER_STATE = "TELANGANA";
// OpenRouter key — enables the LLM agent (natural-language → tool calls).
// Without it, the app falls back to the built-in regex intent matcher.
window.OPENROUTER_API_KEY = "PASTE_YOUR_OPENROUTER_KEY_HERE";
window.OPENROUTER_MODEL = "openai/gpt-4o-mini";
