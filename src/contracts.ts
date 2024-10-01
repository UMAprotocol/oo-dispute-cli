import { Provider } from "@ethersproject/abstract-provider";
import { ERC20Ethers, getAbi, getAddress, OptimisticOracleV2Ethers } from "@uma/contracts-node";
import { Contract, utils } from "ethers";
import ERC20Abi from "./abi/erc20.json";
import { Config } from "./config";

export const getOOV2ContractInstance = async (provider: Provider): Promise<OptimisticOracleV2Ethers> => {
  const networkId = (await provider.getNetwork()).chainId;
  const contractAddress = (await getAddress("OptimisticOracleV2", networkId));
  const contractAbi = getAbi("OptimisticOracleV2");
  return new Contract(contractAddress, contractAbi, provider) as OptimisticOracleV2Ethers;
};

export const getERC20ContractInstance = (provider: Provider, address: string): ERC20Ethers => {
  return new Contract(address, ERC20Abi, provider) as ERC20Ethers;
};

export async function fetchWalletTokenBalance(config: Config, tokenAddress: string) {
  const tokenContract = getERC20ContractInstance(config.provider, tokenAddress);
  const balance = await tokenContract.balanceOf(config.wallet.address);
  const decimals = await tokenContract.decimals();
  const symbol = await tokenContract.symbol();
  return {
    balance: balance,
    decimals: decimals,
    symbol: symbol
  };
}

export const tryHexToUtf8String = (ancillaryData: string): string => {
  try {
    return utils.toUtf8String(ancillaryData);
  } catch (err) {
    return ancillaryData;
  }
};