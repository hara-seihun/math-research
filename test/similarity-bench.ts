/**
 * Which similarity implementation should the ledger ship?
 *
 * Two questions, measured rather than argued: how fast is each one in
 * requests per second at the candidate counts the tools actually use, and how
 * well does each one rank the thing a caller was looking for. Ground truth is
 * the ledger's own asserted links (`duplicate-of` and friends, thousands of
 * them, none of them written by this benchmark) plus a renaming task on real
 * Lean statements, where the correct answer is known by construction and
 * every incidental name has been changed.
 *
 *   test/similarity-corpus.sh          # dump the corpus (once)
 *   bun test/similarity-bench.ts       # measure
 *
 * `--task=ledger|renamed|lean|prefilter|speed|dupes|sweep`, `--queries=N`,
 * `--pool=N`, and `--page=N` for the sweep.
 * A full run takes 45 seconds: the tasks share nothing, so they run as
 * separate processes, and the candidate pools are cached under `.bench/cache`
 * because indexing a quarter-million declarations does not change between
 * runs of the same corpus.
 *
 * The ledger's `duplicate-of` edges are not usable ground truth: all 1,075 of
 * them come from one retracted import that pointed every source at the same
 * target. What is left is the relations agents assert while working
 * (`specializes`, `refines`, `generalizes`, `supersedes`, `parallels`), which
 * are semantic rather than textual and are therefore a floor, not a target;
 * the renaming tasks, where the answer is known by construction; and the
 * clusters the shipped configuration finds in the wild, which are for reading.
 */
import zlib from "node:zlib";
import { alphaLean, alphaProse, bands, flatten, isGenerated, leanBlocks, prepare, similarity } from "../server/src/similarity.ts";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const DIR = arg("dir", ".bench");
const QUERIES = Number(arg("queries", "80"));
const POOL = Number(arg("pool", "150"));
const TASKS = arg("task", "ledger,renamed,lean,prefilter,speed,dupes,sweep").split(",");

// --- Normalizers ------

const plain = (s: string): string =>
  s.normalize("NFKD").replace(/[\u2010-\u2015\u2212]/g, "-").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 4000);

type Normalizer = { name: string; run: (s: string) => string };

const PROSE_NORMALIZERS: Normalizer[] = [
  { name: "plain", run: plain },
  { name: "alpha", run: (s) => alphaProse(s) },
];

const LEAN_NORMALIZERS: Normalizer[] = [
  { name: "plain", run: plain },
  { name: "alpha-prose", run: (s) => alphaProse(s) },
  { name: "alpha-lean", run: (s) => alphaLean(s) },
  { name: "alpha-lean-stmt", run: (s) => alphaLean(s, { body: false }) },
  // Numbering by first occurrence is what identity needs and what similarity
  // cannot afford: one extra typeclass binder shifts every later index, and
  // two statements that say the same thing stop sharing substrings.
  { name: "alpha-lean-flat", run: (s) => flatten(alphaLean(s)) },
];

// --- Scorers ------
// Every scorer prepares the query once and then scores candidates that have
// already been normalized, which is the shape both tools call it in.

type Scorer = {
  name: string;
  prepare: (query: string) => (candidate: string) => number;
};

const bytes = (s: string) => Buffer.from(s);

const concatNcd = (name: string, size: (b: Buffer) => number): Scorer => ({
  name,
  prepare: (query) => {
    const x = bytes(query);
    const cx = size(x);
    return (candidate: string) => {
      const y = bytes(candidate);
      const cy = size(y);
      if (!cy) return 0;
      const cxy = size(Buffer.concat([x, Buffer.from("\n"), y]));
      return 1 - (cxy - Math.min(cx, cy)) / Math.max(cx, cy);
    };
  },
});

const gzipSize = (b: Buffer) => zlib.gzipSync(b).length;
const deflateSize = (b: Buffer) => zlib.deflateRawSync(b, { level: 6, memLevel: 9 }).length;
const zstdSize = (b: Buffer) => Bun.zstdCompressSync(b, { level: 3 }).length;
const zstd19Size = (b: Buffer) => Bun.zstdCompressSync(b, { level: 19 }).length;
const brotliSize = (b: Buffer) =>
  zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 2, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;

/** C(y|x) straight from deflate's preset dictionary: one compression per
 *  candidate rather than two, and no 32 KB window truncation. */
