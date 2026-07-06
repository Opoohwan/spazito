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
this document is a design violation. The council gate (the per-chunk review defined in
the ROADMAP — the reviewer agents are still being built; until they exist the gate is
run manually) is the mechanism meant to catch it.
Every rule below carries an `Invariant:` line — the thing that must remain true — so a
reviewer (human or agent) can check conformance mechanically.

The architecture this standard enforces is decided in **ADR 005** (Functional Core,
Imperative Shell). Read that first; this document is how it is upheld.

> **Maintenance note:** the council reviewer agents in `.claude/agents/` cite specific
> section numbers from this document (`§4`, `§7`, …). If you renumber sections here,
> update those citations so they don't rot.

---

## 2. Functional Core, Imperative Shell — The Seam

Every file is exactly one of two kinds. There is no third kind, and no file is both.

**Core (pure).** No GAS globals, no network, no clock, no `PropertiesService`. A core
function takes plain data and returns plain data. It can be run in Node with no mocks.

```js
// core/Formatter.js — PURE. Imports nothing from GAS.
const Formatter = {
  // quotes: ordered [{ ticker, price, ok }] in watchlist order  ->  "S&P 7,500 | Gold 4,500 | Silver 70.00"
  // `ok` is the source of truth; a failed/unparseable ticker (ok:false) renders in place as "Label n/a"
  summaryLine(quotes) { /* string building only */ },
};
```

**Shell (effects).** Fetches, sends, persists, reads config, reads the clock,
orchestrates. Thin: gather inputs → call the core → perform the effect with the result.

```js
// Scheduler.js — SHELL. Orchestrates; contains no formatting and no fetching of its own.
function runDailyAlert() {
  if (Watchlist.isPaused()) return;                 // ask the state owner
  const tickers = Watchlist.tickers();              // ask the state owner
  const quotes  = PriceService.quotesFor(tickers);  // ask the fetcher
  const message = Formatter.summaryLine(quotes);    // ask the pure core
  SmsService.send(message);                         // ask the sender
}
```

**File format.** Source modules are authored as `.js` (not `.gs`) so Node and Jest load
them directly for tests; `clasp` pushes them to Apps Script, where they run as `.gs` in
one shared global scope. Each module ends with a dual-load guard so the same file works
in both environments:

```js
if (typeof module !== 'undefined') module.exports = { Formatter };
```

**Invariant:** the guard is the last line of every module. In GAS, `module` is undefined
so the line is inert; in Node, it exposes the module to `require` for tests.

**Invariant (Node-side shared scope):** the guard is exactly the one line above — it
never `require`s dependencies and never touches `global`. GAS gives every module a
shared global scope; Node tests recreate it in **one** place, the Jest bootstrap
`test/gasScope.js` (wired via `setupFiles`), which installs each **core** module as a
global. Shell collaborators are installed as (usually mocked) globals by the tests that
need them, through the `gasMocks` teardown registry. (Decided at the Chunk 2 gate after
a per-module `global.X = …` guard variant appeared — one bootstrap, not N forked guards.)

**Invariant:** every module object has a **globally-unique name** — GAS concatenates all
files into one global scope, so two files each declaring `const Formatter` is a fatal
`SyntaxError` that kills every execution.

