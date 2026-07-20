# Session summary — stall (frontier one-shot)

One session, one instruction: read `prd.md` and deliver the application it
describes — a community marketplace with a money-grade credits ledger, shipped
as genuinely incremental releases.

## What was delivered

**stall** — live at https://stall-frontier-one-shot.fly.dev, source at
https://github.com/shftwst/faff-labs-experiment-stall-frontier-one-shot —
shipped as **four releases over ~25 minutes**, each tagged, CI-deployed when
made, and recorded in [RELEASES.md](RELEASES.md) with a monotone acceptance-
criteria ladder:

1. **v0.1.0 — Listings board.** GitHub OAuth (device flow; no passwords),
   profiles, listings with up to 4 photos in R2, browse with filters,
   owner-only edit/withdraw, report-to-hide (3 distinct reporters), CI
   pipeline (harness → Fly deploy → production probe).
2. **v0.2.0 — Search & messaging.** SQLite FTS5 search with category/price
   filters, newest first; per-listing private threads, participants only,
   enforced server-side on every read and write.
3. **v0.3.0 — Offers, escrow & the credits ledger.** 1000 integer credits
   seeded per member (trigger-enforced, journaled); offers at/below asking;
   acceptance atomically escrows and reserves; mutual confirmation releases to
   the seller; cancellation refunds in full. Synchronous single-writer SQLite
   transactions make concurrent overdraws impossible. Public zero-sum
   checkpoint endpoint.
4. **v0.4.0 — Reviews.** One per party per completed transaction, only after
   completion, immutable (API + DB triggers that abort UPDATE/DELETE).

## Verification

The harness (`harness/`) probes a running instance over its public API as
real, distinct authenticated members: an **authorization probe** (cross-member
thread reads, listing/offer mutations — all refused), a **search probe**, a
**reviews probe**, and a **ledger property runner** — seeded-random op
sequences with a shadow-model oracle, zero-sum + non-negativity asserted after
every operation, per-member balance audits, and concurrent double-spend rounds
whose acceptances genuinely overlap in flight.

Final state: **49/49 checks green** locally and in CI; **47/47 against
production** (fewer ops → fewer double-spend rounds); production ledger
zero-sum. The release ladder was spot-checked the way an evaluator would:
`git checkout v0.2.0 && npm ci && npm run harness:local` passes exactly the
25 checks claimed at that tag. Every release's CI run went green on first
attempt; deploys are fully automated (push → harness → deploy → probe).

## Notable choices

- **GitHub OAuth via device flow** — OAuth apps can't be registered
  headlessly, so sign-in uses the device authorization grant with a
  configurable client id (defaults to GitHub's public CLI client). Real OAuth,
  zero passwords, zero pre-registration; swap in a dedicated app via env var.
- **Harness auth** is a secret-gated endpoint minting flagged synthetic
  members — the probe authenticates as real second members against production
  without ever being able to touch a human account.
- **better-sqlite3 on a single Fly machine + volume** — synchronous
  transactions serialize all money movements, making the concurrency
  requirements hold by construction rather than by locking discipline.

## Bookkeeping

- [ECONOMICS.md](ECONOMICS.md) / [economics.json](economics.json) — token
  economics self-measured from the transcript (output 339k; cache reads
  ~22.6M; uncached input 402), by phase and by tool, with waste analysis.
- [transcripts/](transcripts/) — the redacted session transcript plus the
  analysis and redaction tooling. No subagents were used.
