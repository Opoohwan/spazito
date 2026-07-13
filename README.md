# Spazito

**A daily market-price text, and a bot you can text back.** Every weekday at 5pm, Spazito
sends one line with the prices you care about. Reply to change what it tracks, or pause it.
No app, no account, no server, no database.

```
S&P 749 | Gold 367 | Silver 52.16 [#9 869A94CC]
```

That `[#9 869A94CC]` is not decoration — it's an HMAC signature and a sequence number, so
the recipient can prove **offline** that the text genuinely came from their bot and wasn't
altered or spoofed. More on that below.

**Status: live.** Deployed on Google Apps Script, delivering daily.

---

## Why this repo might be worth your time

Three things here are worth stealing:

1. **A serverless SMS bot with no server and no database** — Google Apps Script does the
   compute, the cron, the key-value store, *and* the inbound webhook, on the free tier.
2. **Recipient-verifiable messages.** Every text carries a truncated `HMAC-SHA256` tag and a
   monotonic counter. A self-contained offline HTML verifier
   ([`tools/spazito-verifier.html`](tools/spazito-verifier.html)) checks it with no network,
   using a key only the recipient holds. A repeat counter means replay; a jump means missed
   texts.
3. **A survival guide for US carrier SMS registration** — the part that nearly killed this
   project and that nobody documents honestly. **Read that section before you write a line
   of code.**

---

## ⚠️ Read this first: US carrier registration will hurt you

Building the app took a few days. **Getting permission to send a text took longer than
building the entire thing.** If you're planning a US SMS bot, this is the most valuable
part of this repo.

### The wall

US carriers block *all* programmatic SMS from unregistered numbers. Your messages will be
accepted by your provider and then silently dropped by the carrier:

```
Error 30034 — US A2P 10DLC: Message from an Unregistered Number
```

**This is a carrier mandate (via The Campaign Registry), not a Twilio policy.** Switching to
Telnyx, Plivo, Bandwidth, Vonage, or anyone else does **not** escape it — same forms, same
reviewers. The only way out of carrier vetting is to leave SMS entirely.

### Path 1: A2P 10DLC (a local number) — rejected 3×

The "normal" path. Register a Brand, register a Campaign, attach your number. We were
rejected **three times**, always for the same reason:

```
Error 30912 — the campaign details describe personal or peer-to-peer messaging
```

Here's the thing nobody tells you: **A2P 10DLC is built for businesses messaging their
customers.** A small, interactive bot that texts a handful of people *reads as P2P* to a
reviewer no matter how you word the description — the terse messages and the two-way command
interaction look like a conversation, not a broadcast. You cannot word your way out of it.
Don't burn your money finding out.

**Cost of that lesson: $19** (brand registration $4 + campaign vetting $15, non-refundable).

### Path 2: Toll-free verification — this is the one that worked

A toll-free number goes through a **completely different review** — anti-spam focused, not
"prove you're a real business." It's more permissive for low-volume and edge use cases.

- **Verification is free.** Resubmissions are free too.
- You **cannot** convert a local number to toll-free. You must buy a toll-free number.
- Approval is quoted at 3–5 business days (ours came back in minutes once we fixed the one
  thing below).

We got rejected once here, too:

```
Error 30489 — Website Must Be Established and Active
```

**This is the trap.** Carriers require a real website, and a single thin page with an opt-in
form (thrown up purely to satisfy them) will get rejected. What passed:

- A **real multi-page site** — landing page, how-it-works, features, sample messages, FAQ
- **Separate** `privacy.html` and `terms.html` pages with real navigation
- An opt-in form with a consent checkbox that is **not pre-checked**, stating message
  frequency, "message and data rates may apply," and STOP/HELP instructions
- A privacy policy explicitly saying you **do not sell, rent, or share** mobile numbers with
  third parties for any purpose

The site that got us approved is in [`docs/`](docs/) — it's served free by GitHub Pages, and
you can lift it wholesale. (We were approved on a `github.io` subdomain, so a paid custom
domain is apparently *not* required — though your mileage may vary.)