**Invariant:** **core modules are leaves** — a core module never calls another core
module. (In GAS they'd resolve through shared scope; in Node they'd need cross-`require`,
reintroducing exactly the dual-environment special-casing the seam exists to avoid.)
Shared pure logic becomes a third core module that shell code composes.

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
| `PriceService` | shell | The **only** caller of Alpha Vantage | `UrlFetchApp`, `Config`, `Utilities` (sleep — the §9/ADR 007 call spacing), `Redactor` | Format prices; send SMS; touch state |
| `SmsService` | shell | The **only** caller of Twilio | `UrlFetchApp`, `Config`, `Utilities` (base64Encode — the Basic-auth header), `Redactor` | Decide *what* or *when* to send; build message copy |
| `Formatter` | core | Turn quote data into the daily message string (incl. empty & all-failed cases) | (nothing) | Any I/O whatsoever |
| `CommandParser` | core | Turn a raw SMS body into a parsed intent | (nothing) | Any I/O whatsoever |
| `Replies` | core | Hold command reply / help / error copy strings | (nothing) | Any I/O; price formatting (that's `Formatter`) |
| `Tickers` | core | Canonical ticker text rules (normalize once, at the shell boundary) | (nothing) | Any I/O whatsoever |
| `Redactor` | core | Scrub secret-shaped substrings from strings before they reach a log (§11) | (nothing) | Any I/O whatsoever |
| `Scheduler` | shell | Orchestrate the daily run | `Watchlist`, `PriceService`, `Formatter`, `SmsService` | Fetch, format, persist, or send *itself* |
| `CommandHandler` | shell | `doPost` entry; authorize, parse, dispatch, reply | `Config`, `CommandParser`, `Replies`, `Watchlist`, `PriceService`, `SmsService` | Contain command business logic inline; format prices |

**Invariant:** `PriceService` is the only module that names Alpha Vantage or its
endpoint. `SmsService` is the only module that names Twilio. If a second module needs
to fetch a price or send a text, it calls the owner — it does not open its own
`UrlFetchApp` connection.

**Invariant:** `Scheduler` and `CommandHandler` are orchestrators. They contain no
`UrlFetchApp`, no `.toFixed`, no `PropertiesService`. If either grows logic, that logic
moves into the module that owns it (or a new core module).

**Note on `Tickers` (added at the Chunk 0 gate):** `Tickers.normalize` exists for
**shell** callers (`Watchlist`, `CommandHandler`) to canonicalize user input once at the
boundary. Core modules may not call it — core modules are leaves (§2) — so where this
standard requires a core module to defensively uppercase (`Formatter` §10,
`CommandParser` §6), it does so with its own local one-liner. That duplication is
mandated by the leaf rule and is deliberate; collapsing it into a core→core call is the
violation, not the duplication.

---

## 5. Single-Owner Resources

Some resources have exactly one owner. Every other module goes through that owner.

- **Secrets → `Config`.** Only `Config` calls `PropertiesService.getScriptProperties()`
  for a key like `TWILIO_AUTH_TOKEN`. Everyone else receives the value from `Config`.
- **State → `Watchlist`.** Only `Watchlist` reads or writes the tickers/paused values.
  The storage schema (currently: tickers as a JSON array under one key, `paused` as its
  own `"true"`/`"false"` key) is `Watchlist`'s private detail — no caller may assume it.
- **Alpha Vantage → `PriceService`. Twilio → `SmsService`.** As in §4.

**Concurrent writes.** `Watchlist` mutations (`add`/`remove`/`setPaused`) are
read-modify-write of a single property. Two near-simultaneous `doPost`s (or a Twilio
webhook retry, which fires if no 2xx returns within ~15s) could clobber each other, so
every `Watchlist` write takes a `LockService.getScriptLock()` around the read-modify-write.

The failure contract is specified, not left to chance: **`waitLock` throws on timeout**,
so use a **short timeout (~5s, well under Twilio's ~15s retry window)**, `try`/`catch` the
throw and reply "busy — try again", and `releaseLock` in a `finally`. Reads (`tickers()`,
`isPaused()`) are intentionally **not** locked — a reader overlapping a writer gets the
pre-write value, a harmless timing artifact, not corruption.

- **Security/message state → the security layer (ADR 008).** The message counter, lockout
  flag, `MessageSid` replay set, and audit log are owned by the security/audit code — not
  scattered — under the same single-owner discipline.

**Invariant:** no `Watchlist` write happens outside a `getScriptLock()` → `waitLock(~5s)`
→ (`finally`) `releaseLock` guard; a lock timeout replies "busy", never fails silently.

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
// CommandParser.js — CORE, pure: "  Add tsla " -> { type: "add", arg: "TSLA" }
const CommandParser = { parse(body) { ... } };

// CommandHandler.js — SHELL: one small handler per command, registered in a table.
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

**Frozen-vocabulary convention** (emerged in Chunks 2–5, codified here): when a module
returns or dispatches on string tokens, those tokens live in ONE frozen object on the
module — `UPPER_SNAKE` key → lowercase-string value (`Watchlist.STATUS`,
`CommandParser.TYPES`, `PriceService.REASON`). Callers reference the constants, never
retype the literals. A new dispatching module follows the same shape.

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
  does not sink the whole message. A failed, un-parseable, or rate-limited ticker becomes
  `ok:false` and renders in place as `Label n/a` (§10) — the successful ones still send.
- **No retries.** A failed/slow/rate-limited ticker is simply `ok:false`. Retrying is
  rejected: retrying a rate-limit `Note` *causes* more rate-limiting and spends the daily
  budget, and stacked retries risk the 6-minute execution-cap kill before the single
  end-of-run send. For a ≤10-ticker daily run, no-retries is both simpler and safer.
- **Top-level catch.** The trigger entry point wraps its body so an unexpected error is
  logged rather than dying silently in the execution log.
- **Respect the quota and rate limit.** Alpha Vantage free tier is 25 req/day, 5/min.
  `PriceService` spaces its calls a **flat 15s apart** (`PriceService.MIN_CALL_SPACING_MS`)
  to stay under 5/min, and the watchlist is capped at 10 (`Watchlist.MAX_TICKERS`) so the
  run fits both the 6-minute cap and the daily budget (ADR 007). The rate-limit envelope
  keys (`Note` / `Information`) are a named constant list, tested per key.
- **Empty vs. all-failed — distinct states, must not collapse.** An empty watchlist
  (nothing attempted) sends the "watchlist is empty" notice and **does not** log an error.
  An all-failed run (every ticker `ok:false`) sends `… n/a | … n/a` **and** logs
  `console.error` — that error is the signal that Alpha Vantage is down or throttled.
- **Observability.** `PriceService` logs Alpha Vantage's `07. latest trading day`, so a
  "prices look stale" report (e.g. a market holiday) is diagnosable rather than a guess.
- **Guard the webhook.** `doPost` runs the layered auth gate (ADR 008) and tolerates
  empty/malformed bodies without throwing.

**Invariant:** No single ticker failure produces zero output. The daily message is sent
with the successful subset whenever at least one ticker resolved.

---

## 10. Money-Formatting Rigor

Prices are money; formatting them is pure logic with real traps, and it lives in
`Formatter` (core) where it is unit-tested against edge cases.

- Alpha Vantage returns prices as **strings.** Parse once, at the core boundary; do not
  pass raw API strings around.
- Display rules live as a **data table** in `Formatter` — `{ ticker → { label, decimals } }`
  with a default rule — not as scattered per-ticker `if` branches. **The code table
  (`Formatter.DISPLAY_RULES`) is the source of truth; the listing below is illustrative:**
  - `SPY → { label: "S&P", decimals: 0 }`, `GLD → { label: "Gold", decimals: 0 }`,
    `SLV → { label: "Silver", decimals: 2 }`
  - default (any custom ticker) → `{ label: <symbol>, decimals: 2 }`
  - all prices use thousands-comma grouping.
- **Input is an ordered array** `[{ ticker, price, ok }]` in watchlist order (Gap 1 =
  Option C). `ok` is the **source of truth**; `price` is read only when `ok` is true, and
  a value that parses to `NaN`/empty is set `ok:false` at the boundary — so `"NaN"` can
  never render. An `ok:false` entry renders in place as `Label n/a` (e.g.
  `S&P n/a | Gold 4,500 | …`); the line never silently drops or reorders a slot.
- **Grouping is locale-independent.** `Number.toLocaleString()` is forbidden for comma
  grouping — under Apps Script's locale it may emit `7.500` or `7 500`. Use an explicit
  routine that splits on the decimal point and groups the **integer part only**
  (`600000.00 → 600,000.00`, never `6,00,000.00`).
- **Rounding is specified, not assumed.** `toFixed` is the rounding path (0dp / 2dp); its
  half-up + float behaviour (`(1.005).toFixed(2) === "1.00"`) is covered by a test matrix
  including a `.005` / `.5` boundary value.
- **Lookup keys are uppercase.** The rules table is keyed uppercase; `Formatter`
  uppercases the ticker before lookup (it is pure and must not assume callers normalized).
- Edge cases the tests must cover: sub-dollar, more/fewer decimals than expected, very
  large (comma grouping), a `.005` rounding boundary, a single `ok:false` → `n/a`, an
  **all-failed** run, and an **empty** watchlist (distinct from all-failed — see §9).

**Invariant:** All number formatting is in `Formatter`. No `.toFixed`,
`.toLocaleString`, or manual comma-grouping appears in any shell module.

---

## 11. Security & Logging Discipline

**Sender authorization.** `doPost` validates that `e.parameter.From` equals the
configured `RECIPIENT_NUMBER` **before any command runs.** An unauthorized sender gets
no action and no informative reply.

**Invariant:** No branch of command handling executes before the `From` check passes.
Authorization is the first thing `doPost` does after reading the body.

**The `From` check is one layer, not authentication.** A POST's `From` is attacker-
controllable, so the check is necessary but not sufficient. **ADR 008 (Security &
Defense-in-Depth) is authoritative** and layers a secret URL bearer token, `MessageSid`
replay protection, auto-lockout, and recipient-verifiable message signing on top — all
**required**, not optional. Note: true Twilio `X-Twilio-Signature` HMAC validation is
**infeasible** here — a GAS web app cannot read request headers — so the URL bearer token
is its substitute. Never describe the `From` check alone as authenticating the webhook.

**doPost replies go out via `SmsService` (Twilio REST), never as TwiML.** A GAS web app
cannot reliably return the TwiML content type Twilio's inline-response path expects;
confirmations are sent as ordinary outbound messages.

**Logging.** `DEBUG_MODE=true` makes `SmsService` **log the outbound SMS instead of
sending it** — it gates Twilio only, and does *not* prevent Alpha Vantage calls (so
`testSendNow` in debug mode still spends quota). Logging uses `console.*`, which surfaces
in the Apps Script **Executions** view / Cloud Logging. What may and may not appear:

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

- **Core is unit-tested in plain Node.** `Formatter`, `CommandParser`, and `Replies` have
  real tests covering the §10 edge cases and every command/alias, run without touching GAS.
- **Shell is unit-tested in Node too, with mocked GAS globals** (`PropertiesService`,
  `UrlFetchApp`, `LockService`, `Utilities` stubbed in a Jest setup) — especially the
  security-critical paths (auth gate, partial-send, dispatch). Coverage is **global at 80%
  lines/branches**; core approaches ~100%, shell is covered via the mocks. The QA lead
  judges *meaningfulness*, not just the number.
- **Test files must never reach Apps Script.** A `.claspignore` (with `rootDir: "src"`)
  keeps `*.test.js`/`jest.config.js` off the push — a pushed test file's top-level
  `require` throws at load and silently kills every execution. Lands in Chunk 0.
- **Golden fixtures.** The Alpha Vantage and Twilio mocks are built from *captured real
  responses*, so the mocks cannot drift from the live API contract.
- **`DEBUG_MODE`** exercises the shell flow without Twilio spend (it does not stop Alpha
  Vantage — unit-test `Formatter` in Node for zero-spend formatting).
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
