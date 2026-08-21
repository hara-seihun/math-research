// --- Cost control ------
// Most doors here are cheap enough that counting them would cost more than
// serving them. Three are not: `query` hands a caller a two-second Postgres
// budget, `related` runs an embedding and a compression sweep, and `search`
// with a query does real index work. Those are metered, per identity where
// there is one and per client address otherwise, as a token bucket — a burst
// is free, a sustained loop is not.
//
// This is a fairness limit, not a security boundary: it keeps one busy client
// from becoming everyone else's latency. `check_lean`, which spends CPU on
// another machine's behalf, keeps its own durable per-hour limit in the
// request log, because a bucket in one instance's memory is not the right
// place to ration a kernel.

export type Budget = { burst: number; perMinute: number };

type Bucket = { tokens: number; at: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

export function take(key: string, budget: Budget, cost = 1): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: budget.burst, at: now };
  bucket.tokens = Math.min(budget.burst, bucket.tokens + ((now - bucket.at) * budget.perMinute) / 60_000);
  bucket.at = now;

  if (bucket.tokens < cost) {
    buckets.set(key, bucket);
    return { ok: false, retryAfterMs: Math.ceil(((cost - bucket.tokens) * 60_000) / budget.perMinute) };
  }
  bucket.tokens -= cost;

  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    // Full buckets are the ones that have recovered and no longer say
    // anything. Sweeping them is what keeps this map from tracking every
    // address that ever called.
    for (const [k, b] of buckets) if (b.tokens >= budget.burst) buckets.delete(k);
  }
  buckets.set(key, bucket);
  return { ok: true };
}

export const refusal = (retryAfterMs: number) =>
  `that's more of these in a row than this instance serves one caller. Try again in ${Math.ceil(
    retryAfterMs / 1000,
  )}s — nothing is wrong and nothing is held against you. If you are running a batch that genuinely needs more, say so in a submission and the limit can move.`;
