# Spazito — Development Processes

How to do the common development tasks. Spazito is developed locally with `clasp` and
runs on Google Apps Script; there is no build system beyond `clasp push`.

---

## clasp commands

```bash
# Install clasp globally (one time)
npm install -g @google/clasp

# Authenticate with your Google account (one time)
clasp login

# Push local src/ up to the Apps Script project
clasp push

# Open the project in the Apps Script editor
clasp open

# Deploy as a web app — produces the URL Twilio POSTs to
clasp deploy

# Run a specific function in the cloud (e.g. install the trigger)
clasp run createTrigger
clasp run testSendNow

# Stream recent execution logs to the terminal
clasp logs
```

`.clasp.json` (the script ID) is **gitignored** — it ties the local checkout to the
live script and must never be committed (ADR 003).

---

## First-time deployment checklist

Condensed from the README. Order matters.

1. `npm install -g @google/clasp` → `clasp login`
2. `clasp create --type webapp` (new) or `clasp clone <scriptId>` (existing)
3. Set **all** Script Properties (see `SCHEMA.md` for the full table): the five
   secrets, plus `DEBUG_MODE` if iterating.
4. `clasp push`
5. `clasp deploy` → copy the resulting web-app URL
6. In the Twilio console, set the number's "A message comes in" webhook to that URL,
   method **POST**
7. `clasp run createTrigger` — installs the Mon–Fri 5pm trigger (push alone does not;
   the trigger is runtime state, not source)
8. Smoke test: text `list` → confirm the reply; run `testSendNow` → confirm the SMS
   arrives (or, with `DEBUG_MODE="true"`, confirm the message is logged)

---

## Adding a command

Commands follow the dispatch-table pattern (ADR 006 §6) — never a growing `switch`.
Three small edits:

1. **Parse it** (core, pure) — add a case in `core/CommandParser.gs` that maps the raw
   body to an intent: `"snooze 3"` → `{ type: "snooze", arg: "3" }`.
2. **Handle it** (shell) — add one entry to the `COMMANDS` table in `CommandHandler.gs`.
   The handler is a few lines; it delegates to the module that owns the work
   (`Watchlist`, `PriceService`, …). It does not contain business logic itself.
3. **Test the parse** — add a unit test in the `CommandParser` test file covering the
   command and any alias.

If the handler needs more than a few lines, the logic belongs in a module, not in the
table entry.

---

## Adding or changing a ticker display rule

Money formatting is pure logic and lives entirely in `core/Formatter.gs` (ADR 006 §10).
Never add a `.toFixed` or comma-grouping call to a shell module.

1. Add or adjust the rule in `Formatter` (e.g. a new label, a different decimal count).
2. Add a unit test covering the edge cases: a sub-dollar price, an unusually large
   price (comma grouping), the exact decimal rule, and a missing/failed quote.

Confirmed base rules: SPY→"S&P" and GLD→"Gold" use thousands-comma, no decimals;
SLV→"Silver" uses exactly two decimals; custom tickers generalize as `Ticker Price`.

---

## Testing

- **Core (Node).** `Formatter` and `CommandParser` are pure — no GAS deps — so they can
  be exercised by a Node test runner without deploying. *The Node harness itself is a
  Phase-2 dev task* (the `.gs` core is plain JS; a small loader or a shared build step
  exposes it to Node). Until then, exercise the core via `test*` functions in GAS.
- **Shell (GAS).** Smoke-test the effectful flow with `testSendNow` (runs the full
  daily-alert path immediately, bypassing the trigger) and `DEBUG_MODE="true"` (logs
  instead of sending — no Twilio spend, no Alpha Vantage quota burned on formatting
  work).
- **State isolation.** Any test touching `Watchlist` must leave `WATCHLIST` and
  `PAUSED` as it found them — never pollute the real state.
- Every core function has at least one test that would fail if its contract broke
  (ADR 006 §12).

---

## Installing / re-installing the trigger

The 5pm time trigger is **runtime state**, not source. `clasp push` never installs it.

- Install once per deployment: `clasp run createTrigger` (or run `createTrigger` in the
  editor).
- `createTrigger()` must remove any existing Spazito trigger before installing a new
  one — otherwise you get duplicate triggers and duplicate texts (see
  `DEBUGGING.md` → "I got the text twice").
- Verify in the editor's Triggers panel (clock icon): exactly one `runDailyAlert`,
  weekly, Mon–Fri, 5pm.

---

## Setting and rotating Script Properties

- Set/edit in the editor: Project Settings → **Script Properties**.
- There is no automated provisioning (ADR 003) — this is deliberate; secrets never
  touch the repo.
- **Rotating a key:** edit the value in Script Properties. No code change, no redeploy
  — `Config` reads the new value on the next run. (A Twilio or Alpha Vantage key
  rotation is just an edit here.)
- After adding a *new required* secret, update `Config`'s validation list and the
  `SCHEMA.md` table so a missing value keeps failing loudly.
