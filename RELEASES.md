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
