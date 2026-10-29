import { OptimisticOracleV2Ethers } from "@uma/contracts-node";
import { BigNumber, Contract, ethers } from "ethers";
import type { Log } from "@ethersproject/abstract-provider";
import { Config } from "./config";
import { BATCH_GAS_OVERHEAD, EXPIRY_SAFETY_MARGIN_SECONDS, RequestState } from "./constants";
import { chunk, mapWithConcurrency, withRetry } from "./concurrency";
import { getDisputeBatcherInstance, getERC20ContractInstance, getOOV2ContractInstance } from "./contracts";
import { getGasFeeOverride } from "./gas";
import { disputableAfterLiveness, Proposal, requestKeyArgs, requestKeyId } from "./proposals";

export type DisputeStatus = "disputed" | "already-disputed" | "skipped" | "failed" | "dry-run";

export interface DisputeOutcome {
    proposal: Proposal;
    status: DisputeStatus;
    detail?: string;
    txHash?: string;
}

// batcher: DisputeBatcher (legacy OOv2). multicall: the Managed OOv2's own multicall. direct: one transaction each.
export type Transport = "batcher" | "multicall" | "direct";

export interface ReadyItem {
    proposal: Proposal;
    totalBond: BigNumber;
}

const STATUS_ICONS: Record<DisputeStatus, string> = {
    disputed: "✅",
    "already-disputed": "☑️ ",
    skipped: "⏭️ ",
    failed: "🚨",
    "dry-run": "🧪",
};

// Whether a request can still be disputed now. getState reports Expired once liveness ends, but the Managed OOv2 accepts
// disputes until its resolver settles (it maps Expired to Proposed for disputes); on the OOv2 there is also a safety
// margin, since a transaction sent seconds before expiry would likely land too late.
export function disputable(kind: Proposal["oracleKind"], state: RequestState, settled: boolean, expiration: number, now: number): boolean {
    if (disputableAfterLiveness(kind)) return !settled && (state === RequestState.Proposed || state === RequestState.Expired);
    return state === RequestState.Proposed && expiration > now + EXPIRY_SAFETY_MARGIN_SECONDS;
}

export function describeProposal(proposal: Proposal): string {
    return `${proposal.oracleKind} ${proposal.requester.slice(0, 10)}… ts=${proposal.timestamp.toString()} id=${ethers.utils.parseBytes32String(proposal.identifier)}`;
}

function errorText(error: unknown): string {
    const e = error as { errorName?: string; reason?: string; message?: string };
    return e?.errorName ?? e?.reason ?? e?.message?.split("\n")[0] ?? String(error);
}

// Keeps the most urgent items that the wallet can pay for; the rest fail with a balance error.
export function fitToBalance(items: ReadyItem[], balance: BigNumber): { funded: ReadyItem[]; unfunded: ReadyItem[] } {
    const funded: ReadyItem[] = [];
    const unfunded: ReadyItem[] = [];
    let remaining = balance;
    for (const item of [...items].sort((a, b) => a.proposal.proposalExpirationTimestamp.sub(b.proposal.proposalExpirationTimestamp).isNegative() ? -1 : 1)) {
        if (remaining.gte(item.totalBond)) {
            funded.push(item);
            remaining = remaining.sub(item.totalBond);
        } else {
            unfunded.push(item);
        }
    }
    return { funded, unfunded };
}

export function sumBonds(items: ReadyItem[]): BigNumber {
    return items.reduce((sum, item) => sum.add(item.totalBond), BigNumber.from(0));
}

export class DisputeEngine {
    private batcher?: Contract;

    constructor(private config: Config, private confirm: (question: string) => Promise<boolean>) {}

    // Verifies the configured DisputeBatcher before trusting it; any problem falls back to direct disputes.
    async init() {
        const { config } = this;
        if (!config.batch) {
            console.log("ℹ️  Batching disabled (--no-batch): one dispute per transaction.");
            return;
        }
        const oov2 = config.oracles.find((o) => o.kind === "oov2");
        if (!oov2) return;
        if (!config.disputeBatcherAddress) {
            console.log("ℹ️  DISPUTE_BATCHER_ADDRESS not set: OOv2 disputes go one per transaction (Managed OOv2 still batches via multicall).");
            return;
        }
        try {
            const code = await withRetry(() => config.provider.getCode(config.disputeBatcherAddress!));
            if (code === "0x") throw new Error("no contract code at address");
            const batcher = getDisputeBatcherInstance(config.wallet, config.disputeBatcherAddress);
            const boundOracle: string = await withRetry(() => batcher.oracle());
            if (boundOracle.toLowerCase() !== oov2.address.toLowerCase()) {
                throw new Error(`bound to oracle ${boundOracle}, expected ${oov2.address}`);
            }
            this.batcher = batcher;
            console.log(`📦 DisputeBatcher ${batcher.address} verified for OOv2 ${oov2.address}.`);
        } catch (error) {
            console.warn(`⚠️  DisputeBatcher ${config.disputeBatcherAddress} unusable (${errorText(error)}); OOv2 disputes go one per transaction.`);
        }
    }

