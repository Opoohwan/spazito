# Apps Script Architecture & Quality Standard — Technical Design Document

**Status:** Living document — updated as patterns evolve
**Authors:** David Lyon + Claude
**Applies to:** Spazito, all `src/` code

---

## 1. Purpose

This document is the strict quality and design-pattern standard for Spazito. It exists
to guarantee two things the project was explicitly built to protect: **exceptional
code quality** and **strict separation of concerns with no bleed between modules.**

These are **laws, not suggestions.** Deviating from a pattern here without updating
this document is a design violation, and the council gate treats it as a finding.
Every rule below carries an `Invariant:` line — the thing that must remain true — so a
reviewer (human or agent) can check conformance mechanically.

The architecture this standard enforces is decided in **ADR 005** (Functional Core,
Imperative Shell). Read that first; this document is how it is upheld.

---

## 2. Functional Core, Imperative Shell — The Seam

Every file is exactly one of two kinds. There is no third kind, and no file is both.

**Core (pure).** No GAS globals, no network, no clock, no `PropertiesService`. A core
function takes plain data and returns plain data. It can be run in Node with no mocks.

```js
// core/Formatter.gs — PURE. Imports nothing from GAS.
const Formatter = {
  // quotes: [{ ticker, price }]  ->  "S&P 7,500 | Gold 4,500 | Silver 70.00"
  summaryLine(quotes) { /* string building only */ },
};
```

**Shell (effects).** Fetches, sends, persists, reads config, reads the clock,
orchestrates. Thin: gather inputs → call the core → perform the effect with the result.

```js
// Scheduler.gs — SHELL. Orchestrates; contains no formatting and no fetching of its own.
function runDailyAlert() {
  if (Watchlist.isPaused()) return;                 // ask the state owner
  const tickers = Watchlist.tickers();              // ask the state owner
  const quotes  = PriceService.quotesFor(tickers);  // ask the fetcher
  const message = Formatter.summaryLine(quotes);    // ask the pure core
  SmsService.send(message);                         // ask the sender
}
```

**Invariant:** A core file contains zero references to `UrlFetchApp`,
`PropertiesService`, `CacheService`, `Utilities`, `new Date()`, or any Twilio/Alpha
Vantage call. If a core function needs "now" or a fetched value, it receives it as an
argument. An import of a GAS global into a core file is the single most serious
violation in this codebase.

**Invariant:** A shell function performs I/O **or** calls the core — it does not
*implement* pure logic inline. A `.toFixed()` money-formatting rule inside `Scheduler`
is a bleed; it belongs in `Formatter`.

---

## 3. Module-Object Namespacing

GAS runs every `.gs` file in **one shared global scope.** Forty bare global functions
collide and obscure ownership. Therefore each module is a single object literal named
for the file, and functions hang off it.

```js
const PriceService = {
  quotesFor(tickers) { ... },
  _quote(ticker)     { ... },   // leading underscore = module-internal, not for callers
};
```

**Invariant:** No bare global `function foo()` except the three kinds GAS *requires* to
be global: web-app entrypoints (`doPost`, `doGet`), trigger targets (e.g.
`runDailyAlert`), and manual test entrypoints (`testSendNow`, `test*`). Everything else
is a method on its module object.

**Invariant:** A method prefixed `_` is module-private. No other module may call it.
Cross-module calls use only the un-prefixed public surface.

---

## 4. The No-Bleed Boundary Map

This is the heart of the standard. Each module owns exactly one responsibility and may
only reach across the boundaries listed. Anything else is bleed.

| Module | Kind | Sole responsibility | May call | Must never |
|---|---|---|---|---|
| `Config` | shell | Read + validate all **secrets** from Script Properties | `PropertiesService` (secrets only) | Hold app state; format; fetch; send |
| `Watchlist` | shell | Own all **mutable state** (tickers, paused) + its schema | `PropertiesService` (state only) | Read secrets; fetch; format; send |
| `PriceService` | shell | The **only** caller of Alpha Vantage | `UrlFetchApp`, `Config` | Format prices; send SMS; touch state |
| `SmsService` | shell | The **only** caller of Twilio | `UrlFetchApp`, `Config` | Decide *what* or *when* to send; build message copy |
| `Formatter` | core | Turn quote data into the message string | (nothing) | Any I/O whatsoever |
| `CommandParser` | core | Turn a raw SMS body into a parsed intent | (nothing) | Any I/O whatsoever |
| `Scheduler` | shell | Orchestrate the daily run | `Watchlist`, `PriceService`, `Formatter`, `SmsService` | Fetch, format, persist, or send *itself* |
| `CommandHandler` | shell | `doPost` entry; authorize, parse, dispatch, reply | `Config`, `CommandParser`, `Watchlist`, `PriceService`, `SmsService` | Contain command business logic inline; format prices |

