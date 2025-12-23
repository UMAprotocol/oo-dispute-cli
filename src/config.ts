import { getRetryProvider } from "@uma/common";
import type { Provider } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { Options } from "./handler";
import { POLYGON_BLOCKS_PER_HOUR } from "./constants";
import { getAddress } from "@uma/contracts-node";

export interface Config {
    provider: Provider;
    chainId: number;
    maxBlockLookBack: number;
    onlyPolymarket: boolean;
    wallet: ethers.Wallet;
    multiplier: number;
    sortRemainingTime: boolean;
    sortRandom: boolean;
    sortBondSize: boolean;
    blockLookbackPeriod: number;
    ooContractAddress: string;
}

export const initConfig = async (env: NodeJS.ProcessEnv, options: Options): Promise<Config> => {
    if (!env.CHAIN_ID) throw new Error("CHAIN_ID must be defined in env");
    const chainId = Number(env.CHAIN_ID);

    const provider = getRetryProvider(chainId) as Provider;

    const maxBlockLookBack = env.MAX_BLOCK_LOOK_BACK ? Number(env.MAX_BLOCK_LOOK_BACK) : 3499;

    const onlyPolymarket = options.onlyPolymarket;

    if (!env.PRIVATE_KEY) throw new Error("PRIVATE_KEY must be defined in env");
    const wallet = new ethers.Wallet(env.PRIVATE_KEY).connect(provider);

    const multiplier = options.multiplier;

    const sortRemainingTime = options.sortRemainingTime;

    const sortBondSize = options.sortBondSize;

    const sortRandom = options.sortRandom;

    const blockLookbackPeriod = env.BLOCK_LOOKBACK_PERIOD ? Number(env.BLOCK_LOOKBACK_PERIOD) : POLYGON_BLOCKS_PER_HOUR * 24;

    if ((+sortRemainingTime) + (+sortBondSize) + (+sortRandom) > 1) {
        throw new Error("Only one sort option can be set");
    }

    let ooContractAddress: string;
    if (env.CHAIN_ID === "137") {
        ooContractAddress = options.managedOO ? "0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1" : "0xeE3Afe347D5C74317041E2618C49534dAf887c24";
    } else {
        if (options.managedOO) {
            throw new Error(`Managed OO is only supported on Polygon`);
        }

        ooContractAddress = await getAddress("OptimisticOracleV2", chainId);
    }

    return {
        provider,
        chainId,
        maxBlockLookBack,
        onlyPolymarket,
        wallet,
        multiplier,
        sortRemainingTime,
        sortBondSize,
        sortRandom,
        blockLookbackPeriod,
        ooContractAddress,
    };
};