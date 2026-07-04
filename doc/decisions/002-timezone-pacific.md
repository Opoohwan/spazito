# ADR 002 — Timezone Tracks the Recipient: America/Los_Angeles

**Status:** Accepted
**Date:** 2026-07-04

## Context

Spazito sends a daily alert at "5:00pm." The recipient expects it at the same wall-
clock time every weekday. The recipient lives in **Eureka, CA — Pacific time
(`America/Los_Angeles`), which observes DST.**

An earlier assumption held that the trigger should use a no-DST zone
(`America/Phoenix`) and called that "intentional." That reasoning was backwards — it
optimized for a fixed *absolute* offset instead of a fixed *local* time for the person
actually receiving the text. For a Pacific recipient, Phoenix (permanently UTC−7)
lines up only in summer:

- **Summer:** Phoenix UTC−7 = Pacific Daylight UTC−7 → 5pm Phoenix = 5pm Eureka. ✓
- **Winter:** Phoenix stays UTC−7, Pacific drops to UTC−8 → 5pm Phoenix = **4pm
  Eureka.** ✗

So Phoenix silently delivered the "5pm" text at 4pm the recipient's time for half the
year. (Note: this never affected *data validity* — the market closes at 1pm Pacific,
so 4pm or 5pm are both well after close. The defect was purely the recipient's
wall-clock experience.)

## Decision

All triggers and all date/time logic use **`America/Los_Angeles`** — the recipient's
own zone. It observes DST, so the *absolute* UTC instant of the send shifts by an hour
across the spring/fall transitions, but the recipient's experience is constant: the
text always arrives at **5:00pm on their wall clock**, every weekday, year-round.

Set in `appsscript.json` (`timeZone`) and assumed by any code reasoning about "today,"
"weekday," or "5pm."

## Alternatives Considered

- **`America/Phoenix` (no DST)** — the original assumption. Delivers at 4pm Pacific in
  winter. Rejected: it anchors to an offset, not to the recipient's clock, which is
  the thing that actually matters here.
- **UTC** — a stable offset, but "5pm UTC" is not "5pm" to a human in Eureka and would
  require mental conversion. Rejected — the intent is 5pm *local to the recipient*.
- **Per-recipient configurable timezone** — the correct answer *if* Spazito ever
  serves more than one person in more than one zone. Today it serves one recipient in
  one zone; configurability is complexity with no user. Deferred until multi-recipient
  is real.

## Consequences

**Gain:**
- The text lands at 5:00pm the recipient's local time every weekday, all year. No
  twice-yearly hour drift.
- The timezone reflects a real fact (where the recipient lives), not an abstract
  preference — easy to reason about and to correct if they move.

**Give up:**
- The *absolute* UTC send instant moves by an hour twice a year. This is irrelevant to
  a job scheduled by local wall-clock time, but worth noting for anyone debugging
  execution logs across a DST boundary.
- Correctness now depends on GAS honoring `America/Los_Angeles` DST transitions. It
  does — the platform's trigger scheduling is DST-aware for named zones.
- If Spazito ever adds recipients in other zones, this single-zone decision must be
  revisited (it becomes per-recipient config, per Alternatives).

## Note

The original "America/Phoenix, no DST — intentional" framing was corrected on
2026-07-04 once the recipient's actual location (Eureka, CA) surfaced. It is recorded
here as a reminder: a timezone should be chosen from where the *recipient* is, not
from a property of the zone's name.
