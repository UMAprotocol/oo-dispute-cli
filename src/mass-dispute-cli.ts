import { Command } from 'commander';
import { handleCLI } from './handler';

const program = new Command();

program
    .command('dispute')
    .description('Dispute a proposal')
    .option('-m, --multiplier <number>', 'Gas fee multiplier', '4')
    .option('-t, --sort-remaining-time', 'Sort disputes by remaining time to dispute (ascending)', false)
    .option('-b, --sort-bond-size', 'Sort disputes by bond size (descending)', false)
    .option('-r, --sort-random', 'Sort disputes randomly', false)
    .option('-p, --only-polymarket', 'Only dispute proposals from Polymarket', false)
    .action(handleCLI);

program.parse(process.argv);