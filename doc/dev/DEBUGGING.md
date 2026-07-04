# Spazito — Debugging Guide

> How to diagnose Spazito from the outside when the recipient says "I didn't get my
> text" or "the command didn't work." Spazito runs unattended on Google's
> infrastructure, so nearly all diagnosis happens through the **Apps Script execution
> log**. There is no server to SSH into.

---

## Where the logs are

Apps Script records every trigger fire and every `doPost` as an **execution**.

| How | Where |
|---|---|
| Web UI | script.google.com → open the project → **Executions** (left sidebar) |
| From `clasp` | `clasp logs` (streams recent executions to your terminal) |
| Direct link | `clasp open` → Executions tab |

Each execution shows: what ran (`runDailyAlert`, `doPost`), the start time, the
duration, the status (Completed / Failed), and any `console.log/warn/error` output.

**Log levels and what they mean** (ADR 006 §11):

| Level | Use for | Example |
|---|---|---|
| `console.error` | Unrecoverable — needs a human | Twilio send failed; *all* tickers failed |
| `console.warn` | Recoverable anomaly worth noting | one ticker failed; Alpha Vantage rate-limit note seen |
| `console.log` | Lifecycle | run started/finished; command received |

**What never appears in a log, by design:** `TWILIO_AUTH_TOKEN`, `TWILIO_SID`,
`ALPHA_VANTAGE_KEY`, or any auth header. Ticker symbols, counts, and which ticker
failed are fine and expected.

---

## The DEBUG_MODE switch

Set the Script Property `DEBUG_MODE="true"` to make `SmsService` **log the message it
would send instead of sending it.** Use this to:

- iterate on message formatting without spending Twilio credit,
- confirm the daily flow end-to-end (run `testSendNow`, read the logged message),
- reproduce a formatting bug the recipient reported.

Remember to remove it (or set anything other than `"true"`) to resume live sending.

---

## Common failure patterns

### "No text arrived at 5pm"

Work down this list — it's ordered by likelihood:

1. **Is it paused?** Check the `PAUSED` Script Property (or text `list`). If `"true"`,
   the run returns immediately and sends nothing — by design. Text `resume`.
2. **Did the trigger fire?** Executions tab → look for a `runDailyAlert` entry near
   5pm Pacific. No entry → the time trigger isn't installed. Run `createTrigger()`
   once (it cannot be installed by `clasp push` alone — it must be run in the editor
   or via `clasp run`).
3. **Did the run fail?** If the `runDailyAlert` execution shows **Failed**, open it and
   read the error. A `Config` error ("Missing Script Property: …") means a secret isn't
   set.
4. **Did every ticker fail?** If the log shows `console.error` about all tickers, Alpha
   Vantage is likely rate-limited (see below) or down. Partial-send means *some*
   failing still sends the rest — *all* failing sends nothing and logs an error.
5. **Did Twilio reject the send?** A `console.error` from `SmsService` with a Twilio
   status code (e.g. 21608 = unverified number on trial, 20003 = auth failed) points
   at Twilio config, not Spazito logic.

### "One ticker is missing from the text"

Expected behavior when a single ticker fails — the message still sends with the rest
and notes the failure (partial-send, ADR 006 §9). Likely causes:

- **Alpha Vantage rate limit.** Free tier is **25 requests/day, 5/minute.** A large
  watchlist or repeated `testSendNow` runs can exhaust it. The API returns a `Note`/
  `Information` envelope instead of a quote; `PriceService` logs a `console.warn`.
- **Bad symbol.** A custom ticker added via SMS that Alpha Vantage doesn't recognize.
  (`add` is supposed to validate before inserting — if a bad symbol got in, check that
  validation path.)

### "I texted a command and nothing happened / no reply"

1. **Wrong sender.** `doPost` only acts if `From` exactly equals `RECIPIENT_NUMBER`
   (E.164). A mismatch (different number, or format like `17075559876` vs
   `+17075559876`) is silently ignored — no reply to strangers, by design. Confirm the
   `RECIPIENT_NUMBER` property matches the sending phone exactly.
2. **Webhook not wired.** In the Twilio console, the number's "A message comes in"
   webhook must be the **current** web-app deployment URL, method **POST**. A stale URL
   (from before a redeploy) sends messages into the void. Check the Executions tab —
   no `doPost` entry when you text means Twilio never reached the app.
3. **Malformed body.** An empty or unparseable body should fall through to the help
   reply, not an error. If it errored, check `CommandParser`.

### "I got the text twice"

Almost always a **double-installed trigger.** Deleting and recreating a trigger without
removing the old one leaves two. Check Triggers (clock icon in the editor) and remove
duplicates. `createTrigger()` should clear existing Spazito triggers before installing
(verify it does).

---

## Inspecting live state

The watchlist and paused flag are just Script Properties:

- **Editor:** Project Settings → Script Properties — read `WATCHLIST` and `PAUSED`
  directly.
- **Over SMS:** text `list` (or `status`) — the fastest check; it returns the current
  watchlist and active/paused state without opening the console.

Secrets are visible in the same Script Properties panel — treat that screen as
sensitive; it shows the Twilio auth token in plaintext.

---

## Verifying the schedule is real

Two things must both be true for the 5pm alert to fire:

1. **Timezone** — `appsscript.json` `timeZone` is `America/Los_Angeles` (ADR 002).
2. **Trigger** — a time-based trigger for `runDailyAlert`, weekly Mon–Fri, 5pm, exists
   in the Triggers panel. If it's missing, `createTrigger()` was never run in this
   deployment.

A common trap: `clasp push` uploads code but **does not** install triggers. The trigger
is runtime state in the script, not source. It must be created once, in the editor or
via `clasp run createTrigger`.
