import { BigNumber, Contract, ethers } from "ethers";
import type { Provider } from "@ethersproject/abstract-provider";
import { tryHexToUtf8String } from "./contracts";

// The price UMA uses for "too early to resolve" (p4): type(int256).min.
export const TOO_EARLY_PRICE = BigNumber.from(2).pow(255).mul(-1);

export type Verdict = "p1" | "p2" | "p3" | "p4" | "unclear";
export const VERDICTS: Verdict[] = ["p1", "p2", "p3", "p4", "unclear"];

export interface ParsedAncillary {
    raw: string;
    title?: string;
    description?: string;
    marketId?: string;
    // Price for each of p1..p3 as an 18-decimal integer string, and the human label for each.
    resData: Record<"p1" | "p2" | "p3", { price: string; label?: string }>;
    resDataFound: boolean;
    bulletinBoard?: string;
    initializer?: string;
}

const DEFAULT_RES_DATA: ParsedAncillary["resData"] = {
    p1: { price: "0", label: "No" },
    p2: { price: ethers.constants.WeiPerEther.toString(), label: "Yes" },
    p3: { price: ethers.constants.WeiPerEther.div(2).toString(), label: "50-50" },
};

// Parses Polymarket-style ancillary data: "q: title: ..., description: ... market_id: N res_data: p1: 0, p2: 1, p3: 0.5.
// Where p1 corresponds to A, p2 to B, p3 to unknown/50-50. Updates made by the question creator via the bulletin board
// at 0x... should be considered.,initializer:<hex>". Anything missing is left undefined.
export function parseAncillary(ancillaryHex: string): ParsedAncillary {
    const raw = tryHexToUtf8String(ancillaryHex);
    const text = raw.replace(/^q:\s*/, "");
    const title = text.match(/^title:\s*([\s\S]*?),\s*description:/)?.[1]?.trim();
    const description = text.match(/description:\s*([\s\S]*?)(?=\s+market_id:|\s+res_data:|,initializer:|$)/)?.[1]?.trim();
    const marketId = text.match(/market_id:\s*(\d+)/)?.[1];
    const bulletinBoard = text.match(/bulletin board at (0x[0-9a-fA-F]{40})/)?.[1];
    const initializerHex = text.match(/initializer:\s*(?:0x)?([0-9a-fA-F]{40})/)?.[1];

    const resData = JSON.parse(JSON.stringify(DEFAULT_RES_DATA)) as ParsedAncillary["resData"];
    const section = text.match(/res_data:\s*([\s\S]*?)(?=\s*Updates made|,initializer:|$)/)?.[1];
    let resDataFound = false;
    if (section) {
        const [pricesPart, mappingPart] = section.split(/\bWhere\b/);
        for (const [, index, value] of pricesPart.matchAll(/p([123]):\s*(-?\d+(?:\.\d+)?)/g)) {
            resData[`p${index}` as "p1"].price = ethers.utils.parseEther(value).toString();
            resDataFound = true;
        }
        for (const [, index, label] of (mappingPart ?? "").matchAll(/p([123])\s+(?:corresponds\s+)?to\s+(.+?)(?=,\s*p[123]\s|\.\s*$|$)/g)) {
            resData[`p${index}` as "p1"].label = label.trim();
        }
    }

    return {
        raw,
        title,
        description,
        marketId,
        resData,
        resDataFound,
        bulletinBoard: bulletinBoard ? ethers.utils.getAddress(bulletinBoard) : undefined,
        initializer: initializerHex ? ethers.utils.getAddress(`0x${initializerHex}`) : undefined,
    };
}

export function verdictPrice(verdict: Exclude<Verdict, "unclear">, parsed: ParsedAncillary): BigNumber {
    return verdict === "p4" ? TOO_EARLY_PRICE : BigNumber.from(parsed.resData[verdict].price);
}

// Which verdict a proposed price corresponds to, if any.
export function priceToVerdict(price: BigNumber, parsed: ParsedAncillary): Exclude<Verdict, "unclear"> | undefined {
    if (price.eq(TOO_EARLY_PRICE)) return "p4";
    return (["p1", "p2", "p3"] as const).find((p) => price.eq(parsed.resData[p].price));
}

export function describePrice(price: BigNumber, parsed: ParsedAncillary): string {
    const verdict = priceToVerdict(price, parsed);
    if (!verdict) return `${price.toString()} (not a res_data value)`;
    if (verdict === "p4") return "p4 (too early)";
    return `${verdict} (${parsed.resData[verdict].label ?? parsed.resData[verdict].price})`;
}

