// stdout carries the MCP protocol, and some dependencies print on load (e.g. "secp256k1 unavailable"). Route all
// console output to stderr before loading anything else; hence require() instead of a hoisted import.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startMcpServer } = require("./mcp-server") as typeof import("./mcp-server");

startMcpServer(process.argv.slice(2)).catch((error) => {
    console.error(`oo-dispute MCP failed to start: ${error}`);
    process.exit(1);
});
