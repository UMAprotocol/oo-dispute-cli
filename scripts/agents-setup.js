#!/usr/bin/env node
// Registers the oo-dispute MCP server with Claude Code and Codex on this machine, with absolute paths, so it starts
// from the desktop apps too (they don't load nvm/mise/asdf, and Codex doesn't run servers from the repo).
//
//   yarn agents:setup [--rpc <url>[,<url>...]] [--selection <file>] [--claude] [--codex]
//
// - Uses the Node.js running this script (it must be ≥ 22.13: the queue needs node:sqlite) and builds dist/ if missing.
// - Claude Code: a local-scope server for this repo (`claude mcp add --scope local`), which takes precedence over
//   .mcp.json and stays out of git.
// - Codex: writes or replaces [mcp_servers.oo-dispute] in ~/.codex/config.toml ($CODEX_HOME), after a backup, and
//   installs the /prompts:review-disputes prompt (Claude Code reads it from .claude/commands as /review-disputes).
// - Creates .oo-dispute/mcp.env (chain and RPC for the server) if it doesn't exist. It never holds PRIVATE_KEY.
// Without --claude / --codex, it sets up whichever is installed.
const { spawnSync } = require("child_process");
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require("fs");
const { homedir } = require("os");
const { join, resolve } = require("path");
const readline = require("readline");

const REPO = resolve(__dirname, "..");
const ENTRY = join(REPO, "dist", "mcp-entry.js");
const MCP_ENV = join(REPO, ".oo-dispute", "mcp.env");
const NAME = "oo-dispute";
const REVIEW_PROMPT = join(REPO, ".claude", "commands", "review-disputes.md");
const SERVER_ARGS = [ENTRY, "--only-polymarket"];

function parseArgs(argv) {
    const options = { rpc: undefined, selection: undefined, claude: false, codex: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--rpc") options.rpc = argv[++i];
        else if (arg === "--selection") options.selection = argv[++i];
        else if (arg === "--claude") options.claude = true;
        else if (arg === "--codex") options.codex = true;
        else if (arg === "-h" || arg === "--help") {
            console.log("Usage: yarn agents:setup [--rpc <url>[,<url>...]] [--selection <file>] [--claude] [--codex]");
            process.exit(0);
        } else fail(`Unknown option ${arg}`);
    }
    return options;
}

function fail(message) {
    console.error(`✗ ${message}`);
    process.exit(1);
}

function has(command) {
    return spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [command] : ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

// The `claude` CLI, or the one bundled with the Claude desktop app on macOS (newest version) when only the app is
// installed. Both write the same ~/.claude.json.
function claudeBinary() {
    if (has("claude")) return "claude";
    const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
    if (!existsSync(root)) return undefined;
    const byVersion = (a, b) => b.split(".").map(Number).reduce((diff, part, i) => diff || part - Number(a.split(".")[i] ?? 0), 0);
    for (const version of readdirSync(root).filter((name) => /^\d+(\.\d+)*$/.test(name)).sort(byVersion)) {
        for (const build of readdirSync(join(root, version))) {
            const binary = join(root, version, build, "claude.app", "Contents", "MacOS", "claude");
            if (existsSync(binary)) return binary;
        }
    }
    return undefined;
}

function checkNode() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 13)) {
        fail(`Node.js ${process.versions.node} is too old: the review queue needs ≥ 22.13 (node:sqlite). Switch node and re-run.`);
    }
    console.log(`✓ Node.js ${process.versions.node} at ${process.execPath}`);
}

function build() {
    if (existsSync(ENTRY)) return;
    console.log("… dist/ is missing, running yarn build");
    const result = spawnSync("yarn", ["build"], { cwd: REPO, stdio: "inherit" });
    if (result.status !== 0 || !existsSync(ENTRY)) fail("yarn build failed");
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((done) => rl.question(question, (answer) => (rl.close(), done(answer.trim()))));
}

