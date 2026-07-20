# stall — community marketplace

A peer-to-peer marketplace for a local community. Members sign in with GitHub,
list items with photos, browse and search, message each other about listings,
make offers, and settle in **platform credits** held in escrow until both sides
confirm — then review each other. No real money moves; the credits ledger still
behaves like money.

**Live instance:** https://stall-frontier-one-shot.fly.dev
**Release log:** [RELEASES.md](RELEASES.md)

## Product constants (stated per the PRD's open questions)

| Constant | Value |
| --- | --- |
| Seeded balance per member | **1000 credits** (integer credits only) |
| Photos per listing | up to **4**, max **5MB** each (JPEG/PNG/WebP) |
| Report-hide threshold | **3 distinct members** |
| Categories | electronics, furniture, clothing, books, toys-games, sports, garden, other |

## Sign-in

GitHub OAuth via the [device authorization grant](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow):
no passwords are ever collected or stored, and the GitHub access token is used
once to read the public profile, then discarded. The OAuth client id is
configurable (`GITHUB_CLIENT_ID`); it defaults to GitHub's public CLI client so
the app runs with zero pre-registration. Swap in a dedicated OAuth app by
setting the env var — no code change.

## Architecture

- **Node 22 + Express**, server-rendered HTML with a thin JSON API underneath
  (`/api/...`). Everything the UI does goes through the same API the harness probes.
- **SQLite (better-sqlite3, WAL)** on a Fly.io volume. Synchronous
  single-connection transactions serialize all money movements — the ledger's
  invariants are enforced inside `IMMEDIATE` transactions, so concurrent
  HTTP requests cannot interleave inside a balance check.
- **Cloudflare R2** (S3 API) for listing photos, keyed by unguessable UUIDs and
  streamed through the app (bucket stays private). Falls back to local disk
  when R2 isn't configured (dev/CI).
- **Fly.io** single machine + volume (single-writer SQLite by construction).
- **Search** is SQLite FTS5 over titles and descriptions (from v0.2.0).

## Ledger model (from v0.3.0)

Integer credits only. Every member is seeded 1000 credits on account creation;
a `ledger_meta` row tracks total credits ever seeded. Escrow is held as rows in
`escrows` (`held`/`released`/`refunded`). The invariant — `SUM(balances) +
SUM(held escrow) == total seeded` — plus non-negativity and no-double-spend are
enforced transactionally and continuously verified by the harness. An
append-only `ledger_entries` journal records every movement.
`GET /api/ledger/checkpoint` exposes the aggregate invariant publicly.

## Verification harness

`harness/` probes a **running instance over its public HTTP API**, authenticated
as real, distinct members:

- **Authorization probe** (`authz-probe.js`) — a second authenticated member
  attempts direct API reads of others' message threads and mutations of
  others' listings and offers; every attempt must be refused. Includes the
  report-threshold hiding behaviour.
- **Ledger property runner** (`ledger-runner.js`) — seeded randomized sequences
  of offers, acceptances, cancellations, completions, and genuinely concurrent
  double-spend attempts; asserts zero-sum, non-negativity, and escrow lifecycle
  correctness after every operation.

```sh
npm run harness:local                       # boot a throwaway instance and probe it
node harness/run.js --url https://stall-frontier-one-shot.fly.dev --secret $HARNESS_SECRET
node harness/run.js --local --seed 42 --ops 300   # reproducible ledger sequences
```

Harness members are minted through a **secret-gated** endpoint
(`POST /api/harness/login`, disabled unless `HARNESS_SECRET` is set). It can
only create flagged synthetic members — never touch a human account.

## Deploys

Every push to `main` runs the harness against a throwaway instance, then
deploys to Fly.io, then re-runs the harness against production
(`.github/workflows/deploy.yml`). There is no manual deploy step. Releases are
tagged `v*` and recorded in [RELEASES.md](RELEASES.md) with their deployment
evidence.

## Running locally

```sh
npm ci
npm start                 # http://localhost:3000, SQLite in ./data
npm run harness:local     # full verification harness
```

Config via env: `PORT`, `DATABASE_PATH`, `SESSION_SECRET`, `HARNESS_SECRET`,
`GITHUB_CLIENT_ID`, `BASE_URL`, and `CLOUDFLARE_R2_*` for photo storage.