**Invariant:** `PriceService` is the only module that names Alpha Vantage or its
endpoint. `SmsService` is the only module that names Twilio. If a second module needs
to fetch a price or send a text, it calls the owner — it does not open its own
`UrlFetchApp` connection.

**Invariant:** `Scheduler` and `CommandHandler` are orchestrators. They contain no
`UrlFetchApp`, no `.toFixed`, no `PropertiesService`. If either grows logic, that logic
moves into the module that owns it (or a new core module).

---

## 5. Single-Owner Resources

Some resources have exactly one owner. Every other module goes through that owner.

- **Secrets → `Config`.** Only `Config` calls `PropertiesService.getScriptProperties()`
  for a key like `TWILIO_AUTH_TOKEN`. Everyone else receives the value from `Config`.
- **State → `Watchlist`.** Only `Watchlist` reads or writes the tickers/paused values.
  The storage schema (currently: tickers as a JSON array under one key, `paused` as its
  own `"true"`/`"false"` key) is `Watchlist`'s private detail — no caller may assume it.
- **Alpha Vantage → `PriceService`. Twilio → `SmsService`.** As in §4.

**Why single-owner:** if the schema, the API, or the auth ever changes, exactly one
file changes. A second module reaching around the owner is the coupling that makes
future edits dangerous.

**Invariant:** `grep` for `getScriptProperties` returns hits only in `Config` and
`Watchlist`. `grep` for the Alpha Vantage host returns hits only in `PriceService`.
`grep` for the Twilio host returns hits only in `SmsService`. A hit anywhere else is a
boundary violation.

---

## 6. Command Dispatch Table — No God Handler

Inbound commands route through a **dispatch table**, not a growing `if/else` or
`switch`. Parsing (pure) is separated from doing (effect).

```js
// CommandParser.gs — CORE, pure: "  Add tsla " -> { type: "add", arg: "TSLA" }
const CommandParser = { parse(body) { ... } };

// CommandHandler.gs — SHELL: one small handler per command, registered in a table.
const COMMANDS = {
  add:    (arg) => Watchlist.add(arg),
  remove: (arg) => Watchlist.remove(arg),
  pause:  ()    => Watchlist.setPaused(true),
  resume: ()    => Watchlist.setPaused(false),
  list:   ()    => Watchlist.summary(),
  // ...aliases (stop->pause, start->resume, status->list) map to the same handlers
};
```

**Invariant:** Adding a command means adding one pure parse case and one table entry —
never editing a monolithic branch. No command handler exceeds a few lines; anything
bigger delegates to the module that owns the work.

---

## 7. The Granularity Contract — No God Code

"No god code; small, meaningful functions" is a project law. Operationalized so it
enforces quality instead of decaying into fragmentation-for-its-own-sake:

- **One function, one reason to exist.** If describing it needs the word "and," split it.
- **Pure and effectful never mix in one function.** A function either computes (core)
  or performs an effect (shell). Not both.
- **Depth over count.** Prefer a few well-named functions a maintainer can hold in
  their head over many trivial ones they must chase across files. Extract when the
  extraction earns a name that makes the caller read like a sentence — not merely
  because a function is long.
- **No line-count law.** The test is "single reason + a name that carries its weight,"
  not "under N lines."
- **No `Utils` / `Helpers` grab-bag.** A dumping ground is god-code in disguise — it
  ends up knowing everything. A helper lives in the module that owns its domain. If two
  modules genuinely need it, that is a signal of a *missing named concept*, not a
  missing util; name the concept and give it a home.

**Invariant:** No file named `Utils`, `Helpers`, `Common`, `Misc`, or equivalent
exists. No function does both computation and I/O. No god object accumulates unrelated
methods.

---

## 8. Config & Fail-Loud

`Config` validates every required key **once, at the start of any entry point** (the
trigger run and `doPost`), and throws a clear, named error if one is missing — it never
returns `undefined` to be discovered halfway through a run.

```js
const Config = {
  require(key) {
    const v = PropertiesService.getScriptProperties().getProperty(key);
    if (!v) throw new Error(`Missing Script Property: ${key}. Set it in Project Settings → Script Properties.`);
    return v;
  },
};
```

**Invariant:** A missing secret is a loud failure at the boundary, never a silent
`undefined` propagated into a fetch or a send.

---

## 9. Resilience for Unattended Runs

Spazito runs with no one watching. The daily alert degrades gracefully; it never
all-or-nothings.

- **Per-ticker isolation.** Each Alpha Vantage fetch is wrapped so one failing ticker
  does not sink the whole message. Send what succeeded; note what failed.
