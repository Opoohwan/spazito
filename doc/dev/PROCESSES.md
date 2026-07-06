# Spazito — Development Processes

How to do the common development tasks. Spazito is developed locally with `clasp` and
runs on Google Apps Script; there is no build system beyond `clasp push`.

> **clasp version note:** the commands below use the clasp 2.x names. clasp 3.x renamed
> several — `create` → `create-script`, `deploy` → `create-deployment`, `run` →
> `run-function`. If a command fails with "unknown command", try the 3.x name; the
> workflow is otherwise identical.

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
2. `clasp create --type webapp` (new) or `clasp clone <scriptId>` (existing). Then,
   **before any push:**
   - Edit the generated `.clasp.json` so it contains `"rootDir": "src"`. The real
     manifest lives at `src/appsscript.json` and only `src/` is ever pushed. Pushing
     before this edit would upload clasp's default manifest instead — wrong timezone, no
     anonymous web-app access — and the Twilio webhook would break.
   - Delete any `appsscript.json` / `Code.js` that `clasp create` generated at the
     project root; the committed `src/appsscript.json` is the only manifest.

   The repo's `.claspignore` is the backstop that keeps `*.test.js` off the push (a
   pushed test file's `require` would kill every execution — ADR 006 §12). Its test-file
   globs are the load-bearing lines; the `node_modules`/`doc`/config entries only matter
   if `rootDir` was forgotten. (`.claspignore` is glob-matched — it does **not** support
   `#` comments, which is why the explanation lives here instead of in the file.)
3. Set **all** Script Properties (see `SCHEMA.md` for the full table): the five
   secrets, plus `DEBUG_MODE` if iterating.
4. `clasp push`
5. `clasp deploy` → copy the resulting web-app URL
6. In the Twilio console, set the number's "A message comes in" webhook to that URL,
   method **POST**
7. Install the Mon–Fri 5pm trigger — push alone does **not** do this; the trigger is
   runtime state, not source. The reliable path: `clasp open`, select `createTrigger`
   in the editor's function dropdown, click **Run**. (`clasp run createTrigger` does
   the same but needs extra GCP setup and was renamed `run-function` in clasp 3.x —
   treat it as the optional path, not the required one.)
8. Smoke test: text `list` → confirm the reply; run `testSendNow` → confirm the SMS
   arrives (or, with `DEBUG_MODE="true"`, confirm the message is logged)

**Twilio trial-account gotchas (before the account is upgraded):**
- A trial account can only text **verified** numbers. Verify the recipient's number in
  the Twilio console first, or every send fails with error **21608** in the execution
  log.
- Twilio **prepends "Sent from your Twilio trial account - " to every message body** on
  trial. That prefix lands inside the span the `[#N TAG]` signature covers, so the
  offline verifier will report **every message as unverified until the account leaves
  trial**. This is Twilio mutating the body, not a Spazito bug — upgrade before
  provisioning the verifier key, or warn the recipient that verification starts then.

**Why the web app is deliberately public:** `src/appsscript.json` sets
`"access": "ANYONE_ANONYMOUS"` + `"executeAs": "USER_DEPLOYING"`. Twilio cannot log in
to Google, so the webhook endpoint must accept anonymous POSTs, and executing as the
deployer is what lets `doPost` read Script Properties. This means every protection is
application-layer — the URL bearer token, sender check, replay lock, and lockout of
ADR 008. **Do not wire the Twilio webhook to a live deployment until those gates exist
in code (Chunk 8b).**

---

## Adding a command

Commands follow the dispatch-table pattern (ADR 006 §6) — never a growing `switch`.
Three small edits:

1. **Parse it** (core, pure) — add a case in `core/CommandParser.js` that maps the raw
   body to an intent: `"snooze 3"` → `{ type: "snooze", arg: "3" }`.
2. **Handle it** (shell) — add one entry to the `COMMANDS` table in `CommandHandler.js`.
   The handler is a few lines; it delegates to the module that owns the work
   (`Watchlist`, `PriceService`, …). It does not contain business logic itself.
3. **Test the parse** — add a unit test in the `CommandParser` test file covering the
   command and any alias.

If the handler needs more than a few lines, the logic belongs in a module, not in the
table entry.

---

## Adding or changing a ticker display rule

Money formatting is pure logic and lives entirely in `core/Formatter.js` (ADR 006 §10).
Never add a `.toFixed` or comma-grouping call to a shell module.

1. Add or adjust the rule in `Formatter` (e.g. a new label, a different decimal count).
2. Add a unit test covering the edge cases: a sub-dollar price, an unusually large
   price (comma grouping), the exact decimal rule, and a missing/failed quote.

**`Formatter.DISPLAY_RULES` (the table in `src/core/Formatter.js`) is the source of
truth.** Illustration only — as of this writing: SPY→"S&P" and GLD→"Gold" use
thousands-comma, 0 decimals; SLV→"Silver" uses 2 decimals; the default rule for any
custom ticker is symbol label + 2 decimals; a failed ticker renders in place as
`Label n/a`. If this paragraph and the code table ever disagree, the code table wins.

---

## Testing

- **Core (Node).** `Formatter` and `CommandParser` are pure — no GAS deps — so they run
  in Node under Jest with no deploy. The harness is stood up in **Chunk 0** (see
  ROADMAP), *before* any feature code: the `.js` core carries the dual-load guard
  (`if (typeof module !== 'undefined') module.exports = {...}`) so the same file loads in
  both GAS and Node. Coverage floor is 80% lines/branches, enforced by config.
- **Shell (GAS).** Smoke-test the effectful flow with `testSendNow` (runs the full
  daily-alert path immediately, bypassing the trigger) and `DEBUG_MODE="true"` (logs
  instead of sending — no Twilio spend). Note `DEBUG_MODE` gates Twilio only; the run
  still calls Alpha Vantage and spends quota — to test formatting with zero spend,
  unit-test `Formatter` in Node.
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
