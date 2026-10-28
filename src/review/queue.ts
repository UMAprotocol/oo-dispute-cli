import { createHash } from "crypto";
import { ethers } from "ethers";
import { Config } from "../config";
import { delay, mapWithConcurrency, withRetry } from "../concurrency";
import {
    conditionId,
    describePrice,
    fetchCreatorUpdates,
    fetchMarketData,
    MarketData,
    ParsedAncillary,
    parseAncillary,
    priceToVerdict,
    questionId,
    Verdict,
    VERDICTS,
    verdictPrice,
} from "../polymarket";
import { Proposal, RequestKey, requestKeyId, scanOracleRange } from "../proposals";
import { evaluate, Evaluation, needsReview, recheckTime, ReviewPolicy } from "./policy";
import { GroupRow, now, ProposalContext, ReviewStore, StoredProposal } from "./store";

// Proposals with less time left than this are not handed out: a review would not finish in time.
const MIN_SECONDS_LEFT_TO_REVIEW = 120;
const MARKET_DATA_MAX_AGE_SECONDS = 300;
// A batch is one tool result. MCP clients cap those (Claude Code at about 50 KB) and spill larger ones to a file a
// reviewer may not be able to read, which strands the claims it holds. Each proposal is about 3 KB.
const MAX_BATCH_CHARS = 30_000;
const MAX_OTHER_MARKETS = 40;

export interface QueueOptions {
    policy: ReviewPolicy;
    leaseSeconds: number;
    scanIntervalSeconds: number;
    fetchMarketData: boolean;
}

export interface SubmittedVerdict {
    proposal_id: string;
    verdict: Verdict;
    confidence: number;
    seen_proposed_price: string;
    reasoning: string;
}

