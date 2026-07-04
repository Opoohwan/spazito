# Spazito — Architecture

> **Status: design blueprint.** `src/` is not yet implemented. This document
> describes the intended system exactly as the ADRs specify it. Where it names a
> module or behavior that isn't built yet, that is the target, not a claim of
> current state. The binding rules live in **ADR 006** (`doc/decisions/`); this is
> the map, that is the law.

## What Spazito is

A serverless SMS market-alert system running entirely on Google Apps Script. Once a
weekday at 5:00pm the recipient's local time (`America/Los_Angeles`, ADR 002), it
texts a one-line price summary. The recipient can text commands back to change the
watchlist or pause alerts. No server, no database — GAS provides the trigger, the
key-value store, the HTTP client, and the inbound webhook (ADR 001).

---

## Two kinds of module — the core/shell seam

Every file is exactly one kind. There is no third kind, and no file is both (ADR 005).

| Kind | Location | May do | May **never** do |
|---|---|---|---|
| **Core** (pure) | `src/core/` | Take data, return data. String building, parsing, math. | Any I/O: no `UrlFetchApp`, `PropertiesService`, `new Date()`, Twilio/Alpha Vantage. |
| **Shell** (effects) | `src/` | Fetch, send, persist, read config/clock, orchestrate. Call the core. | Implement pure logic inline (formatting, parsing) — that belongs in core. |
| **Entrypoints** | `src/` (global fns) | `doPost`, trigger targets, `test*` — GAS requires these global. | Contain business logic — they delegate to a module. |

**Decision test:** a new bit of *logic* (a formatting rule, a parse case) → core, pure
function, with a test. A new *effect* (a new API call, a new persisted value) → the
shell module that owns that boundary. If you can't say which module owns it, that's a
missing named concept — name it before writing it.

---

## System overview

```
                         Time trigger (Mon–Fri 5pm America/Los_Angeles)
                                        │
                                        ▼
                              Scheduler.runDailyAlert()   ── SHELL, orchestrates only
                                        │
             ┌──────────────┬───────────┴───────────┬─────────────────┐
             ▼              ▼                        ▼                 ▼
        Watchlist       PriceService            Formatter         SmsService
      (state owner)   (Alpha Vantage only)   (core, pure)      (Twilio only)
             │              │                        │                 │
       PropertiesService  UrlFetchApp          (no I/O)          UrlFetchApp
                                                                       │
                                                                    Twilio ──► phone


        Twilio inbound webhook  (POST form-encoded)
                                        │
                                        ▼
                              CommandHandler.doPost(e)     ── SHELL, entrypoint
                                        │
        1. authorize: e.parameter.From == Config.recipient()   ◄── FIRST, always
        2. parse:     CommandParser.parse(Body)   ── core, pure
        3. dispatch:  COMMANDS[intent.type](arg)  ── table, not a switch
        4. reply:     SmsService.send(confirmation)
```

---

## Module map

Condensed from ADR 006 §4 (the No-Bleed Boundary Map). Each module owns one thing.

| Module | Kind | Sole responsibility |
|---|---|---|
| `Config` | shell | Read + validate all **secrets** from Script Properties |
| `Watchlist` | shell | Own all **mutable state** (tickers, paused) and its schema |
| `PriceService` | shell | The **only** caller of Alpha Vantage |
| `SmsService` | shell | The **only** caller of Twilio |
| `core/Formatter` | core | Quote data → the message string (money-formatting rules) |
| `core/CommandParser` | core | Raw SMS body → a parsed command intent |
| `Scheduler` | shell | Orchestrate the daily run — nothing else |
| `CommandHandler` | shell | `doPost`: authorize → parse → dispatch → reply |

---

## Data flow: the daily alert

```
Time trigger fires
  │
  ▼
Scheduler.runDailyAlert()
  │  wrapped in a top-level try/catch (unattended — never die silently)
  ▼
Watchlist.isPaused()?  ── yes ──►  return, send nothing
  │ no
  ▼
Watchlist.tickers()               → ["SPY","GLD","SLV"] (or custom list)
  │
  ▼
PriceService.quotesFor(tickers)   → per-ticker try/catch; one failure ≠ whole failure
  │                                  returns { ok:[{ticker,price}], failed:[ticker] }
  ▼
Formatter.summaryLine(quotes.ok)  → "S&P 7,500 | Gold 4,500 | Silver 70.00"
  │                                  (pure; unit-tested; appends note if any failed)
  ▼
SmsService.send(message)          → Twilio REST  (or logs, if DEBUG_MODE)
```

**Partial-send invariant:** if at least one ticker resolves, a message goes out with
the successful subset. A single ticker failure never produces zero output (ADR 006 §9).

---

## Data flow: an inbound command

```
Twilio POSTs form-encoded { From, Body } to the web-app URL
  │
  ▼
CommandHandler.doPost(e)
  │
  ▼
Authorize:  e.parameter.From === Config.recipient()?
  │  no  ──►  do nothing, return empty 200  (no informative reply to strangers)
  │ yes
  ▼
CommandParser.parse(e.parameter.Body)   → { type:"add", arg:"TSLA" }   (pure)
  │                                        empty/garbage → { type:"help" }
  ▼
COMMANDS[type](arg)    ── dispatch table, one small handler each
  │   add/remove → Watchlist ;  pause/resume → Watchlist ;  list/status → Watchlist
  │   add also validates the ticker via PriceService before inserting
  ▼
SmsService.send(confirmation)   ── replies are outbound REST, never TwiML (ADR 006 §11)
```

---

## Code quality standard

The binding standard is **ADR 006**. In brief, every change must satisfy:

- **No bleed.** `getScriptProperties` appears only in `Config` (secrets) and
  `Watchlist` (state). The Alpha Vantage host appears only in `PriceService`. The
  Twilio host appears only in `SmsService`. A hit elsewhere is a defect.
- **Core stays pure.** No GAS global is ever imported into a `src/core/` file.
- **No god code, no `Utils` grab-bag.** One function, one reason. Pure and effectful
  logic never share a function.
- **Every core function has a test.** The core exists precisely so it can be tested in
  Node without GAS.

---

## Key invariants

- The daily run is wrapped in a top-level try/catch; an unexpected error is logged,
  never swallowed silently (it runs unattended).
- No single ticker failure produces an empty message — partial send always.
- `doPost` authorizes the sender **before any command logic runs**.
- `doPost` replies via `SmsService` (Twilio REST). It never returns TwiML — a GAS web
  app cannot reliably produce the content type Twilio's inline path expects.
- All timezone reasoning uses `America/Los_Angeles` (ADR 002).
- No secret is ever hardcoded or logged (ADR 003, ADR 006 §11).
