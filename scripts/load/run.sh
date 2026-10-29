#!/usr/bin/env bash
# Fork load test of the agent review queue: many simultaneous Polymarket midterm proposals, scripted reviewers in
# parallel (no LLM), and `apply --watch --auto` sending the disputes. Prints an on-chain report at the end.
#
#   yarn fork:load
#
# Env: COUNT (1000), MINUTES (10), WAVES (20), LIVENESS (1200), WRONG_RATE (0.1), REVIEWERS (10), THINK_MS (2000-8000),
# UNCLEAR_RATE (0.15), FORK_URL (Polygon archive RPC to fork; default https://polygon.drpc.org), FORK_PORT (8556),
# FORK_RPC (reuse an already running fork instead of starting one), LOAD_DIR (.oo-dispute/load-<timestamp>).
set -euo pipefail
cd "$(dirname "$0")/../.."

DIR="${LOAD_DIR:-$PWD/.oo-dispute/load-$(date +%Y%m%d-%H%M%S)}"
PORT="${FORK_PORT:-8556}"
mkdir -p "$DIR"
echo "Load test directory: $DIR"
[ -f dist/mcp-entry.js ] || yarn -s build
[ -f selections/midterms-2026.resolved.json ] || yarn -s select resolve selections/midterms-2026.json

ANVIL_PID=""
cleanup() {
    [ -n "${APPLY_PID:-}" ] && kill -INT "$APPLY_PID" 2>/dev/null || true
    [ -n "${REVIEWERS_PID:-}" ] && kill "$REVIEWERS_PID" 2>/dev/null || true
    [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

if [ -z "${FORK_RPC:-}" ]; then
    command -v anvil >/dev/null || { echo "anvil not found. Install Foundry: https://getfoundry.sh"; exit 1; }
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is in use; set FORK_PORT or FORK_RPC."; exit 1; fi
    anvil --fork-url "${FORK_URL:-https://polygon.drpc.org}" --port "$PORT" --block-time 1 --silent > "$DIR/anvil.log" 2>&1 &
    ANVIL_PID=$!
    export FORK_RPC="http://127.0.0.1:$PORT"
    for _ in $(seq 1 60); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$FORK_RPC" | grep -q result && break; sleep 1; done
fi
echo "Fork: $FORK_RPC"

node scripts/load/fork-load.js setup "$DIR" 2>&1 | grep -v secp256k1

# apply: sends what the reviews decide, without asking (the fork's disputer is pre-approved).
(
    unset NODE_URLS_137
    # eval, not `. <(...)`: macOS's bash 3.2 cannot source a process substitution.
    set -a; eval "$(sed 's/^export //' "$DIR/apply.env" | grep -v '^unset')"; set +a
    exec node dist/mass-dispute-cli.js apply --oracle oov2 --only-polymarket --scope selections/midterms-2026.resolved.json \
        --watch --auto --max-disputes 100000 --max-bond 100000000 --interval 10 < /dev/null > "$DIR/apply.log" 2>&1
) &
APPLY_PID=$!

node scripts/load/reviewers.js "$DIR" > "$DIR/reviewers.log" 2>&1 &
REVIEWERS_PID=$!
( tail -n +1 -f "$DIR/reviewers.log" | grep --line-buffered "\[monitor\]" ) &
TAIL_PID=$!

node scripts/load/fork-load.js generate "$DIR" 2>&1 | grep -v secp256k1 | tee "$DIR/generate.log"

# Reviewers stop once nothing is left to review (or everything generated has expired).
wait "$REVIEWERS_PID" || true
REVIEWERS_PID=""
kill "$TAIL_PID" 2>/dev/null || true
# Give apply a few polling intervals to send the last verdicts before stopping it.
sleep 40
kill -INT "$APPLY_PID" 2>/dev/null || true
APPLY_PID=""

echo; echo "== Reviewers"; sed -n '/^{/,$p' "$DIR/reviewers.log"
echo; echo "== On-chain result"; node scripts/load/fork-load.js report "$DIR" 2>&1 | grep -v secp256k1
echo; echo "Logs and data: $DIR"
