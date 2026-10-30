import type { Provider } from "@ethersproject/abstract-provider";
import { ethers } from "ethers";
import { withRetry } from "./concurrency";
import { conditionId, questionId } from "./polymarket";

// Polymarket's own ids for a UMA request, resolved on chain (no Gamma).
//
// A plain Polymarket UMA CTF adapter uses the UMA question id (keccak256 of the ancillary data) as its question id, and
// the CTF condition is prepared by the adapter itself. Neg-risk markets (every midterm race) go through an adapter
// whose `ctf()` is a NegRiskOperator: Polymarket's question id is `operator.questionIds(umaQuestionId)` (Gamma's
// `questionID`; Gamma calls the UMA one `negRiskRequestID`), and the condition is prepared by the NegRiskAdapter.
export interface PolymarketIds {
    uma_question_id: string;
    polymarket_question_id: string;
    condition_id: string;
    neg_risk: boolean;
}

const ADAPTER_ABI = ["function ctf() view returns (address)"];
const OPERATOR_ABI = ["function questionIds(bytes32) view returns (bytes32)", "function nrAdapter() view returns (address)"];

type NegRiskRoute = { operator: ethers.Contract; nrAdapter: string } | null;

export class PolymarketIdResolver {
    private routes = new Map<string, Promise<NegRiskRoute>>();
    private ids = new Map<string, Promise<PolymarketIds>>();

    constructor(private provider: Provider) {}

    // Whether this requester is an adapter wired to a NegRiskOperator. Anything that doesn't answer these calls (an
    // adapter on plain ConditionalTokens, or not an adapter at all) is treated as a plain request.
    private route(requester: string): Promise<NegRiskRoute> {
        const key = requester.toLowerCase();
        if (!this.routes.has(key)) {
            this.routes.set(
                key,
                (async () => {
                    try {
                        const ctf: string = await withRetry(() => new ethers.Contract(requester, ADAPTER_ABI, this.provider).ctf(), 2);
                        const operator = new ethers.Contract(ctf, OPERATOR_ABI, this.provider);
                        const nrAdapter: string = await withRetry(() => operator.nrAdapter(), 2);
                        return { operator, nrAdapter };
                    } catch {
                        return null;
                    }
                })()
            );
        }
        return this.routes.get(key)!;
    }

    resolve(requester: string, ancillaryData: string): Promise<PolymarketIds> {
        const umaId = questionId(ancillaryData).toLowerCase();
        const key = `${requester.toLowerCase()}:${umaId}`;
        if (!this.ids.has(key)) {
            const lookup = (async () => {
                const route = await this.route(requester);
                if (route) {
                    const negRiskId: string = await withRetry(() => route.operator.questionIds(umaId));
                    if (negRiskId !== ethers.constants.HashZero) {
                        return { uma_question_id: umaId, polymarket_question_id: negRiskId.toLowerCase(), condition_id: conditionId(route.nrAdapter, negRiskId), neg_risk: true };
                    }
                }
                return { uma_question_id: umaId, polymarket_question_id: umaId, condition_id: conditionId(requester, umaId), neg_risk: false };
            })();
            // A failed lookup (RPC down) is retried next time instead of being cached.
            lookup.catch(() => this.ids.delete(key));
            this.ids.set(key, lookup);
        }
        return this.ids.get(key)!;
    }
}
