import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, ethers } from "ethers";
import { Config } from "./config";
import { POLYMARKET_V2_OO_REPORTER } from "./constants";
import { conditionId, parseAncillary, questionId } from "./polymarket";
import { Proposal } from "./proposals";
import { groupFor, proposalId, ReviewQueue } from "./review/queue";
import { compileSelection, parseSelection, protocolOf, resolveSelection } from "./review/selection";
import { now, ReviewStore, StoredProposal } from "./review/store";

const hex = (text: string) => ethers.utils.hexlify(ethers.utils.toUtf8Bytes(text));
const V1_ADAPTER = "0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d";
const OTHER = "0x000000000000000000000000000000000000000A";

function makeProposal(title: string, marketId: string, opts: { requester?: string; oracle?: "oov2" | "managed"; description?: string; timestamp?: number } = {}): Proposal {
    const ancillary = hex(
        `q: title: ${title}, description: ${opts.description ?? `Rules for ${title}.`} market_id: ${marketId} res_data: p1: 0, p2: 1, p3: 0.5. Where p1 corresponds to No, p2 to Yes, p3 to unknown/50-50.`
    );
    return {
        bond: BigNumber.from(500_000_000),
        ooAddress: "0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1",
        oracleKind: opts.oracle ?? "managed",
        bondCurrencySymbol: "USDC",
        bondCurrencyDecimals: 6,
        bondCurrency: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        requester: opts.requester ?? V1_ADAPTER,
        identifier: ethers.utils.formatBytes32String("YES_OR_NO_QUERY"),
        timestamp: BigNumber.from(opts.timestamp ?? Number(marketId)),
        requestTimestamp: BigNumber.from(opts.timestamp ?? Number(marketId)),
        ancillaryData: ancillary,
        proposer: "0x00000000000000000000000000000000000000B0",
        proposedPrice: ethers.constants.WeiPerEther,
        proposalExpirationTimestamp: BigNumber.from(now() + 3600),
    };
}

const stored = (proposal: Proposal): StoredProposal => ({
    id: proposalId(proposal),
    proposal,
    groupKey: "g",
    status: "open",
    context: { parsed: parseAncillary(proposal.ancillaryData), market: { status: "unavailable", fetchedAt: 0 } },
    firstSeen: 0,
});

test("selections match on chain data: market id, title, question/condition id, protocol, oracle, exclude", () => {
    const senate = stored(makeProposal("Will Democrats win the Senate in 2026?", "101"));
    const house = stored(makeProposal("Will Republicans win the House in 2026?", "102", { oracle: "oov2" }));
    const tennis = stored(makeProposal("M25 Malta: Bronzetti vs Blanchar", "103"));
    const v2 = stored(makeProposal("Will Democrats win the NV Senate seat?", "104", { requester: POLYMARKET_V2_OO_REPORTER }));
    const all = [senate, house, tennis, v2];
    const pick = (input: unknown) => all.filter(compileSelection(parseSelection(input))).map((sp) => sp.context.parsed.marketId);

    assert.deepEqual(pick({ name: "everything" }), ["101", "102", "103", "104"]);
    assert.deepEqual(pick({ name: "ids", include: { market_ids: [102, "103"] } }), ["102", "103"]);
    assert.deepEqual(pick({ name: "re", include: { title_regex: "senate|house" } }), ["101", "102", "104"]);
    assert.deepEqual(pick({ name: "re-v1", include: { title_regex: "senate|house" }, protocol: ["polymarket_v1"] }), ["101", "102"]);
    assert.deepEqual(pick({ name: "managed", include: { title_regex: "senate|house" }, oracle: ["managed"] }), ["101", "104"]);
    assert.deepEqual(pick({ name: "excl", include: { title_regex: "2026|NV" }, exclude: { market_ids: ["101"] } }), ["102", "104"]);

    const question = questionId(tennis.proposal.ancillaryData);
    assert.deepEqual(pick({ name: "qid", include: { question_ids: [question.toUpperCase().replace("0X", "0x")] } }), ["103"]);
    assert.deepEqual(pick({ name: "cid", include: { condition_ids: [conditionId(V1_ADAPTER, question)] } }), ["103"]);

    assert.equal(protocolOf(V1_ADAPTER), "polymarket_v1");
    assert.equal(protocolOf(POLYMARKET_V2_OO_REPORTER.toUpperCase().replace("0X", "0x")), "polymarket_v2");
    assert.equal(protocolOf(OTHER), "other");
    assert.throws(() => parseSelection({ name: "bad name!" }), /Invalid selection/);
    assert.throws(() => parseSelection({ name: "x", include: { unknown_key: 1 } }), /Invalid selection/);
});

