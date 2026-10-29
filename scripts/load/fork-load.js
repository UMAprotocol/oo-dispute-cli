// Load test for the agent review queue on a local Polygon fork. Never point this at a real network: it uses anvil's
// well-known test accounts and anvil_* cheat RPCs.
//
//   node scripts/load/fork-load.js setup <dir>                  fresh OOv2 + DisputeBatcher, funds, env files
//   node scripts/load/fork-load.js generate <dir> [options]     bursts of proposals built from real midterm markets
//   node scripts/load/fork-load.js report <dir>                 on-chain outcome vs. the answer key, plus timings
//
// generate options (env): COUNT (1000), MINUTES (10, spread of the bursts), WAVES (20), LIVENESS (1200 s),
// WRONG_RATE (0.1), SELECTION (selections/midterms-2026.json).
//
// A fresh OptimisticOracleV2 is deployed against UMA's real Finder: it uses the real Store and whitelists, but its
// storage is local to the fork, so thousands of requests don't each wait on the remote RPC for new storage slots.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getAbi } = require("@uma/contracts-node");

const RPC = process.env.FORK_RPC;
if (!RPC) throw new Error("Set FORK_RPC to the local Polygon fork, e.g. FORK_RPC=http://127.0.0.1:8556");

const REAL_OOV2 = "0xeE3Afe347D5C74317041E2618C49534dAf887c24";
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
// Polymarket UMA CTF adapter, impersonated as requester so --only-polymarket keeps the proposals.
const POLYMARKET_ADAPTER = "0x2F5e3684cb1F318ec51b00Edba38d79Ac2c0aA9d";
const BULLETIN_BOARD = "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7";
const IDENTIFIER = ethers.utils.formatBytes32String("YES_OR_NO_QUERY");
const MNEMONIC = "test test test test test test test test test test test junk";
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const GAMMA = process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com";
const REPO = path.resolve(__dirname, "../..");

