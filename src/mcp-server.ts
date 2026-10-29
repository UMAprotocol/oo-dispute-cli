import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { readFileSync } from "fs";
import { userPath } from "./paths";
import { z } from "zod";
import { initConfig } from "./config";
import { Options } from "./handler";
import { ORCHESTRATOR_GUIDE, REVIEWER_POLICY, SERVER_INSTRUCTIONS } from "./review/prompts";
import { openReview, ReviewFlags } from "./review/setup";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// Every tool answers with JSON; failures come back as tool errors the agent can read and correct.
async function respond(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
    try {
        return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 1) }] };
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true };
    }
}

// registerTool's generic zod inference exhausts tsc's memory, so tools are registered through this thin, explicitly typed helper.
type ToolConfig<S extends z.ZodRawShape> = { description: string; inputSchema?: S; annotations?: Record<string, boolean> };
function registerTool<S extends z.ZodRawShape>(server: McpServer, name: string, config: ToolConfig<S>, handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>) {
    (server.registerTool as unknown as (...args: unknown[]) => void).call(server, name, config, handler);
}

const criteria = z
    .object({
        market_ids: z.array(z.string()).optional().describe("Polymarket market ids (the market_id in the ancillary data)"),
        question_ids: z.array(z.string()).optional(),
        condition_ids: z.array(z.string()).optional(),
        slugs: z.array(z.string()).optional().describe("Polymarket market slugs (resolved through Gamma)"),
        event_slugs: z.array(z.string()).optional().describe("Polymarket event slugs (resolved through Gamma)"),
        tags: z.array(z.string()).optional().describe("Gamma tag slugs such as elections (resolved through Gamma)"),
        title_regex: z.string().optional().describe("Case-insensitive regex on the market title"),
        requesters: z.array(z.string()).optional(),
    })
    .optional();

const agentName = z.string().min(1).max(64).describe("Your reviewer name, unique across every session using this queue, e.g. k3f9-r1 (random tag + number)");

