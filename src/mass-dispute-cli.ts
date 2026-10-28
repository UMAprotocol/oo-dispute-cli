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

program.parse(process.argv);
