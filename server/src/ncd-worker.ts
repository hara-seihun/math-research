import { parentPort } from "node:worker_threads";
import { alphaLean, alphaProse, bands, prepare, similarity } from "./similarity.ts";

// Alpha normalization and compression distance are the one stretch of request
// handling that is pure CPU with no await in it: a hundred and fifty units
// normalized and compressed, on a single-threaded runtime, is a hundred and
// fifty chances to stall every other request in flight. It runs here instead.

export type Unit = { id: string; text: string };
export type Mode = "prose" | "lean";

export type NcdJob =
  | { id: number; kind: "rank"; mode: Mode; query: string; normalized?: boolean; candidates: Unit[] }
  | { id: number; kind: "cluster"; mode: Mode; normalized?: boolean; units: Unit[]; threshold: number; limit: number };

export type Scored = { id: string; similarity: number };
export type Pair = { a: string; b: string; similarity: number };
export type NcdDone =
  | { id: number; kind: "rank"; scored: Scored[] }
  | { id: number; kind: "cluster"; pairs: Pair[]; compared: number; matched: number; truncated: boolean };

/** Comparisons one cluster job may spend. Bucketing usually keeps a page far
 *  under this; a slice of templated entries blows through it, because every
 *  member collides with every other on boilerplate they all share. Sized so
 *  the worst case is ~1.5s of worker time rather than an unbounded stall. */
const PAIR_BUDGET = 40_000;

const normalize = (mode: Mode, text: string): string => (mode === "lean" ? alphaLean(text) : alphaProse(text));

function rank(job: Extract<NcdJob, { kind: "rank" }>): Scored[] {
  const query = prepare(job.normalized ? job.query : normalize(job.mode, job.query));
  return job.candidates.map((c) => ({
    id: c.id,
    similarity: similarity(query, job.normalized ? c.text : normalize(job.mode, c.text)),
  }));
}

// All-pairs NCD over a module is quadratic in the thing agents most want
// scanned. The band signatures make the pair count linear in what is actually
// near-duplicate, and NCD then scores only those pairs, using the same signatures
// the corpus is indexed by, so a scan here and a lookup in Postgres agree
// about who is worth comparing.
function cluster(job: Extract<NcdJob, { kind: "cluster" }>): { pairs: Pair[]; compared: number; matched: number; truncated: boolean } {
  const texts = job.units.map((u) => (job.normalized ? u.text : normalize(job.mode, u.text)));
  const buckets = new Map<number, number[]>();
  texts.forEach((text, i) => {
    for (const band of bands(text)) (buckets.get(band) ?? buckets.set(band, []).get(band)!).push(i);
  });

  // Smallest buckets first, then spend the budget. Bucket size is inverse
  // evidence: two entries alone in a band collided on something specific to
  // them, while a hundred entries sharing a band share a template, and their
  // pairs are both the least informative and the ones that explode the count.
  // Truncating in this order spends the budget on the pairs worth scoring.
  const seen = new Set<number>();
  const candidates: [number, number][] = [];
  let truncated = false;
  for (const bucket of [...buckets.values()].sort((x, y) => x.length - y.length)) {
    if (bucket.length < 2 || bucket.length > 200) continue;
    if (candidates.length >= PAIR_BUDGET) { truncated = true; break; }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!, b = bucket[j]!;
        const key = a * job.units.length + b;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push([a, b]);
      }
    }
  }

  const pairs: Pair[] = [];
  const prepared = new Map<number, ReturnType<typeof prepare>>();
  for (const [a, b] of candidates) {
    const query = prepared.get(a) ?? prepared.set(a, prepare(texts[a]!)).get(a)!;
    const score = similarity(query, texts[b]!);
    if (score >= job.threshold) pairs.push({ a: job.units[a]!.id, b: job.units[b]!.id, similarity: score });
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  // `matched` is the population, `pairs` is the page of it a caller asked to
  // see. A sweep that clears the threshold four hundred times and returns
  // fifty of them has to say so, or the caller reads a full page as a
  // finished job -- and a demand probe measuring the backlog reads the limit
  // it passed in rather than the work that is there.
  return { pairs: pairs.slice(0, job.limit), compared: candidates.length, matched: pairs.length, truncated };
}

parentPort!.on("message", (job: NcdJob) => {
  const done: NcdDone =
    job.kind === "rank"
      ? { id: job.id, kind: "rank", scored: rank(job) }
      : { id: job.id, kind: "cluster", ...cluster(job) };
  parentPort!.postMessage(done);
});
