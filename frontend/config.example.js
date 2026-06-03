/* ============================================================================
   Swipe Agent — deployment config (TEMPLATE)
   ----------------------------------------------------------------------------
   Copy this to `config.js`, OR generate it at deploy time:

       python scripts/gen_frontend_config.py

   `config.js` is git-ignored. `index.html` loads it before engine.js.

   ⚠️ The Swipe API key is intentionally NOT set here. By design the key is
   entered by the user in the in-app Connection panel, validated against the live
   API with a single call, and then stored ONLY in that user's browser
   (localStorage). Nothing imports a Swipe key on boot — a clean load starts on
   the key-free mock.

   ⚠️ SECURITY: anything you DO set below ships to the browser and is publicly
   readable (view-source / network tab). Do not put the Swipe key here.
============================================================================ */

// Optional: URL of the mock backend (NOT a secret). Defaults to localhost.
// window.SWIPE_API_BASE = "https://your-mock-backend.example.com";

// Optional: your business's state — needed for a correct CGST/SGST-vs-IGST
// split in live mode (the live API has no company endpoint to read it from).
// window.SWIPE_SELLER_STATE = "TELANGANA";

// The LLM agent (natural-language → tool calls) is enabled SERVER-SIDE: set
// OPENROUTER_API_KEY (and optional OPENROUTER_MODEL) in the BACKEND's
// environment. The backend's /llm proxy holds the key and the frontend
// discovers availability via /llm/status — so no LLM key is ever set here or
// shipped to the browser. Without a server key, the app falls back to the
// built-in regex intent matcher.
//
// Optional: override the model name the frontend sends (the backend's
// OPENROUTER_MODEL normally wins via /llm/status; this is just a fallback).
// window.OPENROUTER_MODEL = "openai/gpt-4o-mini";