const dictNcd: Scorer = {
  name: "ncd-dict",
  prepare: (query) => {
    const dictionary = bytes(query);
    const cx = deflateSize(dictionary);
    return (candidate: string) => {
      const y = bytes(candidate);
      const cy = deflateSize(y);
      if (!cy) return 0;
      const cxy = cx + zlib.deflateRawSync(y, { level: 6, memLevel: 9, dictionary }).length;
      return 1 - (cxy - Math.min(cx, cy)) / Math.max(cx, cy);
    };
  },
};

// --- Cheap non-compression baselines ------

function shingles(s: string, k = 6): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + k <= s.length; i++) {
    let h = 2166136261;
    for (let j = i; j < i + k; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    out.add(h >>> 0);
  }
  return out;
}

const jaccard: Scorer = {
  name: "jaccard",
  prepare: (query) => {
    const a = shingles(query);
    return (candidate: string) => {
      const b = shingles(candidate);
      if (!b.size) return 0;
      let shared = 0;
      for (const h of b) if (a.has(h)) shared++;
      return shared / (a.size + b.size - shared);
    };
  },
};

/** Asymmetric containment: how much of the candidate the query already covers.
 *  Robust to one side being much longer than the other. */
const containment: Scorer = {
  name: "containment",
  prepare: (query) => {
    const a = shingles(query);
    return (candidate: string) => {
      const b = shingles(candidate);
      if (!b.size) return 0;
      let shared = 0;
      for (const h of b) if (a.has(h)) shared++;
      return shared / b.size;
    };
  },
};

const SKETCH = 64;

function minhash(s: string): Int32Array {
  const sk = new Int32Array(SKETCH).fill(0x7fffffff);
  for (const h of shingles(s)) {
    for (let i = 0; i < SKETCH; i++) {
      const v = Math.imul(h ^ (i * 0x9e3779b1), 0x85ebca6b) >>> 1;
      if (v < sk[i]!) sk[i] = v;
    }
  }
  return sk;
}

const minhashScorer: Scorer = {
  name: "minhash64",
  prepare: (query) => {
    const a = minhash(query);
    return (candidate: string) => {
      const b = minhash(candidate);
      let same = 0;
      for (let i = 0; i < SKETCH; i++) if (a[i] === b[i]) same++;
      return same / SKETCH;
    };
  },
};

const SCORERS: Scorer[] = [
  concatNcd("ncd-gzip", gzipSize),
  concatNcd("ncd-deflate", deflateSize),
  concatNcd("ncd-zstd3", zstdSize),
  concatNcd("ncd-zstd19", zstd19Size),
  concatNcd("ncd-brotli2", brotliSize),
  dictNcd,
  jaccard,
  containment,
  minhashScorer,
];

// --- Corpus ------

type Contribution = {
  id: string; kind: string; title: string; summary: string; content: string;
  tier: number; notability: number; lean_verified: boolean; status: string;
};
type Decl = { name: string; module: string; library: string; kind: string; is_proof: boolean; statement: string };
type Edge = { src: string; dst: string; rel: string; tier: number };

