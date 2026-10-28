import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, ethers } from "ethers";
import { Config } from "./config";
import { parseAncillary, priceToVerdict, TOO_EARLY_PRICE, verdictPrice } from "./polymarket";
import { Proposal } from "./proposals";
import { evaluate, needsReview, recheckTime } from "./review/policy";
import { groupFor, proposalId, ReviewQueue } from "./review/queue";
import { now, ReviewStore } from "./review/store";

const hex = (text: string) => ethers.utils.hexlify(ethers.utils.toUtf8Bytes(text));
const ANCILLARY =
    "q: title: M25 Malta: Alberto Bronzetti vs Alex Blanchar, description: This market refers to the tennis match.\n\nIt resolves to the winner. market_id: 6322641 " +
    "res_data: p1: 0, p2: 1, p3: 0.5. Where p1 corresponds to Alex Blanchar, p2 to Alberto Bronzetti, p3 to unknown/50-50. " +
    "Updates made by the question creator via the bulletin board at 0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7 as described by https://polygonscan.com/tx/0xa1 should be considered.,initializer:ac9930b2ae455a671b62de86876a7e8587825294";
const ONE = ethers.constants.WeiPerEther;

test("parseAncillary extracts title, rules, res_data labels, bulletin board and creator", () => {
    const parsed = parseAncillary(hex(ANCILLARY));
    assert.equal(parsed.title, "M25 Malta: Alberto Bronzetti vs Alex Blanchar");
    assert.match(parsed.description!, /^This market refers to the tennis match/);
    assert.equal(parsed.marketId, "6322641");
    assert.equal(parsed.resData.p1.label, "Alex Blanchar");
    assert.equal(parsed.resData.p2.label, "Alberto Bronzetti");
    assert.equal(parsed.resData.p3.price, ONE.div(2).toString());
    assert.equal(parsed.bulletinBoard, "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7");
    assert.equal(parsed.initializer, ethers.utils.getAddress("0xac9930b2ae455a671b62de86876a7e8587825294"));
    assert.equal(priceToVerdict(ONE, parsed), "p2");
    assert.equal(priceToVerdict(TOO_EARLY_PRICE, parsed), "p4");
    assert.equal(priceToVerdict(BigNumber.from(7), parsed), undefined);
    assert.ok(verdictPrice("p4", parsed).eq(TOO_EARLY_PRICE));
});

test("parseAncillary falls back to Yes/No defaults for free-form text", () => {
    const parsed = parseAncillary(hex("Will it rain tomorrow?"));
    assert.equal(parsed.resDataFound, false);
    assert.equal(parsed.title, undefined);
    assert.equal(parsed.resData.p2.label, "Yes");
});

test("evaluate: agreement, unclear, low confidence and confirmations", () => {
    const policy = { minConfidence: 0.8, minConfirmations: 2 };
    const d = (agent: string, verdict: "p1" | "p2" | "unclear", confidence: number, createdAt: number, price?: string) => ({ agent, verdict, verdictPrice: price, confidence, createdAt });
    const proposed = ONE.toString();
    assert.equal(evaluate([], proposed, policy).action, "pending");
    assert.equal(evaluate([d("a", "p2", 0.95, 1, proposed)], proposed, policy).action, "agree");
    assert.equal(evaluate([d("a", "unclear", 0.3, 1)], proposed, policy).action, "recheck");
    assert.equal(evaluate([d("a", "p1", 0.6, 1, "0")], proposed, policy).action, "recheck");
    const one = evaluate([d("a", "p1", 0.9, 1, "0")], proposed, policy);
    assert.equal(one.action, "needs_confirmation");
    assert.equal(needsReview(one, "a", 10), false);
    assert.equal(needsReview(one, "b", 10), true);
    assert.equal(evaluate([d("a", "p1", 0.9, 1, "0"), d("b", "p1", 0.85, 2, "0")], proposed, policy).action, "dispute");
    // The same agent twice is still one confirmation.
    assert.equal(evaluate([d("a", "p1", 0.9, 1, "0"), d("a", "p1", 0.95, 2, "0")], proposed, policy).action, "needs_confirmation");
});

