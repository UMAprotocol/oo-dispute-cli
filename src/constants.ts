export const POLYGON_BLOCKS_PER_HOUR = 1800;

export const POLYMARKET_REQUESTER_ADDRESSES = [
    "0xCB1822859cEF82Cd2Eb4E6276C7916e692995130", // binary
    "0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74", // ctf
    "0x2f5e3684cb1f318ec51b00edba38d79ac2c0aa9d", // ctf v2
]

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
👉 Do you want to dispute this proposal? (yes/no) 
`;