const readJsonl = async <T>(file: string): Promise<T[]> =>
  (await Bun.file(`${DIR}/${file}`).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

/** Building the candidate pools means indexing a quarter of a million
 *  declarations, which is most of a run and does not change between runs of
 *  the same corpus. Keyed by the corpus files' sizes, so a re-dumped corpus
 *  rebuilds and nothing else does. */
async function cached<T>(key: string, build: () => Promise<T>): Promise<T> {
  const sizes = await Promise.all(
    ["contribs.jsonl", "decls.jsonl", "edges.jsonl"].map(async (f) => Bun.file(`${DIR}/${f}`).size),
  );
  const path = `${DIR}/cache/${key}-${QUERIES}-${POOL}-${sizes.join("-")}.json`;
  const file = Bun.file(path);
  if (await file.exists()) return (await file.json()) as T;
  const value = await build();
  await Bun.write(path, JSON.stringify(value));
  return value;
}

// --- Lexical prefilter, standing in for the tools' Postgres prefilter ------
// The candidate pool decides what a ranker can possibly find, so the bench
// ranks inside a pool built the same way production builds one: cheap term
// overlap, everything the ranker must then sort out.

class Bm25 {
  private readonly postings = new Map<string, number[]>();
  private readonly lengths: number[] = [];
  private avg = 0;
  constructor(private readonly docs: string[]) {
    docs.forEach((doc, i) => {
      const tf = new Map<string, number>();
      for (const w of Bm25.terms(doc)) tf.set(w, (tf.get(w) ?? 0) + 1);
      this.lengths[i] = tf.size;
      this.avg += tf.size;
      for (const w of tf.keys()) (this.postings.get(w) ?? this.postings.set(w, []).get(w)!).push(i);
    });
    this.avg /= Math.max(1, docs.length);
  }
  static terms(doc: string): string[] {
    return doc.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'.]{2,}/gu)?.slice(0, 400) ?? [];
  }
  top(query: string, k: number, exclude?: number): number[] {
    const scores = new Map<number, number>();
    const N = this.docs.length;
    for (const w of new Set(Bm25.terms(query))) {
      const posting = this.postings.get(w);
      if (!posting || posting.length > N / 8) continue;
      const idf = Math.log(1 + (N - posting.length + 0.5) / (posting.length + 0.5));
      for (const d of posting) {
        if (d === exclude) continue;
        scores.set(d, (scores.get(d) ?? 0) + idf / (1 + this.lengths[d]! / this.avg));
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([d]) => d);
  }
}

// --- Ranking evaluation ------

type Case = { query: string; gold: number; pool: number[] };

/** One normalizer's view of a corpus, computed once and shared by every
 *  scorer measured against it, since otherwise nine scorers normalize the same
 *  45,000 texts nine times, which was most of the benchmark's runtime. */
class Normalized {
  private readonly byIndex = new Map<number, string>();
  private readonly byText = new Map<string, string>();
  constructor(readonly normalizer: Normalizer, private readonly texts: string[]) {}

  at(i: number): string {
    const cached = this.byIndex.get(i);
    if (cached !== undefined) return cached;
    const value = this.normalizer.run(this.texts[i]!);
    this.byIndex.set(i, value);
    return value;
  }

  of(text: string): string {
    const cached = this.byText.get(text);
    if (cached !== undefined) return cached;
    const value = this.normalizer.run(text);
    this.byText.set(text, value);
    return value;
  }
}

function evaluate(cases: Case[], corpus: Normalized, scorer: Scorer) {
  const normalizer = corpus.normalizer;
  const norm = (i: number) => corpus.at(i);
  let reciprocal = 0, top1 = 0, top10 = 0, margin = 0;
  const started = Bun.nanoseconds();
  let scored = 0;
  for (const c of cases) {
    const score = scorer.prepare(corpus.of(c.query));
    let better = 0;
    let best = 0;
    const goldScore = score(norm(c.gold));
    for (const candidate of c.pool) {
      if (candidate === c.gold) continue;
      const s = score(norm(candidate));
      if (s > goldScore) better++;
      if (s > best) best = s;
      scored++;
    }
    const rank = better + 1;
    reciprocal += 1 / rank;
    margin += goldScore - best;
    if (rank === 1) top1++;
    if (rank <= 10) top10++;
  }
  const seconds = (Bun.nanoseconds() - started) / 1e9;
  return {
    normalizer: normalizer.name,
    scorer: scorer.name,
    mrr: reciprocal / cases.length,
    top1: top1 / cases.length,
    top10: top10 / cases.length,
    // How far the right answer sits above the best wrong one. When everything
    // ranks the twin first, this is what still says which method a caller
    // could put an absolute threshold on.
    margin: margin / cases.length,
    candidatesPerSecond: scored / seconds,
  };
}

function table(rows: Record<string, unknown>[], columns: string[]) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(line(columns));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(columns.map((c) => String(r[c]))));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

// --- Task: ledger relatedness against asserted links ------

async function ledgerTask() {
  const contribs = await readJsonl<Contribution>("contribs.jsonl");
  const edges = await readJsonl<Edge>("edges.jsonl");
  const index = new Map(contribs.map((c, i) => [c.id, i]));
  const text = (c: Contribution) => `${c.title}\n${c.summary}\n${c.content}`;
  const texts = contribs.map(text);
  // The pool is what a live tool would return: active entries only. A query
  // may well be an entry that was withdrawn for duplicating one of them.
  const bm25 = new Bm25(texts.map((t, i) => (contribs[i]!.status === "active" ? t.slice(0, 2000) : "")));

  // `duplicate-of` is not among these: all 1,075 of them come from one
  // retracted import that pointed every source at the same target, so they
  // measure that import rather than any similarity method.
  for (const rel of ["specializes", "generalizes|refines|overlaps|equivalent-to"]) {
    const wanted = new Set(rel.split("|"));
    const pairs = edges.filter((e) => wanted.has(e.rel) && index.has(e.src) && index.has(e.dst));
    const cases: Case[] = [];
    for (const e of pairs) {
      if (cases.length >= QUERIES) break;
      const from = index.get(e.src)!, to = index.get(e.dst)!;
      const pool = bm25.top(texts[from]!.slice(0, 2000), POOL, from);
      if (!pool.includes(to)) pool.push(to);
      cases.push({ query: texts[from]!, gold: to, pool });
    }
    if (cases.length < 10) continue;
    const recall = cases.filter((c) => c.pool.length <= POOL || c.pool.indexOf(c.gold) < POOL).length / cases.length;
    console.log(`\n## ledger '${rel}' — ${cases.length} queries, pool ${POOL}, prefilter recall ${pct(recall)}`);
    const rows = [];
    for (const n of PROSE_NORMALIZERS) {
      const corpus = new Normalized(n, texts);
      for (const s of SCORERS) {
        const r = evaluate(cases, corpus, s);
        rows.push({ ...r, mrr: r.mrr.toFixed(3), top1: pct(r.top1), top10: pct(r.top10), margin: r.margin.toFixed(3), "cand/s": num(r.candidatesPerSecond), "req/s@150": num(r.candidatesPerSecond / 150) });
      }
    }
    rows.sort((a, b) => Number(b.mrr) - Number(a.mrr));
    table(rows, ["normalizer", "scorer", "mrr", "top1", "top10", "margin", "cand/s", "req/s@150"]);
  }
}

// --- Task: ledger entries under renaming ------
// Same mathematics, every incidental choice different: variables permuted,
// constants moved, greek letters swapped, whitespace reflowed, and a sixth of
// the sentences gone. This is the case alpha normalization exists for, and
// the only one where the right answer is known rather than asserted.

const GREEK_SWAP: Record<string, string> = {
  "\\varepsilon": "\\delta", "\\epsilon": "\\delta", "\\delta": "\\varepsilon", "\\alpha": "\\beta",
  "\\beta": "\\alpha", "\\lambda": "\\mu", "\\mu": "\\lambda", "\\sigma": "\\tau", "\\tau": "\\sigma",
  "\u03b5": "\u03b4", "\u03b4": "\u03b5", "\u03b1": "\u03b2", "\u03b2": "\u03b1", "\u03bb": "\u03bc", "\u03bc": "\u03bb", "\u03c3": "\u03c4", "\u03c4": "\u03c3",
};
const LETTER_SWAP: Record<string, string> = { n: "k", k: "n", m: "j", j: "m", x: "y", y: "x", i: "p", p: "i", a: "c", c: "a", f: "g", g: "f", s: "t", t: "s" };

function renameProse(text: string, seed: number): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((_, i) => (i * 7 + seed) % 6 !== 0)
    .join(" ");
  return kept
    .replace(/\\[a-zA-Z]+|[\u03b1-\u03c9]/g, (m) => GREEK_SWAP[m] ?? m)
    .replace(/(?<![\p{L}\p{N}_\\])[a-z](?![\p{L}\p{N}_])/gu, (m) => LETTER_SWAP[m] ?? m)
    .replace(/\b\d{1,4}\b/g, (d) => String(Number(d) > 2 ? Number(d) + 3 : d))
    .replace(/[ \t]+/g, "  ");
}

