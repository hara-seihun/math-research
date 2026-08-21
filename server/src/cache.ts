import { sql } from "./db.ts";

// --- Shared read results ------
// The read surface is anonymous, deterministic, and repeated: every new client
// opens with hello, every browser of a programme asks fronts the same
// question, and a news window is identical for everyone holding the same
// cursor. Deriving each of those once per caller is the difference between
// serving a crowd and serving a queue.
//
// Two things keep it honest. Entries are keyed by a corpus epoch that every
// write bumps, so "it is live and searchable right away" stays literally true.
// A submission invalidates every cached read across every instance before
// the submitter's next call. And the epoch is carried between instances by
// Postgres NOTIFY, with a ttl underneath it so a lost listener bounds the
// damage at seconds instead of forever.

const TTL_MS = Number(process.env.READ_CACHE_TTL_MS ?? 30_000);
const MAX_ENTRIES = Number(process.env.READ_CACHE_ENTRIES ?? 2048);
const CHANNEL = "math_write";

let epoch = 0;

type Entry = { at: number; epoch: number; value: Promise<unknown> };
const entries = new Map<string, Entry>();

/** Announce that the corpus moved. Every instance drops what it had cached. */
export async function announceWrite(): Promise<void> {
  epoch += 1;
  try {
    await sql.notify(CHANNEL, String(Date.now()));
  } catch (error) {
    console.error("write notification failed", error);
  }
}

export async function listenForWrites(): Promise<void> {
  await sql.listen(CHANNEL, () => {
    epoch += 1;
  });
}

const fresh = (entry: Entry): boolean => entry.epoch === epoch && Date.now() - entry.at < TTL_MS;

/**
 * Run `produce` unless an identical, still-current call is already cached or
 * in flight. Concurrent callers of the same key share one execution, so a
 * thundering herd on a cold entry costs one query rather than one per caller.
 */
export function shared<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && fresh(hit)) return hit.value as Promise<T>;

  const value = produce();
  const entry: Entry = { at: Date.now(), epoch, value };
  entries.set(key, entry);
  // A failed call is not a result. Drop it so the next caller retries instead
  // of being handed the same rejection for the rest of the ttl.
  void value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });

  if (entries.size > MAX_ENTRIES) {
    // Insertion order is close enough to least-recently-produced here, and it
    // costs nothing to maintain. Drop the oldest eighth in one pass rather
    // than one entry per insert forever after.
    let drop = entries.size - Math.floor((MAX_ENTRIES * 7) / 8);
    for (const k of entries.keys()) {
      if (drop-- <= 0) break;
      entries.delete(k);
    }
  }
  return value;
}

/** Stable regardless of the order a client happened to send arguments in. */
export function cacheKey(tool: string, args: Record<string, unknown>): string {
  const stable = (v: unknown): unknown =>
    v === null || typeof v !== "object"
      ? v
      : Array.isArray(v)
        ? v.map(stable)
        : Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, stable(x)]),
          );
  return `${tool}:${JSON.stringify(stable(args))}`;
}
