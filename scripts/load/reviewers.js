// Scripted reviewers for the fork load test: no LLM, zero tokens. Each reviewer runs its own oo-dispute MCP server
// (exactly as Claude Code or Codex would) and loops next_batch -> "think" -> submit_review, taking verdicts from the
// load test's answer key. They exercise claims, leases, re-checks and the shared queue under load.
//
//   node scripts/load/reviewers.js <dir>
//
// Env: REVIEWERS (10), SCOPE (midterms-2026), SELECT (selections/midterms-2026.resolved.json), THINK_MS ("2000-8000",
// simulated time per group), UNCLEAR_RATE (0.15, first looks that answer unclear), MAX_PROPOSALS (10).
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "../..");
const { Client } = require(path.join(REPO, "node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js"));
const { StdioClientTransport } = require(path.join(REPO, "node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js"));

const dir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: reviewers.js <dir>");
const REVIEWERS = Number(process.env.REVIEWERS || 10);
const SCOPE = process.env.SCOPE || "midterms-2026";
const SELECT = path.resolve(REPO, process.env.SELECT || "selections/midterms-2026.resolved.json");
const [THINK_MIN, THINK_MAX] = (process.env.THINK_MS || "2000-8000").split("-").map(Number);
const UNCLEAR_RATE = Number(process.env.UNCLEAR_RATE || 0.15);
const MAX_PROPOSALS = Number(process.env.MAX_PROPOSALS || 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const answersFile = path.join(dir, "answers.json");
// The generator rewrites the answer key while reviewers read it; keep the last complete copy on a partial read.
let lastAnswers = { done: false, items: [] };
const readAnswers = () => {
    try {
        if (fs.existsSync(answersFile)) lastAnswers = JSON.parse(fs.readFileSync(answersFile, "utf8"));
    } catch {
        // Mid-write: use the previous copy.
    }
    return lastAnswers;
};

async function connect(name) {
    const client = new Client({ name, version: "1" });
    const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(REPO, "dist/mcp-entry.js"), "--oracle", "oov2", "--only-polymarket", "--no-market-data", "--select", SELECT],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, OO_DISPUTE_ENV_FILE: path.join(dir, "mcp.env") },
        cwd: REPO,
        stderr: "ignore",
    });
    await client.connect(transport);
    return {
        client,
        async call(tool, args = {}) {
            const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
            const text = result.content[0].text;
            if (result.isError) throw new Error(text);
            return JSON.parse(text);
        },
    };
}

const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

async function reviewer(index, stopAt) {
    const agent = `load-${index + 1}`;
    const { client, call } = await connect(agent);
    const stats = { agent, batches: 0, empty_batches: 0, groups: 0, verdicts: { p1: 0, p2: 0, unclear: 0 }, unknown_markets: 0, errors: {}, next_batch_ms: [], submit_ms: [] };
    const firstLooks = new Set();
    // When the generator finished, as first seen here: stopping also needs a queue scan after it, or the last wave of
    // proposals is never reviewed.
    let doneSeenAt;
    try {
        while (now() < stopAt.value) {
            const answers = readAnswers();
            if (answers.done && doneSeenAt === undefined) doneSeenAt = now();
            const key = new Map(answers.items.map((it) => [it.market_id, it]));
            let t = Date.now();
            const batch = await call("next_batch", { agent, max_proposals: MAX_PROPOSALS, max_groups: 3, scope: SCOPE });
            stats.next_batch_ms.push(Date.now() - t);
            stats.batches++;
            if (!batch.groups.length) {
                stats.empty_batches++;
                const q = batch.queue;
                const scannedSinceDone = answers.done && now() - q.last_scan_seconds_ago > doneSeenAt;
                if (scannedSinceDone && q.by_status.pending === 0 && q.by_status.recheck === 0 && q.by_status.needs_confirmation === 0) break;
                await sleep(5000);
                continue;
            }
            for (const group of batch.groups) {
                await sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
                const verdicts = group.proposals
                    .filter((p) => p.needs_review)
                    .map((p) => {
                        const answer = key.get(p.market_id);
                        if (!answer) {
                            stats.unknown_markets++;
                            return { proposal_id: p.proposal_id, verdict: "unclear", confidence: 0.3, seen_proposed_price: p.proposed.price, reasoning: "not in answer key" };
                        }
                        if (!firstLooks.has(p.proposal_id) && p.previous_reviews.length === 0 && Math.random() < UNCLEAR_RATE) {
                            firstLooks.add(p.proposal_id);
                            return { proposal_id: p.proposal_id, verdict: "unclear", confidence: 0.4, seen_proposed_price: p.proposed.price, reasoning: "simulated: not yet determinable" };
                        }
                        return { proposal_id: p.proposal_id, verdict: answer.truth, confidence: 0.95, seen_proposed_price: p.proposed.price, reasoning: "answer key" };
                    });
                if (!verdicts.length) continue;
                t = Date.now();
                try {
                    await call("submit_review", { agent, group_key: group.group_key, summary: "scripted load-test review", evidence: [], verdicts });
                    stats.submit_ms.push(Date.now() - t);
                    stats.groups++;
                    for (const v of verdicts) stats.verdicts[v.verdict] = (stats.verdicts[v.verdict] ?? 0) + 1;
                } catch (error) {
                    const kind = /claimed by/.test(error.message) ? "claimed_by_other" : /expired/.test(error.message) ? "expired" : /does not match/.test(error.message) ? "stale_price" : /no longer open/.test(error.message) ? "already_disputed" : "other";
                    stats.errors[kind] = (stats.errors[kind] ?? 0) + 1;
                    if (kind === "other") console.error(`[${agent}] submit error: ${error.message.slice(0, 200)}`);
                }
            }
        }
        await call("release_claim", { agent }).catch(() => undefined);
    } finally {
        await client.close().catch(() => undefined);
    }
    return stats;
}

