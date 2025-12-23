import * as readline from 'readline';
import { handleApproval } from './approval';
import { initConfig } from './config';
import { DISPUTE_CONFIRMATION_PROMPT } from './constants';
import { displayProposalInfo, isYesAnswer } from './display';
import { fetchProposals } from './proposals';
import { disputeProposal } from './transaction';

export interface Options {
    multiplier: number;
    onlyPolymarket: boolean;
    sortRemainingTime: boolean;
    sortBondSize: boolean;
    sortRandom: boolean;
    managedOO: boolean;
}

export async function handleCLI(options: Options) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    let config;
    try {
        config = await initConfig(process.env, options);
    } catch (error) {
        console.error(`🚨 Error initializing config: ${error}`);
        rl.close();
        return;
    }

    const proposals = await fetchProposals(config);

    for (const proposal of proposals) {

        const balanceApproved = await handleApproval(config, proposal.bondCurrency, proposal.bondCurrencySymbol, proposal.ooAddress, proposal.bond);

        await displayProposalInfo(proposal, config);

        let confirmDispute;

        if (!balanceApproved) {
            console.log("🚫 You don't have approved or enough balance, skipping.");
            confirmDispute = await new Promise((resolve) => {
                rl.question('Press Enter to skip...', () => {
                    resolve(false);
                });
            });
        } else {
            confirmDispute = await new Promise((resolve) => {
                rl.question(DISPUTE_CONFIRMATION_PROMPT, (answer) => {
                    resolve(isYesAnswer(answer));
                });
            });
        }

        if (confirmDispute) {
            try {
                await disputeProposal(proposal, config);
                console.log('🏁 Dispute completed, moving to next proposal...');
            } catch (error) {
                console.error(`🚨 Error disputing proposal: ${error}`);
            }
        } else {
            console.log('❌ Skipping dispute for this proposal.');
        }
    }

    console.log('🔚 No more proposals to dispute!');

    rl.close();
}