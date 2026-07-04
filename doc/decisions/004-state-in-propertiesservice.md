# ADR 004 — Mutable State in PropertiesService, No External DB

**Status:** Accepted
**Date:** 2026-07-04

## Context

Spazito holds a small amount of mutable state that must survive between runs and be
changeable by the recipient over SMS:

- the **watchlist** (which tickers to report), and
- the **paused** flag (whether alerts are active).

This is a handful of values for a single recipient, read once a day and written only
when a command arrives. It is not relational, not large, and not high-frequency.

## Decision

Store all mutable state in **Apps Script `PropertiesService`** (Script scope), the
same key-value store the platform already provides. No external database.

A single module — **`Watchlist`** — is the sole reader and writer of this state and
owns its storage schema. No other module touches `PropertiesService` for state; they
ask `Watchlist`. (Secrets are a separate concern owned by `Config`; see ADR 003. The
two never share a module.)

Script scope (not User or Document scope) is correct here: the state is global to the
one script/one recipient, not tied to an interactive user session or a container
document.

The exact key layout (single JSON blob vs. key-per-datum) is an implementation detail
owned entirely by `Watchlist` and documented in the patterns standard (ADR 006). It is
deliberately hidden behind the module so it can change without touching any caller.

## Alternatives Considered

- **External database (Firebase / Firestore / a hosted DB)** — real query power and
  durability, but adds a cloud dependency, credentials, and cost to a free single-user
  app that stores ~2 values. Massive over-engineering. Rejected.
- **Google Sheets as a datastore** — free and GAS-native, but heavier (Spreadsheet
  service quotas, slower reads, a whole spreadsheet to manage) for what is a two-key
  store. Rejected.
- **In-code constants** — simplest, but the recipient must be able to mutate the
  watchlist and paused flag over SMS. Constants cannot change at runtime. Rejected —
  it defeats the command feature.

## Consequences

**Gain:**
- Zero additional infrastructure — the store is already part of the runtime.
- One module owns all state; callers are decoupled from how it is persisted.
- Trivial to reason about and to reset (clear the properties).

**Give up:**
- `PropertiesService` limits apply: ~9KB per value, ~500KB total, ~50 properties per
  scope. Irrelevant at this scale, but a hard ceiling if the watchlist ever grew
  absurdly large. Documented so it is not a surprise.
- No querying, no transactions across keys. `Watchlist` must keep writes simple and
  self-consistent (favoring a single value it rewrites atomically).
- No built-in history — a bad write overwrites the prior state. Acceptable for two
  values a single user controls.
