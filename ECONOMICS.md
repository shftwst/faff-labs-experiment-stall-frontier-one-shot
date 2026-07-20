# Economics report — stall (frontier one-shot)

Self-measured from this session's transcript
(`~/.claude/projects/…/da2cac6b-7f19-4aeb-9354-2c086ebf687d.jsonl`, committed
redacted at `transcripts/session-da2cac6b.jsonl`). All token figures are sums
of per-message `usage` fields — nothing below is estimated. The transcript
flushes with a lag: the committed snapshot ends at **14:34:56Z**, so the tail
of the bookkeeping (this report's final numbers, the last commits, and the
session's final message) post-dates the snapshot and is **excluded from its
own totals** (stated, not estimated). The transcript is the authoritative
source for verification. Machine-readable copy: [economics.json](economics.json).

## Session

| | |
| --- | --- |
| Model | `claude-fable-5` |
| Harness | Claude Code (claude-box container), version 2.1.215 |
| Session start | 2026-07-20T13:48:17Z |
| Snapshot end | 2026-07-20T14:34:56Z (~47 min covered; bookkeeping tail excluded) |
| User turns | 7 (1 real instruction + 6 harness/system notices) |
| Assistant messages with usage | 241 |
| Subagents | 0 |

## Token totals (per usage field, never collapsed)

| Field | Tokens |
| --- | --- |
| `input_tokens` (uncached) | 478 |
| `output_tokens` | 410,918 |
| `cache_creation_input_tokens` | 632,074 |
| `cache_read_input_tokens` | 30,082,526 |

Prompt caching carried essentially all context: uncached input is negligible
and cache reads dominate at ~30M tokens across 241 model calls.

## By phase (observed activity, chronological)

| Phase | Wall clock | Turns | Output | Cache create | Cache read |
| --- | --- | --- | --- | --- | --- |
| Brief + environment survey | 3.7 min | 36 | 51,641 | 259,334 | 1,584,117 |
| v0.1.0 build (auth, listings, photos, harness v1, infra) | 7.2 min | 47 | 98,273 | 84,499 | 4,006,380 |
| v0.1.0 deploy, tag, release log | 3.4 min | 16 | 16,878 | 9,020 | 1,741,614 |
| v0.2.0 build+ship (search, messaging) | 3.3 min | 27 | 24,211 | 35,318 | 3,226,852 |
| v0.3.0 build+ship (ledger, offers, escrow, property runner) | 8.7 min | 41 | 108,596 | 115,055 | 5,954,639 |
| v0.4.0 build+ship (reviews), tag + log, verification start | 7.5 min | 44 | 51,622 | 60,176 | 7,599,043 |
| Verification sweep + bookkeeping + CI false-positive diagnosis & harness fix (0.4.1) | 7.3 min | 28 | 58,849 | 66,551 | 5,543,796 |
| Bookkeeping tail in snapshot | 0.2 min | 2 | 848 | 2,121 | 426,085 |
| Bookkeeping tail after snapshot | — | — | excluded | excluded | excluded |

(`input_tokens` per phase: 68 / 94 / 32 / 54 / 82 / 88 / 56 / 4.)

The three most expensive phases are the three most valuable: the v0.1.0
foundation (auth + listings + harness + CI/deploy infrastructure), the v0.3.0
ledger (money semantics plus the property runner and its shadow-model oracle),
and the verification/diagnosis phase that caught and fixed the harness's
exclusivity assumption.

## By tool

| Tool | Calls | Result payload (chars, measured) |
| --- | --- | --- |
| Bash | 55 | 28,766 |
| Edit | 37 | 8,352 |
| Write | 28 | 5,951 |
| Read | 5 | 12,859 |
| TaskCreate | 6 | 457 |
| TaskUpdate | 10 | 240 |
| ToolSearch | 1 | 103 |

The API reports no per-tool-result token figure, so result sizes are given in
characters of recorded `tool_result` content — a measured quantity, not a
token estimate. Tool results were kept deliberately small (`tail`, `grep -c`,
one-line JSON extractions): 142 tool calls produced only ~57KB of result text.

## Waste analysis

Every release's harness → deploy → production-probe pipeline went green on
first attempt, and there were no dead-end approaches. The segments that spent
the most for the least progress:

1. **CI production-probe false positive (the largest item).** After v0.4.0, one
   CI run's production probe failed: the ledger runner's strict
   "server escrow == baseline + shadow model" equality assumes exclusive
   access to the instance, and another harness invocation overlapped on shared
   production (a transient 15-credit escrow from a concurrent run's fixture).
   The PRD invariants — zero-sum, non-negativity, per-member balances,
   double-spend refusal — all passed in that run. Diagnosis required job-timing
   forensics across three CI runs; the fix (exclusive/shared harness modes,
   `0.4.1`) re-deployed green. ~10 tool calls, roughly 25k output tokens, one
   extra CI cycle.
2. **package.json rewrite** — the Write tool refused to overwrite the
   npm-init file before it was read; one `cat` plus a rewrite. ~1.5k output
   tokens.
3. **curl multipart quoting slip** — `;type=image/jpeg` was eaten by the
   shell, a smoke-test photo silently failed its mimetype filter; one
   diagnostic retry. ~2k output tokens.
4. **Redundant CI deploys** — each release-log commit re-deployed identical
   application code (fly releases v2/v4/v6 duplicate v1/v3/v5). Zero session
   tokens; a few minutes of CI wall clock.
5. **pkill exit-144 noise** — four smoke-test teardowns surfaced as spurious
   command "errors". Cosmetic.

## Provenance

These figures are self-measured from the transcript by
`transcripts/analyze.js` — sums over per-message `usage` fields, with phases
segmented by event timestamps against the activity observed in the transcript.
This bookkeeping step and the session's final message are necessarily excluded
from their own totals. For verification, recompute from
`transcripts/session-da2cac6b.jsonl`.
