# Economics report — stall (frontier one-shot)

Self-measured from this session's transcript
(`~/.claude/projects/…/da2cac6b-7f19-4aeb-9354-2c086ebf687d.jsonl`, committed
redacted at `transcripts/session-da2cac6b.jsonl`). All token figures are sums
of per-message `usage` fields — nothing below is estimated. The transcript is
flushed per turn: the committed snapshot ends at **14:23:59Z**, during the
session's final long turn, so the post-release verification sweep and this
bookkeeping step ran after the snapshot and are **excluded from their own
totals** (stated, not estimated). The transcript is the authoritative source
for verification. Machine-readable copy: [economics.json](economics.json).

## Session

| | |
| --- | --- |
| Model | `claude-fable-5` |
| Harness | Claude Code (claude-box container), version 2.1.215 |
| Session start | 2026-07-20T13:48:17Z |
| Snapshot end | 2026-07-20T14:23:59Z (~36 min covered; verification + bookkeeping tail excluded) |
| User turns | 7 (1 real instruction + 6 harness/system notices) |
| Assistant messages with usage | 203 |
| Subagents | 0 |

## Token totals (whole session, per usage field)

| Field | Tokens |
| --- | --- |
| `input_tokens` (uncached) | 402 |
| `output_tokens` | 339,061 |
| `cache_creation_input_tokens` | 553,437 |
| `cache_read_input_tokens` | 22,644,346 |

Prompt caching carried essentially all context: uncached input is negligible
and cache reads dominate at ~22.6M tokens across 203 model calls.

## By phase (observed activity, chronological)

| Phase | Wall clock | Turns | Output | Cache create | Cache read |
| --- | --- | --- | --- | --- | --- |
| Brief + environment survey | 3.7 min | 36 | 51,641 | 259,334 | 1,584,117 |
| v0.1.0 build (auth, listings, photos, harness v1, infra) | 7.2 min | 47 | 98,273 | 84,499 | 4,006,380 |
| v0.1.0 deploy, tag, release log | 3.4 min | 16 | 16,878 | 9,020 | 1,741,614 |
| v0.2.0 build+ship (search, messaging) | 3.3 min | 27 | 24,211 | 35,318 | 3,226,852 |
| v0.3.0 build+ship (ledger, offers, escrow, property runner) | 8.7 min | 41 | 108,596 | 115,055 | 5,954,639 |
| v0.4.0 build+ship (reviews) + start of tail | 6.3 min | 36 | 39,462 | 50,211 | 6,130,744 |
| Final verification (tag rebuild spot-check, prod harness, OAuth check) + bookkeeping | after snapshot | — | excluded | excluded | excluded |

(`input_tokens` omitted from the table: 68/94/32/54/82/72 per phase.)

The two most expensive phases are exactly the two most valuable: the v0.1.0
foundation (auth + listings + harness + CI/deploy infrastructure) and the
v0.3.0 ledger (money semantics plus the property runner and its shadow-model
oracle).

## By tool

| Tool | Calls | Result payload (chars, measured) |
| --- | --- | --- |
| Bash | 44 | 21,267 |
| Edit | 32 | 7,194 |
| Write | 25 | 5,309 |
| Read | 5 | 12,859 |
| TaskCreate | 6 | 457 |
| TaskUpdate | 10 | 240 |
| ToolSearch | 1 | 103 |

The API does not report a per-tool-result token figure, so result sizes are
reported in characters of recorded `tool_result` content — a measured
quantity, not a token estimate. Tool results were kept deliberately small
(`tail`, `grep -c`, one-line JSON extractions), which is why 117 tool calls
produced only ~47KB of result text.

## Waste analysis

The session had no retry loops, failed CI runs, or dead-end approaches — every
release's harness and deploy went green on first attempt. Residual waste,
quantified:

1. **package.json rewrite** — the Write tool refused to overwrite the
   npm-init-generated file before it was read; one `cat` plus a rewrite.
   ~2 tool calls, ~1.5k output tokens.
2. **curl multipart quoting slip** — `;type=image/jpeg` after a process
   substitution was eaten by the shell, so a smoke-test photo silently failed
   its mimetype filter; one diagnostic retry with a real temp file. ~1 tool
   cycle, ~2k output tokens.
3. **Redundant CI deploys** — each release-log commit re-triggered a full
   deploy of identical code (fly releases v2/v4/v6 duplicate v1/v3/v5). Zero
   session tokens (spent in GitHub Actions), a few minutes of CI wall clock.
4. **pkill exit-144 noise** — three smoke-test teardowns surfaced as spurious
   command "errors". Cosmetic only.

## Provenance

These figures are self-measured from the transcript by
`transcripts/analyze.js` — sums over per-message `usage` fields, with
phases segmented by event timestamps against the activity observed in the
transcript. This bookkeeping step and the session's final message are
necessarily excluded from their own totals. For verification, recompute from
`transcripts/session-da2cac6b.jsonl`.