function sha(text: string) {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Short, stable ID for a request. The full request key embeds the ancillary data (often >1 KB), which agents would
// have to copy back verbatim.
export function proposalId(key: RequestKey): string {
    return `p_${sha(requestKeyId(key))}`;
}

// The Polymarket event is the best key: all lines of one match share it, and two matches built from the same market
// template (identical rules text) never do. Identical rules text is only a fallback when the event is unknown.
export function groupFor(id: string, parsed: ParsedAncillary, market: MarketData): GroupRow {
    const label = parsed.title ?? market.question ?? id.slice(0, 20);
    if (market.negRiskMarketId) return { groupKey: `negrisk:${market.negRiskMarketId}`, label, exclusive: true, source: "negrisk" };
    if (market.eventId) return { groupKey: `event:${market.eventId}`, label: market.eventTitle ?? label, exclusive: false, source: "event" };
    if (parsed.description) return { groupKey: `desc:${sha(parsed.description)}`, label, exclusive: false, source: "description" };
    return { groupKey: `single:${sha(id)}`, label, exclusive: false, source: "single" };
}

type GroupView = Awaited<ReturnType<ReviewQueue["groupView"]>>;

// Drops the least urgent proposals from a view until it fits in maxChars (always keeping one); returns its size.
function fitView(view: GroupView, maxChars: number): number {
    const size = (value: unknown) => JSON.stringify(value, null, 1).length;
    let used = size({ ...view, proposals: [] });
    let keep = 0;
    for (const proposal of view.proposals) {
        const next = size(proposal) + view.proposals.length; // + nesting indentation, roughly
        if (keep > 0 && used + next > maxChars) break;
        used += next;
        keep++;
    }
    if (keep < view.proposals.length) {
        const dropped = view.proposals.slice(keep);
        view.not_shown_needing_review += dropped.length;
        view.proposals = view.proposals.slice(0, keep);
        const compact = dropped.map((p) => ({ proposal_id: p.proposal_id, title: p.title, proposed: p.proposed.meaning, status: p.status }));
        view.other_markets = [...compact, ...view.other_markets];
        used += size(compact);
    }
    return used;
}

// Cheap deterministic signals, computed for every proposal before any model looks at it.
export function proposalFlags(
    sp: StoredProposal,
    group: GroupRow | undefined,
    groupMembers: StoredProposal[],
    proposerCount: number,
    atTime: number
): string[] {
    const { parsed, market, updates } = sp.context;
    const proposed = priceToVerdict(sp.proposal.proposedPrice, parsed);
    const flags: string[] = [];
    if (!parsed.resDataFound) flags.push("res_data_missing");
    if (!proposed) flags.push("proposed_price_not_in_res_data");
    if (proposed === "p3") flags.push("proposed_50_50");
    if (proposed === "p4") flags.push("proposed_too_early");
    if (group?.exclusive) {
        const yes = groupMembers.filter((m) => m.status === "open" && priceToVerdict(m.proposal.proposedPrice, m.context.parsed) === "p2");
        if (yes.length > 1) flags.push("multiple_yes_in_exclusive_group");
    }
    if (market.status === "available" && (proposed === "p1" || proposed === "p2")) {
        const label = parsed.resData[proposed].label?.toLowerCase();
        const quote = market.prices?.find((p) => p.outcome.toLowerCase() === label);
        if (quote && quote.price < 0.2) flags.push("market_disagrees_with_proposal");
    }
    if (sp.proposal.proposalExpirationTimestamp.toNumber() - atTime < 30 * 60) flags.push("expires_within_30_min");
    if (proposerCount <= 2) flags.push("rare_proposer");
    if (updates?.updates.length) flags.push("creator_updates_present");
    return flags;
}

export class ReviewQueue {
    private marketFailures = 0;

    constructor(private config: Config, readonly store: ReviewStore, private options: QueueOptions, private owner = `pid-${process.pid}`) {}

    // Incremental chain scan, shared by all processes: one scanner at a time, at most every scanIntervalSeconds.
    async refresh(force = false): Promise<{ scanned: boolean; added: number }> {
        const { config, store } = this;
        const lastScan = Number(store.getMeta("last_scan_at") ?? 0);
        if (!force && now() - lastScan < this.options.scanIntervalSeconds) return { scanned: false, added: 0 };
        if (!store.tryLock("scan", this.owner, 300)) {
            // Another process is scanning: wait for it rather than hand out work from a stale (or empty) queue.
            const scanning = () => Number(store.getMeta("lock:scan")?.split("|")[1] ?? 0) > now();
            for (let waited = 0; waited < 120 && scanning(); waited++) await delay(1000);
            return { scanned: false, added: 0 };
        }

        let added = 0;
        try {
            const block = await withRetry(() => config.provider.getBlock("latest"));
            for (const oracle of config.oracles) {
                const key = `last_block:${oracle.address.toLowerCase()}`;
                const stored = store.getMeta(key);
                const fromBlock = stored ? Number(stored) + 1 : config.startBlock ?? block.number - config.blockLookbackPeriod;
                if (fromBlock > block.number) continue;
                const scan = await scanOracleRange(config, oracle, fromBlock, block.number, block.timestamp);
                added += await this.ingest(scan.proposals);
                store.markDisputed(scan.disputedIds.map((key) => `p_${sha(key)}`));
                // A failed load must be retried by the next scan, so only advance past ranges that loaded fully.
                if (scan.failed === 0) store.setMeta(key, String(block.number));
            }
            store.setMeta("last_scan_at", String(now()));
            store.setMeta("last_scan_block", String(block.number));
        } finally {
            store.unlock("scan", this.owner);
        }
        return { scanned: true, added };
    }

    private async marketData(proposal: Proposal): Promise<MarketData> {
        if (!this.options.fetchMarketData || this.marketFailures >= 3) {
            return { status: "unavailable", fetchedAt: now(), error: this.options.fetchMarketData ? "skipped after repeated failures" : "disabled" };
        }
        const market = await fetchMarketData(conditionId(proposal.requester, questionId(proposal.ancillaryData)));
        // A 4xx means the API is up but doesn't know this market (not every requester is a Polymarket adapter).
        if (market.status === "unavailable" && !market.error?.startsWith("HTTP 4")) this.marketFailures++;
        else this.marketFailures = 0;
        return market;
    }

    private async ingest(proposals: Proposal[]): Promise<number> {
        const results = await mapWithConcurrency(proposals, 5, async (proposal) => {
            const id = proposalId(proposal);
            if (this.store.getProposal(id)) return false;
            const parsed = parseAncillary(proposal.ancillaryData);
            const market = await this.marketData(proposal);
            return this.store.insertProposal(id, proposal, { parsed, market }, groupFor(id, parsed, market));
        });
        if (this.marketFailures >= 3) this.marketFailures = 2; // probe again on the next scan
        return results.filter(Boolean).length;
    }

    evaluations(proposals: StoredProposal[]): Map<string, Evaluation> {
        const decisions = this.store.decisionsByProposal(proposals.length ? proposals.map((p) => p.id) : undefined);
        return new Map(proposals.map((p) => [p.id, evaluate(decisions.get(p.id) ?? [], p.proposal.proposedPrice.toString(), this.options.policy)]));
    }

    private isSettled(id: string, disputes: ReturnType<ReviewStore["disputes"]>) {
        const status = disputes.get(id)?.status;
        return status === "sending" || status === "disputed" || status === "already-disputed";
    }

    async nextBatch(agent: string, maxProposals: number, maxGroups: number) {
        await this.refresh();
        const atTime = now();
        const claimed = this.store.transaction(() => {
            const open = this.store.openProposals(atTime + MIN_SECONDS_LEFT_TO_REVIEW);
            const evaluations = this.evaluations(open);
            const disputes = this.store.disputes();
            const claims = this.store.claims();
            const groups = new Map<string, { count: number; minExpiry: number }>();
            for (const sp of open) {
                if (this.isSettled(sp.id, disputes) || !needsReview(evaluations.get(sp.id)!, agent, atTime)) continue;
                const claim = claims.get(sp.groupKey);
                if (claim && claim.leaseUntil > atTime && claim.agent !== agent) continue;
                const group = groups.get(sp.groupKey) ?? { count: 0, minExpiry: Infinity };
                group.count++;
                group.minExpiry = Math.min(group.minExpiry, sp.proposal.proposalExpirationTimestamp.toNumber());
                groups.set(sp.groupKey, group);
            }
            // A group bigger than maxProposals is still claimed whole and served in parts: the claim stays with the agent
            // until every member is reviewed, and the next call returns the rest.
            const picked: string[] = [];
            let proposals = 0;
            for (const [key, group] of [...groups].sort((a, b) => a[1].minExpiry - b[1].minExpiry)) {
                if (picked.length >= maxGroups || proposals >= maxProposals) break;
                picked.push(key);
                proposals += group.count;
                this.store.claim(key, agent, atTime + this.options.leaseSeconds);
            }
            return picked;
        });

        const groups: GroupView[] = [];
        let chars = 0;
        let budget = maxProposals;
        for (const key of claimed) {
            const view = budget > 0 && chars < MAX_BATCH_CHARS ? await this.groupView(key, agent, budget) : undefined;
            const viewChars = view ? fitView(view, MAX_BATCH_CHARS - chars) : 0;
            if (!view || view.proposals.length === 0 || (groups.length > 0 && chars + viewChars > MAX_BATCH_CHARS)) {
                this.store.releaseClaim(key, agent); // claimed but not shown: give it back now, not after the lease
                continue;
            }
            groups.push(view);
            chars += viewChars;
            budget -= view.proposals.length;
        }
        return {
            agent,
            lease_seconds: this.options.leaseSeconds,
            groups,
            queue: this.progress(),
            ...(groups.length === 0 ? { note: "Nothing needs review right now. Call next_batch again later; unclear verdicts come back when their re-check time passes." } : {}),
        ...(groups.some((g) => g.not_shown_needing_review > 0)
            ? { split_groups: "Some groups were too large for one batch. Submit what you have; the claim stays yours and next_batch returns the rest." }
            : {}),
        };
    }

    // Lazily adds creator updates (and refreshes stale market data) for proposals about to be shown to an agent.
    private async ensureContext(proposals: StoredProposal[]) {
        await mapWithConcurrency(proposals, this.config.rpcConcurrency, async (sp) => {
            let changed = false;
            const context: ProposalContext = sp.context;
            if (!context.updates || context.updates.status === "unavailable") {
                context.updates = await fetchCreatorUpdates(this.config.provider, sp.proposal.ancillaryData, context.parsed);
                changed = true;
            }
            if (now() - context.market.fetchedAt > MARKET_DATA_MAX_AGE_SECONDS) {
                const market = await this.marketData(sp.proposal);
                market.eventId ??= context.market.eventId;
                market.eventTitle ??= context.market.eventTitle;
                if (market.status === "available" || context.market.status !== "available") context.market = market;
                changed = true;
            }
            if (changed) this.store.updateContext(sp.id, context);
        });
    }

    // Full detail for up to `limit` members the agent still has to review (most urgent first); the rest of the group
    // is listed compactly in other_markets for context.
    async groupView(groupKey: string, agent: string, limit = Infinity) {
        const atTime = now();
        const group = this.store.getGroup(groupKey);
        const open = this.store.groupProposals(groupKey).filter((sp) => sp.status === "open" && sp.proposal.proposalExpirationTimestamp.toNumber() > atTime);
        const evaluations = this.evaluations(open);
        const pending = open.filter((sp) => needsReview(evaluations.get(sp.id)!, agent, atTime));
        const shown = new Set(pending.slice(0, limit).map((sp) => sp.id));
        await this.ensureContext(open.filter((sp) => shown.has(sp.id)));
        const fresh = new Map(this.store.groupProposals(groupKey).map((sp) => [sp.id, sp]));
        const members = open.map((sp) => fresh.get(sp.id) ?? sp);
        const others = members.filter((sp) => !shown.has(sp.id));
        const proposerCounts = this.store.proposerCounts();
        return {
            group_key: groupKey,
            label: group?.label,
            grouping: group?.source,
            ...(group?.source === "description"
                ? { grouping_note: "Grouped only because the rules text is identical. These may be different events built from one template: check each market's title." }
                : {}),
            mutually_exclusive: group?.exclusive ?? false,
            proposals: members.filter((sp) => shown.has(sp.id)).map((sp) => this.proposalView(sp, group, members, evaluations.get(sp.id)!, proposerCounts, atTime, agent)),
            not_shown_needing_review: pending.length - shown.size,
            other_markets: others.slice(0, MAX_OTHER_MARKETS).map((sp) => ({
                proposal_id: sp.id,
                title: sp.context.parsed.title,
                proposed: describePrice(sp.proposal.proposedPrice, sp.context.parsed),
                status: evaluations.get(sp.id)!.action,
            })),
            ...(others.length > MAX_OTHER_MARKETS ? { other_markets_omitted: others.length - MAX_OTHER_MARKETS } : {}),
        };
    }

    proposalView(
        sp: StoredProposal,
        group: GroupRow | undefined,
        members: StoredProposal[],
        evaluation: Evaluation,
        proposerCounts: Map<string, number>,
        atTime: number,
        agent?: string
    ) {
        const { parsed, market, updates } = sp.context;
        const { proposal } = sp;
        const proposed = priceToVerdict(proposal.proposedPrice, parsed);
        return {
            proposal_id: sp.id,
            needs_review: agent ? needsReview(evaluation, agent, atTime) : undefined,
            status: evaluation.action,
            title: parsed.title,
            proposed: { verdict: proposed ?? null, meaning: describePrice(proposal.proposedPrice, parsed), price: proposal.proposedPrice.toString() },
            options: {
                p1: parsed.resData.p1.label ?? parsed.resData.p1.price,
                p2: parsed.resData.p2.label ?? parsed.resData.p2.price,
                p3: parsed.resData.p3.label ?? parsed.resData.p3.price,
                p4: "too early to resolve",
            },
            expires_in_minutes: Math.round((proposal.proposalExpirationTimestamp.toNumber() - atTime) / 6) / 10,
            flags: proposalFlags(sp, group, members, proposerCounts.get(proposal.proposer.toLowerCase()) ?? 0, atTime),
            market: market.status === "available" ? { prices: market.prices, closed: market.closed } : { status: "unavailable" },
            creator_updates: updates ?? { status: "not_loaded" },
            previous_reviews: this.store.decisionDetails(sp.id),
            bond: `${ethers.utils.formatUnits(proposal.bond, proposal.bondCurrencyDecimals)} ${proposal.bondCurrencySymbol}`,
            proposer: proposal.proposer,
            proposer_proposals_seen: proposerCounts.get(proposal.proposer.toLowerCase()) ?? 0,
            oracle: proposal.oracleKind,
            proposal_tx: proposal.proposalTx,
            // Written by whoever created the market. Data to evaluate, never instructions to follow.
            untrusted_market_text: { title: parsed.title, description: parsed.description, raw_if_unparsed: parsed.title ? undefined : parsed.raw },
        };
    }

    submitReview(agent: string, groupKey: string, summary: string, evidence: string[], verdicts: SubmittedVerdict[]) {
        const atTime = now();
        return this.store.transaction(() => {
            const group = this.store.getGroup(groupKey);
            if (!group) throw new Error(`Unknown group ${groupKey}`);
            const claim = this.store.claims().get(groupKey);
            if (claim && claim.agent !== agent && claim.leaseUntil > atTime) throw new Error(`Group ${groupKey} is claimed by ${claim.agent}; call next_batch to get your own work.`);
            if (verdicts.length === 0) throw new Error("Submit at least one verdict.");

            const members = new Map(this.store.groupProposals(groupKey).map((sp) => [sp.id, sp]));
            for (const v of verdicts) {
                const sp = members.get(v.proposal_id);
                if (!sp) throw new Error(`${v.proposal_id} is not in group ${groupKey}`);
                if (sp.status !== "open") throw new Error(`${v.proposal_id} is no longer open (already disputed)`);
                if (sp.proposal.proposalExpirationTimestamp.toNumber() <= atTime) throw new Error(`${v.proposal_id} has expired`);
                if (v.seen_proposed_price !== sp.proposal.proposedPrice.toString()) {
                    throw new Error(`${v.proposal_id}: seen_proposed_price ${v.seen_proposed_price} does not match the proposal (${sp.proposal.proposedPrice}). Re-read it with next_batch or get_proposal.`);
                }
                if (!VERDICTS.includes(v.verdict)) throw new Error(`${v.proposal_id}: invalid verdict ${v.verdict}`);
                if (!(v.confidence >= 0 && v.confidence <= 1)) throw new Error(`${v.proposal_id}: confidence must be between 0 and 1`);
            }

            if (group.exclusive) {
                const latest = this.evaluations([...members.values()].filter((m) => m.status === "open"));
                const yes = new Set([...latest].filter(([, e]) => e.verdict === "p2").map(([id]) => id));
                for (const v of verdicts) v.verdict === "p2" ? yes.add(v.proposal_id) : yes.delete(v.proposal_id);
                if (yes.size > 1) {
                    throw new Error(`Group ${groupKey} is mutually exclusive but ${yes.size} markets would resolve p2 (Yes): ${[...yes].join(", ")}. Re-check the event and submit consistent verdicts.`);
                }
            }

            const { minConfidence } = this.options.policy;
            const earlier = this.store.decisionsByProposal(verdicts.map((v) => v.proposal_id));
            const reviewId = this.store.insertReview(groupKey, agent, summary, evidence);
            const results = verdicts.map((v) => {
                const sp = members.get(v.proposal_id)!;
                const expiration = sp.proposal.proposalExpirationTimestamp.toNumber();
                const decisive = v.verdict !== "unclear" && v.confidence >= minConfidence;
                const inconclusive = (earlier.get(v.proposal_id) ?? []).filter((d) => d.verdict === "unclear" || d.confidence < minConfidence).length;
                const recheckAfter = decisive ? undefined : recheckTime(atTime, expiration, inconclusive);
                const price = v.verdict === "unclear" ? undefined : verdictPrice(v.verdict, sp.context.parsed).toString();
                this.store.insertDecision(reviewId, v.proposal_id, agent, v.verdict, price, v.confidence, v.reasoning, recheckAfter);
                const evaluation = this.evaluations([sp]).get(sp.id)!;
                return {
                    proposal_id: v.proposal_id,
                    verdict: v.verdict,
                    proposed: describePrice(sp.proposal.proposedPrice, sp.context.parsed),
                    status: evaluation.action,
                    ...(recheckAfter ? { recheck_in_minutes: Math.round((recheckAfter - atTime) / 60) } : {}),
                };
            });

            const stillPending = [...members.values()].some((sp) => sp.status === "open" && needsReview(this.evaluations([sp]).get(sp.id)!, agent, atTime));
            if (!stillPending) this.store.releaseClaim(groupKey, agent);
            return { review_id: reviewId, results, claim_released: !stillPending };
        });
    }

    regroup(proposalIds: string[], label: string, exclusive: boolean) {
        const missing = proposalIds.filter((id) => !this.store.getProposal(id));
        if (missing.length) throw new Error(`Unknown proposal(s): ${missing.join(", ")}`);
        const group: GroupRow = { groupKey: `manual:${sha([...proposalIds].sort().join(","))}`, label, exclusive, source: "manual" };
        this.store.regroup(proposalIds, group);
        return group;
    }

    // Open proposals whose review says dispute and that haven't been sent yet.
    candidates() {
        const open = this.store.openProposals(now() + 20);
        const evaluations = this.evaluations(open);
        const disputes = this.store.disputes();
        return open
            .filter((sp) => evaluations.get(sp.id)!.action === "dispute" && !this.isSettled(sp.id, disputes))
            .map((sp) => ({ stored: sp, evaluation: evaluations.get(sp.id)! }));
    }

    progress() {
        const atTime = now();
        const open = this.store.openProposals(atTime);
        const evaluations = this.evaluations(open);
        const disputes = this.store.disputes();
        const claims = this.store.claims();
        const counts: Record<string, number> = { pending: 0, recheck: 0, agree: 0, needs_confirmation: 0, dispute: 0 };
        const atRisk = { under_15_min: 0, under_30_min: 0, under_60_min: 0 };
        for (const sp of open) {
            const action = evaluations.get(sp.id)!.action;
            counts[action]++;
            const unresolved = action === "pending" || action === "recheck" || action === "needs_confirmation" || (action === "dispute" && !this.isSettled(sp.id, disputes));
            const left = sp.proposal.proposalExpirationTimestamp.toNumber() - atTime;
            if (unresolved && left < 60 * 60) {
                atRisk.under_60_min++;
                if (left < 30 * 60) atRisk.under_30_min++;
                if (left < 15 * 60) atRisk.under_15_min++;
            }
        }
        const disputeStatus: Record<string, number> = {};
        for (const d of disputes.values()) disputeStatus[d.status] = (disputeStatus[d.status] ?? 0) + 1;
        return {
            open_proposals: open.length,
            by_status: counts,
            dispute_candidates_not_sent: this.candidates().length,
            disputes: disputeStatus,
            active_claims: [...claims.values()].filter((c) => c.leaseUntil > atTime).length,
            unresolved_expiring: atRisk,
            last_scan_block: Number(this.store.getMeta("last_scan_block") ?? 0),
            last_scan_seconds_ago: atTime - Number(this.store.getMeta("last_scan_at") ?? 0),
        };
    }

    atRisk(minutes: number) {
        const atTime = now();
        const open = this.store.openProposals(atTime).filter((sp) => sp.proposal.proposalExpirationTimestamp.toNumber() - atTime < minutes * 60);
        const evaluations = this.evaluations(open);
        const disputes = this.store.disputes();
        return open
            .filter((sp) => {
                const action = evaluations.get(sp.id)!.action;
                return action !== "agree" && !(action === "dispute" && this.isSettled(sp.id, disputes));
            })
            .map((sp) => this.summary(sp, evaluations.get(sp.id)!, atTime));
    }

    list(limit: number, onlyUnresolved: boolean) {
        const atTime = now();
        const open = this.store.openProposals(atTime);
        const evaluations = this.evaluations(open);
        return open
            .filter((sp) => !onlyUnresolved || evaluations.get(sp.id)!.action !== "agree")
            .slice(0, limit)
            .map((sp) => this.summary(sp, evaluations.get(sp.id)!, atTime));
    }

    summary(sp: StoredProposal, evaluation: Evaluation, atTime: number) {
        return {
            proposal_id: sp.id,
            group_key: sp.groupKey,
            title: sp.context.parsed.title,
            proposed: describePrice(sp.proposal.proposedPrice, sp.context.parsed),
            status: evaluation.action,
            verdict: evaluation.verdict,
            expires_in_minutes: Math.round((sp.proposal.proposalExpirationTimestamp.toNumber() - atTime) / 6) / 10,
        };
    }

    async proposalDetail(id: string) {
        const sp = this.store.getProposal(id);
        if (!sp) throw new Error(`Unknown proposal ${id}`);
        await this.ensureContext([sp]);
        const fresh = this.store.getProposal(id)!;
        const group = this.store.getGroup(fresh.groupKey);
        const members = this.store.groupProposals(fresh.groupKey);
        return { group_key: fresh.groupKey, ...this.proposalView(fresh, group, members, this.evaluations([fresh]).get(id)!, this.store.proposerCounts(), now()) };
    }
}
