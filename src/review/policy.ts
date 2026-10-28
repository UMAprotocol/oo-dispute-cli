import { Verdict } from "../polymarket";

export interface DecisionRecord {
    agent: string;
    verdict: Verdict;
    // Price the verdict maps to (undefined for unclear).
    verdictPrice?: string;
    confidence: number;
    createdAt: number;
    recheckAfter?: number;
}

// pending: nobody has reviewed it. recheck: unclear or low confidence, look again later. agree: verdict matches the
// proposal. needs_confirmation: a confident disagreement still short of the required independent reviewers.
// dispute: confident disagreement confirmed by enough reviewers.
export type Action = "pending" | "recheck" | "agree" | "needs_confirmation" | "dispute";

export interface ReviewPolicy {
    minConfidence: number;
    minConfirmations: number;
}

export interface Evaluation {
    action: Action;
    verdict?: Verdict;
    confirmingAgents: string[];
    recheckAfter?: number;
}

function latestPerAgent(decisions: DecisionRecord[]): DecisionRecord[] {
    const latest = new Map<string, DecisionRecord>();
    for (const decision of [...decisions].sort((a, b) => a.createdAt - b.createdAt)) latest.set(decision.agent, decision);
    return [...latest.values()];
}

// The dispute decision is made here, from structured fields only. A model's free-text reasoning never reaches it.
export function evaluate(decisions: DecisionRecord[], proposedPrice: string, policy: ReviewPolicy): Evaluation {
    if (decisions.length === 0) return { action: "pending", confirmingAgents: [] };
    const latest = [...decisions].sort((a, b) => a.createdAt - b.createdAt)[decisions.length - 1];

    if (latest.verdict === "unclear" || latest.confidence < policy.minConfidence) {
        return { action: "recheck", verdict: latest.verdict, confirmingAgents: [], recheckAfter: latest.recheckAfter };
    }
    if (latest.verdictPrice === proposedPrice) {
        return { action: "agree", verdict: latest.verdict, confirmingAgents: [latest.agent] };
    }

    const confirmingAgents = latestPerAgent(decisions)
        .filter((d) => d.verdict === latest.verdict && d.confidence >= policy.minConfidence)
        .map((d) => d.agent);
    return {
        action: confirmingAgents.length >= policy.minConfirmations ? "dispute" : "needs_confirmation",
        verdict: latest.verdict,
        confirmingAgents,
    };
}

export function needsReview(evaluation: Evaluation, agent: string, now: number): boolean {
    switch (evaluation.action) {
        case "pending":
            return true;
        case "recheck":
            return (evaluation.recheckAfter ?? 0) <= now;
        case "needs_confirmation":
            return !evaluation.confirmingAgents.includes(agent);
        default:
            return false;
    }
}

// Unclear verdicts buy time: look again after a third of the remaining liveness (5-30 min), doubling with every
// earlier inconclusive look (up to 2 h) so events with no findable result stop cycling through reviewers. Always
// leaves room for one more look before expiry; inside the last 15 minutes, look again after 5 minutes.
export function recheckTime(now: number, expiration: number, previousRechecks = 0): number {
    const remaining = expiration - now;
    if (remaining <= 15 * 60) return now + 5 * 60;
    const base = Math.min(Math.max(Math.floor(remaining / 3), 5 * 60), 30 * 60);
    const wait = Math.min(base * 2 ** Math.min(previousRechecks, 4), 2 * 60 * 60);
    return Math.min(now + wait, expiration - 10 * 60);
}
