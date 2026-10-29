import { z } from "zod";
import { POLYMARKET_REQUESTER_ADDRESSES, POLYMARKET_V2_OO_REPORTER } from "../constants";
import { conditionId, questionId } from "../polymarket";
import type { StoredProposal } from "./store";

// A selection narrows which open proposals a review works on, e.g. "the midterm markets". Matching only uses data
// read from the chain (market id, UMA question id, CTF condition id, title, requester, oracle), so it keeps working
// when Polymarket's APIs are down. Slugs, event slugs and tags are converted to ids through Gamma, ideally ahead of
// time with `yarn select resolve`.

const Criteria = z
    .object({
        market_ids: z.array(z.union([z.string(), z.number()]).transform(String)).optional(),
        question_ids: z.array(z.string()).optional(),
        condition_ids: z.array(z.string()).optional(),
        slugs: z.array(z.string()).optional(),
        event_slugs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        title_regex: z.string().optional(),
        requesters: z.array(z.string()).optional(),
    })
    .strict();

export const PROTOCOLS = ["polymarket_v1", "polymarket_v2", "other"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const SelectionSchema = z
    .object({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/, "use letters, digits, '-' or '_'"),
        description: z.string().optional(),
        include: Criteria.optional(),
        exclude: Criteria.optional(),
        protocol: z.array(z.enum(PROTOCOLS)).optional(),
        oracle: z.array(z.enum(["oov2", "managed"])).optional(),
        resolved: z
            .object({
                at: z.string(),
                from: z.object({ slugs: z.array(z.string()), event_slugs: z.array(z.string()), tags: z.array(z.string()) }).partial(),
                unresolved: z.array(z.string()),
                // The include list had selectors before resolution; if none survived, the selection matches nothing.
                include_had_selectors: z.boolean().optional(),
            })
            .optional(),
    })
    .strict();

export type Selection = z.infer<typeof SelectionSchema>;
type CriteriaT = z.infer<typeof Criteria>;

