# Spazito — Architecture Decisions (Index)

The **full** architecture decision records live in [`doc/decisions/`](../decisions/).
This is a one-line index for quick scanning — when you need the *why*, the alternatives,
and the consequences, open the numbered record. Do not restate a decision here; update
the record.

| ADR | Decision | One-line rationale |
|---|---|---|
| [001](../decisions/001-serverless-apps-script.md) | Serverless on Google Apps Script | Triggers + KV store + HTTP client + webhook host, all free, in one box |
| [002](../decisions/002-timezone-pacific.md) | Timezone = `America/Los_Angeles` | Tracks the recipient's Eureka, CA wall clock through DST — "5pm" always means 5pm to him |
| [003](../decisions/003-secrets-in-script-properties.md) | Secrets in Script Properties, never in source | Source is committed to git; secrets read only via `Config`, which fails loud if any are missing |
| [004](../decisions/004-state-in-propertiesservice.md) | State in `PropertiesService`, no DB | ~2 values for one recipient; `Watchlist` is the sole owner; no external dependency |
| [005](../decisions/005-functional-core-imperative-shell.md) | Functional Core, Imperative Shell | Pure logic testable in Node; "no bleed" becomes structural, not a code-review hope |
| [006](../decisions/006-apps-script-patterns.md) | Apps Script Architecture & Quality Standard | The strict, `grep`-checkable no-bleed rules + granularity contract + What-Never-To-Do |

---

**Reading order for someone new to the codebase:** 001 (why GAS) → 005 (the shape) →
006 (the rules) → the rest as needed. Then [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
system map and [`SCHEMA.md`](SCHEMA.md) for the state store.
