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
appsscript.json          — manifest; webapp access set to "Anyone" (required for Twilio webhook)
src/
  Config.gs              — reads all API keys from Script Properties (NEVER hardcode keys)
  PriceService.gs        — Alpha Vantage GLOBAL_QUOTE fetches
  SmsService.gs          — outbound SMS via Twilio REST API
  Scheduler.gs           — 5pm Mon-Fri trigger; calls PriceService + SmsService
  CommandHandler.gs      — doPost(e) entrypoint; parses incoming SMS, routes to commands
  Watchlist.gs           — get/add/remove tickers, get/set paused state, via PropertiesService
.clasp.json              — clasp config (GITIGNORED — contains script ID)
.gitignore               — excludes .clasp.json and any local secrets
README.md                — full setup and deployment instructions
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

`Config.gs` reads all of these. If a key is missing, it should throw a clear error immediately rather than silently failing mid-run.

## Feature Spec

### Scheduled alert (Scheduler.gs)
- Time-based trigger: Mon–Fri at 5:00pm **America/Los_Angeles** (recipient's own zone, Eureka CA — tracks their wall clock through DST; see ADR 002)
- Default watchlist: SPY, GLD, SLV (if PropertiesService has no custom list)
- If `paused` flag is true: skip entirely, send nothing
- Fetch each ticker via Alpha Vantage GLOBAL_QUOTE
- Message format (confirmed with user):
  ```
  S&P 7,500 | Gold 4,500 | Silver 70.00
  ```
  - SPY → label "S&P", price: thousands-comma, no decimals
  - GLD → label "Gold", price: thousands-comma, no decimals
  - SLV → label "Silver", price: exactly 2 decimal places
  - Custom tickers: `Ticker Price | Ticker Price | ...` — generalize gracefully

### Incoming SMS commands (CommandHandler.gs → doPost)
Twilio POSTs form-encoded data. Read `e.parameter.Body` and `e.parameter.From`.

- **Security:** validate `From` matches `RECIPIENT_NUMBER` before acting on any command
- **Commands** (case-insensitive, trim whitespace):
  - `add TICKER` — validate ticker via Alpha Vantage first, then add to watchlist
  - `remove TICKER` — remove from watchlist; friendly no-op if not present
  - `pause` / `stop` — set paused flag true
  - `resume` / `start` — set paused flag false
  - `list` / `status` — reply with current watchlist + active/paused state
  - Unrecognized — reply with short help message listing valid commands
- Every command sends a confirmation SMS back via Twilio REST API (not TwiML response)

### Error handling (runs unattended — this matters)
- Wrap all Alpha Vantage calls in try/catch
- If one ticker fails, don't fail the whole message — send what succeeded, note the failure
- If Twilio send fails, log to Apps Script execution log
- Guard against unauthorized senders on the webhook
- Guard against malformed/empty SMS bodies
- Alpha Vantage free tier: 25 req/day, 5/min — well within normal usage, but respect it

## Code Style

**This project has different commenting rules than most.** The end user is non-technical and this code may sit unmaintained for long stretches between visits. Someone unfamiliar with Apps Script will need to read it.

- Comment setup/config sections — explain what each Script Property is for and where to get it
- Comment the trigger installation and deployment steps inline where they appear in code
- Comment non-obvious Apps Script behavior (e.g. why `doPost` can't return TwiML, why the trigger must be created manually)
- Keep comments on the WHY, not the what — but when the audience is non-technical, err toward more

This overrides the usual "write no comments" default.

## Key Invariants

- **Never hardcode API keys in source.** They will be committed to git. All secrets live in Script Properties, read via `Config.gs`.
- `.clasp.json` must be in `.gitignore` — it contains the script ID which ties to the live script.
- All times/triggers use `America/Los_Angeles` (the recipient's zone; DST-aware so "5pm" always means 5pm on their clock — see ADR 002).
- `doPost` must validate the sender's phone number before executing any command.
- `DEBUG_MODE=true` in Script Properties logs instead of sending — use this when iterating on formatting.

## Testing

- `testSendNow()` — bypasses the time trigger, runs the full scheduled alert flow immediately
- `DEBUG_MODE` Script Property — set `"true"` to log output instead of firing Twilio calls
- Test incoming commands by texting the Twilio number directly after deploying the web app

## Deployment Checklist

1. `npm install -g @google/clasp`
2. `clasp login`
3. `clasp create --type webapp` (or `clasp clone <scriptId>` for existing)
4. Set all Script Properties (see table above)
5. `clasp push`
6. Deploy as Web App via `clasp deploy` — copy the resulting URL
7. In Twilio console: set the number's "A message comes in" webhook to the Web App URL, method POST
8. Run `createTrigger()` once to install the Mon-Fri 5pm time-based trigger (can't be created by push alone — must run once in editor or via `clasp run`)
9. Smoke test: text `list` to the Twilio number, confirm reply; run `testSendNow()`, confirm SMS arrives
