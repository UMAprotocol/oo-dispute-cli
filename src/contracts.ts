import { Provider } from "@ethersproject/abstract-provider";
import { ERC20Ethers, getAbi, OptimisticOracleV2Ethers } from "@uma/contracts-node";
import { Contract, Signer, utils } from "ethers";
import ERC20Abi from "./abi/erc20.json";

// Managed OOv2 inherits MultiCaller, which delegatecalls back into the oracle so each dispute keeps the caller as
// msg.sender. The legacy OOv2 has no multicall.
const MULTICALL_ABI = ["function multicall(bytes[] data) returns (bytes[] results)"];

// See UMAprotocol/mcp-otb oracle/contracts/src/DisputeBatcher.sol.
export const DISPUTE_BATCHER_ABI = [
  "function oracle() view returns (address)",
  "function disputeBatch(address currency, uint256 maxTotalBond, tuple(address requester, bytes32 identifier, uint256 timestamp, bytes ancillaryData)[] requests) returns (bool[] disputed)",
  "event DisputeSkipped(address indexed disputer, uint256 indexed index, bytes reason)",
  "error InvalidOracle()",
  "error EmptyBatch()",
  "error CurrencyMismatch(uint256 index)",
  "error MaxTotalBondExceeded(uint256 required, uint256 maxTotalBond)",
  "error NoDisputesSucceeded()",
];

export const getOOV2ContractInstance = async (provider: Provider | Signer, contractAddress: string): Promise<OptimisticOracleV2Ethers> => {
  const contractAbi = getAbi("OptimisticOracleV2");
  return new Contract(contractAddress, [...contractAbi, ...MULTICALL_ABI], provider) as OptimisticOracleV2Ethers;
};

export const getDisputeBatcherInstance = (provider: Provider | Signer, address: string): Contract => {
  return new Contract(address, DISPUTE_BATCHER_ABI, provider);
};

export const getERC20ContractInstance = (provider: Provider | Signer, address: string): ERC20Ethers => {
  return new Contract(address, ERC20Abi, provider) as ERC20Ethers;
};

export const tryHexToUtf8String = (ancillaryData: string): string => {
  try {
    return utils.toUtf8String(ancillaryData);
  } catch (err) {
    return ancillaryData;
  }
};
