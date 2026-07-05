---
description: Run the Council Gate on the current changes — convene the relevant reviewers, consolidate findings to chat.
---

# Council Gate

Run the review gate on the current work. This is a **blocking step before a commit** — a chunk is not done until its gate is clean.

**Scope:** $ARGUMENTS
(If empty, review the uncommitted working changes: `git diff HEAD` plus untracked files under `src/` and tests. If an argument is given, treat it as the chunk/scope to focus on.)

## Step 1 — Establish the facts
1. Get the diff and the list of changed files (`git status`, `git diff HEAD`).
2. **Run the test suite with coverage** (e.g. `npm test -- --coverage`) and capture the result. The QA lead needs real coverage numbers, not a promise. If tests fail or coverage is under 80%, that is already a gate failure — note it, but still run the gate so all findings surface together.

## Step 2 — Convene the reviewers
Always convene the **five always-on reviewers**:
`architecture-guardian`, `code-quality-reviewer`, `test-quality-reviewer` (QA lead), `security-reviewer`, `tech-debt-hunter`.

Add the **domain SMEs** whose territory the diff touches:
- Alpha Vantage calls / GLOBAL_QUOTE parsing → `alpha-vantage-expert`
- Twilio send / inbound webhook → `twilio-expert`
- Manifest / triggers / PropertiesService / `doPost` / V8 sandbox → `gas-platform-expert`
- Money/number formatting, string parsing, coercion, dates → `javascript-rigor-expert`
- The scheduled run, API error handling, unattended failure → `resilience-reviewer`
- Message format, commands, schedule, watchlist behavior → `spec-conformance-reviewer`
- Anything calling a paid/limited API, looping, or spending → `cost-quota-guardian`

Launch the selected agents **in parallel, synchronously** (`run_in_background: false` — a gate needs results before proceeding). Give each agent: the diff, the changed file paths, the captured coverage output, and the instruction to review against the ADRs in `doc/decisions/` and report in their standard format.

## Step 3 — Consolidate (to chat, never to a file)
Collect every agent's findings and present **one** consolidated critique in chat:
- Lead with the **QA lead's coverage figure and pass/veto verdict**.
- Merge duplicate findings (same `file:line` from multiple reviewers → one entry, attributed to all who raised it).
- Rank **most-severe first** (HIGH → MEDIUM → LOW). Each entry keeps its `file:line`, failure scenario, and fix direction.
- If a reviewer returned clean, note it — do not pad with invented findings.

**Hard rules:**
- Findings go to **chat only. Never create or write `.md` report files.**
- The gate is adversarial. A gate that comes back empty across all reviewers is suspicious on real code — double-check before declaring it clean.
- Do **not** auto-apply fixes. Present findings, let David decide what to fix. Then resolve → re-gate if anything material changed → commit.
