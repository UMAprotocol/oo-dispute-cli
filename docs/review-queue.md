# Agent review queue: how it works

[Back to README](../README.md)

Three pieces share one SQLite database (`.oo-dispute/review-<chain>.sqlite`, or `REVIEW_DB` / `--db`):

- **`yarn mcp`** (`dist/mcp-entry.js`): a local stdio MCP server that an agent (Claude Code, Codex) starts itself.
  It scans the chain, keeps the review queue and exposes read-only review tools. It never holds the private key.
- **Reviewer agents**: they loop `next_batch` → research → `submit_review`. Several can run in parallel, in one
  session (subagents) or several sessions on the same machine.
- **`yarn apply`**: run by a human, with the key. It sends the disputes the reviews call for.

## Queue behaviour

- **One review per event.** A proposal is grouped with the other markets of its Polymarket event, using the first
  of these that is available:
  1. the neg-risk market id from Polymarket's CLOB;
  2. the event recorded in a resolved selection, which works offline;
  3. the Gamma event;
  4. an identical rules text;
  5. otherwise it is on its own.

  Neg-risk events are **mutually exclusive**: a submission that would make two markets resolve Yes is rejected, and
  such proposals are flagged. Agents can merge groups with `regroup`.
- **Claims with leases.** `next_batch` hands each group to one agent for 10 minutes (`--lease-minutes`), most urgent
  first. A group larger than the batch is served in parts while the claim stays with its reviewer. An agent that
  stops gives its work back with `release_claim`, or the lease expires. Each MCP process (one per Claude Code or
  Codex session) appends its own random suffix to agent names (`r1` → `r1@3fa2c1`), so sessions sharing the queue
  never share or release each other's claims, even if their agents pick the same names. A restarted session gets a
  new suffix; its old claims come back when their lease expires.
- **New proposals keep arriving.** The queue re-scans the chain at most every 15 s (`SCAN_INTERVAL_SECONDS`). One
  process scans at a time and the others wait for it.
- **`unclear` comes back.** It is re-checked after a third of the remaining liveness (5–30 min), doubling with each
  inconclusive look (up to 2 h), and 5 minutes later when less than 15 minutes are left.
- **Managed OOv2 proposals stay disputable after liveness** until the permissioned resolver settles them
  (`ManagedOptimisticOracleV2` maps `Expired` to `Proposed` for disputes). The queue keeps handing them out, first,
  flagged `liveness_ended_disputable_until_settled`, and retires them when it sees their `Settle` event. On the OOv2,
  liveness is final.
- **Context comes from the chain.** The parsed rules and `res_data` labels come from the ancillary data, and creator
  updates from the bulletin board it names. Polymarket CLOB prices are added when its public API answers and marked
  unavailable otherwise.
- **Cheap flags.** These are deterministic hints computed before any model looks:
  - `multiple_yes_in_exclusive_group`
  - `market_disagrees_with_proposal`
  - `proposed_too_early`
  - `proposed_50_50`
  - `proposed_price_not_in_res_data`
  - `rare_proposer`
  - `creator_updates_present`
  - `expires_within_30_min`
  - `liveness_ended_disputable_until_settled`

## Dispute policy (decided in code, never by the model's prose)

For each proposal, the latest **confident** verdict of each reviewer counts. Confident means not `unclear`, with
confidence ≥ `--min-confidence` (default 0.8).

| Situation | Action |
|---|---|
| No review yet | `pending` |
| Latest verdict `unclear` or low confidence | `recheck` (comes back later) |
| Confident reviewers disagree with each other | `conflict`: never sent, not re-served, `apply` reports it for a human |
| All agree with the proposal | `agree` |
| All disagree with it, fewer than `--confirmations` (default 1) reviewers | `needs_confirmation` (another reviewer looks) |
| All disagree with it, enough reviewers | `dispute`: shows in `dispute_candidates`, `apply` sends it |

`submit_review` also rejects a verdict when the price the agent saw no longer matches the proposal.

The policy is stored in the database, so the MCP server and `apply` use the same thresholds. Passing
`--min-confidence` or `--confirmations` to either updates it.

## Scopes (selecting markets)