    transportFor(proposal: Proposal): Transport {
        if (!this.config.batch) return "direct";
        if (proposal.oracleKind === "managed") return "multicall";
        return this.batcher ? "batcher" : "direct";
    }

    async dispute(proposals: Proposal[]): Promise<DisputeOutcome[]> {
        const groups = new Map<string, { transport: Transport; proposals: Proposal[] }>();
        for (const proposal of proposals) {
            const transport = this.transportFor(proposal);
            const key = [transport, proposal.ooAddress.toLowerCase(), proposal.bondCurrency.toLowerCase()].join("|");
            if (!groups.has(key)) groups.set(key, { transport, proposals: [] });
            groups.get(key)!.proposals.push(proposal);
        }

        const outcomes: DisputeOutcome[] = [];
        for (const { transport, proposals: group } of groups.values()) {
            const sorted = [...group].sort((a, b) => (a.proposalExpirationTimestamp.lt(b.proposalExpirationTimestamp) ? -1 : 1));
            for (const batch of chunk(sorted, this.config.batchSize)) {
                // One failing chunk (RPC still down after retries, fee lookup...) must not lose the outcomes of the others.
                try {
                    outcomes.push(...(await this.processChunk(transport, batch, true)));
                } catch (error) {
                    outcomes.push(...batch.map((proposal) => this.log({ proposal, status: "failed", detail: errorText(error) })));
                }
            }
        }
        return outcomes;
    }

    private log(outcome: DisputeOutcome): DisputeOutcome {
        const tx = outcome.txHash ? ` tx=${outcome.txHash}` : "";
        console.log(`${STATUS_ICONS[outcome.status]} ${outcome.status}: ${describeProposal(outcome.proposal)}${outcome.detail ? ` — ${outcome.detail}` : ""}${tx}`);
        return outcome;
    }

    private async processChunk(transport: Transport, proposals: Proposal[], allowFallback: boolean): Promise<DisputeOutcome[]> {
        const { config } = this;
        const oo = await getOOV2ContractInstance(config.wallet, proposals[0].ooAddress);
        const { bondCurrencySymbol: symbol, bondCurrencyDecimals: decimals } = proposals[0];
        const outcomes: DisputeOutcome[] = [];

        const { ready, done } = await this.refresh(oo, proposals);
        outcomes.push(...done);
        if (ready.length === 0) return outcomes;

        const token = getERC20ContractInstance(config.wallet, proposals[0].bondCurrency);
        const balance = await withRetry(() => token.balanceOf(config.wallet.address));
        const { funded, unfunded } = fitToBalance(ready, balance);
        for (const item of unfunded) {
            outcomes.push(this.log({ proposal: item.proposal, status: "failed", detail: `insufficient ${symbol} balance (${ethers.utils.formatUnits(balance, decimals)} available)` }));
        }
        if (funded.length === 0) return outcomes;

        const spender = transport === "batcher" ? this.batcher!.address : oo.address;
        const allowance = await this.ensureAllowance(token, symbol, decimals, spender, sumBonds(funded));
        if (allowance !== "ok") {
            const status: DisputeStatus = allowance === "dry-run" ? "dry-run" : "failed";
            const detail = allowance === "dry-run" ? `needs ${symbol} approval for ${spender} first; not simulated` : `${symbol} not approved for ${spender}`;
            return outcomes.concat(funded.map((item) => this.log({ proposal: item.proposal, status, detail })));
        }

        let result: { outcomes: DisputeOutcome[]; retry: Proposal[] };
        try {
            if (transport === "batcher") result = await this.sendViaBatcher(oo, funded);
            else if (transport === "multicall") result = await this.sendViaMulticall(oo, funded);
            else result = await this.sendDirect(oo, funded);
        } catch (error) {
            // Only pre-send failures land here; once a transaction is out, results come from on-chain state.
            if (transport === "direct" || !allowFallback) throw error;
            console.warn(`⚠️  ${transport} batch could not be sent (${errorText(error)}); falling back to one dispute per transaction.`);
            return outcomes.concat(await this.processChunk("direct", funded.map((item) => item.proposal), false));
        }

        outcomes.push(...result.outcomes);
        if (result.retry.length > 0) {
            if (transport !== "direct" && allowFallback) {
                console.warn(`🔁 ${result.retry.length} proposal(s) still open after the ${transport} transaction; retrying one per transaction.`);
                outcomes.push(...(await this.processChunk("direct", result.retry, false)));
            } else {
                outcomes.push(...result.retry.map((proposal) => this.log({ proposal, status: "failed", detail: "still proposed after dispute attempt" })));
            }
        }
        return outcomes;
    }

