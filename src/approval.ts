import { ethers } from "ethers";
import { Config } from "./config";
import { getERC20ContractInstance } from "./contracts";
import * as readline from 'readline';
import { isYesAnswer } from "./display";

export async function handleApproval(config: Config, currency: string, spender: string, bond: ethers.BigNumberish): Promise<boolean> {
    const erc20Contract = await getERC20ContractInstance(config.provider, currency);

    const balance = await erc20Contract.balanceOf(config.wallet.address);

    if (balance.lt(bond)) {
        console.log(`You don't have enough ${currency} to dispute this proposal. Please top up your balance.`);
        // return false; TODO uncomment
    }

    const allowance = await erc20Contract.allowance(config.wallet.address, spender);

    if (allowance.gt(ethers.constants.MaxUint256.div(2))) {
        return true;
    }

    return new Promise<boolean>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(`You haven't approved ${currency} for ${spender}. Approve max? (y/n)`, async (answer) => {
            if (isYesAnswer(answer)) {
                const tx = await erc20Contract.connect(config.wallet).approve(spender, ethers.constants.MaxUint256);
                await tx.wait();
                console.log(`Approved ${currency} for ${spender}`);
                resolve(true);
            } else {
                console.log(`You must approve ${currency} to dispute proposals. Exiting...`);
                resolve(false);
            }
            rl.close();
        });
    });
}