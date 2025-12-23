export const POLYGON_BLOCKS_PER_HOUR = 1800;

export const POLYMARKET_REQUESTER_ADDRESSES = [
    "0xCB1822859cEF82Cd2Eb4E6276C7916e692995130", // binary
    "0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74", // ctf
    "0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d", // ctf v2
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    "0xb21182d0494521Cf45DbbeEbb5A3ACAAb6d22093",
    "0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49",
    "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7",
];


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