async function renamedTask() {
  // Short, symbol-dense claims, not essays: a 6 KB write-up is mostly words,
  // and words survive renaming, so every method finds it. What renaming
  // actually threatens is the unit whose content is symbols.
  const contribs = (await readJsonl<Contribution>("contribs.jsonl"))
    .filter((c) => c.status === "active" && c.content.length > 200 && c.content.length < 1200);
  const texts = contribs.map((c) => `${c.title}\n${c.summary}\n${c.content}`);
  const bm25 = new Bm25(texts.map((t) => t.slice(0, 2000)));
  const cases: Case[] = [];
  const step = Math.max(1, Math.floor(contribs.length / QUERIES));
  for (let i = 0; cases.length < QUERIES && i < contribs.length; i += step) {
    const query = renameProse(texts[i]!, i);
    const pool = bm25.top(query.slice(0, 2000), POOL, -1);
    if (!pool.includes(i)) pool.push(i);
    cases.push({ query, gold: i, pool });
  }
  const recall = cases.filter((c) => c.pool.slice(0, POOL).includes(c.gold)).length / cases.length;
  console.log(`\n## ledger entries, renamed — ${cases.length} queries over ${num(contribs.length)} entries, pool ${POOL}, prefilter recall ${pct(recall)}`);
  const rows = [];
  for (const n of PROSE_NORMALIZERS) {
    const corpus = new Normalized(n, texts);
    for (const s of SCORERS) {
      const r = evaluate(cases, corpus, s);
      rows.push({ ...r, mrr: r.mrr.toFixed(3), top1: pct(r.top1), top10: pct(r.top10), margin: r.margin.toFixed(3), "cand/s": num(r.candidatesPerSecond), "req/s@150": num(r.candidatesPerSecond / 150) });
    }
  }
  rows.sort((a, b) => Number(b.mrr) - Number(a.mrr) || Number(b.margin) - Number(a.margin));
  table(rows, ["normalizer", "scorer", "mrr", "top1", "top10", "margin", "cand/s", "req/s@150"]);
}

