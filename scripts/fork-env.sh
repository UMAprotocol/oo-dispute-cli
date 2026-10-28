#!/usr/bin/env bash
# Local Polygon fork for trying the dispute CLI and the agent review queue end to end, without touching mainnet.
#
#   yarn fork:up       start anvil, create Polymarket-style test proposals, write config for the MCP server and apply
#   yarn fork:status   show whether the fork is running and the review queue state
#   yarn fork:down     stop anvil and remove the fork config
#
# Needs Foundry's anvil. FORK_URL (default https://polygon.drpc.org) must serve historical state; FORK_PORT defaults
# to 8555.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR="$PWD/.oo-dispute/fork"
MCP_ENV="$PWD/.oo-dispute/mcp.env"
PORT="${FORK_PORT:-8555}"
RPC="http://127.0.0.1:$PORT"
FORK_URL="${FORK_URL:-https://polygon.drpc.org}"

rpc() {
    curl -s -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}

running() {
    [ -f "$DIR/anvil.pid" ] && kill -0 "$(cat "$DIR/anvil.pid")" 2>/dev/null
}

up() {
    command -v anvil >/dev/null || { echo "anvil not found. Install Foundry: https://getfoundry.sh"; exit 1; }
    if running; then echo "The fork is already running (pid $(cat "$DIR/anvil.pid")). Run 'yarn fork:down' first."; exit 1; fi
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is already in use. Set FORK_PORT to a free port."; exit 1; fi

    mkdir -p "$DIR"
    rm -f "$DIR"/review.sqlite*
    [ -f dist/mcp-entry.js ] || yarn -s build

    echo "Starting anvil (forking $FORK_URL) on $RPC..."
    nohup anvil --fork-url "$FORK_URL" --port "$PORT" --block-time 1 --silent > "$DIR/anvil.log" 2>&1 &
    echo $! > "$DIR/anvil.pid"
    for _ in $(seq 1 60); do rpc eth_blockNumber | grep -q result && break; sleep 1; done
    rpc eth_blockNumber | grep -q result || { echo "anvil did not start; see $DIR/anvil.log"; exit 1; }
    FORK_BLOCK=$(rpc anvil_nodeInfo | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.forkConfig.forkBlockNumber))')

    echo "Creating test proposals (takes a minute or two)..."
    FORK_RPC="$RPC" node scripts/fork-rehearsal.js scenario "$DIR/scenario.json" 2>&1 | grep -v secp256k1 | tee "$DIR/scenario.log"
    KEY=$(sed -n 's/^DISPUTER_PRIVATE_KEY=//p' "$DIR/scenario.log")
    BATCHER=$(sed -n 's/^DISPUTE_BATCHER_ADDRESS=//p' "$DIR/scenario.log")

    # Read by the MCP server (dist/mcp-entry.js) when Claude Code or Codex starts it from this folder.
    cat > "$MCP_ENV" <<EOF
# Written by 'yarn fork:up'. Points the review MCP server at the local fork; 'yarn fork:down' removes it.
CHAIN_ID=137
NODE_URL_137=$RPC
START_BLOCK=$((FORK_BLOCK + 1))
MAX_BLOCK_LOOK_BACK=1
REVIEW_DB=$DIR/review.sqlite
EOF
    # For 'yarn apply' in a terminal: the same settings plus the fork's test disputer key and batcher.
    # NODE_URLS_137 takes precedence over NODE_URL_137, so clear it in case the shell points at mainnet RPCs.
    { echo "unset NODE_URLS_137"; { grep -v '^#' "$MCP_ENV"; echo "PRIVATE_KEY=$KEY"; echo "DISPUTE_BATCHER_ADDRESS=$BATCHER"; } | sed 's/^/export /'; } > "$DIR/apply.env"

    cat <<EOF

Fork ready at $RPC (forked at block $FORK_BLOCK), with 11 open proposals, 5 of them wrong.

1. Review with an agent. Open this folder in Claude Code (desktop or terminal), enable the 'oo-dispute' MCP server
   from .mcp.json (restart the session if it was already open), then ask:
     "Run the dispute-review prompt: review the open proposals with three dispute-reviewer subagents in parallel."
   Codex: see AGENTS.md; settings come from .oo-dispute/mcp.env.

2. Send the disputes, in a terminal:
     source .oo-dispute/fork/apply.env && yarn apply --watch
   (add --dry-run first if you like). The key is anvil's public test key; it only works on this fork.

3. Check the result on chain:
     FORK_RPC=$RPC node scripts/fork-rehearsal.js check .oo-dispute/fork/scenario.json

While the fork is up, .oo-dispute/mcp.env points the MCP server at it. Run 'yarn fork:down' when you are done.
EOF
}

down() {
    if running; then kill "$(cat "$DIR/anvil.pid")" && echo "Stopped anvil."; else echo "anvil was not running."; fi
    rm -rf "$DIR" "$MCP_ENV"
    echo "Removed fork config (.oo-dispute/fork, .oo-dispute/mcp.env)."
}

status() {
    if running; then echo "Fork running at $RPC (pid $(cat "$DIR/anvil.pid")), block $(($(rpc eth_blockNumber | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result))')))."; else echo "Fork not running."; exit 0; fi
    [ -f "$DIR/scenario.json" ] && FORK_RPC="$RPC" node scripts/fork-rehearsal.js check "$DIR/scenario.json" 2>&1 | grep -v secp256k1
}

case "${1:-}" in
    up) up ;;
    down) down ;;
    status) status ;;
    *) echo "usage: $0 up|down|status"; exit 1 ;;
esac
