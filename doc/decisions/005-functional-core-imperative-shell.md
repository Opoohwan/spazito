# ADR 005 — Functional Core, Imperative Shell

**Status:** Accepted
**Date:** 2026-07-04

## Context

Three goals drive Spazito's internal design, and they are in tension:

1. **Strict separation of concerns — "no bleed."** Each module owns one thing and
   cannot reach past its boundary.
2. **Good test quality.** The logic that matters (money formatting, command parsing,
   watchlist rules) must be genuinely tested.
3. **Readable by a non-technical maintainer** who may open this after months away
   (see CLAUDE.md code-style rules).

The hard constraint working against goals 1 and 2 is that **GAS is painful to test.**
`PropertiesService`, `UrlFetchApp`, and the Twilio/Alpha Vantage calls only exist
inside Google's sandbox. Any logic entangled with them can only be exercised by
deploying and poking the live system — slow, manual, and quota-burning.

The full spectrum considered, least to most disciplined: single-file monolith → flat
global-function modules → namespaced modules → layered architecture → full
ports-and-adapters (hexagonal) → event/pipeline bus → **functional core / imperative
shell**.

## Decision

Adopt **Functional Core, Imperative Shell**, in its *pragmatic* form — no dependency-
injection framework, no formal "ports," no ceremony. Just a hard rule about where side
effects live:

- **Core modules are pure.** They import nothing from GAS, make no network calls, read
  no clock, touch no `PropertiesService`. Data in, data out. Examples: message
  formatting (the S&P/Gold/Silver rules), SMS-command parsing, watchlist
  transformation logic. These are unit-testable in **plain Node**, fast and free.
- **Shell modules do all I/O.** They fetch (`PriceService` → Alpha Vantage), send
  (`SmsService` → Twilio), persist (`Watchlist` → `PropertiesService`), read config
  (`Config`), and orchestrate (`Scheduler`, `CommandHandler`). They are thin: gather
  inputs, call the core, perform effects with the result.

This *extends* the module list in CLAUDE.md: adopting a functional core means
extracting pure logic (e.g. a `Formatter` and a `CommandParser`) into their own core
modules rather than leaving it inline in `Scheduler`/`CommandHandler`. That extraction
is the whole point and is recorded here as a deliberate consequence.

The strict boundary rules, module responsibilities, and granularity contract that
enforce this decision live in **ADR 006** (the patterns standard).

## Alternatives Considered

- **Flat global-function modules (idiomatic GAS)** — the most common GAS style and the
  easiest for a stranger to recognize. **This was the real dissent** (the readability
  argument): functional core adds indirection ("why is formatting in a different file
  from the thing that sends it?"), which is a genuine cost for a non-technical
  maintainer. Rejected *as the default* because it makes "no bleed" a matter of
  discipline and memory rather than structure, and it leaves the important logic
  entangled with untestable GAS calls. The dissent is answered by keeping the core as
  *plain functions in well-named, well-commented files* — no framework — so it reads
  like ordinary code.
- **Namespaced modules** — a good idea we *keep* (module-object grouping is mandated in
  ADR 006 to survive GAS's single global scope), but on its own it does not solve
  testability. Folded in rather than chosen alone.
- **Full hexagonal (ports & adapters)** — maximum boundary rigor, but DI containers and
  formal adapters are ceremony that punishes the non-technical-maintainer goal.
  Rejected: we want hexagonal's testability without its apparatus.
- **Layered architecture** — a lighter cousin; acceptable, but does not push logic to
  *pure* the way functional core does, so the testability win is smaller.
- **Single-file monolith / event bus** — the two ends of the spectrum: one makes
  no-bleed impossible, the other is wild over-engineering for six commands and one
  daily text. Both rejected.

## Consequences

**Gain:**
- The important logic is unit-tested in Node — real tests, fast, free, no GAS deploy.
- "No bleed" becomes **structural**: a core module cannot call Twilio because Twilio is
  not in its scope. Boundary violations become import errors, not code-review misses.
- Side effects are corralled into the shell, so retry, duplicate-send guards, and
  logging have exactly one place to live.

**Give up:**
- More files and one layer of indirection versus flat modules. Mitigated by the
  granularity contract and this project's heavier commenting rule.
- A maintainer must understand the core/shell split. It is documented in ADR 006 and
  should be obvious from module naming and folder layout.
- Discipline is still required at the boundary — the core stays pure only if nobody
  imports a GAS global into it. ADR 006 makes that an explicit "never."