    // Re-reads every request live: the proposal list may be minutes old and others may have disputed already.
    private async refresh(oo: OptimisticOracleV2Ethers, proposals: Proposal[]): Promise<{ ready: ReadyItem[]; done: DisputeOutcome[] }> {
        const now = (await withRetry(() => this.config.provider.getBlock("latest"))).timestamp;
        const ready: ReadyItem[] = [];
        const done: DisputeOutcome[] = [];
        await mapWithConcurrency(proposals, this.config.rpcConcurrency, async (proposal) => {
            try {
                const args = requestKeyArgs(proposal);
                const [state, request] = await Promise.all([withRetry(() => oo.getState(...args)), withRetry(() => oo.getRequest(...args))]);
                if (state === RequestState.Disputed) {
                    done.push(this.log({ proposal, status: "already-disputed", detail: `disputer ${request.disputer}` }));
                } else if (!disputable(proposal.oracleKind, state, request.settled, request.expirationTime.toNumber(), now)) {
                    const late = state === RequestState.Proposed;
                    done.push(this.log({ proposal, status: "skipped", detail: late ? `expires in ${request.expirationTime.toNumber() - now}s, too late to send` : `state is ${RequestState[state]}` }));
                } else {
                    ready.push({ proposal, totalBond: request.requestSettings.bond.add(request.finalFee) });
                }
            } catch (error) {
                done.push(this.log({ proposal, status: "failed", detail: `could not read request: ${errorText(error)}` }));
            }
        });
        return { ready, done };
    }

    private async ensureAllowance(token: ReturnType<typeof getERC20ContractInstance>, symbol: string, decimals: number, spender: string, amount: BigNumber): Promise<"ok" | "declined" | "dry-run"> {
        const allowance = await withRetry(() => token.allowance(this.config.wallet.address, spender));
        if (allowance.gte(amount)) return "ok";
        if (this.config.dryRun) return "dry-run";

        // Unlimited, so a top-up mid-incident doesn't need another approval. The batcher only ever pulls from its caller.
        const approve = await this.confirm(
            `🔐 ${symbol} allowance for ${spender} is ${ethers.utils.formatUnits(allowance, decimals)}, this batch needs ${ethers.utils.formatUnits(amount, decimals)}. Approve unlimited? (y/n) `
        );
        if (!approve) return "declined";
        const tx = await token.approve(spender, ethers.constants.MaxUint256, await getGasFeeOverride(this.config));
        console.log(`🔄 Approving ${symbol} for ${spender} in ${tx.hash}...`);
        await tx.wait();
        return "ok";
    }

    // Batches are sized from a per-dispute budget, never estimateGas (see DEFAULT_GAS_PER_DISPUTE).
    private gasLimitFor(count: number): BigNumber {
        return BigNumber.from(BATCH_GAS_OVERHEAD + count * this.config.gasPerDispute);
    }

