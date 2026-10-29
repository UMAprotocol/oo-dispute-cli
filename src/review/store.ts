import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { BigNumber } from "ethers";
import { CreatorUpdates, MarketData, ParsedAncillary, Verdict } from "../polymarket";
import { Proposal } from "../proposals";
import { DecisionRecord } from "./policy";

// Shared state for every MCP process and `apply` on this machine. SQLite in WAL mode lets several agents claim work
// concurrently; claims are leases, so a crashed agent's work returns to the queue.

export interface ProposalContext {
    parsed: ParsedAncillary;
    market: MarketData;
    updates?: CreatorUpdates;
}

export interface StoredProposal {
    id: string;
    proposal: Proposal;
    groupKey: string;
    status: "open" | "disputed" | "settled";
    context: ProposalContext;
    firstSeen: number;
}

export interface GroupRow {
    groupKey: string;
    label: string;
    exclusive: boolean;
    source: "negrisk" | "event" | "description" | "single" | "manual";
}

export interface DisputeRow {
    proposalId: string;
    status: "sending" | "disputed" | "already-disputed" | "failed" | "skipped";
    txHash?: string;
    detail?: string;
    updatedAt: number;
}

const BIGNUMBER_FIELDS = ["bond", "requestTimestamp", "timestamp", "proposedPrice", "proposalExpirationTimestamp"] as const;

function serializeProposal(proposal: Proposal): string {
    return JSON.stringify(proposal, (_, value) => (value && value.type === "BigNumber" ? BigNumber.from(value).toString() : value));
}

function deserializeProposal(json: string): Proposal {
    const raw = JSON.parse(json);
    for (const field of BIGNUMBER_FIELDS) raw[field] = BigNumber.from(raw[field]);
    return raw as Proposal;
}

export const now = () => Math.floor(Date.now() / 1000);

// Required lazily so the error is explicit on Node versions without (unflagged) node:sqlite.
function openDatabase(path: string): DatabaseSync {
    let sqlite: typeof import("node:sqlite");
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        sqlite = require("node:sqlite");
    } catch {
        throw new Error(`The review queue (yarn mcp / yarn apply) needs Node 22.13 or later; this is ${process.version}. yarn dispute works on older versions.`);
    }
    return new sqlite.DatabaseSync(path);
}

