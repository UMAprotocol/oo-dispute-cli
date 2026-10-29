# Testing on a Polygon fork

[Back to README](../README.md)

Everything here runs against a local [anvil](https://getfoundry.sh) fork. The scripts use anvil's well-known test
accounts and refuse to run unless the RPC has the real Polygon contracts. You need Foundry, `curl`, `lsof`, and a
Polygon RPC that serves historical state.

**RPC choice:**
- An archive RPC is best (Alchemy works).
- `https://polygon.drpc.org` is the default but slow.
- The public publicnode endpoint stops serving the fork after a few minutes.

## Rehearsal fork: `yarn fork:up` / `fork:status` / `fork:down`

```bash
FORK_URL=<polygon archive rpc> yarn fork:up
```

`fork:up` does the following:
- starts anvil on port 8555 (`FORK_PORT` to change it);
- creates 11 Polymarket-format proposals about past events (elections, sports, the Fed). 5 are wrong, and one has a
  prompt injection in its description;
- funds a test disputer and deploys a `DisputeBatcher`;
- writes two files:
  - `.oo-dispute/mcp.env`, which points the `oo-dispute` MCP server (from `.mcp.json`) at the fork;
  - `.oo-dispute/fork/apply.env`, for `source .oo-dispute/fork/apply.env && yarn apply --watch`.

`yarn fork:status` shows who disputed what on chain. `yarn fork:down` stops anvil and **removes
`.oo-dispute/mcp.env`**.

**Back up any existing `.oo-dispute/mcp.env` (your mainnet settings) before `fork:up`, and restore it after
`fork:down`.** While the fork is up, any `oo-dispute` server started from this folder reviews the fork.

## Load test: `yarn fork:load` (many simultaneous proposals, no LLM)

```bash
FORK_URL=<polygon archive rpc> yarn fork:load
```

The load test puts the review queue, the MCP server and `apply` under an election-night burst without spending model
tokens:

1. **Fresh oracle.** It deploys a fresh OptimisticOracleV2 on the fork against UMA's real Finder and registers it in
   the Registry. Disputes escalate to the real oracle, but the oracle's storage is local and fast. The CLI is
   pointed at it with `OOV2_ADDRESS`.
2. **Proposals.** It proposes real midterm markets from `selections/midterms-2026.json`, fetched via Gamma, in waves
   of whole events, with exactly one true Yes per neg-risk event and a known share of wrong answers. Requests come
   from an impersonated Polymarket adapter.
3. **Reviewers.** It runs scripted reviewers in parallel. Each runs its own MCP server and loops `next_batch` →
   simulated thinking time → `submit_review`, using the answer key. Some first looks answer `unclear`.
4. **Disputes.** It runs `apply --watch --auto` alongside, then reports on chain: wrong proposals disputed, missed or
   wrongly disputed, dispute delay, and margin before expiry.

| Variable | Default | |
|---|---|---|
| `COUNT` | 1000 | proposals |
| `MINUTES` / `WAVES` | 10 / 20 | spread of the bursts |
| `LIVENESS` | 1200 | seconds (Polymarket uses 7200) |
| `WRONG_RATE` | 0.1 | share of wrong proposals |
| `REVIEWERS` | 10 | scripted reviewers |
| `THINK_MS` | `2000-8000` | simulated time per group |
| `UNCLEAR_RATE` | 0.15 | first looks that answer unclear |
| `FORK_URL` / `FORK_PORT` / `FORK_RPC` | drpc / 8556 / – | fork source, port, or reuse a running fork |

For a quick 3-market check:

```bash
FORK_URL=<rpc> COUNT=3 MINUTES=1 WAVES=1 LIVENESS=600 WRONG_RATE=0.5 REVIEWERS=2 THINK_MS=500-1000 UNCLEAR_RATE=0 yarn fork:load
```

Output goes to `.oo-dispute/load-<timestamp>/`:
- `report.json`
- `reviewers.json`
- `progress.jsonl`
- `answers.json`
- the logs

It never touches `.oo-dispute/mcp.env`.

### Results so far

| Run | Wrong disputed | Correct disputed | Missed | Group reviews | Dispute delay p50 | Min margin |
|---|---|---|---|---|---|---|
| 1,000 proposals / 10 min, 20-min liveness, 10 reviewers | 98 / 98 | 0 | 0 | 1,136 | 40 s | 12.5 min |
| 4,500 proposals / 30 min, 30-min liveness, grouped by event | 446 / 446 | 0 | 0 | 973 | 32 s | 16.8 min |

The queue isn't the bottleneck: `next_batch` takes ~0.2 s and `submit_review` a few ms. With real LLM reviewers,
capacity depends on how many run in parallel and how long each review takes. Grouping by event means about 515
reviews for all the midterms.

## Building blocks

`scripts/fork-rehearsal.js` (needs `FORK_RPC`):

| Mode | What it does |
|---|---|
| `setup <state.json> [count] [batcher.json\|-] [oov2\|managed]` | Requests per requester, proposals, one rival dispute, optional `DisputeBatcher` |
| `scenario <state.json>` | The 11 past-event markets used by `fork:up` |
| `check <state.json>` | Who disputed each request |

`scripts/load/fork-load.js` (`setup` / `generate` / `report`) and `scripts/load/reviewers.js` are the load test
pieces, and `scripts/load/run.sh` orchestrates them. The `DisputeBatcher` bytecode used on forks is vendored in
`scripts/fixtures/DisputeBatcher.json`, built from UMAprotocol/mcp-otb#2826.

**If your fork RPC rejects historical log ranges**, set `START_BLOCK` (or `BLOCK_LOOKBACK_PERIOD`) to cover only blocks
mined on the fork.
