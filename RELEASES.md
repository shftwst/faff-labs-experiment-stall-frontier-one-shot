# stall — release log

Each release is deployed to the public instance when made, is independently
usable, and lists the PRD acceptance criteria it brought to passing. Criteria,
once passing, stay passing in every later release (the harness re-runs the full
suite in CI on every push and against production after every deploy).

Acceptance criteria are numbered as they appear in `prd.md` (§ Acceptance
criteria, AC1–AC15 in document order).

---

## v0.1.0 — Listings board (2026-07-20)

**Scope.** The first usable product: a community listings board. GitHub OAuth
sign-in (device flow — no passwords collected or stored), member profiles,
listings with title/description/category/price and up to 4 photos stored in R2,
lifecycle active → withdrawn with owner-only edit/withdraw enforced
server-side, browse newest-first with category and price filters, and
per-listing reporting that hides a listing once 3 distinct members report it.
Verification harness v1 (authorization probe) runs in CI against a throwaway
instance before deploy and against production after deploy.

- **Tagged commit:** `v0.1.0` → c4cbf2e7f9bfe965ee17ee0706887697995c8be2
- **Deployment:** Fly.io release v1 of app `stall-frontier-one-shot`
  (https://stall-frontier-one-shot.fly.dev), deployed 2026-07-20T14:02Z by CI run
  [29748757069](https://github.com/shftwst/faff-labs-experiment-stall-frontier-one-shot/actions/runs/29748757069)
  (harness → deploy → production probe, all green).
- **Acceptance criteria brought to passing:**
  - AC1 — sign-in is GitHub OAuth; no password collected or stored.
  - AC10 — a listing reported by 3 distinct members is hidden from browse and search.
  - AC15 — publicly deployed with automated deploys (push → harness → deploy → probe; no manual step).
- **Passing set after this release:** {AC1, AC10, AC15}
- **Harness:** authorization probe (listings + reports): 14/14 checks passing
  locally in CI and against production.

---

## v0.2.0 — Search & messaging (2026-07-20)

**Scope.** Finding things and talking about them. Full-text search (SQLite
FTS5 over titles and descriptions, trigger-synced) combined with category and
price-range filters, newest first by default. Per-listing private message
threads between an interested member and the listing owner — participants
only, membership enforced server-side on every read and write. Thread inbox,
conversation view, and seller-side conversation list on the listing page.
Harness grows a search probe (query-match, filter, and ordering assertions)
and messaging authorization checks.

- **Tagged commit:** `v0.2.0` → f2beead1fba9ca9900664539ed39f781461b6a24
- **Deployment:** Fly.io release v3 of app `stall-frontier-one-shot`
  (https://stall-frontier-one-shot.fly.dev), deployed 2026-07-20T14:07Z by CI run
  [29749140138](https://github.com/shftwst/faff-labs-experiment-stall-frontier-one-shot/actions/runs/29749140138)
  (harness → deploy → production probe, all green).
- **Acceptance criteria brought to passing:**
  - AC3 — every search result matches the query and active filters, newest first by default.
- **Passing set after this release:** {AC1, AC3, AC10, AC15}
- **Harness:** 25/25 checks passing locally in CI and against production
  (authz probe incl. thread membership; search probe).

---

## v0.3.0 — Offers, escrow & the credits ledger (2026-07-20)

**Scope.** Trading. Every member is seeded 1000 integer credits
(trigger-enforced on every member-creation path, journaled append-only).
Members offer at or below asking price; the owner accepts or declines.
Acceptance atomically moves the buyer's credits to escrow and reserves the
listing (superseding other pending offers); mutual completion confirmation
releases escrow to the seller and completes the listing; cancellation before
completion refunds the buyer in full and returns the listing to active. All
money movements run in synchronous single-writer SQLite transactions, so
concurrent acceptances that would overdraw a buyer serialize and only those
the balance covers succeed. Wallet, offer, and deal UI; public aggregate
invariant endpoint at `/api/ledger/checkpoint`. Harness gains the **ledger
property runner**: seeded randomized sequences of offers, acceptances,
declines, cancellations, completions, and withdrawals with a shadow-model
oracle; zero-sum and non-negativity asserted after every operation;
per-member balance audits; and concurrent double-spend rounds whose
acceptances genuinely overlap in flight.

- **Tagged commit:** `v0.3.0` → 94dba3e28f073b4855d60c46d763853dd113fac2
- **Deployment:** Fly.io release v5 of app `stall-frontier-one-shot`
  (https://stall-frontier-one-shot.fly.dev), deployed 2026-07-20T14:15Z by CI run
  [29749691759](https://github.com/shftwst/faff-labs-experiment-stall-frontier-one-shot/actions/runs/29749691759)
  (harness → deploy → production probe incl. ledger runner, all green).
- **Acceptance criteria brought to passing:**
  - AC2 — cross-member thread reads and listing/offer mutations refused via the API (offers now exist, completing the criterion).
  - AC4 — acceptance reserves the listing and moves offered credits to escrow atomically.
  - AC5 — concurrent overdrawing acceptances: only those the balance covers succeed; balance never negative.
  - AC6 — mutual completion confirmation releases escrow to the seller; listing completed.
  - AC7 — cancellation before completion refunds the buyer in full; listing returns to active.
  - AC8 — sum of balances plus escrow equals total seeded at every harness checkpoint.
  - AC14 — repository includes both harness instruments (authz probe + ledger property runner) reporting per-check results.
- **Passing set after this release:** {AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC10, AC14, AC15}
- **Harness:** 40/40 checks passing locally in CI (120 ops, 131 zero-sum
  checkpoints, 4 double-spend rounds) and against production (40 ops).

---

## v0.4.0 — Reviews (2026-07-20)

**Scope.** Trust. Each party to a completed transaction may post exactly one
review (1–5 rating plus text), only after mutual completion confirmation, and
reviews are immutable once posted — enforced in the API and independently by
database triggers that abort any UPDATE or DELETE on the reviews table.
Public profiles show received reviews with average rating. Harness gains a
reviews probe covering the completion gate, non-party refusal, one-per-party
uniqueness, immutability, and the public review feed.

- **Tagged commit:** `v0.4.0` → 12a51367e671ca9eb205731b26925ec28d38807e
- **Deployment:** Fly.io release v7 of app `stall-frontier-one-shot`
  (https://stall-frontier-one-shot.fly.dev), deployed 2026-07-20T14:24Z by CI run
  [29750105888](https://github.com/shftwst/faff-labs-experiment-stall-frontier-one-shot/actions/runs/29750105888)
  (harness → deploy → production probe, all green).
- **Acceptance criteria brought to passing:**
  - AC9 — review before completion refused; exactly one review per party per completed transaction; immutable once posted.
  - AC11/AC12/AC13 — the release log itself now records ≥3 releases with scope, tagged commit, deployment, and a monotone criteria ladder whose final set is the full set, evidenced by repository and CI/deploy history.
- **Passing set after this release (full set):** {AC1, AC2, AC3, AC4, AC5, AC6,
  AC7, AC8, AC9, AC10, AC11, AC12, AC13, AC14, AC15}
- **Harness:** 49/49 checks passing locally in CI and against production.

---

## Verifying this log from history

- Tags: `git tag -l 'v*'` — each tag's committer date matches its release entry.
- CI/deploys: the linked Actions runs (harness → deploy → production probe)
  ran at the recorded times; `fly releases -a stall-frontier-one-shot` shows the
  matching deployment sequence (fly v1/v3/v5/v7 ↔ v0.1.0/v0.2.0/v0.3.0/v0.4.0).
- Spot-check a release: `git checkout v0.2.0 && npm ci && npm run harness:local`
  — the checks that pass there are exactly the criteria claimed at that tag
  (25 checks; no offer/ledger/review checks exist yet at that point).
