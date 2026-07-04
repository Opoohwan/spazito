# Changelog

Our internal journal of where we've been. One story per release — what it was and why
it mattered. Configuration and deployment gotchas are called out because they affect
setup. Everything else is in `git log`.

---

## [Unreleased]

**The foundation.** Before a line of `src/` exists, Spazito's architecture is fully
decided and written down — the deliberate order, so the rules shape the code as it's
written instead of being bolted on after.

The docs got a home: a `doc/` folder with `decisions/` (architecture decision records)
and `dev/` (developer guides), and the CHANGELOG and ROADMAP moved under it. Six ADRs
now record every load-bearing choice and, more importantly, *why* — serverless on Google
Apps Script (001), secrets in Script Properties (003), state in PropertiesService with no
database (004), and the two that define how the code is shaped: Functional Core /
Imperative Shell (005) and the strict, `grep`-checkable no-bleed quality standard (006).
That last one is the spine of the project — each module owns exactly one thing, pure
logic is physically separated from I/O so it can be tested in Node, and there's a
"What Never To Do" list a reviewer can check mechanically.

The `dev/` set followed: an architecture map with data-flow diagrams for both the daily
alert and inbound commands, a schema reference for the PropertiesService key-value store,
a debugging guide for diagnosing the unattended system from execution logs, and a
processes guide for the clasp/deploy workflow.

**Deployment gotcha worth remembering — the timezone was corrected from `America/Phoenix`
to `America/Los_Angeles`.** The recipient lives in Eureka, CA, which is Pacific and
observes DST. Phoenix (permanently UTC−7) would have delivered the "5pm" text at *4pm his
time all winter*. The fix is to track the recipient's own zone so "5pm" always means 5pm
on his clock. When `appsscript.json` is written, its `timeZone` must be
`America/Los_Angeles` — not Phoenix, despite any older note that called Phoenix
"intentional." (See ADR 002.)