A scope is a named selection stored in the queue. `next_batch`, `progress`, `list_queue`, `at_risk` and
`dispute_candidates` take `scope` (`"all"` means everything), and `apply --scope` only sends that scope's disputes.
Different teams can work on different scopes at once. The queue still records every proposal, so switching scopes
needs no new scan.

Every queue has two built-in scopes, split by oracle and re-created whenever the MCP server or `apply` opens it:
- `permissionless`: `{"oracle": ["oov2"]}`, the OOv2, where liveness is final;
- `managed`: `{"oracle": ["managed"]}`, the Managed OOv2, where proposals stay disputable until settled.

```json
{
  "name": "midterms-2026",
  "include": {
    "event_slugs": ["which-party-will-win-the-senate-in-2026"],
    "slugs": ["some-market-slug"],
    "tags": ["midterms"],
    "market_ids": ["6301315"],
    "question_ids": ["0x…"],
    "condition_ids": ["0x…"],
    "title_regex": "\\b(Senate|House|Governor)\\b",
    "requesters": ["0x…"]
  },
  "exclude": { "title_regex": "primary" },
  "protocol": ["polymarket_v1", "polymarket_v2", "other"],
  "oracle": ["managed", "oov2"]
}
```

A proposal is in the scope when all of these hold:
- it matches **any** `include` criterion (or `include` is empty);
- it passes `protocol` and `oracle`;
- it matches no `exclude` criterion.

Matching uses chain data only: the `market_id` in the ancillary data, the UMA question id (`keccak(ancillary)`), the
CTF condition id, the title, the requester and the oracle.

**Resolution.** `yarn select resolve <file>`, or `define_scope`, turns `slugs`, `event_slugs` and `tags` into ids
through Polymarket's Gamma API:
- It also records which event each market belongs to (`market_events` / `events`), so grouping works offline.
- Anything Gamma can't answer is listed in `resolved.unresolved`.
- If **none** of the include criteria resolve, the selection matches nothing, never everything.
- Gamma refuses page offsets past about 2,000 events, so a broad tag (for example `sports`) comes back truncated,
  with a warning. Prefer event slugs or narrow tags.

The repository ships `selections/midterms-2026.json`, the ops list of 515 events, and
`selections/midterms-2026.resolved.json`, a snapshot with 4,552 markets in 512 neg-risk events. Re-resolve shortly
before use.

**Known gap:** Polymarket V2 proposals (requester OOReporter `0x5370…`, JSON ancillary data) are not parsed yet.
`title_regex` and `market_ids` don't match them; `protocol: ["polymarket_v2"]` does. `--only-polymarket` excludes
them.

## MCP tools

| Tool | Purpose |
|---|---|
| `review_policy` | The reviewer policy (load first) and the dispute thresholds |
| `progress` | Queue counts by status, disputes sent, unresolved proposals near expiry |
| `next_batch` | Claim the most urgent groups and get everything needed to review them |
| `submit_review` | Record verdicts for a claimed group (validated) |
| `release_claim` | Give a group back, or all of an agent's groups when called without `group_key` |
| `get_proposal` | Full detail for one proposal, including previous reviews |
| `list_queue` / `at_risk` | Open proposals by expiry / unresolved ones close to expiry |
| `dispute_candidates` | Proposals whose reviews call for a dispute, not yet sent, with the ids to check them: Polymarket market id and event page, UMA question id, CTF condition id, request fields, proposer, bond and a Polygonscan link to the proposal |
| `define_scope` / `list_scopes` | Create or list scopes |
| `regroup` | Put proposals about one event in one group |

There is also the `dispute-review` prompt, the orchestration guide, and the `dispute-reviewer` Claude Code subagent
(`.claude/agents/`), which has only the review tools and web search.

## Security model

- **The MCP server never has `PRIVATE_KEY`.** It removes the variable at start-up and again after loading
  dependencies, which can read a `.env`. Only `apply` / `dispute` sign.
- **Market text is untrusted.** These markets are permissionless, so the description may be written by an
  attacker. Tool output labels it `untrusted_market_text`, and the policy tells agents never to follow instructions
  in it.
- **The dispute decision is made in code** from structured verdict fields. Before sending, `apply` re-checks every
  candidate on chain and simulates the batch.