// --- Task: Lean statements under renaming ------
// The query is a real declaration with every incidental name changed: binders
// renamed, universes renumbered, whitespace reflowed. Nothing about what it
// says has moved, so the original is the correct answer, and a method that
// scores by surface text has to find it the hard way.

function renameLean(statement: string, seed: number): string {
  const names = new Set<string>();
  for (const m of statement.matchAll(/[{(⦃]\s*([^:()}⦄]+?)\s*:/g)) {
    for (const n of m[1]!.split(/\s+/)) if (/^[\p{L}_][\p{L}\p{N}_'₀-₉]*$/u.test(n)) names.add(n);
  }
  for (const m of statement.matchAll(/∀\s+([^,:]+?)[,:]/g)) {
    for (const n of m[1]!.split(/\s+/)) if (/^[\p{L}_][\p{L}\p{N}_'₀-₉]*$/u.test(n)) names.add(n);
  }
  let out = statement;
  let i = seed;
  for (const n of names) {
    const fresh = `zq${(i++ % 26 + 10).toString(36)}${i}`;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_.'])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "gu"), fresh);
  }
  return out.replace(/u_\d+/g, (u) => `u_${Number(u.slice(2)) + 7}`).replace(/\s+/g, "  ");
}

async function leanTask() {
  const decls = (await readJsonl<Decl>("decls.jsonl")).filter((d) => d.is_proof && !isGenerated(d.name) && d.statement.length > 60);
  const texts = decls.map((d) => d.statement);
  const cases = await cached("lean-cases", async () => {
    const bm25 = new Bm25(texts.map((t) => t.slice(0, 1500)));
    const built: Case[] = [];
    const step = Math.floor(decls.length / QUERIES);
    for (let i = 0; built.length < QUERIES && i < decls.length; i += step) {
      const query = renameLean(texts[i]!, i);
      if (query === texts[i]) continue;
      const pool = bm25.top(query, POOL, -1);
      if (!pool.includes(i)) pool.push(i);
      built.push({ query, gold: i, pool });
    }
    return built;
  });
  const recall = cases.filter((c) => c.pool.slice(0, POOL).includes(c.gold)).length / cases.length;
  console.log(`\n## lean statements, renamed — ${cases.length} queries over ${num(decls.length)} declarations, pool ${POOL}, prefilter recall ${pct(recall)}`);
  const rows = [];
  for (const n of LEAN_NORMALIZERS) {
    const corpus = new Normalized(n, texts);
    for (const s of SCORERS) {
      const r = evaluate(cases, corpus, s);
      rows.push({ ...r, mrr: r.mrr.toFixed(3), top1: pct(r.top1), top10: pct(r.top10), margin: r.margin.toFixed(3), "cand/s": num(r.candidatesPerSecond), "req/s@150": num(r.candidatesPerSecond / 150) });
    }
  }
  rows.sort((a, b) => Number(b.mrr) - Number(a.mrr) || Number(b.margin) - Number(a.margin));
  table(rows, ["normalizer", "scorer", "mrr", "top1", "top10", "margin", "cand/s", "req/s@150"]);
}

// --- Task: raw throughput ------

async function speedTask() {
  const contribs = await readJsonl<Contribution>("contribs.jsonl");
  const decls = await readJsonl<Decl>("decls.jsonl");
  const sample = contribs.slice(0, 400).map((c) => `${c.title}\n${c.summary}\n${c.content}`);
  const stmts = decls.filter((d) => d.is_proof).slice(0, 400).map((d) => d.statement);

  for (const [label, corpus, normalizer, poolSize] of [
    ["ledger entry (median 1.4 KB)", sample, PROSE_NORMALIZERS[1]!, 150],
    ["lean statement (median 180 B)", stmts, LEAN_NORMALIZERS[2]!, 300],
  ] as const) {
    const normalized = corpus.map((t) => normalizer.run(t));
    const size = normalized.reduce((a, b) => a + b.length, 0) / normalized.length;
    console.log(`\n## throughput — ${label}, normalized to ${Math.round(size)} B, ${poolSize} candidates per request`);
    const rows = [];
    const normStart = Bun.nanoseconds();
    for (const t of corpus) normalizer.run(t);
    const normPerSecond = corpus.length / ((Bun.nanoseconds() - normStart) / 1e9);
    for (const s of SCORERS) {
      const started = Bun.nanoseconds();
      let n = 0;
      for (let round = 0; round < 3; round++) {
        for (let q = 0; q < 20; q++) {
          const score = s.prepare(normalized[q]!);
          for (const c of normalized) { score(c); n++; }
        }
      }
      const perSecond = n / ((Bun.nanoseconds() - started) / 1e9);
      rows.push({
        scorer: s.name,
        "cand/s": num(perSecond),
        "req/s": num(1 / (poolSize / perSecond)),
        "req/s +normalize": num(1 / (poolSize / perSecond + poolSize / normPerSecond)),
      });
    }
    rows.push({ scorer: "(normalize only)", "cand/s": num(normPerSecond), "req/s": "-", "req/s +normalize": "-" });
    table(rows, ["scorer", "cand/s", "req/s", "req/s +normalize"]);
  }
}

// --- Task: what it finds in the wild ------
// No metric here on purpose: this prints the top duplicate candidates the
// shipped configuration finds in LemmaLib and in the ledger, for a human
// or an agent to judge. A scanner produces an attention list; whether the
// list is worth attention is not a number.

async function dupesTask() {
  const all = (await readJsonl<Decl>("decls.jsonl")).filter((d) => d.is_proof && d.statement.length > 40);
  const decls = all.filter((d) => !isGenerated(d.name));
  console.log(`\n${num(all.length - decls.length)} of ${num(all.length)} proved declarations are Lean-generated boilerplate and are classified out.`);
  const byNorm = new Map<string, Decl[]>();
  const started = Bun.nanoseconds();
  for (const d of decls) {
    const key = alphaLean(d.statement);
    (byNorm.get(key) ?? byNorm.set(key, []).get(key)!).push(d);
  }
  const elapsed = (Bun.nanoseconds() - started) / 1e9;
  const groups = [...byNorm.values()].filter((g) => g.length > 1);
  const crossLibrary = groups.filter((g) => new Set(g.map((d) => d.library)).size > 1);
  const withinLemmaLib = groups.filter((g) => g.every((d) => d.library === "LemmaLib") && new Set(g.map((d) => d.name)).size > 1);
  console.log(`\n## alpha-equivalence classes over ${num(decls.length)} proved declarations (${elapsed.toFixed(1)}s to normalize all of them)`);
  console.log(`${num(groups.length)} classes hold more than one declaration; ${num(crossLibrary.length)} span libraries; ${num(withinLemmaLib.length)} are LemmaLib talking to itself.`);
  const show = (label: string, gs: Decl[][]) => {
    console.log(`\n### ${label}`);
    for (const g of gs.sort((a, b) => b[0]!.statement.length - a[0]!.statement.length).slice(0, 6)) {
      console.log(`  ${g[0]!.statement.replace(/\s+/g, " ").slice(0, 150)}`);
      for (const d of g.slice(0, 4)) console.log(`    - ${d.library}: ${d.name}`);
    }
  };
  show("cross-library duplicates", crossLibrary);
  show("LemmaLib internal duplicates", withinLemmaLib);

  const contribs = await readJsonl<Contribution>("contribs.jsonl");
  const lean = contribs.flatMap((c) => leanBlocks(c.content).map((b) => ({ c, b })));
  console.log(`\n## ledger Lean: ${num(lean.length)} fenced blocks in ${num(new Set(lean.map((l) => l.c.id)).size)} entries`);
  const ledgerNorm = new Map<string, { id: string; title: string }[]>();
  for (const { c, b } of lean) {
    for (const decl of b.split(/\n(?=(?:@\[|theorem |lemma |def |instance |example ))/)) {
      if (decl.trim().length < 60) continue;
      const key = alphaLean(decl, { body: false });
      (ledgerNorm.get(key) ?? ledgerNorm.set(key, []).get(key)!).push({ id: c.id, title: c.title });
    }
  }
  const dupes = [...ledgerNorm.entries()].filter(([, v]) => new Set(v.map((x) => x.id)).size > 1);
  console.log(`${num(dupes.length)} statements appear, verbatim modulo names, in more than one entry.`);
  for (const [key, v] of dupes.slice(0, 5)) {
    console.log(`  ${key.replace(/\s+/g, " ").slice(0, 140)}`);
    for (const x of [...new Map(v.map((i) => [i.id, i])).values()].slice(0, 3)) console.log(`    - ${x.title.slice(0, 90)}`);
  }
}

// --- Task: what a corpus sweep costs and what it finds ------
// `related({scan: true})` runs this exact pipeline on a page of the corpus:
// alpha-normalize every body, bucket by banded minhash, and pay compression
// distance only inside a bucket. Two numbers decide whether the tool is
// usable: what a page costs, and where the threshold has to sit for the pairs
// above it to be worth an agent's reading time. Prose scores far lower than
// Lean does at the same degree of sameness, because a write-up carries a
// paragraph of its own prose around whatever it shares, so the threshold is a
// measurement rather than a transfer from the Lean side.

/** What `related({scan:true})` ships as its default floor. */
const SHIPPED_THRESHOLD = 0.45;

async function sweepTask() {
  const page = Number(arg("page", "6000"));
  const contribs = (await readJsonl<Contribution>("contribs.jsonl")).filter(
    (c) => c.status === "active" && c.kind !== "edge" && c.content.trim().length > 0,
  );
  const slice = contribs.slice(0, page);
  console.log(`\n## sweeping ${num(slice.length)} of ${num(contribs.length)} active entries`);

  let started = Bun.nanoseconds();
  const texts = slice.map((c) => alphaProse(c.content.slice(0, 4000)));
  const normalizeS = (Bun.nanoseconds() - started) / 1e9;

  started = Bun.nanoseconds();
  const buckets = new Map<number, number[]>();
  texts.forEach((text, i) => {
    for (const band of bands(text)) (buckets.get(band) ?? buckets.set(band, []).get(band)!).push(i);
  });
  const bandS = (Bun.nanoseconds() - started) / 1e9;

  const seen = new Set<number>();
  const candidates: [number, number][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > 200) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const key = bucket[i]! * slice.length + bucket[j]!;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push([bucket[i]!, bucket[j]!]);
      }
    }
  }

  started = Bun.nanoseconds();
  const scored: { a: number; b: number; s: number }[] = [];
  const prepared = new Map<number, ReturnType<typeof prepare>>();
  for (const [a, b] of candidates) {
    const query = prepared.get(a) ?? prepared.set(a, prepare(texts[a]!)).get(a)!;
    scored.push({ a, b, s: similarity(query, texts[b]!) });
  }
  const ncdS = (Bun.nanoseconds() - started) / 1e9;

  console.log(
    `normalize ${normalizeS.toFixed(2)}s, band ${bandS.toFixed(2)}s, ${num(candidates.length)} pairs scored in ${ncdS.toFixed(2)}s ` +
      `(a page costs ${(normalizeS + bandS + ncdS).toFixed(2)}s of worker time)`,
  );

  const rows = [0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7].map((t) => ({
    threshold: t.toFixed(2),
    pairs: num(scored.filter((p) => p.s >= t).length),
    entries: num(new Set(scored.filter((p) => p.s >= t).flatMap((p) => [p.a, p.b])).size),
  }));
  table(rows, ["threshold", "pairs", "entries"]);

  console.log("\n### the strongest pairs, for reading");
  for (const p of scored.sort((x, y) => y.s - x.s).slice(0, 8)) {
    console.log(`  ${p.s.toFixed(3)}`);
    console.log(`    - ${slice[p.a]!.title.replace(/\s+/g, " ").slice(0, 110)}`);
    console.log(`    - ${slice[p.b]!.title.replace(/\s+/g, " ").slice(0, 110)}`);
  }

  console.log("\n### pairs straddling the shipped threshold, which is where a bad threshold shows");
  const near = scored.filter((p) => p.s >= SHIPPED_THRESHOLD - 0.08 && p.s < SHIPPED_THRESHOLD + 0.08).sort(() => Math.random() - 0.5).slice(0, 6);
  for (const p of near) {
    console.log(`  ${p.s.toFixed(3)}`);
    console.log(`    - ${slice[p.a]!.title.replace(/\s+/g, " ").slice(0, 110)}`);
    console.log(`    - ${slice[p.b]!.title.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}

// --- Task: which prefilter can even see a structural twin ------
// A ranker only ever sees what the prefilter nominated. A lexical prefilter
// selects on the identifiers alpha normalization is about to throw away, so
// this measures the alternative: nominate on the normalized form instead,
// either by character trigram overlap (what pg_trgm would do over a stored
// normalized column) or by banded minhash (what an LSH table would do).

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

class InvertedIndex {
  private readonly postings = new Map<string, number[]>();
  constructor(docs: string[], private readonly features: (s: string) => Iterable<string>) {
    docs.forEach((doc, i) => {
      for (const f of features(doc)) (this.postings.get(f) ?? this.postings.set(f, []).get(f)!).push(i);
    });
  }
  top(query: string, k: number, exclude: number): number[] {
    const hits = new Map<number, number>();
    for (const f of new Set(this.features(query))) {
      const posting = this.postings.get(f);
      if (!posting || posting.length > 20000) continue;
      const weight = 1 / Math.log(2 + posting.length);
      for (const d of posting) if (d !== exclude) hits.set(d, (hits.get(d) ?? 0) + weight);
    }
    return [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([d]) => d);
  }
}

const BANDS = 16;
function bands(s: string): string[] {
  const sk = minhash(s);
  const out: string[] = [];
  for (let b = 0; b < BANDS; b++) out.push(`${b}:${sk[b * 4]},${sk[b * 4 + 1]},${sk[b * 4 + 2]},${sk[b * 4 + 3]}`);
  return out;
}

async function prefilterTask() {
  const contribs = (await readJsonl<Contribution>("contribs.jsonl")).filter((c) => c.status === "active");
  const texts = contribs.map((c) => `${c.title}\n${c.summary}\n${c.content}`.slice(0, 4000));
  // Capped: four full indexes over 300k statements measures this laptop's
  // memory, not the prefilters. LemmaLib is the corpus the Lean tool is
  // actually pointed at.
  const decls = (await readJsonl<Decl>("decls.jsonl"))
    .filter((d) => d.is_proof && !isGenerated(d.name) && d.statement.length > 60)
    .filter((d) => d.library === "LemmaLib")
    .slice(0, 60000);
  const stmts = decls.map((d) => d.statement);

  for (const [label, corpus, normalize, mutate] of [
    ["ledger entries", texts, (s: string) => alphaProse(s), renameProse],
    ["lean statements", stmts, (s: string) => alphaLean(s), renameLean],
  ] as const) {
    const normalized = corpus.map(normalize);
    const built: Record<string, { index: { top(q: string, k: number, x: number): number[] }; query: (raw: string) => string; seconds: number }> = {};
    const build = (name: string, make: () => { top(q: string, k: number, x: number): number[] }, query: (raw: string) => string) => {
      const started = Bun.nanoseconds();
      const index = make();
      built[name] = { index, query, seconds: (Bun.nanoseconds() - started) / 1e9 };
    };
    build("bm25-raw", () => new Bm25(corpus), (raw) => raw);
    build("bm25-normalized", () => new Bm25(normalized), normalize);
    build("trigram-normalized", () => new InvertedIndex(normalized, trigrams), normalize);
    build("minhash-bands", () => new InvertedIndex(normalized, bands), normalize);

    const step = Math.max(1, Math.floor(corpus.length / QUERIES));
    const queries: { text: string; gold: number }[] = [];
    for (let i = 0; queries.length < QUERIES && i < corpus.length; i += step) {
      if (corpus[i]!.length < 200) continue;
      queries.push({ text: mutate(corpus[i]!, i), gold: i });
    }
    console.log(`\n## prefilter recall — ${label}, ${queries.length} renamed queries over ${num(corpus.length)} units, pool ${POOL}`);
    const rows = [];
    for (const [name, { index, query, seconds }] of Object.entries(built)) {
      const started = Bun.nanoseconds();
      let found = 0;
      for (const q of queries) if (index.top(query(q.text), POOL, -1).includes(q.gold)) found++;
      const elapsed = (Bun.nanoseconds() - started) / 1e9;
      rows.push({ prefilter: name, "recall@pool": pct(found / queries.length), "lookups/s": num(queries.length / elapsed), "build": `${seconds.toFixed(1)}s` });
    }
    table(rows, ["prefilter", "recall@pool", "lookups/s", "build"]);
  }
}

// Tasks share nothing, so a full run is as slow as its slowest task rather
// than as slow as their sum.
if (TASKS.length > 1) {
  const runs = TASKS.map((task) => ({
    task,
    proc: Bun.spawn(["bun", import.meta.path, `--task=${task}`, `--queries=${QUERIES}`, `--pool=${POOL}`, `--dir=${DIR}`], {
      stdout: "pipe",
      stderr: "inherit",
    }),
  }));
  for (const { proc } of runs) process.stdout.write(await new Response(proc.stdout).text());
  process.exit(Math.max(...(await Promise.all(runs.map((r) => r.proc.exited)))));
}

for (const task of TASKS) {
  if (task === "ledger") await ledgerTask();
  else if (task === "renamed") await renamedTask();
  else if (task === "prefilter") await prefilterTask();
  else if (task === "lean") await leanTask();
  else if (task === "speed") await speedTask();
  else if (task === "dupes") await dupesTask();
  else if (task === "sweep") await sweepTask();
}