    private async sendViaBatcher(oo: OptimisticOracleV2Ethers, items: ReadyItem[]) {
        const batcher = this.batcher!;
        const currency = items[0].proposal.bondCurrency;
        let batch = items;
        const droppedBySimulation: Proposal[] = [];

        // Simulate at the exact gas limit we will send with; anything the batcher would skip is dropped and re-read.
        for (;;) {
            const keys = batch.map(({ proposal }) => ({ requester: proposal.requester, identifier: proposal.identifier, timestamp: proposal.timestamp, ancillaryData: proposal.ancillaryData }));
            let simulated: boolean[];
            try {
                simulated = await batcher.callStatic.disputeBatch(currency, sumBonds(batch), keys, { gasLimit: this.gasLimitFor(batch.length) });
            } catch (error) {
                if ((error as { errorName?: string }).errorName !== "NoDisputesSucceeded") throw error;
                simulated = batch.map(() => false);
            }
            const kept = batch.filter((_, i) => simulated[i]);
            droppedBySimulation.push(...batch.filter((_, i) => !simulated[i]).map((item) => item.proposal));
            if (kept.length === batch.length || kept.length === 0) {
                batch = kept;
                break;
            }
            batch = kept;
        }

        if (batch.length === 0) return this.reconcile(oo, droppedBySimulation, [], undefined);

        const total = sumBonds(batch);
        const gasLimit = this.gasLimitFor(batch.length);
        if (this.config.dryRun) {
            const outcomes = batch.map(({ proposal }) =>
                this.log({ proposal, status: "dry-run", detail: `would dispute via DisputeBatcher in a batch of ${batch.length} (bond ${ethers.utils.formatUnits(total, items[0].proposal.bondCurrencyDecimals)} ${items[0].proposal.bondCurrencySymbol}, gas limit ${gasLimit})` })
            );
            const dropped = await this.reconcile(oo, droppedBySimulation, [], undefined);
            return { outcomes: outcomes.concat(dropped.outcomes), retry: dropped.retry };
        }

        const keys = batch.map(({ proposal }) => ({ requester: proposal.requester, identifier: proposal.identifier, timestamp: proposal.timestamp, ancillaryData: proposal.ancillaryData }));
        const tx = await batcher.disputeBatch(currency, total, keys, { gasLimit, ...(await getGasFeeOverride(this.config)) });
        console.log(`📤 Sent DisputeBatcher batch of ${batch.length} in ${tx.hash}`);
        const logs = await this.waitForLogs(tx);
        for (const log of logs.filter((l) => l.address.toLowerCase() === batcher.address.toLowerCase())) {
            try {
                const parsed = batcher.interface.parseLog(log);
                if (parsed.name === "DisputeSkipped") console.warn(`⚠️  Batcher skipped index ${parsed.args.index}: ${parsed.args.reason === "0x" ? "empty revert (out of gas?)" : parsed.args.reason}`);
            } catch {
                // Not a batcher event.
            }
        }
        return this.reconcile(oo, batch.map((item) => item.proposal).concat(droppedBySimulation), logs, tx.hash);
    }

    private async sendViaMulticall(oo: OptimisticOracleV2Ethers, items: ReadyItem[]) {
        // multicall is all-or-nothing, so drop anything that would revert on its own first.
        const reasons = await mapWithConcurrency(items, this.config.rpcConcurrency, async ({ proposal }) => {
            try {
                await oo.callStatic.disputePrice(...requestKeyArgs(proposal));
                return undefined;
            } catch (error) {
                return errorText(error);
            }
        });
        const batch = items.filter((_, i) => reasons[i] === undefined);
        const rejected = items.filter((_, i) => reasons[i] !== undefined).map((item) => item.proposal);
        const rejectedDetail = new Map(items.map((item, i) => [requestKeyId(item.proposal), reasons[i]]));
        const rejectedResult = await this.reconcile(oo, rejected, [], undefined, rejectedDetail);
        if (batch.length === 0) return rejectedResult;

        const data = batch.map(({ proposal }) => oo.interface.encodeFunctionData("disputePrice", requestKeyArgs(proposal)));
        const gasLimit = this.gasLimitFor(batch.length);
        const multicall = oo as unknown as Contract;
        await multicall.callStatic.multicall(data, { gasLimit });

        if (this.config.dryRun) {
            const outcomes = batch.map(({ proposal }) => this.log({ proposal, status: "dry-run", detail: `would dispute via Managed OOv2 multicall in a batch of ${batch.length} (gas limit ${gasLimit})` }));
            return { outcomes: outcomes.concat(rejectedResult.outcomes), retry: rejectedResult.retry };
        }

        const tx = await multicall.multicall(data, { gasLimit, ...(await getGasFeeOverride(this.config)) });
        console.log(`📤 Sent Managed OOv2 multicall batch of ${batch.length} in ${tx.hash}`);
        const logs = await this.waitForLogs(tx);
        const result = await this.reconcile(oo, batch.map((item) => item.proposal), logs, tx.hash);
        return { outcomes: result.outcomes.concat(rejectedResult.outcomes), retry: result.retry.concat(rejectedResult.retry) };
    }

