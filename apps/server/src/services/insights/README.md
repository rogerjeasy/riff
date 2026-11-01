# Aggregate insights — F30

Bounded, privacy-aware participation and operational summaries for the creator console.

## Contract

- `GET /api/insights?range=stream|24h|7d` (default `stream`), private console route,
  `Cache-Control: no-store`, optional hosted-console session gate. The response
  (`{ insights }`) is validated by `insightsSchema` in `contract.ts` and mirrored in
  `apps/web/src/console/insights/contracts.ts`.
- **Last stream** is the latest run of chat decisions without a gap longer than
  30 minutes (looked back at most 12 hours), extended 30 minutes past the last decision so
  trailing incidents count. `24h` and `7d` are rolling windows ending now.
- All reads go through `db/repositories/insights.ts`, which binds `channel_id` and numeric
  bounds as parameters (no user input in SQL) and returns counts only.

## What is computed

| Section                                                                                  | Source                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Participation (people, attempts, admitted, blocked, per active minute, ≤48 time buckets) | `activity` decision rows, excluding `UNRELATED`                                      |
| Blocked-reason breakdown                                                                 | decision codes grouped into reasons (`REASON_OF`)                                    |
| Per-interaction triggers / admitted / blocked / top reason / incidents                   | `activity` + `automations` titles                                                    |
| Round outcomes (started, finished, goal vs deadline)                                     | `session_journal`                                                                    |
| Generation success rate, median / p90 latency                                            | `compile_runs`                                                                       |
| Incidents                                                                                | `activity` incident rows                                                             |
| Proposal engagement (suggestions, ballots, votes, selections)                            | `proposal_contributors`, `proposal_ballots`, `proposal_votes`, `proposal_selections` |
| Plain-language takeaways (≤6)                                                            | derived from the above                                                               |

## Privacy

- Aggregate only: no viewer names, account IDs, per-viewer lists, leaderboards or
  spending rankings are produced; a test asserts names never appear in the output.
- Any group of 1–2 people is suppressed (`MIN_GROUP = 3`): the overall and per-interaction
  participant counts become `null`, and a time bucket with 1–2 people hides all of its
  numbers. Operational counts per interaction (blocked totals) remain visible to the
  creator, who already sees the activity feed.
- Tenant-scoped by `channel_id`; another channel's service sees nothing.

## Limits and known gaps

- `admission_events` is pruned to one hour, so long ranges read the unpruned `activity`
  log. Retention/deletion policy for `activity` is not implemented here.
- Viewer distinctness is by display name as recorded in `activity` (names are never
  returned).