- **Top-level catch.** The trigger entry point wraps its body so an unexpected error is
  logged (and, optionally, self-notified) rather than dying silently in the execution
  log.
- **Respect the quota.** Alpha Vantage free tier is 25 req/day, 5/min. No retry storms;
  a bounded, deliberate retry at most (§ the 6-minute execution cap also limits this).
- **Guard the webhook.** `doPost` validates the sender (see §11) and tolerates
  empty/malformed bodies without throwing.

**Invariant:** No single ticker failure produces zero output. The daily message is sent
with the successful subset whenever at least one ticker resolved.

---

## 10. Money-Formatting Rigor

Prices are money; formatting them is pure logic with real traps, and it lives in
`Formatter` (core) where it is unit-tested against edge cases.

- Alpha Vantage returns prices as **strings.** Parse once, at the core boundary; do not
  pass raw API strings around.
- Format per the confirmed spec: SPY→"S&P" and GLD→"Gold" use thousands-comma, **no**
  decimals; SLV→"Silver" uses **exactly two** decimals. Custom tickers generalize
  gracefully (`Ticker Price`).
- Edge cases the tests must cover: a sub-dollar price, a price with more/fewer decimals
  than expected, a very large price (comma grouping), and a missing/failed quote.

**Invariant:** All number formatting is in `Formatter`. No `.toFixed`,
`.toLocaleString`, or manual comma-grouping appears in any shell module.

---

## 11. Security & Logging Discipline

**Sender authorization.** `doPost` validates that `e.parameter.From` equals the
configured `RECIPIENT_NUMBER` **before any command runs.** An unauthorized sender gets
no action and no informative reply.

**Invariant:** No branch of command handling executes before the `From` check passes.
Authorization is the first thing `doPost` does after reading the body.

**doPost replies go out via `SmsService` (Twilio REST), never as TwiML.** A GAS web app
cannot reliably return the TwiML content type Twilio's inline-response path expects;
confirmations are sent as ordinary outbound messages.

**Logging.** `DEBUG_MODE=true` logs instead of sending — use it when iterating on
formatting. What may and may not appear in logs:

| Level | Use for |
|---|---|
| `console.error` | Unrecoverable failures needing investigation (Twilio send failed, all tickers failed) |
| `console.warn` | Recoverable anomalies worth tracking (one ticker failed, rate-limit note seen) |
| `console.log` | Lifecycle events (run started/finished, command received) |

**Invariant:** No secret ever reaches a log. `TWILIO_AUTH_TOKEN`, `TWILIO_SID`,
`ALPHA_VANTAGE_KEY`, and the full auth header are never logged at any level. Log ticker
symbols, counts, and which ticker failed — never a credential.

---

## 12. Testing Standard

The core exists so it can be tested. Testing is not optional.

- **Core is unit-tested in plain Node.** `Formatter` and `CommandParser` have real
  tests covering the §10 edge cases and every command/alias, run without touching GAS.
- **Shell is smoke-tested in GAS** via `test*` entry points (e.g. `testSendNow`) plus
  `DEBUG_MODE` to exercise the flow without spending Twilio credit or burning quota.
- **State isolation.** Any test that touches `Watchlist` leaves the store as it found
  it — no test pollutes the real watchlist or paused flag.
- **Meaningful, not tautological.** A test asserts behavior a maintainer cares about
  (the S&P line has no decimals; `add tsla` yields `TSLA`), not that a mock was called.

**Invariant:** Every core function has at least one test that would fail if the
function's contract broke. A core module with no tests is an incomplete module.

---

## 13. Rules — What Never To Do

- **NEVER import a GAS global into a core file.** `UrlFetchApp`, `PropertiesService`,
  `Utilities`, `new Date()` in `Formatter`/`CommandParser` breaks the entire testing
  and no-bleed premise. This is the top violation.
- **NEVER call Alpha Vantage outside `PriceService`, or Twilio outside `SmsService`.**
  Need a price or a send elsewhere? Call the owner.
- **NEVER read `PropertiesService` for secrets outside `Config`, or for state outside
  `Watchlist`.**
- **NEVER put formatting or price math in `Scheduler`, `CommandHandler`, or any shell
  module.** It lives in `Formatter`.
- **NEVER act on an inbound command before the `From == RECIPIENT_NUMBER` check.**
- **NEVER return TwiML from `doPost`.** Replies go out via `SmsService`.
- **NEVER hardcode a secret** anywhere in `src/`.
- **NEVER let one ticker failure abort the whole daily message.** Partial send always.
- **NEVER create a `Utils`/`Helpers`/`Common` grab-bag.**
- **NEVER add a bare global function** except web-app entrypoints, trigger targets, and
  `test*` helpers. Everything else hangs off its module object.
- **NEVER log a credential** at any level.
