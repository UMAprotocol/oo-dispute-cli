import { Command } from 'commander';
import { handleCLI } from './handler';

const program = new Command();

program
    .command('dispute')
    .description('Dispute a proposal')
    .option('-m, --multiplier <number>', 'Gas fee multiplier applied to the priority fee', '4')
    .option('-t, --sort-remaining-time', 'Sort disputes by remaining time to dispute (ascending). This is the default', false)
    .option('-b, --sort-bond-size', 'Sort disputes by bond size (descending)', false)
    .option('-r, --sort-random', 'Sort disputes randomly', false)
    .option('-a, --sort-age', 'Keep proposals in event order, per oracle', false)
    .option('-p, --only-polymarket', 'Only dispute proposals from Polymarket', false)
    .option('-o, --oracle <which>', 'Oracles to scan: all, oov2 or managed (managed is Polygon only)', 'all')
    .option('--managed-oo', 'Deprecated: same as --oracle managed', false)
    .option('--no-batch', 'Send one dispute per transaction instead of batching')
    .option('--batch-size <number>', 'Disputes per batch transaction', '20')
    .option('--flush-before <minutes>', 'Send queued disputes when one of them expires within this many minutes', '10')
    .option('-d, --dry-run', 'Simulate disputes without approving or sending anything', false)
    .action(handleCLI);

program
    .command('apply')
    .description('Send the disputes that agent reviews (from the MCP review queue) call for')
    .option('-m, --multiplier <number>', 'Gas fee multiplier applied to the priority fee', '4')
    .option('-o, --oracle <which>', 'Oracles to scan: all, oov2 or managed', 'all')
    .option('-p, --only-polymarket', 'Only Polymarket requesters', false)
    .option('--no-batch', 'Send one dispute per transaction instead of batching')
    .option('--batch-size <number>', 'Disputes per batch transaction', '20')
    .option('-d, --dry-run', 'Simulate disputes without approving or sending anything', false)
    .option('-w, --watch', 'Keep running and send new dispute candidates as reviews come in', false)
    .option('--interval <seconds>', 'Polling interval in watch mode', '20')
    .option('--auto', 'Send without asking, within --max-disputes and --max-bond', false)
    .option('--max-disputes <n>', 'Auto mode: maximum disputes to send in this run')
    .option('--max-bond <amount>', 'Auto mode: maximum total bond to post in this run, in bond token units')
    .option('--db <path>', 'Review database (default .oo-dispute/review-<chain>.sqlite)')
    .option('--min-confidence <n>', 'Confidence a disagreement needs to become a dispute')
    .option('--confirmations <n>', 'Independent reviewers that must agree before disputing')
    // Loaded on demand: the review queue needs node:sqlite (Node 22.13+), and `dispute` must keep working on older Node.
    .action(async (options) => (await import('./apply')).handleApply({ ...options, sortRemainingTime: true, sortBondSize: false, sortRandom: false, sortAge: false, managedOo: false, flushBefore: '10' }));

program.parse(process.argv);