### Bonus trap: the Twilio console is buggy

Editing a rejected toll-free verification in the Console threw
`Invalid Customer profile - BU…` with no way forward. **Use the API instead** — and note it
rejects a no-op edit, so you must change at least one field:

```bash
curl -X POST "https://messaging.twilio.com/v1/Tollfree/Verifications/<HH_SID>" \
  --data-urlencode "UseCaseSummary=<some changed text>" \
  -u <ACCOUNT_SID>:<AUTH_TOKEN>
```

Also: when the verification form asks whether to reuse an existing compliance profile, say
**no** and enter it manually. Reusing a 10DLC profile always errored.

### The honest cost

**This is not free**, despite what the old version of this README claimed:

| Item | Cost |
|---|---|
| Google Apps Script | free |
| Alpha Vantage (25 calls/day) | free |
| Toll-free number | ~$2/month |
| Toll-free verification | **free** |
| Messages (~1/weekday) | ~$3–4/year |
| **Total** | **~$28–30/year** |

**~90% of that is fixed rent, not messaging.** Sending the texts costs about $3 a year; the
rest is the price of being allowed to have a number at all. (The abandoned 10DLC path would
have run ~$40/year.)

---

## The texts, and talking back

```
Spazito                          You
─────────────────────────────────────────────
S&P 749 | Gold 367 |
Silver 52.16 [#9 869A94CC]

                              add TSLA

Added TSLA! Now tracking:
SPY, GLD, SLV, TSLA.

                                  list

Tracking: SPY, GLD, SLV, TSLA.
Daily prices are active,
around 5pm on weekdays.
```

| Text this | It does this |
|---|---|
| `list` / `status` | Show the watchlist and whether alerts are active or paused |
| `add TSLA` | Add a ticker (validated against the price API first — bad symbols are refused) |
| `remove TSLA` | Drop a ticker |
| `pause` / `resume` | Stop and restart the daily alerts |
| `help` | The command list |
| `log` | Pull the security audit — recent blocked attempts, senders shown as salted hashes |
| `unlock <secret>` | Re-arm the bot if auto-lockout has sealed it |

Parsing is deliberately forgiving: case-insensitive, extra words ignored (`add TSLA please`
works), and anything it doesn't understand just returns the help text. It never breaks on
garbage.

> **Carrier gotcha:** `STOP` is intercepted by the *carrier*, not by us. It unsubscribes the
> recipient at the network level, and only `START` — not `resume` — undoes it. That's why the
> help copy steers people to `pause`/`resume`.

---

## Architecture

**Functional core, imperative shell.** Every file is exactly one of two kinds, and never both:

- **`src/core/`** — pure. No I/O, no Apps Script globals, no clock. Plain data in, plain data
  out. Unit-tested in plain Node with zero mocks.
- **`src/`** — shell. Fetches, sends, persists, orchestrates. Thin: gather inputs → call the
  core → perform the effect.

Each module owns exactly one thing, and the boundaries are enforced by `grep`-checkable
invariants (only `PriceService` may name Alpha Vantage; only `SmsService` may name Twilio;
only three modules may touch `PropertiesService`).

```
src/
  Config.js          sole reader of secrets; fails loud on a missing key
  Watchlist.js       sole owner of mutable state; LockService-guarded writes
  PriceService.js    sole caller of Alpha Vantage; call spacing, no retries
  SmsService.js      sole caller of Twilio
  SecurityGate.js    the authorization decision (sealed → token → sender → replay)
  SecurityVault.js   sole owner of security state (counter, lockout, replay set, audit)
  Signer.js          appends the [#N TAG] auth block
  Scheduler.js       orchestrates the daily run; owns the trigger
  CommandHandler.js  doPost: gate → parse → dispatch → reply
  Locks.js           the one home of the script-lock discipline
  core/
    Formatter.js     quotes → the message line (money rules, locale-safe grouping)
    CommandParser.js raw SMS body → a parsed intent
    Replies.js       all command-reply copy
    Tickers.js       canonical ticker rules + a format allowlist
    Redactor.js      scrubs secret-shaped substrings before anything is logged
    SecureCompare.js constant-time string equality
```

