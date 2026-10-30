import { BigNumber, ethers } from 'ethers';
import { mapWithConcurrency } from './concurrency';
import { questionId } from './polymarket';
import { Proposal } from './proposals';

// A list of question ids to dispute without the review queue: UMA question ids (keccak256 of the ancillary data) or
// Polymarket's (which differ for neg-risk markets, see polymarket-ids.ts). Accepts a JSON
// array, a selection file ({ include: { question_ids } }), or plain text with one id per line (commas, spaces and
// # comments allowed).
export function parseQuestionIds(text: string): string[] {
    const trimmed = text.trim();
    let raw: unknown[] = [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        const json = JSON.parse(trimmed);
        raw = Array.isArray(json) ? json : json?.include?.question_ids ?? json?.question_ids ?? [];
    } else {
        raw = trimmed
            .split('\n')
            .map((line) => line.replace(/#.*/, ''))
            .join(' ')
            .split(/[\s,]+/);
    }
    const ids = raw.map((id) => String(id).trim().toLowerCase()).filter(Boolean);
    const invalid = ids.filter((id) => !/^0x[0-9a-f]{64}$/.test(id));
    if (invalid.length) throw new Error(`Not question ids (expected 0x + 64 hex chars): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}`);
    return [...new Set(ids)];
}

export interface QuestionIdMatch {
    matched: Proposal[];
    // Ids with no open proposal in the scanned range: already settled or disputed, never proposed, or proposed before
    // the lookback period.
    missing: string[];
    // Ids with more than one open request (the same ancillary data requested again), all of which are disputed.
    repeated: string[];
    // How many ids matched as Polymarket question ids rather than UMA ones.
    viaPolymarket: number;
}

// Matches UMA question ids first. Ids left over are then looked up as Polymarket question ids through
// `polymarketId` (an on-chain call per remaining proposal), which only runs when some ids didn't match.
export async function matchQuestionIds(proposals: Proposal[], ids: string[], polymarketId?: (proposal: Proposal) => Promise<string | undefined>): Promise<QuestionIdMatch> {
    const wanted = new Set(ids);
    const byId = new Map<string, Proposal[]>();
    const add = (id: string, proposal: Proposal) => byId.set(id, [...(byId.get(id) ?? []), proposal]);
    const matched = new Set<Proposal>();
    for (const proposal of proposals) {
        const id = questionId(proposal.ancillaryData).toLowerCase();
        if (!wanted.has(id)) continue;
        add(id, proposal);
        matched.add(proposal);
    }
    let viaPolymarket = 0;
    const leftover = new Set(ids.filter((id) => !byId.has(id)));
    if (leftover.size > 0 && polymarketId) {
        await mapWithConcurrency(
            proposals.filter((proposal) => !matched.has(proposal)),
            10,
            async (proposal) => {
                const id = (await polymarketId(proposal))?.toLowerCase();
                if (!id || !leftover.has(id)) return;
                if (!byId.has(id)) viaPolymarket++;
                add(id, proposal);
                matched.add(proposal);
            }
        );
    }
    return {
        matched: proposals.filter((proposal) => matched.has(proposal)),
        missing: ids.filter((id) => !byId.has(id)),
        repeated: [...byId].filter(([, list]) => list.length > 1).map(([id]) => id),
        viaPolymarket,
    };
}

// Total bond per token, e.g. "3,750.0 USDC".
export function bondTotals(proposals: Proposal[]): string {
    const totals = new Map<string, { sum: BigNumber; decimals: number }>();
    for (const { bond, bondCurrencySymbol: symbol, bondCurrencyDecimals: decimals } of proposals) {
        const entry = totals.get(symbol) ?? { sum: BigNumber.from(0), decimals };
        entry.sum = entry.sum.add(bond);
        totals.set(symbol, entry);
    }
    return [...totals].map(([symbol, { sum, decimals }]) => `${ethers.utils.commify(ethers.utils.formatUnits(sum, decimals))} ${symbol}`).join(' + ') || '0';
}

// Applies --max-disputes / --max-bond (bond token units, summed across tokens like `apply`), keeping the given order.
export function withinCaps(proposals: Proposal[], maxDisputes: number, maxBond: number): Proposal[] {
    const selected: Proposal[] = [];
    let bond = 0;
    for (const proposal of proposals) {
        const amount = Number(ethers.utils.formatUnits(proposal.bond, proposal.bondCurrencyDecimals));
        if (selected.length + 1 > maxDisputes || bond + amount > maxBond) break;
        selected.push(proposal);
        bond += amount;
    }
    return selected;
}
