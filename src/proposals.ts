import { createHash } from "crypto";
import { BigNumber } from "ethers";
import { Config, OracleConfig, OracleKind, SortOrder } from "./config";
import { POLYMARKET_REQUESTER_ADDRESSES } from "./constants";
import { mapWithConcurrency, withRetry } from "./concurrency";
import { getERC20ContractInstance, getOOV2ContractInstance } from "./contracts";
import { getLogs } from "./rpc";
import type { Log } from "@ethersproject/abstract-provider";

export interface RequestKey {
    requester: string;
    identifier: string;
    timestamp: BigNumber;
    ancillaryData: string;
}

export interface Proposal extends RequestKey {
    bond: BigNumber;
    ooAddress: string;
    oracleKind: OracleKind;
    bondCurrencySymbol: string;
    bondCurrencyDecimals: number;
    bondCurrency: string;
    requestTimestamp: BigNumber;
    proposer: string;
    proposedPrice: BigNumber;
    proposalExpirationTimestamp: BigNumber;
    proposalTx?: string;
    logIndex?: number;
    blockNumber?: number;
}

// A request is identified by all four fields; dropping the requester lets one request's dispute hide another's.
export function requestKeyId(key: RequestKey): string {
    return [key.requester.toLowerCase(), key.identifier.toLowerCase(), key.timestamp.toString(), key.ancillaryData.toLowerCase()].join(":");
}

// Short, stable ID for a request. The full request key embeds the ancillary data (often >1 KB), which agents would
// have to copy back verbatim and which is too big to keep in memory for a day of proposals.
export function proposalId(key: RequestKey): string {
    return `p_${createHash("sha256").update(requestKeyId(key)).digest("hex").slice(0, 16)}`;
}

// Inclusive block ranges of at most `size` blocks covering [from, to] exactly (no rounding before `from`, which on a
// fork would reach into pre-fork blocks).
export function blockRanges(from: number, to: number, size: number): [number, number][] {
    const ranges: [number, number][] = [];
    for (let start = Math.max(0, from); start <= to; start += size) ranges.push([start, Math.min(start + size - 1, to)]);
    return ranges;
}

export function requestKeyArgs(key: RequestKey): [string, string, BigNumber, string] {
    return [key.requester, key.identifier, key.timestamp, key.ancillaryData];
}

type ProposeArgs = RequestKey & { expirationTimestamp: BigNumber };

// Managed OOv2 keeps an expired proposal disputable until its permissioned resolver settles it
// (ManagedOptimisticOracleV2._getStateForDispute maps Expired to Proposed); on the OOv2 liveness is final.
export const disputableAfterLiveness = (kind: OracleKind) => kind === "managed";

// Proposals that are still disputable: not disputed or settled, within liveness (or past it on the Managed OOv2)
// and, optionally, from Polymarket.
export function filterOpenProposals<T extends { args: ProposeArgs }>(
    proposeEvents: T[],
    disputeEvents: { args: RequestKey }[],
    currentTimestamp: number,
    onlyPolymarket: boolean,
    { keepExpired = false, settleEvents = [] as { args: RequestKey }[] } = {}
): T[] {
    const closed = new Set([...disputeEvents, ...settleEvents].map((event) => proposalId(event.args)));
    return proposeEvents.filter((event) => isCandidate(event.args, currentTimestamp, onlyPolymarket, keepExpired) && !closed.has(proposalId(event.args)));
}

const POLYMARKET_REQUESTERS = new Set(POLYMARKET_REQUESTER_ADDRESSES.map((r) => r.toLowerCase()));

function isCandidate(args: ProposeArgs, currentTimestamp: number, onlyPolymarket: boolean, keepExpired: boolean): boolean {
    if (onlyPolymarket && !POLYMARKET_REQUESTERS.has(args.requester.toLowerCase())) return false;
    return keepExpired || args.expirationTimestamp.gt(currentTimestamp);
}

// Fisher-Yates; `sort(() => Math.random() - 0.5)` is biased.
function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

export function sortProposals<T extends Pick<Proposal, "proposalExpirationTimestamp" | "bond">>(proposals: T[], sort: SortOrder): T[] {
    const sorted = [...proposals];
    switch (sort) {
        case "random":
            return shuffle(sorted);
        case "time":
            return sorted.sort((a, b) => compare(a.proposalExpirationTimestamp, b.proposalExpirationTimestamp));
        case "bond":
            return sorted.sort((a, b) => compare(b.bond, a.bond));
        case "age":
            return sorted;
    }
}

function compare(a: BigNumber, b: BigNumber): number {
    return a.lt(b) ? -1 : a.gt(b) ? 1 : 0;
}

const tokenMetadata = new Map<string, Promise<{ symbol: string; decimals: number }>>();
function getTokenMetadata(config: Config, address: string) {
    const key = address.toLowerCase();
    if (!tokenMetadata.has(key)) {
        const token = getERC20ContractInstance(config.provider, address);
        const metadata = withRetry(async () => ({ symbol: await token.symbol(), decimals: await token.decimals() }));
        metadata.catch(() => tokenMetadata.delete(key));
        tokenMetadata.set(key, metadata);
    }
    return tokenMetadata.get(key)!;
}

