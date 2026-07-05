# Spazito — State & Configuration Schema

> Spazito has no database (ADR 004). Its entire persistent state and configuration
> live in **Apps Script `PropertiesService`** (Script scope) — a flat key-value store.
> This document is the analog of a DB schema: every key, who owns it, its format, and
> an example. Source of truth for *access* is `Config` (secrets) and `Watchlist`
> (state); this document is the reference for *what those keys are*.

All values in `PropertiesService` are **strings.** Any structure (a list, a boolean)
is encoded into a string and decoded by its owning module.

---

## Two categories, two owners

| Category | Owner module | What it holds |
|---|---|---|
| **Secrets / config** | `Config` | API keys, phone numbers, the debug flag. Set by hand. |
| **Mutable state** | `Watchlist` | The watchlist and the paused flag. Changed at runtime by SMS commands. |

**Invariant:** No module other than `Config` reads a secret key. No module other than
`Watchlist` reads or writes a state key. Everyone else goes through the owner (ADR 006
§5). The *encoding* of each value is the owner's private detail — callers never parse a
raw property themselves.

---

## Secrets / configuration keys (owned by `Config`)

Set manually in the editor: **Project Settings → Script Properties.** Never in source
(ADR 003). `Config` validates that every required key is present at startup and throws
a clear, named error if one is missing — it never proceeds with an `undefined`.

| Key | Required | Format | Example | Where to get it |
|---|---|---|---|---|
| `ALPHA_VANTAGE_KEY` | yes | string | `RIBXT3XYZ...` | alphavantage.co free API key |
| `TWILIO_SID` | yes | `AC` + 32 hex | `AC1a2b...` | Twilio console → Account Info |
| `TWILIO_AUTH_TOKEN` | yes | 32 hex | `f9e8d7...` | Twilio console → Account Info |
| `TWILIO_FROM_NUMBER` | yes | E.164 | `+15095551234` | Your Twilio phone number |
| `RECIPIENT_NUMBER` | yes | E.164 | `+17075559876` | The recipient's mobile (Eureka, CA) |
| `WEBHOOK_TOKEN` | yes | long random | `9f3c…` (64 ch) | Bearer token in the webhook URL `?k=` (ADR 008) |
| `VERIFIER_KEY` | yes | long random | `k7Q…` | HMAC key for the `[#N TAG]` message signature (ADR 008); shared out-of-band with the recipient |
| `UNLOCK_SECRET` | yes | random | `re-arm…` | Re-arms the bot after auto-lockout (ADR 008) |
| `DEBUG_MODE` | no | `"true"` / unset | `true` | Set to `"true"` to log instead of sending |

(Twilio auth uses a **scoped API Key / subaccount, not the master `TWILIO_AUTH_TOKEN`** —
ADR 008 — so a leaked property can at worst send messages, not own the account.)

**Notes:**
- `RECIPIENT_NUMBER` is load-bearing for security: `doPost` compares `From` against it
  before acting on any command (ADR 006 §11). It must be exact E.164 to match Twilio's
  `From` value.
- `DEBUG_MODE` absent or anything other than `"true"` means live sending. Only the
  literal string `"true"` enables debug logging.
- `DEBUG_MODE` **gates Twilio only** — it makes `SmsService` log instead of send. It does
  *not* stop Alpha Vantage calls, so a debug-mode `testSendNow` still spends AV quota.

---

## Mutable state keys (owned by `Watchlist`)

| Key | Format | Example | Default when unset |
|---|---|---|---|
| `WATCHLIST` | JSON array of ticker strings | `["SPY","GLD","SLV"]` | `["SPY","GLD","SLV"]` (ADR: default list) |
| `PAUSED` | `"true"` / `"false"` | `"false"` | treated as not paused |

**Behavior:**
- When `WATCHLIST` is absent, `Watchlist.tickers()` returns the default `SPY, GLD, SLV`
  — the store is not pre-seeded; the default lives in code.
- `Watchlist` rewrites the whole `WATCHLIST` value on every add/remove, under a
  `LockService` script lock so the read-modify-write is atomic against concurrent
  `doPost`s (ADR 006 §5). A single property write; no cross-key transaction (ADR 004).
- Ticker symbols are stored uppercased and de-duplicated by `Watchlist` on write.
- The watchlist is **capped at 10 tickers** — the Alpha Vantage free-tier budget (ADR
  007). `add` refuses beyond the cap with a friendly reply.

**Security / message state (ADR 008), owned by the security layer — not `Watchlist`:**
the message sequence **counter**, the **lockout** attempt-count + sealed flag, the recent
**`MessageSid`** replay set (TTL), and a bounded **audit** log (senders hashed) — same
single-owner discipline as above.

**Reserved (not yet implemented):** if duplicate-send protection is added later, a
`LAST_SENT_DATE` key (owned by `Watchlist` or `Scheduler`) would record the last
successful send date to guard against a double-firing trigger. Not built; noted so the
key name is claimed and the decision is visible.

---

## Storage limits

`PropertiesService` (Script scope) hard limits — far beyond Spazito's needs, documented
so they are never a surprise:

| Limit | Value | Spazito usage |
|---|---|---|
| Value size | ~9 KB per property | `WATCHLIST` of a few tickers is bytes |
| Total size | ~500 KB per scope | negligible |
| Property count | ~50 keys per scope | ~8 keys total |

If the watchlist ever approached the 9 KB value ceiling (hundreds of tickers), the
encoding would need revisiting — but that is far outside the product's single-recipient
scope.

---

## Quick reference: reading state safely

```
Config.require("TWILIO_AUTH_TOKEN")   // secrets — Config only, throws if missing
Watchlist.tickers()                   // state  — Watchlist only, returns array
Watchlist.isPaused()                  // state  — Watchlist only, returns boolean
```

Anything that reaches into `PropertiesService.getScriptProperties()` directly, outside
those two modules, is a boundary violation (ADR 006 §5).
