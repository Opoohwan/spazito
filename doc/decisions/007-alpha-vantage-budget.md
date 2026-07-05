# ADR 007 — Living Within the Alpha Vantage Free Tier: Rate Spacing + Watchlist Cap

**Status:** Accepted
**Date:** 2026-07-04

## Context

Alpha Vantage's free tier allows **25 requests/day and 5 requests/minute**, shared
across everything Spazito does. Two hard consequences the design must respect — both
surfaced in the 2026-07-04 review as foundation cracks that were previously undocumented:

- **Daily budget.** The 5pm run spends **one call per ticker**; each `add` spends
  **one** to validate a symbol. A large watchlist competes with `add` calls against the
  same 25/day budget. Past ~24 tickers, a single daily run cannot even complete.
- **Burst rate.** More than 5 calls in a minute returns a rate-limit `Note`/
  `Information` envelope instead of a quote — so an un-spaced multi-ticker run produces
  **silent partial data every day**, not just in exceptional cases.

The original design mentioned neither a cap nor call spacing. That made predictable
failures look like edge cases.

## Decision

1. **Watchlist soft cap: 10 tickers** (`Watchlist.MAX_TICKERS = 10`). `Watchlist.add`
   refuses beyond 10 with a friendly reply. Ten daily calls leave headroom in the 25/day
   budget for `add`/`remove`, and ten spaced calls fit inside the 6-minute execution cap.
2. **Call spacing in `PriceService`.** Alpha Vantage calls are spaced a **flat 15s** apart
   (`PriceService.MIN_CALL_SPACING_MS = 15000`, via `Utilities.sleep`) to stay under 5/min
   with margin (12s is the floor; 15s = 4/min). Ten calls ≈ 2.25 min, well within the
   6-minute cap. **No retries** (ADR 006 §9) — a failed ticker is simply `ok:false`.
3. **`add` validation costs one call, counted against the budget.** We keep it — rejecting
   a bad symbol is worth a call — but **order matters**: the free local checks (duplicate,
   at-cap) run **before** the paid validation, so a no-op `add` spends nothing. Note the
   cap bounds the *daily-run* cost, **not** cumulative `add` spend (see Consequences).
4. **Constants live in their owner module**, not a shared file: `Watchlist.MAX_TICKERS`
   and `PriceService.MIN_CALL_SPACING_MS`, each commented with the 25/day · 5/min · 6-min
   derivation. A shared `Constants` file would couple two single-owner modules (ADR 006 §5).
5. **The 25/day ceiling is a documented product constraint, not a bug.** Spazito is a
   single-recipient personal tool; a 10-ticker cap is generous for that use.

## Alternatives Considered

- **No cap, no spacing (the original implicit design)** — rejected: guarantees daily
  partial data for any watchlist over 5, and lets a chatty day of `add`s exhaust the
  quota before 5pm.
- **Paid Alpha Vantage tier** — rejected: breaks the free-tier premise (ADR 001).
- **A batch quote endpoint** — the free `GLOBAL_QUOTE` is single-symbol; there is no
  free batch call. Not available.
- **Cache/skip-unchanged tickers** — over-engineering for one daily run of ≤10 symbols.

## Consequences

**Gain:**
- The daily run reliably completes within free-tier limits.
- No silent partial data under normal use; spacing keeps every call under the rate cap.
- Under reasonable use, a day of commands cannot exhaust the quota.

**Give up:**
- Watchlist is limited to 10 tickers (default is 3; generous for a personal tool).
- The daily run takes ~2+ minutes due to spacing instead of seconds — irrelevant for an
  unattended job, but visible in execution logs.
- `add` still costs one Alpha Vantage call.
- **Residual risk (accepted):** daily spend is not metered, so a pathological add/remove
  day *could* still cross 25 and degrade the 5pm run. Not worth a per-day counter for a
  single occasional user — noted so it's an eyes-open acceptance, not a surprise.