const provider = new ethers.providers.StaticJsonRpcProvider({ url: RPC, timeout: 600_000 }, 137);
const account = (i) => ethers.Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`).connect(provider);
const [deployer, proposer, disputer] = [0, 3, 5].map(account);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// Atomic: reviewers read the answer key while it is being rewritten.
const writeJson = (file, value) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
    fs.renameSync(`${file}.tmp`, file);
};

async function assertFork() {
    for (const address of [REAL_OOV2, USDCE]) {
        if ((await provider.getCode(address)) === "0x") throw new Error(`${RPC} has no contract at ${address}; is it a Polygon fork?`);
    }
}

async function fundUsdc(address, amount) {
    const token = new ethers.Contract(USDCE, ERC20, provider);
    for (let slot = 0; slot < 20; slot++) {
        const key = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [address, slot]));
        const previous = await provider.send("eth_getStorageAt", [USDCE, key, "latest"]);
        await provider.send("anvil_setStorageAt", [USDCE, key, ethers.utils.hexZeroPad(amount.toHexString(), 32)]);
        if ((await token.balanceOf(address)).eq(amount)) return;
        await provider.send("anvil_setStorageAt", [USDCE, key, previous]);
    }
    throw new Error("Could not find the USDC.e balance slot");
}

async function impersonate(address) {
    await provider.send("anvil_impersonateAccount", [address]);
    await provider.send("anvil_setBalance", [address, ethers.utils.hexValue(ethers.constants.WeiPerEther.mul(1000))]);
    return provider.getSigner(address);
}

// The OOv2 escalates disputes to UMA's oracle, which only accepts contracts in the Registry. Register the fresh one by
// impersonating the Registry owner on the fork.
async function register(oracleAddress) {
    const finder = new ethers.Contract(await new ethers.Contract(REAL_OOV2, ["function finder() view returns (address)"], provider).finder(), ["function getImplementationAddress(bytes32) view returns (address)"], provider);
    const registryAddress = await finder.getImplementationAddress(ethers.utils.formatBytes32String("Registry"));
    const registry = new ethers.Contract(
        registryAddress,
        ["function getMember(uint256) view returns (address)", "function addMember(uint256,address)", "function registerContract(address[],address)", "function isContractRegistered(address) view returns (bool)"],
        provider
    );
    const owner = await registry.getMember(0);
    await (await registry.connect(await impersonate(owner)).addMember(1, deployer.address)).wait();
    await (await registry.connect(deployer).registerContract([], oracleAddress)).wait();
    if (!(await registry.isContractRegistered(oracleAddress))) throw new Error("registration failed");
}

async function setup(dir) {
    await assertFork();
    fs.mkdirSync(dir, { recursive: true });
    const finder = await new ethers.Contract(REAL_OOV2, ["function finder() view returns (address)"], provider).finder();
    const ooArtifact = require(path.join(REPO, "node_modules/@uma/core/artifacts/contracts/optimistic-oracle-v2/implementation/OptimisticOracleV2.sol/OptimisticOracleV2.json"));
    const oo = await (await new ethers.ContractFactory(ooArtifact.abi, ooArtifact.bytecode, deployer).deploy(7200, finder, ethers.constants.AddressZero)).deployed();
    await register(oo.address);
    const batcherArtifact = readJson(path.join(REPO, "scripts/fixtures/DisputeBatcher.json"));
    const batcher = await (await new ethers.ContractFactory(batcherArtifact.abi, batcherArtifact.bytecode, deployer).deploy(oo.address)).deployed();

    await fundUsdc(proposer.address, ethers.utils.parseUnits("10000000", 6));
    await fundUsdc(disputer.address, ethers.utils.parseUnits("10000000", 6));
    await (await new ethers.Contract(USDCE, ERC20, proposer).approve(oo.address, ethers.constants.MaxUint256)).wait();
    // Pre-approved so `apply --auto` never stops at an approval prompt.
    for (const spender of [batcher.address, oo.address]) await (await new ethers.Contract(USDCE, ERC20, disputer).approve(spender, ethers.constants.MaxUint256)).wait();
    await impersonate(POLYMARKET_ADAPTER);

    const startBlock = (await provider.getBlockNumber()) + 1;
    const common = [
        "CHAIN_ID=137",
        `NODE_URL_137=${RPC}`,
        `OOV2_ADDRESS=${oo.address}`,
        `START_BLOCK=${startBlock}`,
        // Per-block log queries: the paginator would otherwise round ranges down into pre-fork blocks.
        "MAX_BLOCK_LOOK_BACK=1",
        "SCAN_INTERVAL_SECONDS=10",
        `REVIEW_DB=${path.resolve(dir, "review.sqlite")}`,
    ];
    fs.writeFileSync(path.join(dir, "mcp.env"), common.join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "apply.env"), ["unset NODE_URLS_137", ...common, `PRIVATE_KEY=${disputer.privateKey}`, `DISPUTE_BATCHER_ADDRESS=${batcher.address}`].map((l) => (l.startsWith("unset") ? l : `export ${l}`)).join("\n") + "\n");
    writeJson(path.join(dir, "setup.json"), { oracle: oo.address, batcher: batcher.address, startBlock, disputer: disputer.address, proposer: proposer.address });
    console.log(`Fresh OOv2 ${oo.address} (registered), DisputeBatcher ${batcher.address}, start block ${startBlock}`);
}

// Real midterm markets from Gamma: question and rules text, used to build realistic ancillary data.
async function loadMarkets(selectionFile) {
    const slugs = readJson(selectionFile).include.event_slugs;
    const markets = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: 8 }, async () => {
            while (next < slugs.length) {
                const slug = slugs[next++];
                try {
                    const response = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(15000) });
                    const events = response.ok ? await response.json() : [];
                    for (const event of events) {
                        for (const m of event.markets ?? []) {
                            if (m.id && m.question && m.description) markets.push({ id: String(m.id), question: m.question, description: m.description, event: slug });
                        }
                    }
                } catch {
                    // A missing event only shrinks the pool.
                }
            }
        })
    );
    return markets;
}

function ancillaryFor(market) {
    // Same shape as Polymarket's UMA CTF adapter requests, so the CLI parses title, rules, market_id and res_data.
    const description = market.description.replace(/\s+/g, " ").slice(0, 5000);
    const text =
        `q: title: ${market.question}, description: ${description} market_id: ${market.id} res_data: p1: 0, p2: 1, p3: 0.5. ` +
        `Where p1 corresponds to No, p2 to Yes, p3 to unknown/50-50. Updates made by the question creator via the bulletin board at ${BULLETIN_BOARD} ` +
        `as described by https://polygonscan.com/tx/0x0 should be considered.,initializer:${proposer.address.slice(2).toLowerCase()}`;
    return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(text));
}

