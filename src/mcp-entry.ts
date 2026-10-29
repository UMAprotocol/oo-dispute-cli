// stdout carries the MCP protocol, and some dependencies print on load (e.g. "secp256k1 unavailable"). Route all
// console output to stderr before loading anything else; hence require() instead of a hoisted import.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { existsSync, readFileSync } from "fs";
import { repoPath, userPath } from "./paths";

// Agents launched from a desktop app don't inherit shell variables, so settings can also come from a KEY=VALUE file
// (OO_DISPUTE_ENV_FILE, default .oo-dispute/mcp.env in the repository). The file wins over the environment, so what it says is what the
// server uses (a mainnet NODE_URLS_137 exported in the shell must not leak into a fork rehearsal). PRIVATE_KEY is never
// loaded: the review server must not hold the key.
function loadEnvFile() {
    const path = process.env.OO_DISPUTE_ENV_FILE ? userPath(process.env.OO_DISPUTE_ENV_FILE) : repoPath(".oo-dispute", "mcp.env");
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        const [, key, raw] = match;
        if (key === "PRIVATE_KEY") {
            console.error(`Ignoring PRIVATE_KEY in ${path}: the review server never signs.`);
            continue;
        }
        process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
    }
    console.error(`Loaded settings from ${path}`);
}

loadEnvFile();
delete process.env.PRIVATE_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startMcpServer } = require("./mcp-server") as typeof import("./mcp-server");
// Importing @uma/common runs dotenv, which re-reads a .env in the working directory: remove the key again.
delete process.env.PRIVATE_KEY;

startMcpServer(process.argv.slice(2)).catch((error) => {
    console.error(`oo-dispute MCP failed to start: ${error}`);
    process.exit(1);
});
