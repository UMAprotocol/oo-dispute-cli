import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, ethers } from "ethers";
import { chunk, mapWithConcurrency, withRetry } from "./concurrency";
import { fitToBalance, ReadyItem } from "./dispute";
import { formatExpiryTime } from "./display";
import { computeFees } from "./gas";
import { filterOpenProposals, Proposal, requestKeyId, sortProposals } from "./proposals";

const gwei = (n: number) => ethers.utils.parseUnits(String(n), "gwei");
const key = (requester: string, timestamp = 1) => ({
    requester,
    identifier: ethers.utils.formatBytes32String("YES_OR_NO_QUERY"),
    timestamp: BigNumber.from(timestamp),
    ancillaryData: "0x1234",
});
const A = "0x000000000000000000000000000000000000000A";
const B = "0x000000000000000000000000000000000000000B";

test("computeFees enforces the chain tip floor before the multiplier", () => {
    // ethers v5 would suggest 1.5 gwei; Polygon needs ~30.
    const fees = computeFees(gwei(100), gwei(1.5), 30, 4);
    assert.ok(fees.maxPriorityFeePerGas.eq(gwei(120)));
    assert.ok(fees.maxFeePerGas.eq(gwei(320)));
});

test("computeFees uses the node's tip when it is above the floor, and supports decimal multipliers", () => {
    const fees = computeFees(gwei(100), gwei(50), 30, 1.5);
    assert.ok(fees.maxPriorityFeePerGas.eq(gwei(75)));
    assert.ok(computeFees(gwei(1), undefined, 30, 1).maxPriorityFeePerGas.eq(gwei(30)));
});

test("filterOpenProposals keys disputes by requester too", () => {
    const now = 1000;
    const proposals = [A, B].map((requester) => ({ args: { ...key(requester), expirationTimestamp: BigNumber.from(now + 100) } }));
    const disputes = [{ args: key(A) }];
    const open = filterOpenProposals(proposals, disputes, now, false);
    assert.deepEqual(open.map((p) => p.args.requester), [B]);
});

test("filterOpenProposals drops expired proposals and non-Polymarket requesters when asked", () => {
    const now = 1000;
    const polymarket = "0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d";
    const proposals = [
        { args: { ...key(polymarket.toLowerCase()), expirationTimestamp: BigNumber.from(now + 1) } },
        { args: { ...key(polymarket, 2), expirationTimestamp: BigNumber.from(now) } },
        { args: { ...key(A), expirationTimestamp: BigNumber.from(now + 1) } },
    ];
    assert.equal(filterOpenProposals(proposals, [], now, true).length, 1);
    assert.equal(filterOpenProposals(proposals, [], now, false).length, 2);
});

test("requestKeyId is case-insensitive on addresses and data", () => {
    assert.equal(requestKeyId(key(A)), requestKeyId({ ...key(A.toLowerCase()), ancillaryData: "0X1234".toLowerCase() }));
    assert.notEqual(requestKeyId(key(A)), requestKeyId(key(B)));
});

test("sortProposals orders by expiry, by bond without overflowing, and shuffles without losing items", () => {
    const big = ethers.utils.parseEther("1000000"); // > 2^53, used to throw in toNumber()
    const items = [
        { proposalExpirationTimestamp: BigNumber.from(30), bond: BigNumber.from(1) },
        { proposalExpirationTimestamp: BigNumber.from(10), bond: big },
        { proposalExpirationTimestamp: BigNumber.from(20), bond: BigNumber.from(5) },
    ];
    assert.deepEqual(sortProposals(items, "time").map((p) => p.proposalExpirationTimestamp.toNumber()), [10, 20, 30]);
    assert.ok(sortProposals(items, "bond")[0].bond.eq(big));
    assert.equal(sortProposals(items, "random").length, 3);
    assert.deepEqual(sortProposals(items, "age"), items);
});

test("fitToBalance funds the most urgent disputes first", () => {
    const item = (expiry: number, bond: number) => ({ proposal: { proposalExpirationTimestamp: BigNumber.from(expiry) } as Proposal, totalBond: BigNumber.from(bond) }) as ReadyItem;
    const { funded, unfunded } = fitToBalance([item(300, 50), item(100, 50), item(200, 50)], BigNumber.from(120));
    assert.deepEqual(funded.map((i) => i.proposal.proposalExpirationTimestamp.toNumber()), [100, 200]);
    assert.deepEqual(unfunded.map((i) => i.proposal.proposalExpirationTimestamp.toNumber()), [300]);
});

test("mapWithConcurrency keeps order and caps in-flight calls", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, n));
        inFlight--;
        return n * 10;
    });
    assert.deepEqual(results, [50, 10, 30, 20, 40]);
    assert.equal(peak, 2);
});

test("withRetry retries transient failures and rethrows after the last attempt", async () => {
    let calls = 0;
    assert.equal(await withRetry(async () => (++calls < 3 ? Promise.reject(new Error("rate limited")) : "ok"), 3, 1), "ok");
    await assert.rejects(withRetry(async () => Promise.reject(new Error("down")), 1, 1), /down/);
});

test("chunk and formatExpiryTime", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.equal(formatExpiryTime(-5), "EXPIRED");
    assert.equal(formatExpiryTime(3661), "1 hour(s), 1 minute(s), 1 second(s)");
});