    // Sends one transaction per dispute with locally tracked nonces, then waits for all of them together.
    private async sendDirect(oo: OptimisticOracleV2Ethers, items: ReadyItem[]) {
        const { config } = this;
        const fees = config.dryRun ? {} : await getGasFeeOverride(config);
        let nonce = config.dryRun ? 0 : await withRetry(() => config.wallet.getTransactionCount("pending"));
        const sent: { proposal: Proposal; tx: ethers.ContractTransaction }[] = [];
        const notSent: Proposal[] = [];
        const errors = new Map<string, string>();
        const outcomes: DisputeOutcome[] = [];

        for (const { proposal } of items) {
            const args = requestKeyArgs(proposal);
            const fail = (error: unknown) => {
                errors.set(requestKeyId(proposal), errorText(error));
                notSent.push(proposal);
            };
            let estimate: BigNumber;
            try {
                // A revert here (already disputed, expired...) never uses a nonce.
                estimate = await oo.estimateGas.disputePrice(...args);
            } catch (error) {
                fail(error);
                continue;
            }
            if (config.dryRun) {
                outcomes.push(this.log({ proposal, status: "dry-run", detail: `would dispute directly (gas ~${estimate})` }));
                continue;
            }
            try {
                const tx = await oo.disputePrice(...args, { ...fees, gasLimit: estimate.mul(13).div(10), nonce });
                nonce++;
                console.log(`📤 Sent dispute in ${tx.hash}`);
                sent.push({ proposal, tx });
            } catch (error) {
                fail(error);
                // The failed send may or may not have used the nonce. A lagging node can under-count the transactions
                // this loop already sent, so never move backwards.
                const pending = await withRetry(() => config.wallet.getTransactionCount("pending")).catch(() => nonce);
                nonce = Math.max(nonce, pending);
            }
        }

        const logs = (await Promise.all(sent.map(({ tx }) => this.waitForLogs(tx)))).flat();
        const result = await this.reconcile(oo, sent.map((s) => s.proposal).concat(notSent), logs, undefined, errors, new Map(sent.map((s) => [requestKeyId(s.proposal), s.tx.hash])));
        return { outcomes: outcomes.concat(result.outcomes), retry: result.retry };
    }

    private async waitForLogs(tx: ethers.ContractTransaction): Promise<Log[]> {
        try {
            return (await tx.wait()).logs;
        } catch (error) {
            const receipt = (error as { receipt?: ethers.ContractReceipt }).receipt;
            console.error(`🚨 Transaction ${tx.hash} failed: ${errorText(error)}`);
            return receipt?.logs ?? [];
        }
    }

    // Decides each outcome from our DisputePrice logs, then from live state; a transaction result alone is not trusted.
    private async reconcile(
        oo: OptimisticOracleV2Ethers,
        proposals: Proposal[],
        logs: Log[],
        txHash: string | undefined,
        errors = new Map<string, string | undefined>(),
        txHashes = new Map<string, string>()
    ): Promise<{ outcomes: DisputeOutcome[]; retry: Proposal[] }> {
        const wallet = this.config.wallet.address.toLowerCase();
        const ours = new Set<string>();
        for (const log of logs.filter((l) => l.address.toLowerCase() === oo.address.toLowerCase())) {
            try {
                const parsed = oo.interface.parseLog(log);
                if (parsed.name === "DisputePrice" && parsed.args.disputer.toLowerCase() === wallet) ours.add(requestKeyId(parsed.args as never));
            } catch {
                // Not an oracle event.
            }
        }

        const outcomes: DisputeOutcome[] = [];
        const retry: Proposal[] = [];
        await mapWithConcurrency(proposals, this.config.rpcConcurrency, async (proposal) => {
            const id = requestKeyId(proposal);
            const hash = txHashes.get(id) ?? txHash;
            if (ours.has(id)) {
                outcomes.push(this.log({ proposal, status: "disputed", txHash: hash }));
                return;
            }
            const error = errors.get(id);
            try {
                const args = requestKeyArgs(proposal);
                const [state, request, block] = await Promise.all([
                    withRetry(() => oo.getState(...args)),
                    withRetry(() => oo.getRequest(...args)),
                    withRetry(() => this.config.provider.getBlock("latest")),
                ]);
                const now = block.timestamp;
                if (state === RequestState.Disputed) {
                    const byUs = request.disputer.toLowerCase() === wallet;
                    outcomes.push(this.log({ proposal, status: byUs ? "disputed" : "already-disputed", detail: byUs ? undefined : `disputer ${request.disputer}`, txHash: byUs ? hash : undefined }));
                } else if (disputable(proposal.oracleKind, state, request.settled, request.expirationTime.toNumber(), now) && !error) {
                    retry.push(proposal);
                } else {
                    const stillOpen = disputable(proposal.oracleKind, state, request.settled, request.expirationTime.toNumber(), now);
                    outcomes.push(this.log({ proposal, status: stillOpen ? "failed" : "skipped", detail: error ?? `state is ${RequestState[state]}` }));
                }
            } catch (readError) {
                outcomes.push(this.log({ proposal, status: "failed", detail: `${error ? `${error}; ` : ""}could not read state: ${errorText(readError)}` }));
            }
        });
        return { outcomes, retry };
    }
}
