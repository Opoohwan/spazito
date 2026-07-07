# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What is Spazito

Automated SMS market price alerts — texts the user's phone every weekday at 5:00pm with prices for S&P 500, Gold, and Silver (and any customized watchlist). The recipient can text commands back to control what gets tracked and whether alerts are active.

Runs entirely on free-tier infrastructure. No server, no database.

## Stack

- **Platform:** Google Apps Script (Google's infrastructure, free, built-in time triggers)
- **CLI:** `clasp` (`@google/clasp`) — local development, version control, push from VS Code
- **Price data:** Alpha Vantage free API (`GLOBAL_QUOTE` endpoint)
- **SMS:** Twilio (~$0.0079/message; free trial credit to start)
- **Storage:** Apps Script `PropertiesService` — key-value store, no external DB

## Project Structure

```
src/                     — the ONLY folder clasp pushes (.clasp.json rootDir: "src")
  appsscript.json        — manifest; must live inside src/ (clasp rootDir); webapp access "Anyone" (Twilio webhook); timezone America/Los_Angeles
  Config.js              — sole reader/validator of secret Script Properties; fails loud if any missing
  Watchlist.js           — sole owner of mutable state (watchlist + paused); LockService-guarded writes
  PriceService.js        — sole caller of Alpha Vantage GLOBAL_QUOTE; spaces calls, no retries (ADR 007); returns ordered [{ticker,price,ok}]
  SmsService.js          — sole caller of Twilio REST; DEBUG_MODE logs instead of sending
  Scheduler.js           — orchestrates the daily run (Watchlist → PriceService → Formatter → Signer → SmsService); trigger + testSendNow
  SecurityGate.js        — the webhook authorization decision (ADR 008: sealed → token → From → replay)
  SecurityVault.js       — sole owner of security state (sequence counter, lockout, replay set, audit ring)
  Signer.js              — appends the [#N TAG] auth block (the offline verifier's contract)
  Locks.js               — the one home of the script-lock discipline (shared by Watchlist + SecurityVault)
  CommandHandler.js      — doPost(e): gate → parse → dispatch table → reply
  core/                  — pure modules (no I/O; unit-tested in Node; tests live alongside as *.test.js, kept off the push by .claspignore)
    Formatter.js         — quote data → the message string (display-rules table; ADR 006 §10)
    CommandParser.js     — raw SMS body → parsed command intent
    Replies.js           — all command-reply copy (warm, says what happened + next step)
    Tickers.js           — canonical ticker text rules for shell callers (normalize once at the boundary)
    Redactor.js          — scrubs secret-shaped substrings before anything is logged
    SecureCompare.js     — constant-time string equality for the auth gate
.clasp.json              — clasp config (GITIGNORED — contains script ID)
.gitignore               — excludes .clasp.json, secrets, node_modules, coverage
README.md                — orientation; full setup lives in doc/dev/PROCESSES.md

Source is authored as .js so Node/Jest load it directly for tests; clasp pushes these to
Apps Script, where they run as .gs in one shared global scope. The dual-load guard
(`if (typeof module !== 'undefined') module.exports = {...}`) makes each file work in
both environments. See ADR 006 §2.
```

## Commands

```bash
# Install clasp globally
npm install -g @google/clasp

# Authenticate
clasp login

# Push code to Apps Script
clasp push

# Open the Apps Script editor in browser
clasp open

# Deploy as web app (get the webhook URL for Twilio)
clasp deploy

# Run a specific function (e.g. one-time setup)
clasp run createTrigger
clasp run testSendNow
```

## Configuration (Script Properties — never in source)

Set these via `clasp open` → Project Settings → Script Properties:

| Key | Purpose |
|-----|---------|
| `ALPHA_VANTAGE_KEY` | Alpha Vantage API key |
| `TWILIO_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | Twilio outbound number (E.164 format) |
| `RECIPIENT_NUMBER` | SMS destination (E.164 format) |
| `DEBUG_MODE` | Set `"true"` to log instead of sending SMS |

`Config.js` reads all of these. If a key is missing, it should throw a clear error immediately rather than silently failing mid-run.

## Feature Spec

### Scheduled alert (Scheduler.js)
- Time-based trigger: Mon–Fri at 5:00pm **America/Los_Angeles** (recipient's own zone, Eureka CA — tracks their wall clock through DST; see ADR 002)
- Default watchlist: SPY, GLD, SLV (if PropertiesService has no custom list)
- Watchlist capped at 10 tickers — Alpha Vantage free-tier budget (see ADR 007)
- If the watchlist is empty: send a short "watchlist is empty — text `add TICKER`" notice, not a blank text
- If `paused` flag is true: skip entirely, send nothing
- Fetch each ticker via Alpha Vantage GLOBAL_QUOTE, **spacing calls to stay under 5/min** (ADR 007)
- Message format (base format confirmed with user; the failed-ticker and custom-ticker
  rules below were decided 2026-07-04 and are open to your adjustment):
  ```
  S&P 7,500 | Gold 4,500 | Silver 70.00 [#47 A3F9C2E1]
  ```
  `Formatter` (core) builds the price line; a **shell signer** then appends the `[#N TAG]`
  auth block (sequence count + HMAC — ADR 008 §6) so the recipient can verify authenticity
  with `tools/spazito-verifier.html`. Display rules live as a **data table in
  `core/Formatter.js`** (ADR 006 §10), not scattered as per-ticker branches:
  - SPY → label "S&P", thousands-comma, **0 decimals**
  - GLD → label "Gold", thousands-comma, **0 decimals**
  - SLV → label "Silver", thousands-comma, **2 decimals**
  - Any other (custom) ticker → label = the symbol, thousands-comma, **2 decimals** (the default rule)
  - A ticker whose fetch failed shows in place as `Label n/a`
    (e.g. `S&P n/a | Gold 4,500 | Silver 70.00`) — the line never silently drops a slot

### Incoming SMS commands (CommandHandler.js → doPost)
Twilio POSTs form-encoded data. Read `e.parameter.Body` and `e.parameter.From`.

- **Security:** validate `From` matches `RECIPIENT_NUMBER` before acting on any command.
  This is the *baseline* guard — and `From` is spoofable by anyone who learns the webhook
  URL, so a POST body alone is not proof of origin. Twilio request-signature validation
  is the hardening path (ADR 006 §11 + ROADMAP).
- **Commands** (case-insensitive, trim whitespace):
  - `add TICKER` — validate via Alpha Vantage first (costs one call, ADR 007), then add.
    Already present → friendly "already tracking" no-op. Unknown symbol → "couldn't find
    TICKER — not added". At the 10-ticker cap → refuse with a friendly message.
  - `remove TICKER` — remove from watchlist; friendly no-op if not present; if this
    empties the list, confirm and note the list is now empty.
  - `pause` / `stop` — set paused flag true
  - `resume` / `start` — set paused flag false
  - `list` / `status` — reply with current watchlist + active/paused state
  - `help` — reply with the short help message listing valid commands
  - `log` — reply with the recent security audit (blocked attempts, senders hashed) —
    security is pull, not push (ADR 008 §4)
  - `unlock SECRET` — re-arm a sealed bot (the secret is case-sensitive and must arrive
    with the valid URL token and From; handled inside the gate)
  - Unrecognized — reply with the same short help message
  - Parsing is deliberately lenient: words after the command are ignored
    (`add TSLA please` adds TSLA; only the FIRST token after add/remove is the ticker)
  - An argument that isn't even ticker-shaped (`add $$$$$`) is refused for free with a
    friendly "doesn't look like a ticker" reply — no Alpha Vantage call is spent
  - A write that loses the storage lock replies "busy — try again" (ADR 006 §5)
  - **Carrier-keyword caveat:** `STOP` is intercepted by Twilio/the carrier as a full
    opt-out (error 21610 on all sends after) and only `START` — not `resume` — undoes
    it. Help copy steers the recipient to `pause`/`resume`; texting `HELP` may produce
    a second, carrier-generated reply. Accepted platform behavior.
- Every command sends a confirmation SMS back via Twilio REST API (not TwiML response)

### Error handling (runs unattended — this matters)
- Wrap the whole scheduled run in a **top-level try/catch** — never die silently
- Wrap all Alpha Vantage calls in **per-ticker** try/catch
- If one ticker fails, don't fail the whole message — send what succeeded; the failed
  ticker shows as `Label n/a` in place (see message format)
- If Twilio send fails, log to Apps Script execution log
- Guard against unauthorized senders on the webhook
- Guard against malformed/empty SMS bodies
- Alpha Vantage free tier: 25 req/day, 5/min — the watchlist cap and call spacing keep
  the daily run within budget (ADR 007)
- Market holidays: the trigger still fires Mon–Fri; on a closed-market day Alpha Vantage
  returns the last close, so the text reflects prior-close prices. Accepted behavior.

## Code Style

**This project has different commenting rules than most.** The end user is non-technical and this code may sit unmaintained for long stretches between visits. Someone unfamiliar with Apps Script will need to read it.

- Comment setup/config sections — explain what each Script Property is for and where to get it
- Comment the trigger installation and deployment steps inline where they appear in code
- Comment non-obvious Apps Script behavior (e.g. why `doPost` can't return TwiML, why the trigger must be created manually)
- Keep comments on the WHY, not the what — but when the audience is non-technical, err toward more

This overrides the usual "write no comments" default.

## Key Invariants

- **Never hardcode API keys in source.** They will be committed to git. All secrets live in Script Properties, read via `Config.js`.
- `.clasp.json` must be in `.gitignore` — it contains the script ID which ties to the live script.
- All times/triggers use `America/Los_Angeles` (the recipient's zone; DST-aware so "5pm" always means 5pm on their clock — see ADR 002).
- `doPost` runs the **layered auth gate** (URL token → `From` → `MessageSid` replay) before any command — **ADR 008 is authoritative; it is required, not optional.**
- `DEBUG_MODE=true` gates **Twilio sends only** (logs instead of texting). It does *not* stop Alpha Vantage calls — formatting iteration still spends quota unless the fetch is mocked.

## Testing

- `testSendNow()` — bypasses the time trigger, runs the full scheduled alert flow immediately
- `DEBUG_MODE` Script Property — set `"true"` to log the outbound SMS instead of firing Twilio. Gates Twilio only; `testSendNow` still calls Alpha Vantage and spends quota. To exercise formatting with zero spend, unit-test `Formatter` in Node.
- Test incoming commands by texting the Twilio number directly after deploying the web app

## Deployment Checklist

The canonical, step-by-step setup and deployment guide is the single source of truth in
[`doc/dev/PROCESSES.md`](doc/dev/PROCESSES.md) — kept in one place so the steps can't
drift between two files. In brief: `clasp login` → create/clone → set Script Properties
→ `clasp push` → `clasp deploy` → wire the Twilio webhook (POST) → run `createTrigger()`
once → smoke test (`list`, then `testSendNow`).
