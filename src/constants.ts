export const POLYGON_BLOCKS_PER_HOUR = 1800;

export const POLYGON_CHAIN_ID = 137;
export const POLYGON_OOV2_ADDRESS = "0xeE3Afe347D5C74317041E2618C49534dAf887c24";
export const POLYGON_MANAGED_OOV2_ADDRESS = "0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1";

export const POLYMARKET_REQUESTER_ADDRESSES = [
    "0xCB1822859cEF82Cd2Eb4E6276C7916e692995130", // binary
    "0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74", // ctf
    "0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d", // ctf v2
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    "0xb21182d0494521Cf45DbbeEbb5A3ACAAb6d22093",
    "0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49",
    "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7",
];

// ethers v5 assumes a 1.5 gwei tip, which Polygon nodes reject as underpriced. These floors apply before the
// multiplier and can be overridden with MIN_PRIORITY_FEE_GWEI.
export const MIN_PRIORITY_FEE_GWEI: Record<number, number> = { [POLYGON_CHAIN_ID]: 30 };
export const DEFAULT_MIN_PRIORITY_FEE_GWEI = 1.5;

// Disputes per transaction. The DisputeBatcher fork test used ~6.7M gas for 20 disputes with Polymarket-style
// re-requesting callbacks (~335k each).
export const DEFAULT_BATCH_SIZE = 20;
// Gas budgeted per dispute in a batch. Batches are NOT sized with estimateGas: the batcher wraps each dispute in
// try/catch, so the lowest non-reverting gas limit can silently skip the last disputes with out-of-gas.
export const DEFAULT_GAS_PER_DISPUTE = 500_000;
export const BATCH_GAS_OVERHEAD = 200_000;
export const DEFAULT_RPC_CONCURRENCY = 10;
// Proposals expiring within this many seconds are not worth sending: the transaction would likely land too late.
export const EXPIRY_SAFETY_MARGIN_SECONDS = 20;

export enum RequestState {
    Invalid = 0,
    Requested = 1,
    Proposed = 2,
    Expired = 3,
    Disputed = 4,
    Resolved = 5,
    Settled = 6
}

export const DISPUTE_CONFIRMATION_PROMPT = `
👉 Dispute this proposal? [y]es (queue) / [s]end now (queue and send) / [n]o / [q]uit reviewing: `;