function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

async function sendAll(txs) {
    const sent = await Promise.all(txs);
    const receipts = await Promise.all(sent.map((tx) => tx.wait()));
    const failed = receipts.filter((r) => r.status !== 1).length;
    if (failed) throw new Error(`${failed} transaction(s) reverted`);
    return receipts;
}

async function generate(dir) {
    const count = Number(process.env.COUNT || 1000);
    const minutes = Number(process.env.MINUTES || 10);
    const waves = Math.min(Number(process.env.WAVES || 20), count);
    const liveness = Number(process.env.LIVENESS || 1200);
    const wrongRate = Number(process.env.WRONG_RATE || 0.1);
    const { oracle } = readJson(path.join(dir, "setup.json"));
    const oo = new ethers.Contract(oracle, getAbi("OptimisticOracleV2"), provider);
    const requester = oo.connect(await impersonate(POLYMARKET_ADAPTER));
    const asProposer = oo.connect(proposer);

    // Whole events go out together, like a race being called: all its markets are proposed at once. Each event (a
    // neg-risk set) has exactly one true Yes; a wrong proposal flips that (an extra Yes, or the winner proposed No).
    const markets = await loadMarkets(path.resolve(REPO, process.env.SELECTION || "selections/midterms-2026.json"));
    const byEvent = new Map();
    for (const m of markets) byEvent.set(m.event, [...(byEvent.get(m.event) ?? []), m]);
    const pool = [];
    for (const group of shuffle([...byEvent.values()])) {
        if (pool.length >= count) break;
        const winner = Math.floor(Math.random() * group.length);
        group.slice(0, count - pool.length).forEach((m, i) => pool.push({ ...m, truth: i === winner ? "p2" : "p1" }));
    }
    if (pool.length < count) throw new Error(`Only ${markets.length} midterm markets available, asked for ${count}`);
    console.log(`Loaded ${markets.length} midterm markets (${byEvent.size} events) from Gamma; proposing ${count} in ${waves} waves over ${minutes} min, liveness ${liveness}s, ${wrongRate * 100}% wrong.`);

    const answersFile = path.join(dir, "answers.json");
    const answers = { liveness, wrongRate, count, done: false, items: [] };
    // Waves of whole events, about count / waves proposals each.
    const waveBatches = [];
    let current = [];
    for (let i = 0; i < pool.length; i++) {
        current.push(pool[i]);
        const eventEnds = i + 1 === pool.length || pool[i + 1].event !== pool[i].event;
        if (eventEnds && current.length >= count / waves) {
            waveBatches.push(current);
            current = [];
        }
    }
    if (current.length) waveBatches.push(current);
    const started = Date.now();
    for (const [wave, batch] of waveBatches.entries()) {
        const due = started + (wave * minutes * 60_000) / waveBatches.length;
        if (Date.now() < due) await sleep(due - Date.now());
        const waveStart = Date.now();
        const timestamp = (await provider.getBlock("latest")).timestamp - 60;
        const items = batch.map((market) => {
            const wrong = Math.random() < wrongRate;
            const proposed = wrong ? (market.truth === "p2" ? "p1" : "p2") : market.truth;
            return { market_id: market.id, title: market.question, event: market.event, ancillaryData: ancillaryFor(market), timestamp, proposed, truth: market.truth, wrong };
        });

        // The answer key goes out before the proposals, so a fast reviewer never sees a proposal without its answer.
        const pending = items.map((it) => ({ ...it, ancillaryData: undefined, ancillary_hash: ethers.utils.keccak256(it.ancillaryData) }));
        writeJson(answersFile, { ...answers, items: [...answers.items, ...pending] });

        // Requests first, then the proposals. The impersonated adapter's nonces are assigned by anvil in arrival order,
        // so its transactions go out one by one (without waiting for receipts) and with a fixed gas limit: estimating
        // setBond before its requestPrice is mined would fail.
        const bond = ethers.utils.parseUnits("10", 6);
        const requestTxs = [];
        for (const it of items) {
            requestTxs.push(await requester.requestPrice(IDENTIFIER, it.timestamp, it.ancillaryData, USDCE, 0, { gasLimit: 1_500_000 }));
            requestTxs.push(await requester.setBond(IDENTIFIER, it.timestamp, it.ancillaryData, bond, { gasLimit: 500_000 }));
            requestTxs.push(await requester.setCustomLiveness(IDENTIFIER, it.timestamp, it.ancillaryData, liveness, { gasLimit: 500_000 }));
        }
        await sendAll(requestTxs);
        let nonce = await proposer.getTransactionCount("pending");
        const receipts = await sendAll(items.map((it) => asProposer.proposePrice(POLYMARKET_ADAPTER, IDENTIFIER, it.timestamp, it.ancillaryData, it.proposed === "p2" ? ethers.constants.WeiPerEther : 0, { nonce: nonce++, gasLimit: 1_500_000 })));
        for (const [i, it] of items.entries()) {
            const block = await provider.getBlock(receipts[i].blockNumber);
            answers.items.push({ ...pending[i], proposal_tx: receipts[i].transactionHash, proposed_at: block.timestamp, expires_at: block.timestamp + liveness });
        }
        writeJson(answersFile, answers);
        console.log(`wave ${wave + 1}/${waveBatches.length}: ${items.length} proposals (${items.filter((i) => i.wrong).length} wrong) in ${((Date.now() - waveStart) / 1000).toFixed(1)}s; total ${answers.items.length}`);
    }
    answers.done = true;
    writeJson(answersFile, answers);
    console.log(`Generated ${answers.items.length} proposals in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
}

async function report(dir) {
    const { oracle, disputer: disputerAddress } = readJson(path.join(dir, "setup.json"));
    const { items } = readJson(path.join(dir, "answers.json"));
    const oo = new ethers.Contract(oracle, getAbi("OptimisticOracleV2"), provider);
    const head = await provider.getBlock("latest");

    // Dispute time per request, from the oracle's DisputePrice logs.
    const disputeLogs = await oo.queryFilter(oo.filters.DisputePrice(POLYMARKET_ADAPTER), readJson(path.join(dir, "setup.json")).startBlock, head.number);
    const blockTime = new Map();
    const disputedAt = new Map();
    for (const log of disputeLogs) {
        if (!blockTime.has(log.blockNumber)) blockTime.set(log.blockNumber, (await provider.getBlock(log.blockNumber)).timestamp);
        disputedAt.set(ethers.utils.keccak256(log.args.ancillaryData), { at: blockTime.get(log.blockNumber), by: log.args.disputer });
    }

    const tally = { wrong_disputed: 0, wrong_missed: 0, correct_disputed: 0, correct_left: 0, still_open: 0 };
    const margins = [];
    const delays = [];
    for (const it of items) {
        const dispute = disputedAt.get(it.ancillary_hash);
        const byUs = dispute && dispute.by.toLowerCase() === disputerAddress.toLowerCase();
        if (it.wrong) {
            if (byUs) {
                tally.wrong_disputed++;
                margins.push(it.expires_at - dispute.at);
                delays.push(dispute.at - it.proposed_at);
            } else if (it.expires_at > head.timestamp) tally.still_open++;
            else tally.wrong_missed++;
        } else if (byUs) tally.correct_disputed++;
        else tally.correct_left++;
    }
    const stats = (values) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        return { min: sorted[0], p50: q(0.5), p90: q(0.9), max: sorted[sorted.length - 1] };
    };
    const result = {
        proposals: items.length,
        wrong: items.filter((i) => i.wrong).length,
        ...tally,
        dispute_delay_seconds: stats(delays),
        margin_before_expiry_seconds: stats(margins),
        dispute_transactions: new Set(disputeLogs.map((l) => l.transactionHash)).size,
    };
    writeJson(path.join(dir, "report.json"), result);
    console.log(JSON.stringify(result, null, 1));
}

const [mode, dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: fork-load.js setup|generate|report <dir>");
({ setup, generate, report }[mode] ?? (() => Promise.reject(new Error(`unknown mode ${mode}`))))(path.resolve(dir)).catch((error) => {
    console.error(error);
    process.exit(1);
});
