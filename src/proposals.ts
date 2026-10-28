import { paginatedEventQuery } from "@uma/common";
import { DisputePriceEvent, ProposePriceEvent } from "@uma/contracts-node/dist/packages/contracts-node/typechain/core/ethers/OptimisticOracleV2";
import { BigNumber } from "ethers";
import { Config, OracleConfig, OracleKind, SortOrder } from "./config";
import { POLYMARKET_REQUESTER_ADDRESSES } from "./constants";
import { mapWithConcurrency, withRetry } from "./concurrency";
import { getERC20ContractInstance, getOOV2ContractInstance } from "./contracts";

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
}

// A request is identified by all four fields; dropping the requester lets one request's dispute hide another's.
export function requestKeyId(key: RequestKey): string {
    return [key.requester.toLowerCase(), key.identifier.toLowerCase(), key.timestamp.toString(), key.ancillaryData.toLowerCase()].join(":");
}

export function requestKeyArgs(key: RequestKey): [string, string, BigNumber, string] {
    return [key.requester, key.identifier, key.timestamp, key.ancillaryData];
}

type ProposeArgs = RequestKey & { expirationTimestamp: BigNumber };

// Proposals that are still disputable: not already disputed, not expired and, optionally, from Polymarket.
export function filterOpenProposals<T extends { args: ProposeArgs }>(
    proposeEvents: T[],
    disputeEvents: { args: RequestKey }[],
    currentTimestamp: number,
    onlyPolymarket: boolean
): T[] {
    const disputed = new Set(disputeEvents.map((event) => requestKeyId(event.args)));
    const polymarket = new Set(POLYMARKET_REQUESTER_ADDRESSES.map((r) => r.toLowerCase()));
    return proposeEvents
        .filter((event) => !onlyPolymarket || polymarket.has(event.args.requester.toLowerCase()))
        .filter((event) => !disputed.has(requestKeyId(event.args)))
        .filter((event) => event.args.expirationTimestamp.gt(currentTimestamp));
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

async function fetchOracleProposals(config: Config, oracle: OracleConfig, currentBlockNumber: number, currentTimestamp: number) {
    const searchConfig = {
        fromBlock: Math.max(0, currentBlockNumber - config.blockLookbackPeriod),
        toBlock: currentBlockNumber,
        maxBlockLookBack: config.maxBlockLookBack,
    };

    const oo = await getOOV2ContractInstance(config.provider, oracle.address);

    const [proposeEvents, disputeEvents] = await Promise.all([
        withRetry(() => paginatedEventQuery<ProposePriceEvent>(oo, oo.filters.ProposePrice(null, null, null, null, null, null, null, null), searchConfig)),
        withRetry(() => paginatedEventQuery<DisputePriceEvent>(oo, oo.filters.DisputePrice(null, null, null, null, null, null, null), searchConfig)),
    ]);

    return { oo, events: filterOpenProposals(proposeEvents, disputeEvents, currentTimestamp, config.onlyPolymarket) };
}

export async function fetchProposals(config: Config): Promise<Proposal[]> {
    const block = await withRetry(() => config.provider.getBlock("latest"));

    const tokenMetadata = new Map<string, Promise<{ symbol: string; decimals: number }>>();
    const getTokenMetadata = (address: string) => {
        const key = address.toLowerCase();
        if (!tokenMetadata.has(key)) {
            const token = getERC20ContractInstance(config.provider, address);
            const metadata = withRetry(async () => ({ symbol: await token.symbol(), decimals: await token.decimals() }));
            metadata.catch(() => tokenMetadata.delete(key));
            tokenMetadata.set(key, metadata);
        }
        return tokenMetadata.get(key)!;
    };

    const proposals: Proposal[] = [];
    let failed = 0;
    for (const oracle of config.oracles) {
        const { oo, events } = await fetchOracleProposals(config, oracle, block.number, block.timestamp);
        console.log(`🔎 ${oracle.kind} (${oracle.address}): ${events.length} open proposal(s)`);

        const loaded = await mapWithConcurrency(events, config.rpcConcurrency, async (event) => {
            try {
                const request = await withRetry(() => oo.getRequest(event.args.requester, event.args.identifier, event.args.timestamp, event.args.ancillaryData));
                const { symbol, decimals } = await getTokenMetadata(request.currency);
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
                } as Proposal;
            } catch (error) {
                failed++;
                console.error(`🚨 Could not load request ${event.transactionHash} (log ${event.logIndex}): ${error}`);
                return undefined;
            }
        });
        proposals.push(...loaded.filter((p): p is Proposal => p !== undefined));
    }

    if (failed > 0) {
        console.error(`🚨 ${failed} proposal(s) could not be loaded and are NOT shown. Re-run to pick them up.`);
    }

    return sortProposals(proposals, config.sort);
}
