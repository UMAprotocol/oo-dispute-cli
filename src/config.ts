import { getRetryProvider } from "@uma/common";
import type { Provider } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { Options } from "./handler";

export interface Config {
    provider: Provider;
    chainId: number;
    maxBlockLookBack: number;
    onlyPolymarket: boolean;
    wallet: ethers.Wallet;
    multiplier: number;
    sortRemainingTime: boolean;
    sortBondSize: boolean;
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

    return {
        provider,
        chainId,
        maxBlockLookBack,
        onlyPolymarket,
        wallet,
        multiplier,
        sortRemainingTime,
        sortBondSize,
    };
};