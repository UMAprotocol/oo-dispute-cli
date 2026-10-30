import { readFileSync, writeFileSync } from 'fs';
import * as readline from 'readline';
import { Config, initConfig } from './config';
import { DISPUTE_CONFIRMATION_PROMPT } from './constants';
import { withRetry } from './concurrency';
import { describeProposal, DisputeEngine, DisputeOutcome, DisputeStatus } from './dispute';
import { displayProposalInfo, isYesAnswer } from './display';
import { parseAncillary } from './polymarket';
import { PolymarketIdResolver } from './polymarket-ids';
import { userPath } from './paths';
import { disputableAfterLiveness, fetchProposals, Proposal } from './proposals';
import { bondTotals, matchQuestionIds, parseQuestionIds, withinCaps } from './question-ids';

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
    questionIds?: string;
    yes?: boolean;
    maxDisputes?: string;
    maxBond?: string;
}

export async function handleCLI(options: Options) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    // Once stdin ends (piped input, a script), every further question is answered with "" (no) instead of throwing.
    let closed = false;
    let pending: ((answer: string) => void) | undefined;
    rl.on('close', () => {
        closed = true;
        pending?.('');
    });
    const ask = (question: string) =>
        new Promise<string>((resolve) => {
            if (closed) return resolve('');
            pending = resolve;
            rl.question(question, (answer) => {
                pending = undefined;
                resolve(answer);
            });
        });

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

    // --yes also answers the bond-token approval prompt.
    const engine = new DisputeEngine(config, async (question) => options.yes || isYesAnswer(await ask(question)));
    await engine.init();

    const proposals = await fetchProposals(config);
    if (options.questionIds) return disputeQuestionIds(options, config, engine, proposals, ask);

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
        if (proposal.proposalExpirationTimestamp.lte(now) && !disputableAfterLiveness(proposal.oracleKind)) {
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

// Disputes a known list of question ids without the review queue: no per-proposal prompt, one confirmation for the
// whole list (or none with --yes, which requires caps). Each proposal is still re-checked on chain before sending.
async function disputeQuestionIds(options: Options, config: Config, engine: DisputeEngine, proposals: Proposal[], ask: (question: string) => Promise<string>) {
    const file = userPath(options.questionIds!);
    const ids = parseQuestionIds(readFileSync(file, 'utf8'));
    // Ids that aren't UMA question ids are looked up as Polymarket ones (neg-risk markets), on chain. A lookup that
    // fails (RPC) leaves that proposal unmatched and is reported, rather than guessed.
    const resolver = new PolymarketIdResolver(config.provider);
    let lookupFailures = 0;
    const { matched, missing, repeated, viaPolymarket } = await matchQuestionIds(proposals, ids, async (proposal) => {
        try {
            const resolved = await resolver.resolve(proposal.requester, proposal.ancillaryData);
            return resolved.neg_risk ? resolved.polymarket_question_id : undefined;
        } catch {
            lookupFailures++;
            return undefined;
        }
    });
    if (lookupFailures > 0) {
        console.warn(`🚨 ${lookupFailures} proposal(s) could not be checked for a Polymarket question id (RPC errors): Polymarket ids may be reported missing. Re-run to retry.`);
    }
    console.log(`🎯 ${ids.length} question id(s) in ${options.questionIds}: ${matched.length} open proposal(s) match${viaPolymarket ? ` (${viaPolymarket} by Polymarket neg-risk question id)` : ''}.`);
    if (missing.length > 0) {
        writeFileSync(`${file}.missing.txt`, missing.join('\n') + '\n');
        console.warn(
            `⚠️  ${missing.length} id(s) have no open proposal in the scanned range (already settled or disputed, not proposed yet, or older than BLOCK_LOOKBACK_PERIOD): listed in ${options.questionIds}.missing.txt`
        );
    }
    if (repeated.length > 0) console.warn(`⚠️  ${repeated.length} id(s) have more than one open request (the same question asked again); all of them are disputed.`);
    if (options.yes && (!options.maxDisputes || !options.maxBond)) throw new Error('--yes requires --max-disputes and --max-bond');

    const selected = withinCaps(matched, options.maxDisputes ? Number(options.maxDisputes) : Infinity, options.maxBond ? Number(options.maxBond) : Infinity);
    if (selected.length < matched.length) console.warn(`⚠️  Caps reached: ${matched.length - selected.length} matching proposal(s) left out of this run.`);
    if (selected.length === 0) {
        console.log('🔚 Nothing to dispute.');
        return;
    }

    const byOracle = new Map<string, number>();
    for (const proposal of selected) byOracle.set(proposal.oracleKind, (byOracle.get(proposal.oracleKind) ?? 0) + 1);
    console.log(`\n⚖️  ${selected.length} dispute(s) (${[...byOracle].map(([kind, count]) => `${kind}: ${count}`).join(', ')}), total bond ${bondTotals(selected)}:`);
    for (const proposal of selected.slice(0, 10)) console.log(`   • ${parseAncillary(proposal.ancillaryData).title ?? describeProposal(proposal)} (${describeProposal(proposal)})`);
    if (selected.length > 10) console.log(`   … and ${selected.length - 10} more`);

    if (!options.yes && !isYesAnswer((await ask(`👉 Dispute these ${selected.length} proposal(s)? (y/n) `)).trim())) {
        console.log('❌ Nothing sent.');
        return;
    }
    printSummary(await engine.dispute(selected));
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
