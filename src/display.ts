import { ethers } from "ethers";
import { tryHexToUtf8String } from "./contracts";
import { fetchWalletTokenBalance, Proposal } from "./proposals";
import { Config } from "./config";

function formatExpiryTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const remainingMinutes = minutes % 60; // Calculate remaining minutes
  const remainingSeconds = seconds % 60; // Calculate remaining seconds

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

export async function displayProposalInfo(proposal: Proposal, config: Config) {
  const currentBlockNumber = await config.provider.getBlockNumber();
  const block = await config.provider.getBlock(currentBlockNumber);
  const currentTimestamp = block.timestamp;

  const ancillaryData = decodeProposalData(proposal.ancillaryData);
  const rawAnswer = proposal.proposedPrice;
  const answer = ethers.utils.formatEther(rawAnswer);
  const bondValue = ethers.utils.formatUnits(proposal.bond, proposal.bondCurrencyDecimals);
  const expiryTime = formatExpiryTime(proposal.proposalExpirationTimestamp.sub(currentTimestamp).toNumber());

  const walletBalance = await fetchWalletTokenBalance(config, proposal.bondCurrency);
  const walletBalanceFormatted = ethers.utils.formatUnits(walletBalance.balance, walletBalance.decimals);

  console.log(`
--------------------------------------------------------------------------------
\x1b[1mPROPOSAL DETAILS\x1b[0m

📊 Ancillary Data: ${colorize(ancillaryData, "darkGrey")}

📋 Answer: ${colorize(answer, "darkBlue")}

💰 Bond Value: ${colorize(bondValue + " " + proposal.bondCurrencySymbol, "darkBlue")} - Available: ${colorize(walletBalanceFormatted + " " + proposal.bondCurrencySymbol, "darkGrey")}

⏳ Time to Expiry: ${colorize(expiryTime, "orange")}
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