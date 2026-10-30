import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, ethers } from "ethers";
import { questionId } from "./polymarket";
import { Proposal } from "./proposals";
import { bondTotals, matchQuestionIds, parseQuestionIds, withinCaps } from "./question-ids";

const hex = (text: string) => ethers.utils.hexlify(ethers.utils.toUtf8Bytes(text));
const proposal = (title: string, bond: number, timestamp = 1): Proposal =>
    ({
        ancillaryData: hex(`q: title: ${title}`),
        timestamp: BigNumber.from(timestamp),
        bond: BigNumber.from(bond).mul(1_000_000),
        bondCurrencySymbol: "USDC",
        bondCurrencyDecimals: 6,
        oracleKind: "oov2",
    }) as unknown as Proposal;

const a = proposal("A", 750);
const b = proposal("B", 2750);
const c = proposal("C", 750);
const idA = questionId(a.ancillaryData);
const idB = questionId(b.ancillaryData);

test("question ids parse from text, JSON arrays and selection files", () => {
    assert.deepEqual(parseQuestionIds(`# to dispute\n${idA}\n${idB.toUpperCase().replace("0X", "0x")}, ${idA}\n`), [idA, idB]);
    assert.deepEqual(parseQuestionIds(JSON.stringify([idA, idB])), [idA, idB]);
    assert.deepEqual(parseQuestionIds(JSON.stringify({ name: "x", include: { question_ids: [idB] } })), [idB]);
    assert.throws(() => parseQuestionIds("0x1234"), /Not question ids/);
});

test("matching keeps proposal order, lists missing ids and repeated requests", () => {
    const again = proposal("A", 750, 2); // the same question asked again
    const missing = "0x" + "11".repeat(32);
    const result = matchQuestionIds([b, a, c, again], [idA, idB, missing]);
    assert.deepEqual(result.matched, [b, a, again]);
    assert.deepEqual(result.missing, [missing]);
    assert.deepEqual(result.repeated, [idA]);
});

test("caps limit count and total bond; totals are per token", () => {
    assert.equal(withinCaps([a, b, c], 2, Infinity).length, 2);
    assert.deepEqual(withinCaps([a, b, c], Infinity, 3000), [a]);
    assert.equal(bondTotals([a, b, c]), "4,250.0 USDC");
});