test("recheckTime spreads re-checks over liveness and stays before expiry", () => {
    assert.equal(recheckTime(0, 600), 60);
    assert.equal(recheckTime(0, 7200), 1800);
    assert.equal(recheckTime(0, 1800), 600);
    assert.ok(recheckTime(0, 1500) <= 1500 - 600);
});

// ---- queue (in-memory store, no chain) ----

const REQUESTER = "0x000000000000000000000000000000000000000A";
function makeProposal(title: string, description: string, proposed: BigNumber, timestamp: number, expiresIn = 3600): Proposal {
    const ancillary = hex(`q: title: ${title}, description: ${description} res_data: p1: 0, p2: 1, p3: 0.5. Where p1 corresponds to No, p2 to Yes, p3 to unknown/50-50.`);
    return {
        bond: BigNumber.from(750_000_000),
        ooAddress: "0xeE3Afe347D5C74317041E2618C49534dAf887c24",
        oracleKind: "oov2",
        bondCurrencySymbol: "USDC",
        bondCurrencyDecimals: 6,
        bondCurrency: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        requester: REQUESTER,
        identifier: ethers.utils.formatBytes32String("YES_OR_NO_QUERY"),
        timestamp: BigNumber.from(timestamp),
        requestTimestamp: BigNumber.from(timestamp),
        ancillaryData: ancillary,
        proposer: "0x00000000000000000000000000000000000000B0",
        proposedPrice: proposed,
        proposalExpirationTimestamp: BigNumber.from(now() + expiresIn),
    };
}

function setupQueue(policy = { minConfidence: 0.8, minConfirmations: 1 }) {
    const store = new ReviewStore(":memory:");
    store.setMeta("last_scan_at", String(now() + 10_000)); // no chain scans in these tests
    const config = { rpcConcurrency: 4, oracles: [] } as unknown as Config;
    const queue = new ReviewQueue(config, store, { policy, leaseSeconds: 600, scanIntervalSeconds: 1_000_000, fetchMarketData: false });
    const add = (proposal: Proposal, exclusive = false) => {
        const id = proposalId(proposal);
        const parsed = parseAncillary(proposal.ancillaryData);
        const market = { status: "unavailable" as const, fetchedAt: now() };
        const group = groupFor(id, parsed, market);
        store.insertProposal(id, proposal, { parsed, market, updates: { status: "not_applicable", updates: [] } }, { ...group, exclusive });
        return id;
    };
    return { store, queue, add };
}

const RACE = "This market resolves to Yes for the candidate who wins the 2024 US presidential election.";

test("next_batch groups markets of one event, claims them, and other agents skip the claim", async () => {
    const { queue, add } = setupQueue();
    add(makeProposal("Will Trump win?", RACE, ONE, 1, 3000), true);
    add(makeProposal("Will Harris win?", RACE, BigNumber.from(0), 2, 3000), true);
    add(makeProposal("Did Spain win Euro 2024?", "Resolves Yes if Spain won the UEFA Euro 2024 final.", BigNumber.from(0), 3, 6000));

    const first = await queue.nextBatch("reviewer-1", 20, 1);
    assert.equal(first.groups.length, 1);
    assert.equal(first.groups[0].proposals.length, 2, "both race markets come together");
    assert.equal(first.groups[0].mutually_exclusive, true);

    const second = await queue.nextBatch("reviewer-2", 20, 3);
    assert.deepEqual(second.groups.map((g) => g.label), ["Did Spain win Euro 2024?"], "the claimed race group is not handed out again");
    const third = await queue.nextBatch("reviewer-3", 20, 3);
    assert.equal(third.groups.length, 0);
});

