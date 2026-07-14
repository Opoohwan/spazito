# Spazito Roadmap

**Single source of truth for what's next. Open here first every session.**

Forward-looking only. When work is done it moves to the CHANGELOG and leaves here — no
completed items, no strikethroughs.

---

## How we build: chunks, gates, and tests

### The rhythm
Small chunks. Each one ends green (tests pass, coverage ≥ 80%), each gets a **Council
Gate**, each is **one commit**. A chunk is not "done" until its gate is clean and it's
committed. This matches the commit-per-chunk discipline — no long uncommitted stretches.

### The Council Gate — after each chunk, before the commit
- **Convened:** the five always-on reviewers **+** that chunk's domain SMEs.
  - **Always-on five (every gate):** `architecture-guardian`, `code-quality-reviewer`,
    `test-quality-reviewer` (the **QA lead**), `security-reviewer`, `tech-debt-hunter`.
  - Per-chunk lines below list only the **added** domain SMEs.
- **Adversarial, not a rubber stamp:** "looks good, no findings" is a failure of
  diligence, not a pass. Every finding carries a `file:line` and a concrete failure
  scenario. Reviewers report independently — no consensus-softening.
- **Findings come back in chat. No `.md` report files.**
- Flow: run the gate → findings to chat → resolve → re-gate if needed → **commit**.

### Testing from day 1 — the QA-lead standard
- The harness exists in **Chunk 0**, before any feature code.
- **Runner:** Jest (`coverageThreshold` enforces the gate). *Confirm at Chunk 0.*
- **Coverage floor: 80% lines + branches**, enforced by config — the suite fails under
  80%, so a gate cannot pass without it. The pure **core** targets ~100%; **shell**
  modules are covered via mocked GAS seams (`UrlFetchApp`, `PropertiesService`).
- **"Acceptable to the QA lead"** = ≥ 80% **and** tests assert real behavior (not that a
  mock was called) **and** error paths are covered **and** state is isolated between
  tests. A hollow-but-green suite fails the gate.
- **Dual-load pattern:** every module ends with
  `if (typeof module !== 'undefined') module.exports = {...}` so the same file runs in
  Node (tests) and GAS (prod). GAS ignores the guard; Node uses it.

**Legend:** 🧑 needs David · 🤖 Claude · 💰 has a cost · 🛡 Council Gate

---

## Now

**Spazito is live.** Built, deployed, carrier-approved, and texting the recipient daily —
that story lives in `doc/CHANGELOG.md`. One requirement is not yet met:

### Chunk 10 — Deliver at 5:00, not "sometime in the 5 o'clock hour"

**The problem, observed in production.** The spec says *"every weekday at 5:00pm."* We
don't do that. Apps Script's `atHour(17)` recurring trigger fires at a **random minute
inside the hour** — Google picks it, we cannot. Four days of live trigger history:

| Tue Jul 7 | Wed Jul 8 | Thu Jul 9 | Fri Jul 10 |
|---|---|---|---|
| 5:09 PM | 5:49 PM | 5:02 PM | 5:58 PM |

A 56-minute spread. That is not a 5pm text. **The recipient has been told, for now, to
expect it any time before 6.**

**The design.** A stable recurring trigger *books* a precise one — nothing schedules
itself, so nothing can die permanently.

1. **Scheduler** — five weekly triggers, Mon–Fri, **`atHour(15)`** (3–4pm). Only job:
   create a **one-time trigger for today at exactly 5:00:00 PM**, after deleting any stale
   one-time trigger left over from a previous day.
   *Why 3pm and not 4pm:* even a 3:59 firing leaves a full hour of margin before the 5:00
   target. A 4pm scheduler could fire at 4:58 and be racing its own deadline.
2. **The precise run** — that one-time trigger fires at **5:00** and calls `runDailyAlert`.
3. **`LAST_SENT_DATE` guard** — `runDailyAlert` records the date of a successful send and
   refuses to send twice on the same date. (This key has been reserved in `SCHEMA.md` since
   day one; this is the situation it was reserved for.)