// Scans one oracle over [fromBlock, toBlock]: open proposals (enriched with live bond data) and every request disputed
// in the range, so callers can also retire proposals they found earlier.
interface OpenEvent {
    args: ProposeArgs & { proposer: string; proposedPrice: BigNumber };
    address: string;
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
}

export async function scanOracleRange(config: Config, oracle: OracleConfig, fromBlock: number, toBlock: number, currentTimestamp: number) {
    const oo = await getOOV2ContractInstance(config.provider, oracle.address);
    const keepExpired = disputableAfterLiveness(oracle.kind);

    // Page by page, keeping only proposals that are still open: a day of Managed OOv2 traffic is ~20k proposals with
    // KBs of ancillary data each, which does not fit in memory as ethers events. Disputes and settlements close a proposal whichever page they arrive in, so pages can be
    // processed in any order.
    const open = new Map<string, OpenEvent>();
    const closed = new Set<string>();
    const disputedIds: string[] = [];
    const settledIds: string[] = [];
    // RPCs cap eth_getLogs by block range or response size (Alchemy: 2,000 blocks once the response is large), so a
    // rejected range is split in halves until it fits.
    const logs = async (name: string, fromBlock: number, toBlock: number): Promise<Log[]> => {
        const filter = { address: oracle.address, topics: [oo.interface.getEventTopic(name)], fromBlock, toBlock };
        try {
            return await withRetry(() => (config.rpcUrls.length ? getLogs(config.rpcUrls, filter) : config.provider.getLogs(filter)), 1);
        } catch (error) {
            if (fromBlock === toBlock) throw error;
            const middle = Math.floor((fromBlock + toBlock) / 2);
            return [...(await logs(name, fromBlock, middle)), ...(await logs(name, middle + 1, toBlock))];
        }
    };
    await mapWithConcurrency(blockRanges(fromBlock, toBlock, config.maxBlockLookBack), 4, async ([from, to]) => {
        const [proposals, disputes, settles] = await Promise.all([
            logs("ProposePrice", from, to),
            logs("DisputePrice", from, to),
            // Only needed where proposals outlive their liveness: there, settlement is what closes them.
            keepExpired ? logs("Settle", from, to) : Promise.resolve([]),
        ]);
        for (const [entries, ids] of [[disputes, disputedIds], [settles, settledIds]] as const) {
            for (const log of entries) {
                const id = proposalId(oo.interface.parseLog(log).args as unknown as RequestKey);
                closed.add(id);
                open.delete(id);
                ids.push(id);
            }
        }
        for (const log of proposals) {
            const args = oo.interface.parseLog(log).args as unknown as OpenEvent["args"];
            const id = proposalId(args);
            if (closed.has(id) || !isCandidate(args, currentTimestamp, config.onlyPolymarket, keepExpired)) continue;
            const { requester, identifier, timestamp, ancillaryData, proposer, proposedPrice, expirationTimestamp } = args;
            open.set(id, {
                args: { requester, identifier, timestamp, ancillaryData, proposer, proposedPrice, expirationTimestamp },
                address: log.address,
                transactionHash: log.transactionHash,
                logIndex: log.logIndex,
                blockNumber: log.blockNumber,
            });
        }
    });
    const events = [...open.values()];

    let failed = 0;
    const loaded = await mapWithConcurrency(events, config.rpcConcurrency, async (event) => {
        try {
            const request = await withRetry(() => oo.getRequest(event.args.requester, event.args.identifier, event.args.timestamp, event.args.ancillaryData));
            const { symbol, decimals } = await getTokenMetadata(config, request.currency);
            return {
                bond: request.finalFee.add(request.requestSettings.bond),
                bondCurrency: request.currency,
                bondCurrencySymbol: symbol,
                bondCurrencyDecimals: decimals,
                requester: event.args.requester,
                requestTimestamp: event.args.timestamp,
                ancillaryData: event.args.ancillaryData,
                timestamp: event.args.timestamp,
                identifier: event.args.identifier,
                proposedPrice: event.args.proposedPrice,
                proposalExpirationTimestamp: event.args.expirationTimestamp,
                proposer: event.args.proposer,
                ooAddress: event.address,
                oracleKind: oracle.kind,
                proposalTx: event.transactionHash,
                logIndex: event.logIndex,
                blockNumber: event.blockNumber,
            } as Proposal;
        } catch (error) {
            failed++;
            console.error(`🚨 Could not load request ${event.transactionHash} (log ${event.logIndex}): ${error}`);
            return undefined;
        }
    });

    return {
        proposals: loaded.filter((p): p is Proposal => p !== undefined),
        disputedIds,
        settledIds,
        failed,
    };
}

export async function fetchProposals(config: Config): Promise<Proposal[]> {
    const block = await withRetry(() => config.provider.getBlock("latest"));

    const proposals: Proposal[] = [];
    let failed = 0;
    for (const oracle of config.oracles) {
        const scan = await scanOracleRange(config, oracle, block.number - config.blockLookbackPeriod, block.number, block.timestamp);
        console.log(`🔎 ${oracle.kind} (${oracle.address}): ${scan.proposals.length + scan.failed} open proposal(s)`);
        proposals.push(...scan.proposals);
        failed += scan.failed;
    }

    if (failed > 0) {
        console.error(`🚨 ${failed} proposal(s) could not be loaded and are NOT shown. Re-run to pick them up.`);
    }

    return sortProposals(proposals, config.sort);
}