export function parseSelection(input: unknown): Selection {
    const result = SelectionSchema.safeParse(input);
    if (!result.success) {
        throw new Error(`Invalid selection: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    if (result.data.include?.title_regex) new RegExp(result.data.include.title_regex, "i");
    if (result.data.exclude?.title_regex) new RegExp(result.data.exclude.title_regex, "i");
    return result.data;
}

export function protocolOf(requester: string): Protocol {
    const r = requester.toLowerCase();
    if (r === POLYMARKET_V2_OO_REPORTER) return "polymarket_v2";
    return POLYMARKET_REQUESTER_ADDRESSES.some((a) => a.toLowerCase() === r) ? "polymarket_v1" : "other";
}

const hasSelectors = (c?: CriteriaT) =>
    !!c && ["market_ids", "question_ids", "condition_ids", "slugs", "event_slugs", "tags", "requesters"].some((k) => (c[k as keyof CriteriaT] as unknown[] | undefined)?.length) || !!c?.title_regex;

function compileCriteria(c: CriteriaT) {
    const set = (values?: string[]) => new Set((values ?? []).map((v) => v.toLowerCase()));
    const marketIds = set(c.market_ids);
    const questionIds = set(c.question_ids);
    const conditionIds = set(c.condition_ids);
    const requesters = set(c.requesters);
    const title = c.title_regex ? new RegExp(c.title_regex, "i") : undefined;
    return (sp: StoredProposal) => {
        const { parsed } = sp.context;
        if (parsed.marketId && marketIds.has(parsed.marketId)) return true;
        if (requesters.has(sp.proposal.requester.toLowerCase())) return true;
        if (title && title.test(parsed.title ?? "")) return true;
        if (questionIds.size || conditionIds.size) {
            const question = questionId(sp.proposal.ancillaryData).toLowerCase();
            if (questionIds.has(question)) return true;
            if (conditionIds.has(conditionId(sp.proposal.requester, question).toLowerCase())) return true;
        }
        return false;
    };
}

// A proposal matches when it passes the protocol/oracle constraints, matches any include selector (or include is
// empty), and matches no exclude selector.
export function compileSelection(selection: Selection): (sp: StoredProposal) => boolean {
    // Fail closed: an include list whose selectors all failed to resolve must not widen to "everything".
    const emptyAfterResolution = !hasSelectors(selection.include) && selection.resolved?.include_had_selectors;
    const include = hasSelectors(selection.include) ? compileCriteria(selection.include!) : emptyAfterResolution ? () => false : () => true;
    const exclude = hasSelectors(selection.exclude) ? compileCriteria(selection.exclude!) : () => false;
    const protocols = selection.protocol ? new Set(selection.protocol) : undefined;
    const oracles = selection.oracle ? new Set(selection.oracle) : undefined;
    return (sp) =>
        (!protocols || protocols.has(protocolOf(sp.proposal.requester))) &&
        (!oracles || oracles.has(sp.proposal.oracleKind)) &&
        include(sp) &&
        !exclude(sp);
}

// ---- Gamma resolution: slugs / event slugs / tags -> ids ----

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
interface GammaMarket {
    id?: string | number;
    questionID?: string;
    conditionId?: string;
}

const GAMMA_BASE_URL = process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com";
const MAX_TAG_EVENTS = 5000;

async function getJson(fetchFn: Fetch, url: string): Promise<unknown> {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.json();
}

async function marketsBySlug(fetchFn: Fetch, slug: string): Promise<GammaMarket[]> {
    // Gamma hides closed markets unless asked, and markets close for trading before they are proposed.
    const [open, closed] = await Promise.all(["false", "true"].map((c) => getJson(fetchFn, `${GAMMA_BASE_URL}/markets?slug=${encodeURIComponent(slug)}&closed=${c}`)));
    return [...(open as GammaMarket[]), ...(closed as GammaMarket[])];
}

async function marketsByEventSlug(fetchFn: Fetch, slug: string): Promise<GammaMarket[]> {
    const events = (await getJson(fetchFn, `${GAMMA_BASE_URL}/events?slug=${encodeURIComponent(slug)}`)) as { markets?: GammaMarket[] }[];
    return events.flatMap((e) => e.markets ?? []);
}

async function marketsByTag(fetchFn: Fetch, tag: string, warnings: string[]): Promise<GammaMarket[]> {
    const markets: GammaMarket[] = [];
    for (let offset = 0; ; offset += 100) {
        if (offset >= MAX_TAG_EVENTS) {
            warnings.push(`tag:${tag} (truncated at ${MAX_TAG_EVENTS} events; use a narrower tag or event slugs)`);
            break;
        }
        let page: { markets?: GammaMarket[] }[];
        try {
            page = (await getJson(fetchFn, `${GAMMA_BASE_URL}/events?tag_slug=${encodeURIComponent(tag)}&closed=false&limit=100&offset=${offset}`)) as { markets?: GammaMarket[] }[];
        } catch (error) {
            if (offset === 0) throw error;
            // Gamma refuses deep offsets (HTTP 422 past ~2000): keep what was fetched and say the tag is incomplete.
            warnings.push(`tag:${tag} (truncated after ${offset} events: ${(error as Error).message}; use a narrower tag or event slugs)`);
            break;
        }
        markets.push(...page.flatMap((e) => e.markets ?? []));
        if (page.length < 100) break;
    }
    return markets;
}

async function resolveCriteria(c: CriteriaT | undefined, fetchFn: Fetch, unresolved: string[]): Promise<CriteriaT | undefined> {
    if (!c) return c;
    const marketIds = new Set(c.market_ids ?? []);
    const questionIds = new Set(c.question_ids ?? []);
    const conditionIds = new Set(c.condition_ids ?? []);
    const lookups: [string, () => Promise<GammaMarket[]>][] = [
        ...(c.slugs ?? []).map((s) => [`slug:${s}`, () => marketsBySlug(fetchFn, s)] as [string, () => Promise<GammaMarket[]>]),
        ...(c.event_slugs ?? []).map((s) => [`event_slug:${s}`, () => marketsByEventSlug(fetchFn, s)] as [string, () => Promise<GammaMarket[]>]),
        ...(c.tags ?? []).map((t) => [`tag:${t}`, () => marketsByTag(fetchFn, t, unresolved)] as [string, () => Promise<GammaMarket[]>]),
    ];
    for (const [label, lookup] of lookups) {
        try {
            const markets = await lookup();
            if (markets.length === 0) unresolved.push(`${label} (no markets found)`);
            for (const m of markets) {
                if (m.id !== undefined) marketIds.add(String(m.id));
                if (m.questionID) questionIds.add(m.questionID.toLowerCase());
                if (m.conditionId) conditionIds.add(m.conditionId.toLowerCase());
            }
        } catch (error) {
            unresolved.push(`${label} (${(error as Error).message})`);
        }
    }
    const { slugs: _s, event_slugs: _e, tags: _t, ...rest } = c;
    return {
        ...rest,
        ...(marketIds.size ? { market_ids: [...marketIds] } : {}),
        ...(questionIds.size ? { question_ids: [...questionIds] } : {}),
        ...(conditionIds.size ? { condition_ids: [...conditionIds] } : {}),
    };
}

export const needsResolution = (s: Selection) => [s.include, s.exclude].some((c) => (c?.slugs?.length ?? 0) + (c?.event_slugs?.length ?? 0) + (c?.tags?.length ?? 0) > 0);

// Converts slugs, event slugs and tags into ids via Gamma. Anything Gamma cannot answer is listed in
// resolved.unresolved and dropped, so the result never depends on Gamma again.
export async function resolveSelection(selection: Selection, fetchFn: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) })): Promise<Selection> {
    if (!needsResolution(selection)) return selection;
    const unresolved: string[] = [];
    const pick = (c?: CriteriaT) => ({ slugs: c?.slugs ?? [], event_slugs: c?.event_slugs ?? [], tags: c?.tags ?? [] });
    const from = { slugs: [...pick(selection.include).slugs, ...pick(selection.exclude).slugs], event_slugs: [...pick(selection.include).event_slugs, ...pick(selection.exclude).event_slugs], tags: [...pick(selection.include).tags, ...pick(selection.exclude).tags] };
    const includeHadSelectors = hasSelectors(selection.include);
    const include = await resolveCriteria(selection.include, fetchFn, unresolved);
    const exclude = await resolveCriteria(selection.exclude, fetchFn, unresolved);
    if (includeHadSelectors && !hasSelectors(include)) unresolved.push("include: nothing could be resolved, so this selection matches no proposals");
    return {
        ...selection,
        include,
        exclude,
        resolved: { at: new Date().toISOString(), from, unresolved: [...(selection.resolved?.unresolved ?? []), ...unresolved], include_had_selectors: includeHadSelectors },
    };
}

export function describeSelection(s: Selection) {
    const count = (c?: CriteriaT) => ({
        market_ids: c?.market_ids?.length ?? 0,
        question_ids: c?.question_ids?.length ?? 0,
        condition_ids: c?.condition_ids?.length ?? 0,
        ...(c?.title_regex ? { title_regex: c.title_regex } : {}),
        ...(c?.requesters?.length ? { requesters: c.requesters.length } : {}),
    });
    return {
        name: s.name,
        description: s.description,
        include: count(s.include),
        exclude: count(s.exclude),
        protocol: s.protocol ?? "any",
        oracle: s.oracle ?? "any",
        resolved_at: s.resolved?.at,
        unresolved: s.resolved?.unresolved ?? [],
    };
}