test("submit_review validates the seen price and mutual exclusivity, then marks disputes", async () => {
    const { queue, add } = setupQueue();
    const trump = add(makeProposal("Will Trump win?", RACE, ONE, 1), true);
    const harris = add(makeProposal("Will Harris win?", RACE, ONE, 2), true); // wrong Yes
    const batch = await queue.nextBatch("r1", 20, 1);
    const group = batch.groups[0];
    assert.ok(group.proposals.every((p) => p.flags.includes("multiple_yes_in_exclusive_group")));

    const v = (proposal_id: string, verdict: "p1" | "p2", seen = ONE.toString()) => ({ proposal_id, verdict, confidence: 0.97, seen_proposed_price: seen, reasoning: "AP call" });
    assert.throws(() => queue.submitReview("r1", group.group_key, "s", [], [v(trump, "p2", "123")]), /does not match/);
    assert.throws(() => queue.submitReview("r1", group.group_key, "s", [], [v(trump, "p2"), v(harris, "p2")]), /mutually exclusive/);
    assert.throws(() => queue.submitReview("r2", group.group_key, "s", [], [v(trump, "p2")]), /claimed by r1/);

    const result = queue.submitReview("r1", group.group_key, "Trump won", ["https://apnews.com"], [v(trump, "p2"), v(harris, "p1")]);
    assert.deepEqual(result.results.map((r) => r.status), ["agree", "dispute"]);
    assert.equal(result.claim_released, true);
    assert.deepEqual(queue.candidates().map((c) => c.stored.id), [harris]);
    assert.equal(queue.progress().dispute_candidates_not_sent, 1);
});

test("unclear verdicts come back after their re-check time; confirmations need a different agent", async () => {
    const { queue, store, add } = setupQueue({ minConfidence: 0.8, minConfirmations: 2 });
    const id = add(makeProposal("Did Spain win Euro 2024?", "Resolves Yes if Spain won.", BigNumber.from(0), 9, 7200));
    const g = (await queue.nextBatch("r1", 20, 1)).groups[0];
    queue.submitReview("r1", g.group_key, "not sure", [], [{ proposal_id: id, verdict: "unclear", confidence: 0.4, seen_proposed_price: "0", reasoning: "?" }]);
    assert.equal((await queue.nextBatch("r1", 20, 1)).groups.length, 0, "re-check is in the future");

    store.db.prepare("UPDATE decisions SET recheck_after = ?").run(now() - 1);
    const again = (await queue.nextBatch("r1", 20, 1)).groups[0];
    queue.submitReview("r1", again.group_key, "Spain won", [], [{ proposal_id: id, verdict: "p2", confidence: 0.95, seen_proposed_price: "0", reasoning: "final 2-1" }]);
    assert.equal(queue.candidates().length, 0, "one reviewer is not enough with confirmations=2");
    assert.equal((await queue.nextBatch("r1", 20, 1)).groups.length, 0, "the same reviewer cannot confirm itself");

    const confirm = (await queue.nextBatch("r2", 20, 1)).groups[0];
    queue.submitReview("r2", confirm.group_key, "Spain won", [], [{ proposal_id: id, verdict: "p2", confidence: 0.9, seen_proposed_price: "0", reasoning: "UEFA" }]);
    assert.equal(queue.candidates().length, 1);
});

test("expired leases return work to the queue", async () => {
    const { queue, store, add } = setupQueue();
    add(makeProposal("Did Spain win Euro 2024?", "Resolves Yes if Spain won.", BigNumber.from(0), 9));
    assert.equal((await queue.nextBatch("r1", 20, 1)).groups.length, 1);
    assert.equal((await queue.nextBatch("r2", 20, 1)).groups.length, 0);
    store.db.prepare("UPDATE claims SET lease_until = ?").run(now() - 1);
    assert.equal((await queue.nextBatch("r2", 20, 1)).groups.length, 1);
});
