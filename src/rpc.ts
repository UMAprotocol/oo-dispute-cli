import type { Log } from "@ethersproject/abstract-provider";

// RPC URLs in the order @uma/common's retry provider tries them.
export function rpcUrls(env: NodeJS.ProcessEnv, chainId: number): string[] {
    const list = env[`NODE_URLS_${chainId}`];
    if (list) {
        const urls = JSON.parse(list);
        if (!Array.isArray(urls) || urls.length === 0) throw new Error(`NODE_URLS_${chainId} must be a JSON array of URLs`);
        return urls;
    }
    const url = env[`NODE_URL_${chainId}`];
    return url ? [url] : [];
}

export interface LogFilter {
    address: string;
    topics: string[];
    fromBlock: number;
    toBlock: number;
}

// eth_getLogs over plain fetch, trying each URL in turn. ethers v5 decodes every response through a per-character
// array (~30x its size in transient memory), which runs out of heap on busy oracles: a page of Managed OOv2
// proposals is several MB of ancillary data.
export async function getLogs(urls: string[], { address, topics, fromBlock, toBlock }: LogFilter): Promise<Log[]> {
    const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ address, topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
    });
    let lastError: unknown;
    for (const url of urls) {
        try {
            const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
            const { result, error } = (await response.json()) as { result?: RawLog[]; error?: { message: string } };
            if (error || !result) throw new Error(error?.message ?? "empty eth_getLogs response");
            return result.map(toLog);
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(`eth_getLogs ${fromBlock}-${toBlock} failed on every RPC: ${(lastError as Error)?.message ?? lastError}`);
}

interface RawLog {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    blockHash: string;
    transactionHash: string;
    transactionIndex: string;
    logIndex: string;
    removed?: boolean;
}

const toLog = (log: RawLog): Log => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    removed: Boolean(log.removed),
});
