# Optimistic Oracle Dispute CLI Tool

## Overview

The OO Dispute CLI is a last-resort command-line tool for disputing many UMA Optimistic Oracle V2 proposals quickly, when the usual UIs and APIs are unavailable. It talks to the chain directly through your own RPC nodes.

It scans the permissionless OOv2 and, on Polygon, the Managed OOv2 in one run. It shows each open proposal (most urgent first), and sends the ones you approve in batches:

- **Permissionless OOv2:** through the `DisputeBatcher` contract, up to 20 disputes per transaction. Your wallet is still the recorded disputer and receives the payout.
- **Managed OOv2:** through the oracle's own `multicall`.
- **Fallback:** one transaction per dispute, sent back to back. Used with `--no-batch`, when `DISPUTE_BATCHER_ADDRESS` is unset, or when the batcher fails its startup check or a batch can't be sent.

Before sending, every dispute is re-checked against live chain state and simulated. Afterwards, results are confirmed from the oracle's `DisputePrice` logs and live state. Proposals that are still open after a batch are retried one by one.

## Prerequisites

- Node.js (version 22.13 or higher; the review queue uses the built-in `node:sqlite`)
- yarn (version 1.22.19 or higher)

## Installation

1. **Install dependencies:**

```bash
yarn install --frozen-lockfile
```

2. **Build the project:**

```bash
yarn build
```

3. **Run the unit tests (optional):**

```bash
yarn test
```

## Usage

### Starting the CLI

```bash
yarn dispute
```

For each proposal the CLI asks:

- `y`: queue the dispute.
- `s`: queue it and send the queue now.
- `n`: skip.
- `q`: stop reviewing and send whatever is queued.

The queue is also sent automatically when it reaches the batch size, when a queued proposal is within `--flush-before` minutes of expiry, and at the end. If the bond token isn't approved for the contract that pulls the bond (the `DisputeBatcher` or the oracle), the CLI asks before approving it.

### Arguments

- `-h` or `--help`: Display help information.
- `-m` or `--multiplier`: Multiplier applied to the priority fee (default is 4). Decimals such as `1.5` are allowed.
- `-t` or `--sort-remaining-time`: Sort by remaining time to dispute, ascending. This is the default.
- `-b` or `--sort-bond-size`: Sort by bond size, descending.
- `-r` or `--sort-random`: Sort randomly.
- `-a` or `--sort-age`: Keep proposals in event order, per oracle.
- `-p` or `--only-polymarket`: Only consider proposals requested from the addresses in `POLYMARKET_REQUESTER_ADDRESSES` in `constants.ts`.
- `-o` or `--oracle <all|oov2|managed>`: Which oracles to scan (default `all`). `managed` is Polygon only. `--managed-oo` is a deprecated alias for `--oracle managed`.
- `--no-batch`: Send one dispute per transaction.
- `--batch-size <n>`: Disputes per batch transaction (default 20).
- `--flush-before <minutes>`: Send the queue when a queued proposal expires within this many minutes (default 10).
- `-d` or `--dry-run`: Read, re-check and simulate everything, but approve and send nothing. A batch can only be simulated if the bond token is already approved for the contract that pulls it; otherwise the dry run says so.

> **Note:** Only one sort option can be applied.

### Environment Variables

- `CHAIN_ID`: The chain ID. Required.
- `NODE_URL_{CHAIN_ID}`: The node URL for the chain ID. Required unless `NODE_URLS_{CHAIN_ID}` is set.
- `NODE_URLS_{CHAIN_ID}`: A JSON array of node URLs, tried in order when one fails, e.g. `NODE_URLS_137='["https://a","https://b"]'`. Recommended: configure several independent providers.
- `NODE_RETRIES`, `NODE_RETRY_DELAY`, `NODE_TIMEOUT`: Retries per node (default 2), delay between retries in seconds (default 1), and request timeout in ms (default 60000).
- `PRIVATE_KEY`: The private key for the disputer wallet. Required.
- `DISPUTE_BATCHER_ADDRESS`: The `DisputeBatcher` deployed for the permissionless OOv2. Optional: without it, OOv2 disputes go one per transaction. At startup the CLI checks that a contract exists at this address and that it is bound to the configured OOv2.
- `MAX_BLOCK_LOOK_BACK`: The maximum block range per log query (default 3499).
- `BLOCK_LOOKBACK_PERIOD`: How many blocks back to look for proposals (default POLYGON_BLOCKS_PER_HOUR \* 24).
- `MIN_PRIORITY_FEE_GWEI`: The minimum tip before the multiplier is applied. Defaults to 30 on Polygon, because nodes there reject the 1.5 gwei that ethers v5 assumes.
- `GAS_PER_DISPUTE`: Gas budgeted per dispute in a batch (default 500000). Batch gas limits are not taken from `estimateGas`: the batcher catches each failed dispute, so the lowest gas limit that doesn't revert can silently skip the last disputes.
- `RPC_CONCURRENCY`: Maximum RPC calls in flight when loading or re-checking proposals (default 10).

