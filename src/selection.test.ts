import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, ethers } from "ethers";
import { Config } from "./config";
import { POLYMARKET_V2_OO_REPORTER } from "./constants";
import { conditionId, parseAncillary, questionId } from "./polymarket";
import { Proposal } from "./proposals";
import { groupFor, proposalId, ReviewQueue } from "./review/queue";
import { BUILTIN_SCOPES, compileSelection, parseSelection, protocolOf, resolveSelection } from "./review/selection";
import { openReview } from "./review/setup";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

test("every queue has the permissionless and managed scopes, split by oracle", () => {
    const oov2 = stored(makeProposal("Will Republicans win the House in 2026?", "701", { oracle: "oov2" }));
    const managed = stored(makeProposal("Will Democrats win the Senate in 2026?", "702", { oracle: "managed" }));
    const pick = (name: string) => [oov2, managed].filter(compileSelection(BUILTIN_SCOPES.find((s) => s.name === name)!)).map((sp) => sp.context.parsed.marketId);
    assert.deepEqual(pick("permissionless"), ["701"]);
    assert.deepEqual(pick("managed"), ["702"]);

    const db = join(mkdtempSync(join(tmpdir(), "oo-scopes-")), "review.sqlite");
    const { queue } = openReview({ chainId: 137, rpcConcurrency: 4, oracles: [] } as unknown as Config, { db });
    assert.deepEqual(queue.listScopes().map((s) => s.name), ["managed", "permissionless"]);
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

test("resolution records each market's event, keyed like the live grouping", async () => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const fakeFetch = async (url: string) => {
        if (url.includes("/events?slug=az-01")) return json([{ id: 106050, title: "AZ-01", negRisk: true, negRiskMarketID: "0xABC", markets: [{ id: "11" }, { id: "12" }] }]);
        if (url.includes("tag_slug=midterms") && url.includes("offset=0")) return json([{ id: 7, title: "Senate control", negRisk: false, markets: [{ id: "21" }] }]);
        if (url.includes("/markets?slug=single&closed=false")) return json([{ id: "31", negRisk: true, negRiskMarketID: "0xDEF", events: [{ id: 9, title: "Event 9" }] }]);
        return json([]);
    };
    const resolved = await resolveSelection(parseSelection({ name: "m", include: { event_slugs: ["az-01"], tags: ["midterms"], slugs: ["single"] } }), fakeFetch);
    assert.deepEqual(resolved.market_events, { "11": "negrisk:0xabc", "12": "negrisk:0xabc", "21": "event:7", "31": "negrisk:0xdef" });
    assert.deepEqual(resolved.events?.["negrisk:0xabc"], { title: "AZ-01", exclusive: true });
    assert.equal(resolved.events?.["event:7"]?.exclusive, false);
    assert.equal(parseSelection(JSON.parse(JSON.stringify(resolved))).market_events?.["31"], "negrisk:0xdef", "the map survives a save/load");
});

test("groupFor: live neg-risk id first, then the selection's event map, then the live Gamma event", () => {
    const parsed = parseAncillary(makeProposal("Will A win the AZ-01 House seat?", "11").ancillaryData);
    const known = { key: "negrisk:0xabc", title: "AZ-01", exclusive: true };
    const none = { status: "unavailable" as const, fetchedAt: 0 };
    assert.deepEqual(groupFor("p", parsed, none, known), { groupKey: "negrisk:0xabc", label: "AZ-01", exclusive: true, source: "negrisk" });
    assert.equal(groupFor("p", parsed, { ...none, negRiskMarketId: "0xABC" }, known).groupKey, "negrisk:0xabc", "live and offline keys agree");
    assert.equal(groupFor("p", parsed, { ...none, eventId: "106050" }, known).groupKey, "negrisk:0xabc", "map wins over the live Gamma event id");
    assert.equal(groupFor("p", parsed, { ...none, eventId: "106050" }).groupKey, "event:106050");
});

test("without any market data, proposals of one race are grouped and marked exclusive through the selection map", async () => {
    const { queue } = setupQueue();
    await queue.defineScope({
        name: "az01",
        include: { market_ids: ["11", "12"] },
        market_events: { "11": "negrisk:0xabc", "12": "negrisk:0xabc" },
        events: { "negrisk:0xabc": { title: "AZ-01 House", exclusive: true } },
    });
    const a = makeProposal("Will A win the AZ-01 House seat?", "11", { description: "Rules for A." });
    const b = makeProposal("Will B win the AZ-01 House seat?", "12", { description: "Rules for B." });
    await (queue as unknown as { ingest(p: Proposal[]): Promise<number> }).ingest([a, b]);
    const batch = await queue.nextBatch("r1", 10, 1, "az01");
    assert.equal(batch.groups.length, 1);
    assert.equal(batch.groups[0].label, "AZ-01 House");
    assert.equal(batch.groups[0].mutually_exclusive, true);
    assert.equal(batch.groups[0].proposals.length, 2);
    assert.ok(batch.groups[0].proposals.every((p) => p.flags.includes("multiple_yes_in_exclusive_group")), "both were proposed Yes");
    const yes = (p: Proposal) => ({ proposal_id: proposalId(p), verdict: "p2" as const, confidence: 0.95, seen_proposed_price: ethers.constants.WeiPerEther.toString(), reasoning: "x" });
    assert.throws(() => queue.submitReview("r1", batch.groups[0].group_key, "s", [], [yes(a), yes(b)]), /mutually exclusive/);
});

test("Managed OOv2 proposals stay open past liveness until settled; OOv2 ones close at expiry", async () => {
    const { disputable } = await import("./dispute");
    const { filterOpenProposals } = await import("./proposals");
    const { RequestState } = await import("./constants");
    const t = 1000;
    const key = (requester: string) => ({ requester, identifier: ethers.utils.formatBytes32String("YES_OR_NO_QUERY"), timestamp: BigNumber.from(1), ancillaryData: "0x01" });
    const expired = [V1_ADAPTER, OTHER].map((r) => ({ args: { ...key(r), expirationTimestamp: BigNumber.from(t - 10) } }));
    assert.equal(filterOpenProposals(expired, [], t, false).length, 0, "OOv2: expired is closed");
    assert.equal(filterOpenProposals(expired, [], t, false, { keepExpired: true }).length, 2, "Managed: expired stays open");
    assert.equal(filterOpenProposals(expired, [], t, false, { keepExpired: true, settleEvents: [{ args: key(V1_ADAPTER) }] }).length, 1, "a Settle event closes it");

    assert.equal(disputable("managed", RequestState.Expired, false, t - 10, t), true);
    assert.equal(disputable("managed", RequestState.Expired, true, t - 10, t), false, "settled");
    assert.equal(disputable("oov2", RequestState.Expired, false, t - 10, t), false);
    assert.equal(disputable("oov2", RequestState.Proposed, false, t + 5, t), false, "inside the safety margin");
    assert.equal(disputable("oov2", RequestState.Proposed, false, t + 3600, t), true);
});

test("the queue keeps handing out an expired, unsettled Managed OOv2 proposal and accepts its verdict", async () => {
    const { queue, store, add } = setupQueue();
    const managed = makeProposal("Will Democrats win the Senate in 2026?", "601", { oracle: "managed" });
    const oov2 = makeProposal("Will Republicans win the House in 2026?", "602", { oracle: "oov2" });
    for (const p of [managed, oov2]) p.proposalExpirationTimestamp = BigNumber.from(now() - 60);
    add(managed);
    add(oov2);

    const batch = await queue.nextBatch("r1", 10, 5);
    assert.deepEqual(batch.groups.map((g) => g.label), ["Will Democrats win the Senate in 2026?"], "only the managed one is still disputable");
    const view = batch.groups[0].proposals[0];
    assert.ok(view.flags.includes("liveness_ended_disputable_until_settled"));
    const result = queue.submitReview("r1", batch.groups[0].group_key, "wrong", [], [{ proposal_id: proposalId(managed), verdict: "p1", confidence: 0.95, seen_proposed_price: view.proposed.price, reasoning: "x" }]);
    assert.equal(result.results[0].status, "dispute");
    assert.equal(queue.candidates().length, 1);

    store.markSettled([proposalId(managed)]);
    assert.equal(queue.candidates().length, 0, "settled: no longer disputable");
    assert.equal(queue.progress().open_proposals, 0);
});