4. **Backstop** — keep five weekly triggers but move them to **`atHour(18)`** (6–7pm). Each
   day they fire, see `LAST_SENT_DATE` is already today, and exit silently. If anything
   upstream broke, **they send** — late, but delivered.
   *Why a later hour:* a 5–6pm backstop could fire seconds from the precise run, both read
   "not sent yet," and double-text. An hour apart, that race cannot happen.

**Rejected: a self-rescheduling chain** (each run books the next). It gives the same
precision, but the chain *is* the schedule — one failed run kills it **permanently and
silently**, which is the single failure this project exists to prevent. In the chosen design
the scheduler is an ordinary Google-owned recurring trigger; it cannot be broken by our code.

**The failure ladder:**
- Normal day → text at **5:00 sharp**
- Scheduler or one-time trigger fails → **backstop delivers ~6pm.** Late, not lost.
- Total failure → tomorrow's 3pm trigger runs regardless. Self-heals. Nothing goes dark.

**The work:**
- [ ] `Scheduler.scheduleTodaysAlert()` — new global entry point (trigger target): clear any
      stale one-time alert trigger, then create one at **today 5:00:00 in the script's
      timezone** (`America/Los_Angeles` — the recipient's clock, ADR 002)
- [ ] **Decide the owner of `LAST_SENT_DATE`** — it is app state, so `Watchlist` by the
      single-owner rule (ADR 006 §5); confirm at build rather than defaulting
- [ ] `Scheduler.runDailyAlert()` — guard: if `LAST_SENT_DATE` is today, log and exit
      **without sending**; record the date only **after a successful send** (a miss is worse
      than a rare double — never mark sent for a send that didn't happen)
- [ ] `Scheduler.installTrigger()` — rework to install 5× Mon–Fri `atHour(15)` →
      `scheduleTodaysAlert`, plus 5× Mon–Fri `atHour(18)` → `runDailyAlert` (backstop).
      Stay idempotent (clear our own triggers first) and keep the post-install verification
- [ ] **Trigger budget:** 5 scheduler + 5 backstop + 1 one-time = **11**, against Apps
      Script's **20-trigger cap**. Verify, and make sure stale one-time triggers cannot
      accumulate toward it
- [ ] ⚠️ **DST correctness** — `at()` takes a real timestamp, so "today at 5:00pm Pacific"
      must be built in a way that survives the DST transition. Classic trap; verify explicitly
- [ ] **Tests:** guard blocks a same-day second send; a new day sends; scheduler creates
      exactly one one-time trigger at the right timestamp; scheduler clears a stale one
      first; backstop exits quietly when the day is already sent; backstop **does** send when
      it isn't; a failed send does **not** set `LAST_SENT_DATE`
- [ ] 🧑 Live verification: watch the one-time trigger appear in the Triggers panel during
      the 3pm hour; confirm the text lands at **5:00**; confirm the 6pm backstop fires and
      does nothing
- 🛡 **+ SMEs:** `gas-platform-expert` (one-time `at()` precision, the 20-trigger cap,
      timezone/DST), `resilience-reviewer` (the failure ladder — prove nothing can go dark),
      `spec-conformance-reviewer` (does it actually meet *"5:00pm"* now?)

---


## Parking Lot

- _(Duplicate-send guard / `LAST_SENT_DATE` — no longer parked. It is now a required part of
  **Chunk 10** above, where it guards against the backstop trigger double-sending.)_
- **Dedicated `AUDIT_SALT`** — `SecurityVault.hashSender` currently salts with
  `VERIFIER_KEY` (key reuse: the same key signs messages). Exposure is ~nil for a
  single-recipient tool whose only audit reader holds that key, but a dedicated salt
  property is cleaner. Cheap to add later; noted at the 8b gate.
- **Unsigned-degrade visibility** — when the signer can't claim a sequence number
  (vault lock busy, vanishingly rare) the daily text goes out with no `[#N TAG]`.
  Recipient guidance: "no tag = the bot couldn't sign that one, not forged" — goes in
  the key-provisioning note at deploy. A visible `[unsigned]` marker was considered and
  parked.
- _(Twilio `X-Twilio-Signature` validation was investigated and dropped — GAS web apps
  can't read request headers, so it's infeasible on this stack. Superseded by the URL
  bearer token in ADR 008.)_
