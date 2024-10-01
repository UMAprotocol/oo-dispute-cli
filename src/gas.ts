import { BigNumber, ethers } from "ethers";

export async function getGasFeeOverride(multiplier: number, provider: ethers.providers.Provider) {
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ? feeData.maxFeePerGas : BigNumber.from(0);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(BigNumber.from(multiplier)) : BigNumber.from(0);
    return {
        maxFeePerGas: maxFeePerGas.add(maxPriorityFeePerGas),
        maxPriorityFeePerGas: maxPriorityFeePerGas,
    };
}