test("resolveSelection turns slugs, event slugs and tags into ids and reports what Gamma could not answer", async () => {
    const calls: string[] = [];
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const fakeFetch = async (url: string) => {
        calls.push(url);
        if (url.includes("/markets?slug=senate-2026&closed=false")) return json([{ id: "201", questionID: "0xAA", conditionId: "0xBB" }]);
        if (url.includes("/markets?slug=")) return json([]);
        if (url.includes("/events?slug=midterms")) return json([{ markets: [{ id: "202" }, { id: "203", questionID: "0xCC" }] }]);
        if (url.includes("tag_slug=elections") && url.includes("offset=0")) return json(Array.from({ length: 100 }, (_, i) => ({ markets: [{ id: String(1000 + i) }] })));
        if (url.includes("tag_slug=elections") && url.includes("offset=100")) return json([{ markets: [{ id: "2000" }] }]);
        if (url.includes("tag_slug=broken")) return { ok: false, status: 503, json: async () => ({}) };
        return json([]);
    };
    const resolved = await resolveSelection(
        parseSelection({ name: "midterms", include: { slugs: ["senate-2026", "missing-slug"], event_slugs: ["midterms"], tags: ["elections", "broken"], title_regex: "Senate" } }),
        fakeFetch
    );
    assert.equal(resolved.include?.slugs, undefined);
    assert.equal(resolved.include?.tags, undefined);
    assert.equal(resolved.include?.title_regex, "Senate");
    assert.ok(resolved.include?.market_ids?.includes("201") && resolved.include.market_ids.includes("203") && resolved.include.market_ids.includes("2000"));
    assert.equal(resolved.include?.market_ids?.length, 3 + 101);
    assert.deepEqual(resolved.include?.question_ids, ["0xaa", "0xcc"]);
    assert.deepEqual(resolved.include?.condition_ids, ["0xbb"]);
    assert.deepEqual(resolved.resolved?.from.tags, ["elections", "broken"]);
    assert.equal(resolved.resolved?.unresolved.length, 2);
    assert.match(resolved.resolved!.unresolved.join(" "), /missing-slug.*no markets/);
    assert.match(resolved.resolved!.unresolved.join(" "), /tag:broken.*503/);
    assert.ok(calls.some((u) => u.includes("offset=100")), "tag results are paginated");
});

function setupQueue() {
    const store = new ReviewStore(":memory:");
    store.setMeta("last_scan_at", String(now() + 10_000)); // no chain scans
    const config = { rpcConcurrency: 4, oracles: [] } as unknown as Config;
    const queue = new ReviewQueue(config, store, { policy: { minConfidence: 0.8, minConfirmations: 1 }, leaseSeconds: 600, scanIntervalSeconds: 1e6, fetchMarketData: false });
    const add = (proposal: Proposal) => {
        const id = proposalId(proposal);
        const parsed = parseAncillary(proposal.ancillaryData);
        const market = { status: "unavailable" as const, fetchedAt: now() };
        store.insertProposal(id, proposal, { parsed, market, updates: { status: "not_applicable", updates: [] } }, groupFor(id, parsed, market));
        return id;
    };
    return { store, queue, add };
}