async function writeMcpEnv({ rpc, selection }) {
    if (existsSync(MCP_ENV)) {
        const text = readFileSync(MCP_ENV, "utf8");
        console.log(`✓ ${MCP_ENV} exists (left as is)`);
        if (/127\.0\.0\.1|localhost/.test(text)) console.log("  ⚠ It points at a local fork: run 'yarn fork:down' and set it up again for mainnet.");
        return;
    }
    if (!rpc && process.stdin.isTTY) rpc = await ask("Polygon RPC URL(s) for the review server, comma-separated: ");
    if (!rpc) {
        console.log(`⚠ No RPC given: create ${MCP_ENV} later (or re-run with --rpc <url>).`);
        return;
    }
    const urls = rpc.split(",").map((url) => url.trim()).filter(Boolean);
    const lines = ["CHAIN_ID=137", `NODE_URLS_137=${JSON.stringify(urls)}`];
    lines.push(selection ? `REVIEW_SELECTION=${selection}` : "# REVIEW_SELECTION=selections/midterms-2026.resolved.json");
    mkdirSync(join(REPO, ".oo-dispute"), { recursive: true });
    writeFileSync(MCP_ENV, lines.join("\n") + "\n", { mode: 0o600 });
    console.log(`✓ Wrote ${MCP_ENV}`);
}

function setupClaude(binary) {
    // Replace any earlier local registration; a missing one is not an error.
    spawnSync(binary, ["mcp", "remove", NAME, "--scope", "local"], { cwd: REPO, stdio: "ignore" });
    const result = spawnSync(binary, ["mcp", "add", NAME, "--scope", "local", "--", process.execPath, ...SERVER_ARGS], { cwd: REPO, encoding: "utf8" });
    if (result.status !== 0) {
        console.log(`✗ Claude Code: 'claude mcp add' failed: ${(result.stderr || result.stdout || "").trim()}`);
        return false;
    }
    console.log("✓ Claude Code: registered 'oo-dispute' for this repo (local scope)");
    return true;
}

// Drops the [mcp_servers.oo-dispute] table and its sub-tables (e.g. .env) from a config.toml.
function withoutServer(toml) {
    const header = new RegExp(`^\\[mcp_servers\\.(?:"${NAME}"|${NAME})(?:\\..*)?\\]\\s*$`);
    const out = [];
    let skipping = false;
    for (const line of toml.split("\n")) {
        if (/^\s*\[/.test(line)) skipping = header.test(line.trim());
        if (!skipping) out.push(line);
    }
    return out.join("\n").replace(/\n+$/, "");
}

function setupCodex() {
    const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
    const file = join(dir, "config.toml");
    mkdirSync(dir, { recursive: true });
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current) copyFileSync(file, `${file}.bak`);
    const block = [
        `[mcp_servers.${NAME}]`,
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${SERVER_ARGS.map((arg) => JSON.stringify(arg)).join(", ")}]`,
        // The first call scans the chain and can take minutes.
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 600",
    ].join("\n");
    const rest = withoutServer(current);
    writeFileSync(file, (rest ? `${rest}\n\n` : "") + block + "\n");
    console.log(`✓ Codex: wrote [mcp_servers.${NAME}] to ${file}${current ? ` (backup: ${file}.bak)` : ""}`);
    mkdirSync(join(dir, "prompts"), { recursive: true });
    copyFileSync(REVIEW_PROMPT, join(dir, "prompts", "review-disputes.md"));
    console.log("✓ Codex: installed the /prompts:review-disputes prompt");
    return true;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    checkNode();
    build();
    await writeMcpEnv(options);

    const explicit = options.claude || options.codex;
    const claudeCli = claudeBinary();
    const claude = explicit ? options.claude : Boolean(claudeCli);
    const codex = explicit ? options.codex : has("codex") || existsSync(process.env.CODEX_HOME || join(homedir(), ".codex"));
    if (!claude && !codex) fail("Neither Claude Code nor Codex found. Pass --claude or --codex to set one up anyway.");
    if (claude && !claudeCli) fail("--claude: neither the 'claude' CLI nor the Claude desktop app was found");

    const done = [claude && setupClaude(claudeCli) && "Claude Code", codex && setupCodex() && "Codex"].filter(Boolean);
    if (!done.length) process.exit(1);
    console.log(`\nNext: open a new ${done.join(" / ")} session in ${REPO} and run /review-disputes (Codex: /prompts:review-disputes),`);
    console.log("optionally with a scope and a limit, e.g. '/review-disputes permissionless 10'. The first call scans the chain and can");
    console.log("take a few minutes. Send disputes yourself with 'yarn apply --watch --scope <scope>'.");
}

if (require.main === module) main().catch((error) => fail(error.message));

module.exports = { withoutServer };