export async function startMcpServer(argv: string[]) {
    // The review server never signs. Keep the key out of its environment even if a .env provides one.
    delete process.env.PRIVATE_KEY;
    const program = new Command()
        .option("-o, --oracle <which>", "all, oov2 or managed", "all")
        .option("-p, --only-polymarket", "Only Polymarket requesters", false)
        .option("--db <path>", "Review database (default .oo-dispute/review-<chain>.sqlite)")
        .option("--min-confidence <n>", "Confidence a disagreement needs to become a dispute")
        .option("--confirmations <n>", "Independent reviewers that must agree before disputing")
        .option("--lease-minutes <n>", "How long a claimed group stays reserved", "10")
        .option("--no-market-data", "Do not query Polymarket's public API")
        .option("--select <files...>", "Selection JSON files to load as scopes (also REVIEW_SELECTION, comma-separated)")
        .option("--scope <name>", "Default scope for tools called without one (default: the first selection loaded, else all)")
        .parse(argv, { from: "user" });
    const flags = program.opts<ReviewFlags & { oracle: string; onlyPolymarket: boolean; select?: string[]; scope?: string }>();

    const options: Options = {
        multiplier: "1",
        onlyPolymarket: flags.onlyPolymarket,
        sortRemainingTime: false,
        sortBondSize: false,
        sortRandom: false,
        sortAge: false,
        managedOo: false,
        oracle: flags.oracle,
        batch: false,
        dryRun: true,
    };
    const config = await initConfig(process.env, options, { readOnly: true });
    const { queue, policy } = openReview(config, flags);

    const selectionFiles = [...(flags.select ?? []), ...(process.env.REVIEW_SELECTION ?? "").split(",").map((p) => p.trim()).filter(Boolean)];
    const loaded: string[] = [];
    for (const file of selectionFiles) {
        const scope = await queue.defineScope(JSON.parse(readFileSync(userPath(file), "utf8")));
        loaded.push(scope.name);
        console.error(`Scope "${scope.name}" from ${file}: ${scope.open_proposals_matching} open proposals match${scope.unresolved.length ? `; unresolved: ${scope.unresolved.join(", ")}` : ""}`);
    }
    const defaultScope = flags.scope ?? loaded[0];
    if (defaultScope) queue.scopeMatch(defaultScope); // fail fast on an unknown --scope
    const scopeOf = (scope?: string) => scope ?? defaultScope;
    const scopeParam = z
        .string()
        .optional()
        .describe(`Scope name from list_scopes; "all" for every proposal. Default: ${defaultScope ?? "all"}`);

    const server = new McpServer({ name: "oo-dispute", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
    const readOnly = { readOnlyHint: true, openWorldHint: true };

    registerTool(
        server,
        "review_policy",
        { description: "The policy reviewers must follow. Load it before reviewing.", annotations: readOnly },
        () => respond(() => ({ policy: REVIEWER_POLICY, dispute_thresholds: policy }))
    );

    registerTool(
        server,
        "progress",
        { description: "Queue size, review status counts, unresolved proposals close to expiry, and disputes sent.", inputSchema: { scope: scopeParam }, annotations: readOnly },
        ({ scope }) => respond(async () => {
            await queue.refresh();
            return queue.progress(scopeOf(scope));
        })
    );

    registerTool(
        server,
        "next_batch",
        {
            description:
                "Claim the most urgent groups of proposals that need review (one group = one real-world event) and get everything needed to review them. Claims expire after the lease; submit or release them.",
            inputSchema: {
                agent: agentName,
                max_proposals: z.number().int().min(1).max(25).default(10).describe("Most proposals returned. Larger groups are served across several calls"),
                max_groups: z.number().int().min(1).max(10).default(3),
                scope: scopeParam,
            },
        },
        ({ agent, max_proposals, max_groups, scope }) => respond(() => queue.nextBatch(agent, max_proposals, max_groups, scopeOf(scope)))
    );

    registerTool(
        server,
        "submit_review",
        {
            description:
                "Record verdicts for proposals in a group you claimed. One call per group. Verdicts are validated (price you saw, mutual exclusivity); the dispute decision is made by code from these fields.",
            inputSchema: {
                agent: agentName,
                group_key: z.string(),
                summary: z.string().max(2000).describe("What happened in the event, in one or two sentences"),
                evidence: z.array(z.string()).max(20).describe("URLs you relied on"),
                verdicts: z
                    .array(
                        z.object({
                            proposal_id: z.string(),
                            verdict: z.enum(["p1", "p2", "p3", "p4", "unclear"]),
                            confidence: z.number().min(0).max(1),
                            seen_proposed_price: z.string().describe("Copy of proposed.price from the batch"),
                            reasoning: z.string().max(1000),
                        })
                    )
                    .min(1),
            },
        },
        ({ agent, group_key, summary, evidence, verdicts }) => respond(() => queue.submitReview(agent, group_key, summary, evidence, verdicts))
    );

    registerTool(
        server,
        "release_claim",
        {
            description: "Give a claimed group back to the queue without reviewing it. Omit group_key to release every group you hold (do this before you stop).",
            inputSchema: { agent: agentName, group_key: z.string().optional() },
        },
        ({ agent, group_key }) =>
            respond(() => (group_key ? { released: queue.store.releaseClaim(group_key, agent) } : { released_groups: queue.store.releaseAgentClaims(agent) }))
    );

    registerTool(
        server,
        "get_proposal",
        { description: "Full detail for one proposal, including previous reviews.", inputSchema: { proposal_id: z.string() }, annotations: readOnly },
        ({ proposal_id }) => respond(() => queue.proposalDetail(proposal_id))
    );

    registerTool(
        server,
        "list_queue",
        {
            description: "Open proposals ordered by expiry, with review status.",
            inputSchema: { limit: z.number().int().min(1).max(500).default(50), only_unresolved: z.boolean().default(true), scope: scopeParam },
            annotations: readOnly,
        },
        ({ limit, only_unresolved, scope }) => respond(() => queue.list(limit, only_unresolved, scopeOf(scope)))
    );

    registerTool(
        server,
        "at_risk",
        {
            description: "Open proposals expiring within the given minutes that still lack a final verdict or a sent dispute.",
            inputSchema: { minutes: z.number().min(1).max(240).default(30), scope: scopeParam },
            annotations: readOnly,
        },
        ({ minutes, scope }) => respond(() => queue.atRisk(minutes, scopeOf(scope)))
    );

    registerTool(
        server,
        "dispute_candidates",
        { description: "Proposals whose reviews call for a dispute and that have not been sent yet.", inputSchema: { scope: scopeParam }, annotations: readOnly },
        ({ scope }) =>
            respond(() =>
                queue.candidates(scopeOf(scope)).map(({ stored, evaluation }) => ({
                    ...queue.summary(stored, evaluation, Math.floor(Date.now() / 1000)),
                    confirming_agents: evaluation.confirmingAgents,
                }))
            )
    );

    registerTool(
        server,
        "regroup",
        {
            description: "Put proposals about the same real-world event into one group so they are reviewed together.",
            inputSchema: {
                proposal_ids: z.array(z.string()).min(1).max(200),
                label: z.string().max(200),
                mutually_exclusive: z.boolean().describe("True when at most one of these markets can resolve Yes"),
            },
        },
        ({ proposal_ids, label, mutually_exclusive }) => respond(() => queue.regroup(proposal_ids, label, mutually_exclusive))
    );

    registerTool(
        server,
        "list_scopes",
        { description: "Named selections of markets (scopes) with how many open proposals match and how many still need review.", annotations: readOnly },
        () => respond(() => ({ default_scope: defaultScope ?? "all", scopes: queue.listScopes() }))
    );

    registerTool(
        server,
        "define_scope",
        {
            description:
                "Create or replace a named selection of markets to review, e.g. only the midterm markets. A proposal matches if it matches any include criterion (or include is empty), passes protocol/oracle, and matches no exclude criterion. Slugs, event slugs and tags are resolved through Polymarket's Gamma API when it answers; ids and title_regex work offline.",
            inputSchema: {
                name: z.string().describe("letters, digits, - or _"),
                description: z.string().optional(),
                include: criteria,
                exclude: criteria,
                protocol: z.array(z.enum(["polymarket_v1", "polymarket_v2", "other"])).optional(),
                oracle: z.array(z.enum(["oov2", "managed"])).optional(),
            },
        },
        (args) => respond(() => queue.defineScope(JSON.parse(JSON.stringify(args))))
    );

    server.registerPrompt("dispute-review", { description: "Coordinate a parallel review of open proposals" }, () => ({
        messages: [{ role: "user", content: { type: "text", text: `${ORCHESTRATOR_GUIDE}\n\n${REVIEWER_POLICY}` } }],
    }));

    await server.connect(new StdioServerTransport());
    console.error(`oo-dispute MCP ready: chain ${config.chainId}, oracles ${config.oracles.map((o) => o.kind).join("+")}, policy ${JSON.stringify(policy)}, default scope ${defaultScope ?? "all"}`);
}