test("scopes limit what next_batch, progress and candidates see, and are shared through the database", async () => {
    const { queue, store, add } = setupQueue();
    add(makeProposal("Will Democrats win the Senate in 2026?", "301"));
    add(makeProposal("M25 Malta: Bronzetti vs Blanchar", "302"));

    const scope = await queue.defineScope({ name: "midterms", include: { title_regex: "Senate|House" } });
    assert.equal(scope.open_proposals_matching, 1);
    assert.deepEqual(queue.listScopes().map((s) => s.name), ["midterms"]);
    assert.equal(queue.progress("midterms").open_proposals, 1);
    assert.equal(queue.progress().open_proposals, 2);
    assert.throws(() => queue.progress("nope"), /Unknown scope "nope"/);

    const batch = await queue.nextBatch("r1", 10, 5, "midterms");
    assert.deepEqual(batch.groups.map((g) => g.label), ["Will Democrats win the Senate in 2026?"]);
    assert.equal((await queue.nextBatch("r2", 10, 5, "midterms")).groups.length, 0);
    assert.equal((await queue.nextBatch("r3", 10, 5)).groups.length, 1, "the unscoped queue still has the tennis market");

    // Another process opening the same database sees the scope.
    assert.deepEqual(new ReviewQueue({ rpcConcurrency: 4, oracles: [] } as unknown as Config, store, { policy: { minConfidence: 0.8, minConfirmations: 1 }, leaseSeconds: 600, scanIntervalSeconds: 1e6, fetchMarketData: false }).listScopes().map((s) => s.name), ["midterms"]);
});

test("submitting the in-scope members of a group releases the claim even if out-of-scope members remain", async () => {
    const { queue, add } = setupQueue();
    const shared = "Resolves to the winner of the race.";
    const yes = add(makeProposal("Will Alice win the 2026 Senate race?", "401", { description: shared }));
    add(makeProposal("Will Alice win the 2026 primary?", "402", { description: shared }));
    await queue.defineScope({ name: "senate", include: { title_regex: "Senate" } });

    const group = (await queue.nextBatch("r1", 10, 1, "senate")).groups[0];
    assert.deepEqual(group.proposals.map((p) => p.proposal_id), [yes]);
    assert.ok(group.other_markets.some((m) => "outside_scope" in m && m.outside_scope));
    const result = queue.submitReview("r1", group.group_key, "Alice won", [], [
        { proposal_id: yes, verdict: "p2", confidence: 0.95, seen_proposed_price: ethers.constants.WeiPerEther.toString(), reasoning: "AP call" },
    ]);
    assert.equal(result.claim_released, true);
    assert.equal((await queue.nextBatch("r2", 10, 1)).groups.length, 1, "the primary market is free for an unscoped reviewer");
});

test("a selection whose include criteria all fail to resolve matches nothing, not everything", async () => {
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const resolved = await resolveSelection(parseSelection({ name: "midterms", include: { tags: ["midterms"], event_slugs: ["senate-2026"] } }), down);
    assert.match(resolved.resolved!.unresolved.join(" "), /matches no proposals/);
    const anything = stored(makeProposal("Will Democrats win the Senate in 2026?", "501"));
    assert.equal(compileSelection(resolved)(anything), false);
    // With a criterion that works offline, the rest still applies.
    const mixed = await resolveSelection(parseSelection({ name: "m2", include: { tags: ["midterms"], title_regex: "Senate" } }), down);
    assert.equal(compileSelection(mixed)(anything), true);
});

test("a tag cut off by Gamma's offset limit keeps the pages already fetched and is reported as truncated", async () => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const fakeFetch = async (url: string) =>
        url.includes("offset=0") ? json(Array.from({ length: 100 }, (_, i) => ({ markets: [{ id: String(i) }] }))) : { ok: false, status: 422, json: async () => ({}) };
    const resolved = await resolveSelection(parseSelection({ name: "sports", include: { tags: ["sports"] } }), fakeFetch);
    assert.equal(resolved.include?.market_ids?.length, 100);
    assert.match(resolved.resolved!.unresolved.join(" "), /tag:sports \(truncated after 100 events: HTTP 422/);
});
