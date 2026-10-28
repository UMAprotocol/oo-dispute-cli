import * as readline from 'readline';
import { initConfig } from './config';
import { DISPUTE_CONFIRMATION_PROMPT } from './constants';
import { withRetry } from './concurrency';
import { describeProposal, DisputeEngine, DisputeOutcome, DisputeStatus } from './dispute';
import { displayProposalInfo, isYesAnswer } from './display';
import { fetchProposals, Proposal } from './proposals';

export interface Options {
    multiplier: string;
    onlyPolymarket: boolean;
    sortRemainingTime: boolean;
    sortBondSize: boolean;
    sortRandom: boolean;
    sortAge: boolean;
    managedOo: boolean;
    oracle: string;
    batch: boolean;
    batchSize?: string;
    flushBefore?: string;
    dryRun: boolean;
}

export async function handleCLI(options: Options) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    const ask = (question: string) => new Promise<string>((resolve) => rl.question(question, resolve));

    try {
        await run(options, ask);
    } catch (error) {
        console.error(`🚨 ${error}`);
        process.exitCode = 1;
    } finally {
        rl.close();
    }
}

async function run(options: Options, ask: (question: string) => Promise<string>) {
    const config = await initConfig(process.env, options);
    if (config.dryRun) console.log('🧪 DRY RUN: disputes are simulated, nothing is approved or sent.');
    console.log(`👛 Disputer ${config.wallet.address} on chain ${config.chainId}; batch size ${config.batchSize}.`);

    const engine = new DisputeEngine(config, async (question) => isYesAnswer(await ask(question)));
    await engine.init();

    const proposals = await fetchProposals(config);
    console.log(`📋 ${proposals.length} open proposal(s), sorted by ${config.sort}.`);

    // Approved proposals are queued and sent in batches: when the queue is full, when a queued proposal is close to
    // expiry, on [s]end, and at the end of the review.
    const queue: Proposal[] = [];
    const outcomes: DisputeOutcome[] = [];
    const flush = async () => {
        if (queue.length === 0) return;
        const batch = queue.splice(0);
        console.log(`🚀 Sending ${batch.length} queued dispute(s)...`);
        try {
            outcomes.push(...(await engine.dispute(batch)));
        } catch (error) {
            console.error(`🚨 Error disputing queued proposals: ${error}`);
            outcomes.push(...batch.map((proposal) => ({ proposal, status: 'failed' as const, detail: String(error) })));
        }
    };

    for (const proposal of proposals) {
        const now = (await withRetry(() => config.provider.getBlock('latest'))).timestamp;
        if (queue.some((queued) => queued.proposalExpirationTimestamp.lte(now + config.flushBeforeSeconds))) {
            console.log('⏰ A queued proposal expires soon; sending the queue now.');
            await flush();
        }
        if (proposal.proposalExpirationTimestamp.lte(now)) {
            console.log(`⌛ Skipping expired proposal ${describeProposal(proposal)}`);
            continue;
        }

        await displayProposalInfo(proposal, config, now, queue.length);

        const answer = (await ask(DISPUTE_CONFIRMATION_PROMPT)).trim().toLowerCase();
        if (answer === 'q' || answer === 'quit') break;
        if (isYesAnswer(answer) || answer === 's' || answer === 'send') {
            queue.push(proposal);
            if (answer.startsWith('s') || queue.length >= config.batchSize) await flush();
        } else {
            console.log('❌ Skipping dispute for this proposal.');
        }
    }

    await flush();
    printSummary(outcomes);
}

function printSummary(outcomes: DisputeOutcome[]) {
    const counts = new Map<DisputeStatus, number>();
    for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
    console.log(`\n🔚 Done. ${[...counts].map(([status, count]) => `${status}: ${count}`).join(', ') || 'nothing disputed'}`);

    const failed = outcomes.filter((outcome) => outcome.status === 'failed');
    if (failed.length > 0) {
        console.log('🚨 Failed (re-run to retry):');
        for (const outcome of failed) console.log(`   ${describeProposal(outcome.proposal)} — ${outcome.detail}`);
    }
}
