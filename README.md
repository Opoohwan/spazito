# Spazito

Automated SMS market-price alerts. Every weekday at 5:00pm the recipient's local time,
Spazito texts a one-line summary of the S&P 500, Gold, and Silver (and any custom
watchlist). The recipient can text commands back to change what's tracked or pause
alerts.

Runs entirely on free-tier infrastructure — no server, no database.

## Stack

- **Google Apps Script** — compute, time triggers, key-value storage, and the inbound
  webhook, all in one free runtime
- **Alpha Vantage** (free tier) — price data via `GLOBAL_QUOTE`
- **Twilio** — outbound and inbound SMS
- **clasp** — local development and push to Apps Script

## Documentation

The design is documented before the code. Start here:

- **[doc/ROADMAP.md](doc/ROADMAP.md)** — what's next; the chunked build plan
- **[doc/decisions/](doc/decisions/)** — architecture decision records (why things are
  the way they are)
- **[doc/dev/ARCHITECTURE.md](doc/dev/ARCHITECTURE.md)** — the system map
- **[doc/dev/PROCESSES.md](doc/dev/PROCESSES.md)** — full setup, deployment, and dev
  task recipes
- **[doc/dev/DEBUGGING.md](doc/dev/DEBUGGING.md)** — diagnosing the unattended system
- **[doc/CHANGELOG.md](doc/CHANGELOG.md)** — where we've been

## Status

Pre-build. The architecture and developer docs are complete; `src/` construction begins
at Chunk 0 of the roadmap.
