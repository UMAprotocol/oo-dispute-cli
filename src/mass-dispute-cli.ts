import { Command } from 'commander';
import * as readline from 'readline';
import { handleApproval } from './approval';
import { initConfig } from './config';
import { displayProposalInfo, isYesAnswer } from './display';
import { handleErrors } from './errors';
import { fetchProposals } from './proposals';
import { disputeProposal } from './transaction';
import { DISPUTE_CONFIRMATION_PROMPT } from './constants';

const program = new Command();

program
    .command('dispute')
    .description('Dispute a proposal')
    .action(async (options) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });


        const config = await initConfig(process.env);

        const proposals = await fetchProposals(config);

        for (const proposal of proposals) {

            const balanceApproved = await handleApproval(config, proposal.bondCurrency, proposal.ooAddress, proposal.bond);

            if (!balanceApproved) {
                break;
            }

            await displayProposalInfo(proposal, config);

            const confirmDispute = await new Promise((resolve) => {
                rl.question(DISPUTE_CONFIRMATION_PROMPT, (answer) => {
                    resolve(isYesAnswer(answer));
                });
            });

            if (confirmDispute) {
                try {
                    await disputeProposal(proposal, config);
                    console.log('🏁 Dispute completed, moving to next proposal...');
                } catch (error) {
                    handleErrors(error);
                }
            } else {
                console.log('❌ Skipping dispute for this proposal.');
            }
        }

        console.log('🔚 No more proposals to dispute!');

        rl.close();
    });

program.parse(process.argv);