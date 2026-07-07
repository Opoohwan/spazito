# ADR 008 — Security & Defense-in-Depth

**Status:** Accepted
**Date:** 2026-07-04

## Context

The recipient (David's brother) is off-grid and **very** security-centric. For this user,
strong security is not overhead — it is a **delight feature**. "Overkill" is the point.
This ADR raises Spazito's security from the single-user baseline (which ADR 006 §11 left
as a spoofable `From` check) to layered defense-in-depth, and adds recipient-verifiable
message authentication.

Two honest platform constraints shape what's buildable:
- **A GAS web app cannot read request headers.** True Twilio `X-Twilio-Signature` HMAC
  validation is therefore **impossible** on this stack. A URL bearer token substitutes.
- **SMS is not end-to-end encrypted.** Carriers and Twilio inherently know the number;
  SIM-swap / SS7 attacks live at the carrier layer, which no app can fix. The payload is
  **public stock prices**, so transport secrecy is irrelevant — we harden the *control
  plane* (who can command the bot) and the *Twilio account*, and we do not claim SMS is
  private when it isn't.

## Decision

### 1. The recipient's number never exists anywhere reachable
- Stored only in `Config`/Script Properties (ADR 003). Never in source, logs, error
  messages, or any reply.
- In the audit log it appears only as a **salted hash** (`Utilities.computeHmacSha256Signature`),
  never raw digits.
- Inbound `From` is compared **constant-time**, read fresh from `Config`, never cached.

### 2. Layered webhook gate (all must pass)
1. **Secret deployment URL** — the Apps Script exec URL is a capability secret.
2. **URL bearer token** — a long random `WEBHOOK_TOKEN` in the configured webhook URL
   (`…/exec?k=<token>`), arriving in `e.parameter.k`, **constant-time** compared. This is
   the GAS-legal substitute for signature validation (weaker than HMAC — static, travels
   in the URL — documented as such).
3. **`From == RECIPIENT_NUMBER`** — constant-time.
4. **`MessageSid` replay lock** — reject any repeated Twilio `MessageSid` (short-TTL
   store). A captured request cannot be re-fired.

### 3. Auto-lockout, fail-safe
- After N consecutive blocked attempts the bot **seals** and ignores everyone until
  re-armed with a separate `UNLOCK_SECRET`. Brute force → it goes dark. Any auth failure
  produces a **silent 200** with zero side effects (no Alpha Vantage call, no reply).
- **Amended at the Chunk 8b gate:** only **token-valid** failures count toward the seal
  — a targeted probe by someone holding the secret webhook URL. Ambient junk texts
  (spam that hits every Twilio number; no token) are rejected for one property read
  with **zero writes**: they can neither seal the bot (self-DoS) nor drain the storage
  quota (flood-DoS). While sealed, rejections also write nothing. A replayed
  `MessageSid` cannot re-arm the bot.

### 4. Security is *pull*, not *push* (the anti-spam rule)
- Blocked attempts are **logged to the audit trail only** — never proactively texted.
  (Ambient junk hits Twilio numbers constantly; push-alerting on it would spam the
  recipient and cry wolf. This was an earlier design mistake, corrected here.)
- The recipient pulls it on demand: text **`log`** → redacted recent activity.
- The **only** proactive security text is a single **"🔒 sealed"** notice when the
  lockout trips. **Amended at the Chunk 8b gate: ON by default** — with token-gated
  counting (above), sealing now means a genuinely targeted attack, and a silently-sealed
  bot would just look broken to its one user.

### 5. Twilio account hardening (the real vault door)
- **2FA on the Twilio account.** Spazito authenticates with a **scoped API Key /
  subaccount, not the master Auth Token**, so a leaked Script Property can at worst send
  messages — it cannot own the whole Twilio account or the number.

### 6. Recipient-verifiable message authentication
Each daily price text carries a compact auth block so the recipient can prove it is
genuinely from his bot and unaltered:

```
S&P 7,500 | Gold 4,500 | Silver 70.00 [#47 A3F9C2E1]
```
- `#47` — a monotonic **sequence counter** (persisted state); climbs by 1 per sent
  alert. A repeat = replay; a jump = missed texts.
- `A3F9C2E1` — **`HMAC-SHA256(VERIFIER_KEY, "<count>|<payload>")` → hex → UPPERCASE →
  first 8 chars**, where `payload` is the price line and `<count>|payload` is the exact
  canonical input.

**This contract is authoritative** — the offline verifier and the GAS signer must
produce identical tags. GAS computes it with `Utilities.computeHmacSha256Signature`
(a GAS global), so **signing is a shell step appended *after* the pure `Formatter`
builds the price line** — never in core.

The verifier is a single self-contained offline HTML file (`tools/spazito-verifier.html`):
no network calls, browser-native Web Crypto, a self-test against a published HMAC vector
on load, the key entered locally (never transmitted), and the sequence tracked in
`localStorage`. It is safe to publish/email — security rests in the key, not the tool.

### 7. Key provisioning (out-of-band, split-channel)
- **Email the verifier tool** (harmless — no secret in it).
- **Never email the key.** From a Gmail sender it is not end-to-end encrypted (Google
  holds plaintext) and it persists in inboxes.
- **Split the `VERIFIER_KEY` across two channels:** e.g. half by **snail mail** (paper,
  air-gapped, **no labels** so a thief sees a meaningless fragment), the other half by a
  **second channel** (phone / Signal). Neither piece alone is usable.
- Send the tool's **SHA-256 checksum by the second channel** so the recipient confirms
  the emailed HTML wasn't tampered with. Recipient destroys the paper after entry.

### New secrets & state introduced
- Secrets (`Config`): `WEBHOOK_TOKEN`, `VERIFIER_KEY`, `UNLOCK_SECRET`, scoped Twilio API
  key/secret (replacing the master Auth Token).
- State: message counter, lockout attempt-count + sealed flag, recent `MessageSid` set
  (TTL), audit log (bounded ring).

## Alternatives Considered
- **Twilio `X-Twilio-Signature` HMAC validation** — the "correct" webhook auth, but GAS
  cannot read request headers. Infeasible on this stack. Bearer token substitutes.
- **Push intrusion alerts on every blocked attempt** — rejected: turns ambient Twilio-
  number spam into recipient spam and desensitizes him to real events. Replaced by
  pull-based audit + a single lockout notice.
- **Emailing the key** — rejected: not E2E from Gmail, and persists in mailboxes.
- **TOTP message codes (option 2)** — rejected by the user: not content-bound, and adds
  cruft to every text. The HMAC tag already binds content.

## Consequences

**Gain:**
- Real, layered, *quiet* security the recipient can independently verify — offline, with
  a key only he holds. To hijack anything an attacker needs the secret URL **and** token
  **and** number, must beat replay + lockout, and must have breached a 2FA'd Twilio
  account — while being logged the whole time.
- No self-inflicted spam; security watches and logs, and only speaks when asked.
- Honest posture: no false "encrypted SMS" claims.

**Give up:**
- Real complexity in Chunk 8b (signing, counter, replay store, lockout, audit) and
  several new secrets/state keys.
- A shared `VERIFIER_KEY` that must be provisioned out-of-band and guarded by the
  recipient. If it leaks, message forgery becomes possible (it never transits after
  provisioning).
- Each daily text carries a small `[#N TAG]` block.
