import { ethers } from "ethers";
import { getERC20ContractInstance, tryHexToUtf8String } from "./contracts";
import { disputableAfterLiveness, Proposal } from "./proposals";

import { Config } from "./config";

export function formatExpiryTime(seconds: number): string {
  if (seconds <= 0) return "EXPIRED";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;

  return `${days > 0 ? `${days} day(s), ` : ''}${hours > 0 ? `${hours % 24} hour(s), ` : ''}${remainingMinutes > 0 ? `${remainingMinutes} minute(s), ` : ''}${remainingSeconds} second(s)`.trim(); // Show all components
}

function getColorCode(color: string): string {
  const colors: { [key: string]: string } = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    orange: "\x1b[38;5;208m",
    darkBlue: "\x1b[34m",
    darkGrey: "\x1b[90m",
    reset: "\x1b[0m"
  };
  return colors[color] || colors.reset; // Default to reset if color not found
}

export async function displayProposalInfo(proposal: Proposal, config: Config, currentTimestamp: number, queued: number) {
  const ancillaryData = decodeProposalData(proposal.ancillaryData);
  const answer = ethers.utils.formatEther(proposal.proposedPrice);
  const bondValue = ethers.utils.formatUnits(proposal.bond, proposal.bondCurrencyDecimals);
  const secondsLeft = proposal.proposalExpirationTimestamp.sub(currentTimestamp).toNumber();
  const expiryTime = secondsLeft <= 0 && disputableAfterLiveness(proposal.oracleKind) ? "liveness ended, still disputable until the resolver settles" : formatExpiryTime(secondsLeft);

  const balance = await getERC20ContractInstance(config.provider, proposal.bondCurrency).balanceOf(config.wallet.address);
  const walletBalanceFormatted = ethers.utils.formatUnits(balance, proposal.bondCurrencyDecimals);

  console.log(`
--------------------------------------------------------------------------------
\x1b[1mPROPOSAL DETAILS\x1b[0m

📊 Ancillary Data: ${colorize(ancillaryData, "darkGrey")}

📋 Answer: ${colorize(answer, "darkBlue")}

🙋 Proposer: ${colorize(proposal.proposer, "darkGrey")} - Oracle: ${colorize(`${proposal.oracleKind} ${proposal.ooAddress}`, "darkGrey")}

💰 Bond Value: ${colorize(bondValue + " " + proposal.bondCurrencySymbol, "darkBlue")} - Available: ${colorize(walletBalanceFormatted + " " + proposal.bondCurrencySymbol, "darkGrey")}

⏳ Time to Expiry: ${colorize(expiryTime, "orange")}

📥 Queued disputes: ${queued}
--------------------------------------------------------------------------------`);

}

function colorize(text: string, color: string): string {
  return `${getColorCode(color)}${text}${getColorCode("reset")}`;
}

function decodeProposalData(data: string) {
  return tryHexToUtf8String(data);
}

export function isYesAnswer(answer: string) {
  return answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';
}
