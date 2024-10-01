import { Config } from "./config";
import { RequestState } from "./constants";
import { getOOV2ContractInstance } from "./contracts";
import { getGasFeeOverride } from "./gas";
import { Proposal } from "./proposals";

export async function disputeProposal(proposal: Proposal, config: Config) {
    const oov2 = await getOOV2ContractInstance(config.provider);

    const state = await oov2.getState(proposal.requester, proposal.identifier, proposal.timestamp, proposal.ancillaryData);
    if (state === RequestState.Disputed) {
        return console.log("✅ Proposal already disputed. Continuing...");
    }
    if (state !== RequestState.Proposed) {
        return console.log(`❌ Proposal cannot be disputed in current state: ${RequestState[state]}. Continuing...`);
    }
    console.log(`🔄 Disputing proposal...`);
    const gasFeeOverride = await getGasFeeOverride(config.multiplier, config.provider);
    const tx = await oov2.connect(config.wallet).disputePrice(proposal.requester, proposal.identifier, proposal.timestamp, proposal.ancillaryData, gasFeeOverride);
    await tx.wait();
    console.log(`✅ Disputed proposal in transaction ${tx.hash}`);
}