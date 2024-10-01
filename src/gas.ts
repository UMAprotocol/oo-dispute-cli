import { BigNumber, ethers } from "ethers";

export async function getGasFeeOverride(multiplier: string, provider: ethers.providers.Provider) {
    const feeData = await provider.getFeeData();
    const customPriorityFee = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(BigNumber.from(multiplier)) : BigNumber.from(0);
    return {
        maxPriorityFeePerGas: feeData.lastBaseFeePerGas ? feeData.lastBaseFeePerGas.add(customPriorityFee) : BigNumber.from(0),
    };
}