### Example Usage

To dispute Polymarket proposals on Polygon Mainnet (chain ID 137) using two RPC providers and the batcher:

```bash
CHAIN_ID=137 NODE_URLS_137='["<RPC_1>","<RPC_2>"]' PRIVATE_KEY=<YOUR_PRIVATE_KEY> DISPUTE_BATCHER_ADDRESS=<BATCHER> yarn dispute -p
```

To rehearse first without sending anything, add `--dry-run`.

## Reviewing with Claude Code or Codex (MCP)

When there are too many proposals to review by hand, agents can review them in parallel while a human sends the
disputes. Nothing is hosted: the agent starts the MCP server as a local process.

- **`yarn mcp`** (`dist/mcp-entry.js`): a local stdio MCP server. It scans the chain, keeps a shared review queue in
  `.oo-dispute/review-<chain>.sqlite`, and gives agents read-only tools. It never sees `PRIVATE_KEY`.
- **`yarn apply --watch`**: run by a human, with the key. It picks up the disputes that reviews call for, re-checks
  them on chain, asks for confirmation, and sends them in batches.

Setup:

1. `yarn install --frozen-lockfile && yarn build` (Node 22.13 or later).
2. Export `CHAIN_ID=137` and `NODE_URLS_137='["<rpc1>","<rpc2>"]'` (or `NODE_URL_137`).
3. Open this folder in Claude Code and enable the `oo-dispute` server from `.mcp.json`. For Codex, see `AGENTS.md`.
4. Ask the agent to run the `dispute-review` prompt, or: "Review the open proposals with three dispute-reviewer
   subagents in parallel." The `dispute-reviewer` subagent (`.claude/agents/`) only has the review tools and web
   search, with no shell.
5. In another terminal: `PRIVATE_KEY=<key> yarn apply --watch` (add `--dry-run` to rehearse).

How the queue works:

- **One review per event.** Markets that share a neg-risk group (from Polymarket's public API) or an identical
  description are grouped, so one review answers all of them. Agents can merge groups with `regroup`.
- **Claims with leases.** `next_batch` hands each group to one agent for 10 minutes (`--lease-minutes`), most urgent
  first. Work from an agent that stops comes back to the queue.
- **New proposals keep arriving.** The queue re-scans the chain at most every 15 s (`SCAN_INTERVAL_SECONDS`).
- **`unclear` comes back.** It is re-checked after a third of the remaining liveness (5–30 min), and again close to
  expiry.
- **Code decides, not the model.** A proposal becomes a dispute candidate only when the latest verdict disagrees with
  the proposed price at confidence ≥ `--min-confidence` (default 0.8), from at least `--confirmations` distinct
  reviewers (default 1). Submissions are rejected if the price the agent saw is stale or if more than one market in a
  mutually exclusive group would resolve Yes.
- **Cheap flags first.** Each proposal comes with deterministic flags: several Yes proposals in an exclusive group,
  market price against the proposal, a too-early or 50-50 proposal, a price outside `res_data`, a rare proposer,
  creator updates present, and less than 30 minutes left.
- **Self-contained.** Context comes from the chain (ancillary data, creator updates from the bulletin board). The
  Polymarket CLOB price is added when its public API answers, and is marked unavailable when it doesn't.

`apply` options: `--watch`, `--interval <s>`, `--dry-run`, and `--auto --max-disputes <n> --max-bond <amount>` to
send without asking within those limits. Only one `apply` can run per review database.

## Fork rehearsal

`scripts/fork-rehearsal.js` creates test proposals on a local Polygon fork, so you can run the whole flow end to end without touching mainnet. It uses anvil's well-known test accounts and refuses to run unless the RPC it is given has the real Polygon contracts.

```bash
anvil --fork-url <polygon archive rpc> --port 8555 --block-time 1
FORK_RPC=http://127.0.0.1:8555 node scripts/fork-rehearsal.js setup state.json 12 <DisputeBatcher.json artifact or -> oov2
# Run the CLI with the env the script prints, then:
FORK_RPC=http://127.0.0.1:8555 node scripts/fork-rehearsal.js check state.json
```

`scenario` mode instead creates Polymarket-style markets about past events (elections, sports, the Fed), some with
wrong proposals and one with a prompt injection in its description, to rehearse agent review end to end:
`FORK_RPC=http://127.0.0.1:8555 node scripts/fork-rehearsal.js scenario state.json`.

The `DisputeBatcher` artifact comes from building `oracle/contracts` in `UMAprotocol/mcp-otb` with Foundry. Pass `managed` instead of `oov2` to create proposals on the Managed OOv2. If your fork RPC rejects historical log ranges, set `BLOCK_LOOKBACK_PERIOD` to the number of blocks mined on the fork and `MAX_BLOCK_LOOK_BACK=1`.
