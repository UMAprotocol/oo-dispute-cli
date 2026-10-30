import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { conditionId, questionId } from "./polymarket";
import { PolymarketIdResolver } from "./polymarket-ids";

const ADAPTER = "0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d";
const OPERATOR = "0x71523d0f655B41E805Cec45b17163f528B59B820";
const NR_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const NEG_RISK_ID = "0x07311e10dac665c35744c1174ff683c68ab1db694733aa68146364adea49a300";
const ANCILLARY = ethers.utils.hexlify(ethers.utils.toUtf8Bytes("q: title: Will the Democrats win the Alabama governor race in 2026?"));
const coder = ethers.utils.defaultAbiCoder;
const selector = (signature: string) => ethers.utils.id(signature).slice(0, 10);

// Answers eth_call like a neg-risk adapter + operator; `fail` makes the next N calls fail like an unreachable RPC.
class FakeProvider extends ethers.providers.StaticJsonRpcProvider {
    calls = 0;
    fail = 0;
    constructor(private negRisk = true) {
        super("http://127.0.0.1:1", { chainId: 137, name: "matic" });
    }
    async perform(method: string, params: { transaction: { to: string; data: string } }): Promise<unknown> {
        if (method !== "call") throw new Error(`unexpected ${method}`);
        this.calls++;
        if (this.fail > 0) {
            this.fail--;
            throw Object.assign(new Error("connection refused"), { code: "SERVER_ERROR" });
        }
        const { to, data } = params.transaction;
        if (to.toLowerCase() === ADAPTER.toLowerCase() && data === selector("ctf()")) return this.negRisk ? coder.encode(["address"], [OPERATOR]) : "0x";
        if (to.toLowerCase() === OPERATOR.toLowerCase() && data === selector("nrAdapter()")) return coder.encode(["address"], [NR_ADAPTER]);
        if (to.toLowerCase() === OPERATOR.toLowerCase() && data.startsWith(selector("questionIds(bytes32)"))) return coder.encode(["bytes32"], [NEG_RISK_ID]);
        return "0x";
    }
}

test("neg-risk requests resolve to Polymarket's question and condition ids", async () => {
    const ids = await new PolymarketIdResolver(new FakeProvider()).resolve(ADAPTER, ANCILLARY);
    assert.equal(ids.neg_risk, true);
    assert.equal(ids.uma_question_id, questionId(ANCILLARY));
    assert.equal(ids.polymarket_question_id, NEG_RISK_ID);
    assert.equal(ids.condition_id, conditionId(NR_ADAPTER, NEG_RISK_ID));
});

test("a requester that reverts is a plain request, and that answer is cached", async () => {
    const provider = new FakeProvider(false);
    const resolver = new PolymarketIdResolver(provider);
    const ids = await resolver.resolve(ADAPTER, ANCILLARY);
    assert.equal(ids.neg_risk, false);
    assert.equal(ids.polymarket_question_id, questionId(ANCILLARY));
    const calls = provider.calls;
    await resolver.resolve(ADAPTER, ethers.utils.hexlify(ethers.utils.toUtf8Bytes("q: title: another market")));
    assert.equal(provider.calls, calls, "no new route lookup for the same requester");
});

test("an RPC failure is not cached as 'not neg-risk': the next lookup retries", async () => {
    const provider = new FakeProvider();
    const resolver = new PolymarketIdResolver(provider);
    provider.fail = 3; // the first ctf() call and its two retries
    await assert.rejects(resolver.resolve(ADAPTER, ANCILLARY), /connection refused/);
    const ids = await resolver.resolve(ADAPTER, ANCILLARY);
    assert.equal(ids.neg_risk, true, "resolved correctly once the RPC is back");
    assert.equal(ids.polymarket_question_id, NEG_RISK_ID);
});