Source is authored as `.js` (so Node/Jest load it directly) and pushed to Apps Script, where
it runs as `.gs` in one shared global scope. A one-line dual-load guard makes each file work
in both worlds.

**The design is documented before the code.** Eight ADRs in [`doc/decisions/`](doc/decisions/)
record every load-bearing choice and *why* — serverless on Apps Script, state in
PropertiesService with no database, the functional-core seam, living inside the Alpha Vantage
free tier, and the security model.

---

## Security

The recipient is security-conscious, so security is a **feature**, not overhead.
([ADR 008](doc/decisions/008-security-defense-in-depth.md) is the full story.)

**The webhook gate** — every inbound request passes, in order:

1. **Sealed check** — after repeated blocked attempts the bot seals itself and ignores
   everyone until re-armed with a separate secret.
2. **URL bearer token** — a long random secret in the webhook URL. (True Twilio signature
   validation is *impossible* on Apps Script — a GAS web app cannot read request headers — so
   this is the legal substitute, and the README says so honestly.)
3. **Sender check** — constant-time comparison against the configured recipient.
4. **Replay lock** — a repeated `MessageSid` is rejected. A captured request cannot be re-fired.

Failures return a **silent 200** with zero side effects. Only *token-valid* failures count
toward the lockout, so ambient spam (which every Twilio number receives) can never seal the
bot or drain the storage quota — a self-DoS an adversarial review caught before launch.

**Security is pull, not push.** Blocked attempts are logged to a bounded audit ring with
senders stored as salted hashes, retrievable by texting `log`. They are never proactively
texted — that would just relay ambient spam to the recipient.

**Message authentication.** Each alert carries `[#N TAG]`:
`TAG = first 8 hex chars, uppercase, of HMAC-SHA256(VERIFIER_KEY, "<N>|<payload>")`.
The offline verifier and the server-side signer are pinned to each other by golden-vector
tests. Provision the key **out of band, split across two channels** — never email it.

---

## Setup

Full recipes live in [`doc/dev/PROCESSES.md`](doc/dev/PROCESSES.md). The short version:

```bash
npm install -g @google/clasp
clasp login
clasp create-script --type standalone --title "Spazito"
# set "rootDir": "src" in .clasp.json BEFORE any push
clasp push
```

Then, in the Apps Script editor:

1. **Project Settings → Script Properties** — set the secrets (see
   [`doc/dev/SCHEMA.md`](doc/dev/SCHEMA.md) for the full table). Nothing sensitive ever lives
   in this repo.
2. **Deploy → New deployment → Web app**, access **Anyone** (Twilio can't log into Google).
3. Point your Twilio number's inbound webhook at `<exec-url>?k=<WEBHOOK_TOKEN>` (POST).
   **If your number is in a Messaging Service, the webhook goes on the *service*, not the
   number** — otherwise it's silently bypassed.
4. Run `createTrigger` once by hand to install the Mon–Fri schedule.
5. Set `DEBUG_MODE="true"` and run `testSendNow` to watch the whole flow without spending a
   text.

---

## Testing

```bash
npm test
```

**342 tests, 100% coverage**, enforced by config — `src/core/` is pinned at 100%, and shell
modules have a per-file floor so no module can hide under its siblings' average. The pure core
runs in Node with no mocks; shell modules run against mocked Apps Script globals built from
*captured real API responses*, so the mocks can't drift from the live contract.

Every chunk of this codebase was built, reviewed by an adversarial panel, and committed as one
green unit. That review caught real bugs before launch: an API key leaking into exception logs,
an error swallow that would have made a dead run look healthy, and the lockout self-DoS.

---

## License

MIT — see [LICENSE](LICENSE).

Built as a gift for my brother, who now gets a text at 5pm.
