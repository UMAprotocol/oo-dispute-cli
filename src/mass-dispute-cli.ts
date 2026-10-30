// Settings and the key can come from a .env in the working directory (variables already set win). Only the CLI loads
// it on purpose; the MCP review server never takes PRIVATE_KEY (see mcp-entry).
import 'dotenv/config';
import { Command } from 'commander';
import { handleCLI } from './handler';

const program = new Command();

program
    .command('dispute')
    .description('Review open proposals one by one in the terminal and dispute the wrong ones')
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
    .option('--question-ids <file>', 'Dispute these UMA question ids directly, no per-proposal prompt (JSON array, selection file, or one id per line)')
    .option('-y, --yes', 'With --question-ids: send without asking (requires --max-disputes and --max-bond)', false)
    .option('--max-disputes <n>', 'With --question-ids: maximum disputes to send in this run')
    .option('--max-bond <amount>', 'With --question-ids: maximum total bond to post in this run, in bond token units')
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
    .option('--scope <name-or-file>', 'Only send disputes for proposals in this scope (a name defined in the review, or a selection JSON file)')
    // Loaded on demand: the review queue needs node:sqlite (Node 22.13+), and `dispute` must keep working on older Node.
    .action(async (options) => (await import('./apply')).handleApply({ ...options, sortRemainingTime: true, sortBondSize: false, sortRandom: false, sortAge: false, managedOo: false, flushBefore: '10' }));

program
    .command('select')
    .description('Prepare market selections (scopes) for the agent review')
    .command('resolve <file>')
    .description('Resolve slugs, event slugs and tags in a selection JSON to ids through Polymarket Gamma, so it works offline later')
    .option('-o, --out <file>', 'Output file (default <file>.resolved.json)')
    .action(async (file, options) => (await import('./review/select-cli')).resolveSelectionFile(file, options.out));

program.parse(process.argv);
