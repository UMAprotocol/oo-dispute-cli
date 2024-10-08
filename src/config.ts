import { getRetryProvider } from "@uma/common";
import type { Provider } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { Options } from "./handler";
import { POLYGON_BLOCKS_PER_HOUR } from "./constants";

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
        blockLookbackPeriod
    };
};