import * as readline from "readline";
import { BigNumber, ethers } from "ethers";
import { initConfig } from "./config";
import { delay } from "./concurrency";
import { DisputeEngine, DisputeStatus } from "./dispute";
import { isYesAnswer } from "./display";
import { Options } from "./handler";
import { describePrice, verdictPrice } from "./polymarket";
import { openReview, ReviewFlags } from "./review/setup";
import { now } from "./review/store";

export interface ApplyOptions extends Options, ReviewFlags {
    watch: boolean;
    interval: string;
    auto: boolean;
    maxDisputes?: string;
    maxBond?: string;
}

const STORED_STATUS: Partial<Record<DisputeStatus, "disputed" | "already-disputed" | "failed" | "skipped">> = {
    disputed: "disputed",
    "already-disputed": "already-disputed",
    failed: "failed",
    skipped: "skipped",
};

// Sends the disputes that reviews call for. This is the only step that holds the key; the MCP review tools never do.
export async function handleApply(options: ApplyOptions) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (question: string) => new Promise<string>((resolve) => rl.question(question, resolve));
    try {
        await runApply(options, ask);
    } catch (error) {
        console.error(`🚨 ${error}`);
        process.exitCode = 1;
    } finally {
        rl.close();
    }
}

async function runApply(options: ApplyOptions, ask: (question: string) => Promise<string>) {
    const config = await initConfig(process.env, options);
    const { store, queue, policy } = openReview(config, options);
    const owner = `apply-${process.pid}`;
    if (!store.tryLock("apply", owner, 120)) throw new Error("Another `apply` is already running against this review database.");
    // Release the lock on Ctrl+C so an operator can restart immediately instead of waiting for the lease.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
            store.unlock("apply", owner);
            process.exit(130);
        });
    }

    const engine = new DisputeEngine(config, async (question) => isYesAnswer(await ask(question)));
    await engine.init();

    const intervalMs = Number(options.interval) * 1000;
    const maxDisputes = options.maxDisputes ? Number(options.maxDisputes) : Infinity;
    const maxBond = options.maxBond ? Number(options.maxBond) : Infinity;
    if (options.auto && (!options.maxDisputes || !options.maxBond)) throw new Error("--auto requires --max-disputes and --max-bond");
    let sentCount = 0;
    let sentBond = 0;
    const declined = new Set<string>();

    console.log(`${config.dryRun ? "🧪 DRY RUN. " : ""}👛 ${config.wallet.address}; policy ${JSON.stringify(policy)}; ${options.watch ? `watching every ${options.interval}s, press Ctrl+C to stop` : "single pass"}.`);

    for (;;) {
        store.tryLock("apply", owner, Math.max(120, (intervalMs / 1000) * 3));
        await queue.refresh();
        const candidates = queue.candidates().filter((c) => !declined.has(c.stored.id));

        if (candidates.length > 0) {
            const atTime = now();
            console.log(`\n⚖️  ${candidates.length} dispute(s) ready:`);
            for (const { stored, evaluation } of candidates) {
                const { parsed } = stored.context;
                const verdict = evaluation.verdict as "p1";
                console.log(
                    `   • ${parsed.title ?? stored.id} — proposed ${describePrice(stored.proposal.proposedPrice, parsed)} → reviewed ${describePrice(verdictPrice(verdict, parsed), parsed)} ` +
                        `[${evaluation.confirmingAgents.join(", ")}] expires in ${Math.round((stored.proposal.proposalExpirationTimestamp.toNumber() - atTime) / 60)} min, bond ${ethers.utils.formatUnits(stored.proposal.bond, stored.proposal.bondCurrencyDecimals)} ${stored.proposal.bondCurrencySymbol}`
                );
            }

            const bondOf = (bond: BigNumber, decimals: number) => Number(ethers.utils.formatUnits(bond, decimals));
            let selected = candidates;
            let approved: boolean;
            if (options.auto) {
                selected = [];
                for (const candidate of candidates) {
                    const bond = bondOf(candidate.stored.proposal.bond, candidate.stored.proposal.bondCurrencyDecimals);
                    if (sentCount + selected.length + 1 > maxDisputes || sentBond + bond > maxBond) break;
                    selected.push(candidate);
                    sentBond += bond;
                }
                if (selected.length < candidates.length) console.warn(`⚠️  Auto limits reached; ${candidates.length - selected.length} candidate(s) wait for a manual run.`);
                approved = selected.length > 0;
            } else {
                approved = isYesAnswer((await ask(`👉 Send these ${candidates.length} dispute(s)? (y/n) `)).trim());
                if (!approved) candidates.forEach((c) => declined.add(c.stored.id));
            }

            if (approved && selected.length > 0) {
                if (options.watch) console.log("");
                if (!config.dryRun) selected.forEach((c) => store.setDispute(c.stored.id, "sending"));
                const outcomes = await engine.dispute(selected.map((c) => c.stored.proposal));
                const byProposal = new Map(selected.map((c) => [c.stored.proposal, c.stored.id]));
                for (const outcome of outcomes) {
                    const id = byProposal.get(outcome.proposal)!;
                    const status = STORED_STATUS[outcome.status];
                    if (!status) {
                        store.db.prepare("DELETE FROM disputes WHERE proposal_id = ? AND status = 'sending'").run(id);
                        continue;
                    }
                    store.setDispute(id, status, outcome.txHash, outcome.detail);
                    if (status === "disputed" || status === "already-disputed") store.markDisputed([id]);
                    if (status === "disputed") sentCount++;
                }
            }
        }

        if (!options.watch) break;
        if (candidates.length > 0) console.log(`👀 Still watching for new dispute candidates every ${options.interval}s (Ctrl+C to stop).`);
        const progress = queue.progress();
        process.stdout.write(
            `\r⏳ ${new Date().toLocaleTimeString()} open ${progress.open_proposals}, pending ${progress.by_status.pending}, recheck ${progress.by_status.recheck}, ` +
                `needs confirmation ${progress.by_status.needs_confirmation}, unresolved <30 min ${progress.unresolved_expiring.under_30_min}, disputes ${JSON.stringify(progress.disputes)}   `
        );
        await delay(intervalMs);
    }
    store.unlock("apply", owner);
}
