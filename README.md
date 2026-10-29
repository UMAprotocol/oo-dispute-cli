# Optimistic Oracle Dispute CLI

A last-resort tool for disputing wrong UMA Optimistic Oracle proposals (mostly Polymarket markets on Polygon) when the
usual tools and APIs are down. It talks to the chain through your own RPC. There are two ways to use it:

- **In a terminal:** review open proposals one by one and dispute the wrong ones.
- **With agents:** Claude Code or Codex review proposals in parallel from a shared queue (through a local MCP
  server), and a human sends the disputes with one command.

Disputes go out in batches: through the `DisputeBatcher` on the permissionless OOv2, and through the Managed OOv2's
own `multicall`. If batching fails, it falls back to one transaction per dispute.

## Quickstart

```bash
yarn install --frozen-lockfile && yarn build
```

Then configure the chain, the RPC and the key. Either copy `.env.example` to `.env` and fill it in, or export them
in the shell:

```bash
export CHAIN_ID=137 NODE_URLS_137='["https://<rpc-1>","https://<rpc-2>"]'
```

```bash
read -rs PRIVATE_KEY && export PRIVATE_KEY
```

The second command asks for the key without echoing it and keeps it out of your shell history. Use a dedicated
wallet (see [Wallet, funds and keys](#wallet-funds-and-keys)).

Then pick a path:

| Situation | Use |
|---|---|
| A handful of proposals to check, by hand | **[A. Terminal](#a-dispute-from-the-terminal)**: `yarn dispute -p` |
| Hundreds or thousands (e.g. election night) | **[B. Agents](#b-review-with-agents-claude-code-or-codex)**: MCP review + `yarn apply --watch` |
| First time, or before an incident | **[C. Rehearse on a fork](#c-rehearse-on-a-fork)**: `yarn fork:up`, nothing real is touched |

Always try `--dry-run` first: it reads, re-checks and simulates everything, but approves and sends nothing.

## Prerequisites

- Node.js **22.13 or later** (the agent queue uses the built-in `node:sqlite`). `yarn dispute` alone also runs on
  Node 18.
- yarn 1.22.
- A Polygon RPC that allows `eth_getLogs` over ~3,500 blocks; otherwise set `MAX_BLOCK_LOOK_BACK`. Configure two
  providers in `NODE_URLS_137` so one can fail.
- For fork rehearsals: [Foundry](https://getfoundry.sh) (`anvil`) and an RPC that serves historical state.

## Wallet, funds and keys

- **A dedicated hot wallet**, holding only what it may post.
- **Bonds:** each dispute posts the proposer's bond plus UMA's final fee, in the bond token (USDC.e for Polymarket).
  `apply` shows it per proposal. Midterm markets bond $750 (House) to $2,750 (statewide) each, and the 515 midterm
  events total about $5.5M in bonds. Plan for the share you expect to dispute.
- **Gas:** POL. A batch of 20 disputes uses up to ~7M gas.
- **Approvals:** the first send asks to approve the bond token for the contract that pulls the bond (the
  `DisputeBatcher` or the Managed OOv2). Approving ahead of time avoids that prompt mid-incident.
- **Key handling:**
  - Only `yarn dispute` and `yarn apply` read `PRIVATE_KEY`, from the environment or a `.env` (gitignored).
  - The MCP server that agents use never takes it, even if a `.env` defines it.
  - Never paste the key into an agent chat.
- **DisputeBatcher:** not deployed on Polygon yet (UMAprotocol/mcp-otb#2826). Leave `DISPUTE_BATCHER_ADDRESS` empty
  until it is. Permissionless OOv2 disputes then go one per transaction; Managed OOv2 disputes are batched either way.

## A. Dispute from the terminal

```bash
yarn dispute -p --dry-run
```

The command lists open Polymarket proposals on both oracles, most urgent first. For each one you answer:

| Key | Action |
|---|---|
| `y` | queue the dispute |
| `s` | queue it and send the queue now |
| `n` | skip |
| `q` | stop reviewing and send what is queued |

The queue is also sent when it's full, or when a queued proposal is about to expire. Drop `--dry-run` to send for
real. Managed OOv2 proposals past their liveness are still shown: they can be disputed until the resolver settles
them.

## B. Review with agents (Claude Code or Codex)

Agents review; you send. Nothing is hosted: the agent starts the MCP server (`dist/mcp-entry.js`) as a local
process, and it keeps a shared queue in `.oo-dispute/review-137.sqlite` in this repo.

1. **Build:** `yarn build`.
2. **Give the MCP server its settings.** The Claude desktop app doesn't pass your shell variables, so put them in
   `.oo-dispute/mcp.env`:
   ```bash
   mkdir -p .oo-dispute && printf 'CHAIN_ID=137\nNODE_URLS_137=["https://<rpc-1>","https://<rpc-2>"]\nREVIEW_SELECTION=selections/midterms-2026.resolved.json\n' > .oo-dispute/mcp.env
   ```
   - This file **wins over shell variables**. Never put `PRIVATE_KEY` in it: it is ignored.
   - `REVIEW_SELECTION` makes the midterms the default scope; leave it out to review everything.
   - Check that this file doesn't still point at a fork from an earlier rehearsal.
3. **Open this folder in Claude Code** (a new session) and enable the `oo-dispute` server from `.mcp.json`. To check
   it, ask: *"call `progress` on oo-dispute"*. The first call scans the chain and can take a few minutes.
   - For Codex, see [AGENTS.md](AGENTS.md).
   - `.mcp.json` passes `--only-polymarket`.
4. **Start the review**, for example: *"Run the dispute-review prompt with three dispute-reviewer subagents in
   parallel on scope midterms-2026."* The `dispute-reviewer` subagent only has the review tools and web search, with
   no shell. Prefer a strong model for real decisions.
5. **Send the disputes** from a terminal, with the same `CHAIN_ID`/RPC and your key. It shares the agents' queue,
   `.oo-dispute/review-137.sqlite` in this repo, from whatever folder you run it:
   ```bash
   yarn apply --watch --scope selections/midterms-2026.resolved.json --dry-run
   ```
   - Passing the file (rather than the scope name) works even if `apply` starts before the agents. Drop `--dry-run`
     to send. It asks before each batch, unless you pass `--auto --max-disputes N --max-bond X`.
   - Stop it with Ctrl+C.
   - If reviewers disagree with each other (a `conflict`), it's never sent automatically: `apply` reports it, and you
     decide.

**Midterms:** `selections/midterms-2026.json` lists the 515 midterm events. The committed
`selections/midterms-2026.resolved.json` is a snapshot with 4,552 markets in 512 events. Re-resolve it shortly before
the election, while Polymarket's API is up:
```bash
yarn select resolve selections/midterms-2026.json
```
It lets the review filter and group a race's markets even if Polymarket's APIs are down. For other selections, see
[docs/review-queue.md](docs/review-queue.md#scopes-selecting-markets).

## C. Rehearse on a fork

Back up your `.oo-dispute/mcp.env` first: `fork:up` replaces it and `fork:down` deletes it.

```bash
FORK_URL=<polygon archive rpc> yarn fork:up
```

This starts a local fork with 11 test proposals about past events, 5 of them wrong. Then:
1. Review them with path B in a new Claude Code session.
2. Send the disputes with `source .oo-dispute/fork/apply.env && yarn apply --watch`. The key in that file is anvil's
   public test key and only works on the fork.
3. Check the result on chain with `yarn fork:status`.
4. Clean up with `yarn fork:down`.

To stress-test the queue with thousands of simultaneous proposals, without spending model tokens, use
`yarn fork:load`. See [docs/fork-testing.md](docs/fork-testing.md).

## Pre-election checklist

- [ ] Two working Polygon RPCs in `NODE_URLS_137`, both allowing `eth_getLogs` ranges (or a lower `MAX_BLOCK_LOOK_BACK`).
- [ ] A dedicated wallet funded with USDC.e for bonds and POL for gas, with approvals done.
- [ ] `yarn select resolve selections/midterms-2026.json` re-run in the last day.
- [ ] A rehearsal done (`yarn fork:up` … `yarn fork:down`), and `.oo-dispute/mcp.env` points at mainnet again.
- [ ] Claude Code / Codex sees the `oo-dispute` server, and `progress` answers.
- [ ] `yarn apply --dry-run --scope selections/midterms-2026.resolved.json` runs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `secp256k1 unavailable, reverting to browser version` | Harmless. |
| `CHAIN_ID is not set` / `No RPC configured` | Export the variables, put them in `.env` (CLI), or in `.oo-dispute/mcp.env` (agents). |
| `exceed maximum block range`, `ranges over 10000 blocks…` | The RPC limits `eth_getLogs`: set `MAX_BLOCK_LOOK_BACK=1000` (or lower), or use another provider. |
| `oo-dispute` server missing or "failed to start" in Claude Code | Run `yarn build`, open a new session in this folder, and check `.oo-dispute/mcp.env`. If the desktop app can't find `node` (nvm, mise…), put the absolute path to `node` in your local `.mcp.json`. |
| The agents see fork proposals during a real incident | A leftover `.oo-dispute/mcp.env` from a rehearsal: run `yarn fork:down` and recreate it. |
| `apply` finds no candidates | Use the same `CHAIN_ID`/RPC and `--scope` as the agents, and don't point `--db`/`REVIEW_DB` elsewhere. |
| `Another apply is already running` | Only one `apply` per database. Ctrl+C releases it at once; after a `kill -9`, wait 2 minutes. |
| A proposal shows as `conflict` | Reviewers disagree: it's never sent automatically. Decide by hand (`yarn dispute`), or ask a reviewer to re-check. |
| Polymarket V2 proposals are not reviewed | V2 (OOReporter, JSON ancillary data) isn't supported yet, and `--only-polymarket` excludes it. |
| `Approve unlimited?` prompt | The bond token isn't approved for the contract that pulls the bond. Answer `y`, or approve ahead of time. |

## Reference

### Commands

| Command | Purpose |
|---|---|
| `yarn dispute [options]` | Interactive terminal review and dispute (path A) |
| `yarn apply [options]` | Send the disputes the agent reviews call for (path B) |
| `yarn mcp [options]` | The MCP review server; agents normally start it from `.mcp.json` |
| `yarn select resolve <file> [-o out]` | Resolve a selection's slugs/tags to ids through Gamma |
| `yarn fork:up` / `fork:status` / `fork:down` | Local rehearsal fork |
| `yarn fork:load` | Load test on a fork |
| `yarn test` | Unit tests (no network) |

**Shared by `dispute` and `apply`:**

| Option | Default | |
|---|---|---|
| `-p, --only-polymarket` | off | Only Polymarket requesters (excludes V2 for now) |
| `-o, --oracle <all\|oov2\|managed>` | all | Which oracles to scan (`managed` is Polygon only) |
| `-m, --multiplier <n>` | 4 | Multiplier on the priority fee (decimals allowed) |
| `--no-batch` | | One dispute per transaction |
| `--batch-size <n>` | 20 | Disputes per batch transaction |
| `-d, --dry-run` | off | Simulate; approve and send nothing |

**`dispute` only:**

| Option | Default | |
|---|---|---|
| `-t` / `-b` / `-r` / `-a` | `-t` | Sort by time left / bond / random / event order |
| `--flush-before <min>` | 10 | Send the queue when a queued proposal expires within this many minutes |

**`apply` only:**

| Option | Default | |
|---|---|---|
| `-w, --watch` | off | Keep running and send new candidates |
| `--interval <s>` | 20 | Polling interval in watch mode |
| `--scope <name\|file>` | all | Only this scope's disputes |
| `--auto --max-disputes <n> --max-bond <x>` | | Send without asking, within these limits (bond in token units) |
| `--db <path>` | `.oo-dispute/review-<chain>.sqlite` in the repo | Review database |
| `--min-confidence <n>` / `--confirmations <n>` | 0.8 / 1 | Dispute policy (stored in the database, shared with the MCP server) |

**MCP server** (`dist/mcp-entry.js`):

| Option | Default | |
|---|---|---|
| `-o, --oracle` / `-p, --only-polymarket` | all / off | As above (`.mcp.json` passes `-p`) |
| `--select <files…>` | | Selection files to load as scopes; the first becomes the default scope |
| `--scope <name>` | | Default scope for tool calls |
| `--db`, `--min-confidence`, `--confirmations` | | As for `apply` |
| `--lease-minutes <n>` | 10 | How long a claimed group stays reserved |
| `--no-market-data` | | Don't query Polymarket's public API |

### Environment variables

| Variable | Used by | Default / notes |
|---|---|---|
| `CHAIN_ID` | all | Required. 137 for Polygon |
| `NODE_URLS_137` / `NODE_URL_137` | all | Required. A JSON array of RPCs tried in order (wins), or a single URL |
| `NODE_RETRIES`, `NODE_RETRY_DELAY`, `NODE_TIMEOUT` | all | 2 retries, 1 s, 60000 ms |
| `PRIVATE_KEY` | `dispute`, `apply` | Required there; never read by the MCP server |
| `DISPUTE_BATCHER_ADDRESS` | `dispute`, `apply` | Empty: OOv2 disputes go one per transaction |
| `BLOCK_LOOKBACK_PERIOD` | all | 43200 (~24 h) blocks scanned on a fresh start |
| `START_BLOCK` | MCP, `apply` | First block a fresh review queue scans (overrides the lookback) |
| `MAX_BLOCK_LOOK_BACK` | all | 3499 blocks per `eth_getLogs` call |
| `MIN_PRIORITY_FEE_GWEI` | sending | 30 on Polygon (ethers v5 assumes 1.5) |
| `GAS_PER_DISPUTE` | sending | 500000 gas budgeted per dispute in a batch |
| `RPC_CONCURRENCY` | all | 10 calls in flight |
| `REVIEW_DB` | MCP, `apply` | `.oo-dispute/review-<chain>.sqlite` in the repo |
| `REVIEW_SELECTION` | MCP | Comma-separated selection files loaded at start-up |
| `SCAN_INTERVAL_SECONDS` | MCP, `apply` | 15 |
| `OO_DISPUTE_ENV_FILE` | MCP | `.oo-dispute/mcp.env` in the repo; settings file read at start-up (it wins over the environment) |
| `OOV2_ADDRESS` / `MANAGED_OOV2_ADDRESS` | all | Override the oracle addresses (testnets, forks) |
| `POLYMARKET_CLOB_URL` / `POLYMARKET_GAMMA_URL` | MCP, `select` | Polymarket's public APIs |

## Further reading

- [docs/review-queue.md](docs/review-queue.md): how the agent queue works, the dispute policy, scopes, MCP tools and
  the security model.
- [docs/fork-testing.md](docs/fork-testing.md): the rehearsal fork, the load test and its results, and the scripts
  behind them.
- [AGENTS.md](AGENTS.md): instructions for agents and the Codex setup.