async function monitor(stopAt, done) {
    const { call, client } = await connect("load-monitor");
    const log = fs.createWriteStream(path.join(dir, "progress.jsonl"), { flags: "a" });
    try {
        while (!done.value && now() < stopAt.value) {
            const p = await call("progress", { scope: SCOPE }).catch((e) => ({ error: e.message }));
            const answers = readAnswers();
            log.write(JSON.stringify({ t: now(), generated: answers.items.length, ...p }) + "\n");
            if (!p.error) {
                console.log(
                    `[monitor] generated ${answers.items.length}${answers.done ? " (done)" : ""} | open ${p.open_proposals} | pending ${p.by_status.pending} recheck ${p.by_status.recheck} agree ${p.by_status.agree} dispute ${p.by_status.dispute} | not sent ${p.dispute_candidates_not_sent} | sent ${JSON.stringify(p.disputes)} | claims ${p.active_claims} | <15m unresolved ${p.unresolved_expiring.under_15_min} | scan ${p.last_scan_seconds_ago}s ago`
                );
                // Stop once everything generated has expired: nothing left to review.
                const items = answers.items;
                if (answers.done && items.length && now() > Math.max(...items.map((i) => i.expires_at)) + 30) stopAt.value = now();
            }
            await sleep(15000);
        }
    } finally {
        log.end();
        await client.close().catch(() => undefined);
    }
}

(async () => {
    const stopAt = { value: now() + 3 * 3600 };
    const done = { value: false };
    const started = Date.now();
    console.log(`Starting ${REVIEWERS} scripted reviewers on scope ${SCOPE} (think ${THINK_MIN}-${THINK_MAX} ms, unclear ${UNCLEAR_RATE * 100}%).`);
    const monitoring = monitor(stopAt, done);
    const results = await Promise.all(Array.from({ length: REVIEWERS }, (_, i) => reviewer(i, stopAt)));
    done.value = true;
    await monitoring;
    const all = (k) => results.flatMap((r) => r[k]);
    const summary = {
        reviewers: REVIEWERS,
        minutes: Math.round((Date.now() - started) / 6000) / 10,
        groups_submitted: results.reduce((a, r) => a + r.groups, 0),
        verdicts: results.reduce((a, r) => ({ p1: a.p1 + r.verdicts.p1, p2: a.p2 + r.verdicts.p2, unclear: a.unclear + r.verdicts.unclear }), { p1: 0, p2: 0, unclear: 0 }),
        unknown_markets: results.reduce((a, r) => a + r.unknown_markets, 0),
        errors: results.reduce((a, r) => {
            for (const [k, v] of Object.entries(r.errors)) a[k] = (a[k] ?? 0) + v;
            return a;
        }, {}),
        next_batch_ms: { p50: percentile(all("next_batch_ms"), 0.5), p90: percentile(all("next_batch_ms"), 0.9), max: percentile(all("next_batch_ms"), 1) },
        submit_ms: { p50: percentile(all("submit_ms"), 0.5), p90: percentile(all("submit_ms"), 0.9), max: percentile(all("submit_ms"), 1) },
        per_reviewer_groups: results.map((r) => r.groups),
    };
    fs.writeFileSync(path.join(dir, "reviewers.json"), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary, null, 1));
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
