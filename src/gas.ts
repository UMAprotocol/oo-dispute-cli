import { BigNumber, ethers } from "ethers";
import { Config } from "./config";

export type FeeOverride = { maxFeePerGas: BigNumber; maxPriorityFeePerGas: BigNumber } | { gasPrice: BigNumber };

// Multiplies by a decimal factor (e.g. 1.5) with 2-decimal precision.
export function scale(value: BigNumber, multiplier: number): BigNumber {
    return value.mul(Math.round(multiplier * 100)).div(100);
}

// Tip = max(node suggestion, chain floor) * multiplier; max fee leaves room for the base fee to double.
export function computeFees(baseFee: BigNumber, suggestedTip: BigNumber | undefined, minTipGwei: number, multiplier: number) {
    const floor = ethers.utils.parseUnits(String(minTipGwei), "gwei");
    const tip = scale(suggestedTip && suggestedTip.gt(floor) ? suggestedTip : floor, multiplier);
    return { maxFeePerGas: baseFee.mul(2).add(tip), maxPriorityFeePerGas: tip };
}

export async function getGasFeeOverride(config: Config): Promise<FeeOverride> {
    const provider = config.provider as ethers.providers.JsonRpcProvider;
    const block = await provider.getBlock("latest");
    if (!block.baseFeePerGas) {
        return { gasPrice: scale(await provider.getGasPrice(), config.multiplier) };
    }

    let suggestedTip: BigNumber | undefined;
    try {
        suggestedTip = BigNumber.from(await provider.send("eth_maxPriorityFeePerGas", []));
    } catch {
        // Not every node exposes it; the chain floor still applies.
    }
    return computeFees(block.baseFeePerGas, suggestedTip, config.minPriorityFeeGwei, config.multiplier);
}
