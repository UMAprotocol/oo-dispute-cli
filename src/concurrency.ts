export function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries `fn` with exponential backoff. RPC calls fail transiently under load; a single failure must not abort a run.
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 500): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt >= retries) throw error;
            await delay(baseDelayMs * 2 ** attempt);
        }
    }
}

// Like Promise.all over `items.map(fn)`, but with at most `limit` calls in flight so thousands of proposals don't
// trip RPC rate limits. Results keep the input order.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}
