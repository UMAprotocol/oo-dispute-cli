import { join } from "path";
import { Config } from "../config";
import { ReviewPolicy } from "./policy";
import { ReviewQueue } from "./queue";
import { ReviewStore } from "./store";

export interface ReviewFlags {
    db?: string;
    minConfidence?: string;
    confirmations?: string;
    leaseMinutes?: string;
    marketData?: boolean;
}

const DEFAULT_POLICY: ReviewPolicy = { minConfidence: 0.8, minConfirmations: 1 };

export function reviewDbPath(config: Config, db?: string) {
    return db || process.env.REVIEW_DB || join(process.cwd(), ".oo-dispute", `review-${config.chainId}.sqlite`);
}

// The dispute policy lives in the database so every MCP process and `apply` use the same thresholds. Flags given
// explicitly update it; otherwise the stored (or default) policy applies.
export function openReview(config: Config, flags: ReviewFlags) {
    const store = new ReviewStore(reviewDbPath(config, flags.db));
    const stored = store.getMeta("policy");
    const policy: ReviewPolicy = { ...DEFAULT_POLICY, ...(stored ? JSON.parse(stored) : {}) };
    if (flags.minConfidence !== undefined) policy.minConfidence = Number(flags.minConfidence);
    if (flags.confirmations !== undefined) policy.minConfirmations = Number(flags.confirmations);
    if (!(policy.minConfidence > 0 && policy.minConfidence <= 1)) throw new Error("--min-confidence must be in (0, 1]");
    if (!(Number.isInteger(policy.minConfirmations) && policy.minConfirmations >= 1)) throw new Error("--confirmations must be an integer >= 1");
    store.setMeta("policy", JSON.stringify(policy));

    const queue = new ReviewQueue(config, store, {
        policy,
        leaseSeconds: Number(flags.leaseMinutes ?? 10) * 60,
        scanIntervalSeconds: Number(process.env.SCAN_INTERVAL_SECONDS ?? 15),
        fetchMarketData: flags.marketData !== false,
    });
    return { store, queue, policy };
}
