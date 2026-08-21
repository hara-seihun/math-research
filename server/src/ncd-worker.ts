import { parentPort } from "node:worker_threads";
import { alphaLean, alphaProse, prepare, similarity } from "./similarity.ts";

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
  | { id: number; kind: "cluster"; pairs: Pair[]; compared: number };

const normalize = (mode: Mode, text: string): string => (mode === "lean" ? alphaLean(text) : alphaProse(text));

function rank(job: Extract<NcdJob, { kind: "rank" }>): Scored[] {
  const query = prepare(job.normalized ? job.query : normalize(job.mode, job.query));
  return job.candidates.map((c) => ({
    id: c.id,
    similarity: similarity(query, job.normalized ? c.text : normalize(job.mode, c.text)),
  }));
}

// Shingle sketches decide who is worth compressing against whom. All-pairs NCD
// over a module is quadratic in the thing agents most want scanned; banded
// minhash makes the pair count linear in what is actually near-duplicate, and
// NCD then scores only those pairs. The sketch is never the answer: it decides
// what to look at.
const SKETCH = 64;
const BAND = 4;

function sketch(s: string): Int32Array {
  const seen = new Set<number>();
  for (let i = 0; i + 6 <= s.length; i++) {
    let h = 2166136261;
    for (let j = i; j < i + 6; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    seen.add(h >>> 0);
  }
  const out = new Int32Array(SKETCH).fill(0x7fffffff);
  for (const h of seen) {
    for (let i = 0; i < SKETCH; i++) {
      const v = Math.imul(h ^ (i * 0x9e3779b1), 0x85ebca6b) >>> 1;
      if (v < out[i]!) out[i] = v;
    }
  }
  return out;
}

function cluster(job: Extract<NcdJob, { kind: "cluster" }>): { pairs: Pair[]; compared: number } {
  const texts = job.units.map((u) => (job.normalized ? u.text : normalize(job.mode, u.text)));
  const buckets = new Map<string, number[]>();
  texts.forEach((text, i) => {
    const sk = sketch(text);
    for (let b = 0; b < SKETCH / BAND; b++) {
      const key = `${b}:${sk[b * BAND]},${sk[b * BAND + 1]},${sk[b * BAND + 2]},${sk[b * BAND + 3]}`;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(i);
    }
  });

  const seen = new Set<number>();
  const candidates: [number, number][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > 200) continue;
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
  return { pairs: pairs.slice(0, job.limit), compared: candidates.length };
}

parentPort!.on("message", (job: NcdJob) => {
  const done: NcdDone =
    job.kind === "rank"
      ? { id: job.id, kind: "rank", scored: rank(job) }
      : { id: job.id, kind: "cluster", ...cluster(job) };
  parentPort!.postMessage(done);
});