// UMA CTF adapters use keccak256(ancillaryData) as the question ID and the adapter as the CTF oracle.
export function questionId(ancillaryHex: string): string {
    return ethers.utils.keccak256(ancillaryHex);
}

export function conditionId(adapter: string, question: string): string {
    return ethers.utils.solidityKeccak256(["address", "bytes32", "uint256"], [adapter, question, 2]);
}

export interface MarketData {
    status: "available" | "unavailable";
    question?: string;
    negRisk?: boolean;
    negRiskMarketId?: string;
    closed?: boolean;
    prices?: { outcome: string; price: number }[];
    // The Polymarket event the market belongs to: every line of one match (winner, spreads, totals) shares it.
    eventId?: string;
    eventTitle?: string;
    eventSlug?: string;
    fetchedAt: number;
    error?: string;
}

const CLOB_BASE_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const GAMMA_BASE_URL = process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com";

// Best effort: Polymarket's public CLOB market endpoint plus the market's event from Gamma, no key. Any CLOB failure
// is reported as unavailable; a missing event only leaves eventId unset.
export async function fetchMarketData(condition: string, timeoutMs = 3000): Promise<MarketData> {
    const [market, event] = await Promise.all([fetchClobMarket(condition, timeoutMs), fetchEvent(condition, timeoutMs)]);
    return event ? { ...market, eventId: event.id, eventTitle: event.title, eventSlug: event.slug } : market;
}

// Gamma hides closed markets unless asked, and trading usually closes before the proposal, so both are queried.
export async function fetchEvent(condition: string, timeoutMs = 3000): Promise<{ id: string; title?: string; slug?: string } | undefined> {
    const lookups = await Promise.allSettled(
        ["false", "true"].map(async (closed) => {
            const response = await fetch(`${GAMMA_BASE_URL}/markets?condition_ids=${condition}&closed=${closed}`, { signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) return undefined;
            const markets = (await response.json()) as { events?: { id?: string | number; title?: string; slug?: string }[] }[];
            return markets[0]?.events?.[0];
        })
    );
    for (const lookup of lookups) {
        if (lookup.status === "fulfilled" && lookup.value?.id !== undefined) return { id: String(lookup.value.id), title: lookup.value.title, slug: lookup.value.slug };
    }
    return undefined;
}

async function fetchClobMarket(condition: string, timeoutMs: number): Promise<MarketData> {
    const fetchedAt = Math.floor(Date.now() / 1000);
    try {
        const response = await fetch(`${CLOB_BASE_URL}/markets/${condition}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return { status: "unavailable", fetchedAt, error: `HTTP ${response.status}` };
        const market = (await response.json()) as {
            question?: string;
            neg_risk?: boolean;
            neg_risk_market_id?: string;
            closed?: boolean;
            tokens?: { outcome: string; price: number }[];
        };
        return {
            status: "available",
            question: market.question,
            negRisk: market.neg_risk,
            negRiskMarketId: market.neg_risk_market_id || undefined,
            closed: market.closed,
            prices: market.tokens?.map(({ outcome, price }) => ({ outcome, price })),
            fetchedAt,
        };
    } catch (error) {
        return { status: "unavailable", fetchedAt, error: (error as Error).message };
    }
}

export interface CreatorUpdates {
    status: "available" | "unavailable" | "not_applicable";
    updates: { timestamp: number; text: string }[];
    source?: string;
    error?: string;
}

const BULLETIN_BOARD_ABI = ["function getUpdates(bytes32 questionID, address owner) view returns (tuple(uint256 timestamp, bytes update)[])"];

// Creator clarifications posted on chain to the bulletin board named in the ancillary data. They amend the rules.
export async function fetchCreatorUpdates(provider: Provider, ancillaryHex: string, parsed: ParsedAncillary): Promise<CreatorUpdates> {
    if (!parsed.bulletinBoard || !parsed.initializer) return { status: "not_applicable", updates: [] };
    try {
        const board = new Contract(parsed.bulletinBoard, BULLETIN_BOARD_ABI, provider);
        const updates: { timestamp: BigNumber; update: string }[] = await board.getUpdates(questionId(ancillaryHex), parsed.initializer);
        return {
            status: "available",
            source: parsed.bulletinBoard,
            updates: updates.map((u) => ({ timestamp: u.timestamp.toNumber(), text: tryHexToUtf8String(u.update) })),
        };
    } catch (error) {
        return { status: "unavailable", updates: [], source: parsed.bulletinBoard, error: (error as Error).message?.split("\n")[0] };
    }
}