export class ReviewStore {
    readonly db: DatabaseSync;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = openDatabase(path);
        // busy_timeout must come first: several processes may open a fresh database at the same moment.
        this.db.exec(`
            PRAGMA busy_timeout = 10000;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS proposals (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                context TEXT NOT NULL,
                group_key TEXT NOT NULL,
                proposer TEXT NOT NULL,
                proposed_price TEXT NOT NULL,
                expiration INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                first_seen INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS proposals_group ON proposals(group_key);
            CREATE INDEX IF NOT EXISTS proposals_open ON proposals(status, expiration);
            CREATE TABLE IF NOT EXISTS groups (
                group_key TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                exclusive INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS claims (group_key TEXT PRIMARY KEY, agent TEXT NOT NULL, lease_until INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_key TEXT NOT NULL,
                agent TEXT NOT NULL,
                summary TEXT NOT NULL,
                evidence TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                proposal_id TEXT NOT NULL,
                review_id INTEGER NOT NULL,
                agent TEXT NOT NULL,
                verdict TEXT NOT NULL,
                verdict_price TEXT,
                confidence REAL NOT NULL,
                reasoning TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                recheck_after INTEGER
            );
            CREATE INDEX IF NOT EXISTS decisions_proposal ON decisions(proposal_id);
            CREATE TABLE IF NOT EXISTS scopes (name TEXT PRIMARY KEY, definition TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS disputes (
                proposal_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                tx_hash TEXT,
                detail TEXT,
                updated_at INTEGER NOT NULL
            );
        `);
        // Databases created before scopes existed: the claim remembers the scope the agent was working in.
        if (!(this.db.prepare("PRAGMA table_info(claims)").all() as { name: string }[]).some((c) => c.name === "scope")) {
            this.db.exec("ALTER TABLE claims ADD COLUMN scope TEXT");
        }
    }

    // BEGIN IMMEDIATE takes the write lock up front, so two agents can't claim the same group.
    transaction<T>(fn: () => T): T {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    getMeta(key: string): string | undefined {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
        return row?.value;
    }

    setMeta(key: string, value: string) {
        this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    }

    // A named lock with a lease, e.g. so only one process scans the chain at a time.
    tryLock(name: string, owner: string, seconds: number): boolean {
        return this.transaction(() => {
            const current = this.getMeta(`lock:${name}`);
            if (current) {
                const [holder, until] = current.split("|");
                if (holder !== owner && Number(until) > now()) return false;
            }
            this.setMeta(`lock:${name}`, `${owner}|${now() + seconds}`);
            return true;
        });
    }

    unlock(name: string, owner: string) {
        const current = this.getMeta(`lock:${name}`);
        if (current?.startsWith(`${owner}|`)) this.db.prepare("DELETE FROM meta WHERE key = ?").run(`lock:${name}`);
    }

    insertProposal(id: string, proposal: Proposal, context: ProposalContext, group: GroupRow): boolean {
        this.db.prepare("INSERT OR IGNORE INTO groups (group_key, label, exclusive, source) VALUES (?, ?, ?, ?)").run(group.groupKey, group.label, group.exclusive ? 1 : 0, group.source);
        const result = this.db
            .prepare(
                `INSERT OR IGNORE INTO proposals (id, data, context, group_key, proposer, proposed_price, expiration, first_seen)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(id, serializeProposal(proposal), JSON.stringify(context), group.groupKey, proposal.proposer.toLowerCase(), proposal.proposedPrice.toString(), proposal.proposalExpirationTimestamp.toNumber(), now());
        return Number(result.changes) > 0;
    }

    updateContext(id: string, context: ProposalContext) {
        this.db.prepare("UPDATE proposals SET context = ? WHERE id = ?").run(JSON.stringify(context), id);
    }

    markDisputed(ids: string[]) {
        const statement = this.db.prepare("UPDATE proposals SET status = 'disputed' WHERE id = ?");
        for (const id of ids) statement.run(id);
    }

    markSettled(ids: string[]) {
        const statement = this.db.prepare("UPDATE proposals SET status = 'settled' WHERE id = ? AND status = 'open'");
        for (const id of ids) statement.run(id);
    }

    private toStored(row: Record<string, unknown>): StoredProposal {
        return {
            id: row.id as string,
            proposal: deserializeProposal(row.data as string),
            groupKey: row.group_key as string,
            status: row.status as StoredProposal["status"],
            context: JSON.parse(row.context as string),
            firstSeen: row.first_seen as number,
        };
    }

    getProposal(id: string): StoredProposal | undefined {
        const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row ? this.toStored(row) : undefined;
    }

    // Proposals that can still be disputed: within liveness, or past it on the Managed OOv2 until a Settle event marks
    // them settled (its resolver settles; until then ManagedOptimisticOracleV2 still accepts disputes).
    openProposals(atTime = now()): StoredProposal[] {
        return (
            this.db
                .prepare("SELECT * FROM proposals WHERE status = 'open' AND (expiration > ? OR json_extract(data, '$.oracleKind') = 'managed') ORDER BY expiration")
                .all(atTime) as Record<string, unknown>[]
        ).map((r) => this.toStored(r));
    }

    groupProposals(groupKey: string): StoredProposal[] {
        return (this.db.prepare("SELECT * FROM proposals WHERE group_key = ? ORDER BY expiration").all(groupKey) as Record<string, unknown>[]).map((r) => this.toStored(r));
    }

    getGroup(groupKey: string): GroupRow | undefined {
        const row = this.db.prepare("SELECT * FROM groups WHERE group_key = ?").get(groupKey) as Record<string, unknown> | undefined;
        return row ? { groupKey: row.group_key as string, label: row.label as string, exclusive: row.exclusive === 1, source: row.source as GroupRow["source"] } : undefined;
    }

    regroup(ids: string[], group: GroupRow) {
        this.db.prepare("INSERT OR REPLACE INTO groups (group_key, label, exclusive, source) VALUES (?, ?, ?, ?)").run(group.groupKey, group.label, group.exclusive ? 1 : 0, group.source);
        const statement = this.db.prepare("UPDATE proposals SET group_key = ? WHERE id = ?");
        for (const id of ids) statement.run(group.groupKey, id);
    }

    proposerCounts(): Map<string, number> {
        const rows = this.db.prepare("SELECT proposer, COUNT(*) AS n FROM proposals GROUP BY proposer").all() as { proposer: string; n: number }[];
        return new Map(rows.map((r) => [r.proposer, r.n]));
    }

    claims(): Map<string, { agent: string; leaseUntil: number; scope?: string }> {
        const rows = this.db.prepare("SELECT * FROM claims").all() as { group_key: string; agent: string; lease_until: number; scope: string | null }[];
        return new Map(rows.map((r) => [r.group_key, { agent: r.agent, leaseUntil: r.lease_until, scope: r.scope ?? undefined }]));
    }

    claim(groupKey: string, agent: string, leaseUntil: number, scope?: string) {
        this.db.prepare("INSERT OR REPLACE INTO claims (group_key, agent, lease_until, scope) VALUES (?, ?, ?, ?)").run(groupKey, agent, leaseUntil, scope ?? null);
    }

    putScope(name: string, definition: unknown) {
        this.db.prepare("INSERT OR REPLACE INTO scopes (name, definition, updated_at) VALUES (?, ?, ?)").run(name, JSON.stringify(definition), now());
    }

    getScope(name: string): unknown | undefined {
        const raw = this.getScopeRaw(name);
        return raw ? JSON.parse(raw) : undefined;
    }

    getScopeRaw(name: string): string | undefined {
        return (this.db.prepare("SELECT definition FROM scopes WHERE name = ?").get(name) as { definition: string } | undefined)?.definition;
    }

    scopeNames(): string[] {
        return (this.db.prepare("SELECT name FROM scopes ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    }

    releaseClaim(groupKey: string, agent: string): boolean {
        return Number(this.db.prepare("DELETE FROM claims WHERE group_key = ? AND agent = ?").run(groupKey, agent).changes) > 0;
    }

    // Every group an agent holds, e.g. when it stops early or never saw what a batch claimed.
    releaseAgentClaims(agent: string): string[] {
        return this.transaction(() => {
            const keys = (this.db.prepare("SELECT group_key FROM claims WHERE agent = ?").all(agent) as { group_key: string }[]).map((r) => r.group_key);
            this.db.prepare("DELETE FROM claims WHERE agent = ?").run(agent);
            return keys;
        });
    }

    decisionsByProposal(ids?: string[]): Map<string, DecisionRecord[]> {
        const rows = (ids
            ? this.db.prepare(`SELECT * FROM decisions WHERE proposal_id IN (${ids.map(() => "?").join(",")})`).all(...ids)
            : this.db.prepare("SELECT d.* FROM decisions d JOIN proposals p ON p.id = d.proposal_id WHERE p.status = 'open'").all()) as Record<string, unknown>[];
        const map = new Map<string, DecisionRecord[]>();
        for (const row of rows) {
            const id = row.proposal_id as string;
            if (!map.has(id)) map.set(id, []);
            map.get(id)!.push({
                agent: row.agent as string,
                verdict: row.verdict as Verdict,
                verdictPrice: (row.verdict_price as string | null) ?? undefined,
                confidence: row.confidence as number,
                createdAt: row.created_at as number,
                recheckAfter: (row.recheck_after as number | null) ?? undefined,
            });
        }
        return map;
    }

    decisionDetails(id: string) {
        return this.db.prepare("SELECT d.agent, d.verdict, d.confidence, d.reasoning, d.created_at, r.summary FROM decisions d JOIN reviews r ON r.id = d.review_id WHERE d.proposal_id = ? ORDER BY d.created_at").all(id);
    }

    insertReview(groupKey: string, agent: string, summary: string, evidence: string[]): number {
        const result = this.db.prepare("INSERT INTO reviews (group_key, agent, summary, evidence, created_at) VALUES (?, ?, ?, ?, ?)").run(groupKey, agent, summary, JSON.stringify(evidence), now());
        return Number(result.lastInsertRowid);
    }

    insertDecision(reviewId: number, proposalId: string, agent: string, verdict: Verdict, verdictPrice: string | undefined, confidence: number, reasoning: string, recheckAfter?: number) {
        this.db
            .prepare(
                `INSERT INTO decisions (proposal_id, review_id, agent, verdict, verdict_price, confidence, reasoning, created_at, recheck_after)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(proposalId, reviewId, agent, verdict, verdictPrice ?? null, confidence, reasoning, now(), recheckAfter ?? null);
    }

    disputes(): Map<string, DisputeRow> {
        const rows = this.db.prepare("SELECT * FROM disputes").all() as Record<string, unknown>[];
        return new Map(
            rows.map((r) => [
                r.proposal_id as string,
                { proposalId: r.proposal_id as string, status: r.status as DisputeRow["status"], txHash: (r.tx_hash as string) ?? undefined, detail: (r.detail as string) ?? undefined, updatedAt: r.updated_at as number },
            ])
        );
    }

    setDispute(proposalId: string, status: DisputeRow["status"], txHash?: string, detail?: string) {
        this.db
            .prepare("INSERT OR REPLACE INTO disputes (proposal_id, status, tx_hash, detail, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(proposalId, status, txHash ?? null, detail ?? null, now());
    }
}
