import { getRetryProvider } from "@uma/common";
import type { Provider } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { Options } from "./handler";
import {
    DEFAULT_BATCH_SIZE,
    DEFAULT_GAS_PER_DISPUTE,
    DEFAULT_MIN_PRIORITY_FEE_GWEI,
    DEFAULT_RPC_CONCURRENCY,
    MIN_PRIORITY_FEE_GWEI,
    POLYGON_BLOCKS_PER_HOUR,
    POLYGON_CHAIN_ID,
    POLYGON_MANAGED_OOV2_ADDRESS,
    POLYGON_OOV2_ADDRESS,
} from "./constants";
import { getAddress } from "@uma/contracts-node";

export type OracleKind = "oov2" | "managed";
export type SortOrder = "time" | "bond" | "random" | "age";

export interface OracleConfig {
    kind: OracleKind;
    address: string;
}

export interface Config {
    provider: Provider;
    chainId: number;
    maxBlockLookBack: number;
    onlyPolymarket: boolean;
    wallet: ethers.Wallet;
    multiplier: number;
    minPriorityFeeGwei: number;
    sort: SortOrder;
    blockLookbackPeriod: number;
    oracles: OracleConfig[];
    disputeBatcherAddress?: string;
    batch: boolean;
    batchSize: number;
    gasPerDispute: number;
    flushBeforeSeconds: number;
    rpcConcurrency: number;
    dryRun: boolean;
}

function parseNumber(name: string, value: string | number | undefined, fallback: number, { integer = false, min = 0 } = {}): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
        throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${min}, got "${value}"`);
    }
    return parsed;
}

function resolveSort(options: Options): SortOrder {
    const selected: SortOrder[] = [];
    if (options.sortRemainingTime) selected.push("time");
    if (options.sortBondSize) selected.push("bond");
    if (options.sortRandom) selected.push("random");
    if (options.sortAge) selected.push("age");
    if (selected.length > 1) throw new Error("Only one sort option can be set");
    // With 2h liveness the most urgent proposal must come first, so time is the default.
    return selected[0] ?? "time";
}

async function resolveOracles(chainId: number, options: Options): Promise<OracleConfig[]> {
    const selection = options.managedOo ? "managed" : options.oracle;
    if (!["all", "oov2", "managed"].includes(selection)) {
        throw new Error(`--oracle must be one of all, oov2, managed; got "${selection}"`);
    }

    if (chainId === POLYGON_CHAIN_ID) {
        const oracles: OracleConfig[] = [];
        if (selection !== "managed") oracles.push({ kind: "oov2", address: POLYGON_OOV2_ADDRESS });
        if (selection !== "oov2") oracles.push({ kind: "managed", address: POLYGON_MANAGED_OOV2_ADDRESS });
        return oracles;
    }

    if (selection === "managed") throw new Error(`Managed OO is only supported on Polygon`);
    return [{ kind: "oov2", address: await getAddress("OptimisticOracleV2", chainId) }];
}

// readOnly: the MCP review server never signs, so it must not need (or see) the private key.
export const initConfig = async (env: NodeJS.ProcessEnv, options: Options, { readOnly = false } = {}): Promise<Config> => {
    if (!env.CHAIN_ID) throw new Error("CHAIN_ID must be defined in env");
    const chainId = parseNumber("CHAIN_ID", env.CHAIN_ID, 0, { integer: true, min: 1 });

    const provider = getRetryProvider(chainId) as Provider;

    if (!readOnly && !env.PRIVATE_KEY) throw new Error("PRIVATE_KEY must be defined in env");
    const wallet = (readOnly ? ethers.Wallet.createRandom() : new ethers.Wallet(env.PRIVATE_KEY!)).connect(provider);

    const disputeBatcherAddress = env.DISPUTE_BATCHER_ADDRESS || undefined;
    if (disputeBatcherAddress && !ethers.utils.isAddress(disputeBatcherAddress)) {
        throw new Error(`DISPUTE_BATCHER_ADDRESS is not a valid address: ${disputeBatcherAddress}`);
    }

    return {
        provider,
        chainId,
        maxBlockLookBack: parseNumber("MAX_BLOCK_LOOK_BACK", env.MAX_BLOCK_LOOK_BACK, 3499, { integer: true, min: 1 }),
        onlyPolymarket: options.onlyPolymarket,
        wallet,
        multiplier: parseNumber("--multiplier", options.multiplier, 4, { min: 1 }),
        minPriorityFeeGwei: parseNumber("MIN_PRIORITY_FEE_GWEI", env.MIN_PRIORITY_FEE_GWEI, MIN_PRIORITY_FEE_GWEI[chainId] ?? DEFAULT_MIN_PRIORITY_FEE_GWEI),
        sort: resolveSort(options),
        blockLookbackPeriod: parseNumber("BLOCK_LOOKBACK_PERIOD", env.BLOCK_LOOKBACK_PERIOD, POLYGON_BLOCKS_PER_HOUR * 24, { integer: true, min: 1 }),
        oracles: await resolveOracles(chainId, options),
        disputeBatcherAddress,
        batch: options.batch,
        batchSize: options.batch ? parseNumber("--batch-size", options.batchSize, DEFAULT_BATCH_SIZE, { integer: true, min: 1 }) : 1,
        gasPerDispute: parseNumber("GAS_PER_DISPUTE", env.GAS_PER_DISPUTE, DEFAULT_GAS_PER_DISPUTE, { integer: true, min: 100_000 }),
        flushBeforeSeconds: parseNumber("--flush-before", options.flushBefore, 10, { min: 0 }) * 60,
        rpcConcurrency: parseNumber("RPC_CONCURRENCY", env.RPC_CONCURRENCY, DEFAULT_RPC_CONCURRENCY, { integer: true, min: 1 }),
        dryRun: options.dryRun,
    };
};
