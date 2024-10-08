import { paginatedEventQuery } from "@uma/common";
import { DisputePriceEvent, ProposePriceEvent } from "@uma/contracts-node/dist/packages/contracts-node/typechain/core/ethers/OptimisticOracleV2";
import { BigNumber } from "ethers";
import { Config } from "./config";
import { POLYGON_BLOCKS_PER_HOUR, POLYMARKET_REQUESTER_ADDRESSES } from "./constants";
import { getERC20ContractInstance, getOOV2ContractInstance } from "./contracts";

export interface Proposal {
    bond: BigNumber;
    ooAddress: string;
    bondCurrencySymbol: string;
    bondCurrencyDecimals: number;
    bondCurrency: string;
    requester: string;
    requestTimestamp: BigNumber;
    timestamp: BigNumber;
    identifier: string;
    ancillaryData: string;
    proposer: string;
    proposedPrice: BigNumber;
    proposalExpirationTimestamp: BigNumber;
}

export async function fetchProposals(config: Config): Promise<Proposal[]> {

    const currentBlockNumber = await config.provider.getBlockNumber();
    const block = await config.provider.getBlock(currentBlockNumber);
    const currentTimestamp = block.timestamp;
    const startBlockNumber = currentBlockNumber - config.blockLookbackPeriod;

    const searchConfig = {
        fromBlock: startBlockNumber,
        toBlock: currentBlockNumber,
        maxBlockLookBack: config.maxBlockLookBack,
    };

    const oo = await getOOV2ContractInstance(config.provider);

    const proposeEvents = await paginatedEventQuery<ProposePriceEvent>(
        oo,
        oo.filters.ProposePrice(null, null, null, null, null, null, null, null),
        searchConfig
    );

    const disputeEvents = await paginatedEventQuery<DisputePriceEvent>(
        oo,
        oo.filters.DisputePrice(null, null, null, null, null, null, null),
        searchConfig
    );

    const proposals = await Promise.all(proposeEvents
        .filter((event) => config.onlyPolymarket ? POLYMARKET_REQUESTER_ADDRESSES.map((r) => r.toLowerCase()).includes(event.args.requester.toLowerCase()) : true)
        .filter((event) => !disputeEvents.some((dispute) => dispute.args.identifier === event.args.identifier && dispute.args.timestamp.eq(event.args.timestamp) && dispute.args.ancillaryData === event.args.ancillaryData))
        .filter((event) => event.args.expirationTimestamp.gt(BigNumber.from(currentTimestamp)))
        .map(async (event) => {
            const request = await oo.getRequest(event.args.requester, event.args.identifier, event.args.timestamp, event.args.ancillaryData);
            const finalFee = request.finalFee;
            const bond = finalFee?.add(request.requestSettings.bond)

            const bondCurrency = request.currency;
            const currencyContract = getERC20ContractInstance(config.provider, bondCurrency);
            const bondCurrencySymbol = await currencyContract.symbol();
            const bondCurrencyDecimals = await currencyContract.decimals();

            return {
                bond: bond,
                bondCurrency: bondCurrency,
                bondCurrencySymbol: bondCurrencySymbol,
                bondCurrencyDecimals: bondCurrencyDecimals,
                requestLogIndex: event.logIndex,
                requester: event.args.requester,
                requestTimestamp: event.args.timestamp,
                ancillaryData: event.args.ancillaryData,
                timestamp: event.args.timestamp,
                identifier: event.args.identifier,
                proposedPrice: event.args.proposedPrice,
                proposalExpirationTimestamp: event.args.expirationTimestamp,
                proposer: event.args.proposer,
                ooAddress: event.address
            };
        }));

    const sortedProposals = proposals.sort((a, b) => {
        if (config.sortRandom) {
            return Math.random() - 0.5;
        }

        if (config.sortRemainingTime) {
            return a.proposalExpirationTimestamp.toNumber() - b.proposalExpirationTimestamp.toNumber();
        }

        if (config.sortBondSize) {
            return b.bond.toNumber() - a.bond.toNumber();
        }

        return 0;
    });

    return sortedProposals;
}