/**
 * Alpha-normalized similarity: how this ledger decides two things are the
 * same work wearing different names.
 *
 * Two halves, both pure and both testable without a database:
 *
 *   1. **Alpha normalization** rewrites a unit so that locally arbitrary
 *      choices — a bound variable called `n` instead of `k`, a lemma called
 *      `foo_bar`, whitespace, a constant that happens to be 7 — become
 *      positional placeholders, while everything that carries meaning
 *      (operators, connectives, control flow, library constants, real words)
 *      survives untouched. Two units that differ only in naming normalize to
 *      the same string.
 *   2. **Normalized compression distance** over the normalized forms:
 *      NCD(x,y) = (C(xy) - min(C(x),C(y))) / max(C(x),C(y)), reported as a
 *      similarity 1 - NCD.
 *
 * The compressor is deflate with the query installed as a preset dictionary,
 * which measures C(y|x) directly instead of paying C(xy) for every pair.
 * `test/similarity-bench.ts` is where that choice, and the normalizers, are
 * measured against the alternatives on the live corpus; it prints requests
 * per second and ranking quality against the ledger's own `duplicate-of`
 * edges. Change nothing here without re-running it.
 */
import zlib from "node:zlib";
import { createHash } from "node:crypto";

/** Bumped whenever a normalizer changes what it produces. Stored rows carry
 *  it, so a change is a backfill the tooling can find rather than a corpus
 *  half-written in two conventions. */
export const NORM_VERSION = 3;

// --- Alpha normalization ------

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma",
  "Upsilon", "Phi", "Psi", "Omega",
]);

const GREEK_CHARS = /[\u03b1-\u03c9\u0391-\u03a9\u2135-\u2138]/;

/** Short words that are English, not algebra. Without this every "is", "the"
 *  and "of" would be renamed alongside the variables. */
const SHORT_WORDS = new Set([
  "a", "an", "as", "at", "be", "by", "do", "if", "in", "is", "it", "no", "of", "on", "or", "so",
  "to", "up", "we", "the", "and", "but", "for", "not", "are", "was", "all", "any", "can", "its",
  "has", "had", "let", "one", "two", "how", "why", "use", "see", "new", "our", "per", "via",
]);

/** A token that names something locally: a math variable, a greek letter, a
 *  subscripted index. Real words name shared concepts and are kept. */
function looksLocal(word: string): boolean {
  if (word.startsWith("\\")) return GREEK.has(word.slice(1));
  const lower = word.toLowerCase();
  if (SHORT_WORDS.has(lower)) return false;
  if (GREEK_CHARS.test(word)) return true;
  if (word.length <= 2) return true;
  return /^\p{L}[_'\u2032]?[\p{N}\p{L}]{1,3}$/u.test(word) && !/^\p{L}{2,}$/u.test(word);
}

const PROSE_TOKEN = /\\?[\p{L}_][\p{L}\p{N}_'\u2032]*|\d+(?:\.\d+)?|[^\s\p{L}\p{N}]/gu;

class Alphabet {
  private readonly seen = new Map<string, string>();
  get(name: string): string {
    const known = this.seen.get(name);
    if (known !== undefined) return known;
    const placeholder = this.seen.size < 62 ? `\u00a7${this.seen.size.toString(36)}` : "\u00a7z";
    this.seen.set(name, placeholder);
    return placeholder;
  }
}

/** Constants that mean something everywhere. 7 is a choice; 0 and 1 are not. */
const meaningfulNumber = (n: string) => n === "0" || n === "1" || n === "2";

/**
 * Prose, LaTeX and mixed mathematical writing. Keeps words, operators and
 * structural macros; replaces variable names, greek letters and arbitrary
 * constants with first-occurrence placeholders.
 */
export function alphaProse(text: string, limit = 4000): string {
  const source = text.length > limit * 2 ? text.slice(0, limit * 2) : text;
  const alphabet = new Alphabet();
  const out: string[] = [];
  for (const [token] of source.matchAll(PROSE_TOKEN)) {
    if (/^[\p{L}_\\]/u.test(token)) {
      out.push(looksLocal(token) ? alphabet.get(token) : token.toLowerCase());
    } else if (/^\d/.test(token)) {
      out.push(meaningfulNumber(token) ? token : "#");
    } else {
      out.push(token);
    }
  }
  const joined = out.join(" ");
  return joined.length > limit ? joined.slice(0, limit) : joined;
}

// --- Lean ------

const LEAN_COMMENT = /--[^\n]*|\/-[\s\S]*?-\//g;
// Brackets and commas stand alone because they delimit binder groups; every
// other symbol run stays glued, so `:=` and `→` are one token each.
const LEAN_TOKEN =
  /[()\[\]{}⟨⟩⦃⦄,]|[\p{L}_][\p{L}\p{N}_.'!?ₐ-ₜ₀-₉✝¹²³⁴-⁹]*|\d+|[^\s\p{L}\p{N}()\[\]{}⟨⟩⦃⦄,]+/gu;

/** Tokens that open a binder scope: the identifiers that immediately follow
 *  are bound names, and bound names are what alpha-equivalence forgets. */
const BINDER_HEAD = new Set([
  "∀", "∃", "∃!", "fun", "λ", "Σ", "Π", "∑", "∏", "⨆", "⨅", "⋃", "⋂", "∫",
  "obtain", "intro", "intros", "rintro", "let", "have", "set", "suffices",
]);
const DECL_HEAD = new Set(["theorem", "lemma", "def", "abbrev", "instance", "example", "structure", "inductive", "class"]);
/** Only a proof body is dropped by `body: false`. A definition *is* its body. */
const PROVES = new Set(["theorem", "lemma", "example"]);
const MODIFIER = new Set(["noncomputable", "private", "protected", "partial", "unsafe", "scoped", "@"]);
const OPEN = new Set(["(", "{", "[", "⦃", "⟨"]);
const CLOSE = new Set([")", "}", "]", "⦄", "⟩"]);
/** What ends a run of binder names by binding it: `∀ x y, …`, `∀ x ∈ s, …`,
 *  `fun x => …`, `(s t : Finset α)`. Any other operator means the run was an
 *  expression all along, and the names it collected are not binders. */
const NAME_BIND = /^(,|=>|↦|:|::|∈|∉|⊆|⊂|≤|<)$/;

/** `Nat` and `ℕ` are one type written two ways, and which one appears is a
 *  choice about notation rather than about mathematics. The pretty printer
 *  always picks the notation, so source folds to it too. */
const NOTATION: Record<string, string> = {
  Nat: "ℕ", Int: "ℤ", Rat: "ℚ", Real: "ℝ", Complex: "ℂ", NNReal: "ℝ≥0", ENNReal: "ℝ≥0∞",
};

/** Universe parameters, elaborator-invented instance names, and inaccessible
 *  hygiene names are never meaningful. */
const auto = (word: string) => word.includes("✝") || /^u_\d+$/.test(word) || /^inst_?\d*$/.test(word);

/**
 * Lean 4 source or a pretty-printed statement. Bound names, declaration names
 * and universe parameters become placeholders; constants, notation, operators
 * and structure survive, because `Finset.card` is not an arbitrary choice and
 * `n` is.
 *
 * `body: false` keeps only what a declaration claims, dropping the proof after
 * `:=`, which is what "are these the same lemma?" actually asks.
 */
export function alphaLean(source: string, opts?: { body?: boolean; limit?: number }): string {
  const limit = opts?.limit ?? 4000;
  const keepBody = opts?.body ?? true;
  const tokens = [...source.replace(LEAN_COMMENT, " ").matchAll(LEAN_TOKEN)].map((m) => m[0]!);
  const alphabet = new Alphabet();
  const bound = new Set<string>();
  const out: string[] = [];

  // A name is emitted before we know whether it is bound: `(s t : Finset α)`
  // only becomes a binder at the colon, and `(a + b)` never does. Each
  // bracket depth carries its own run of candidates, rewritten in place once
  // the run resolves.
  type Frame = { pending: { name: string; at: number }[]; collecting: boolean };
  const stack: Frame[] = [{ pending: [], collecting: false }];
  let expectDeclName = false;
  let skippingBody = false;
  let proving = false;

  const bind = (f: Frame) => {
    for (const p of f.pending) bound.add(p.name);
    for (const p of f.pending) out[p.at] = alphabet.get(p.name);
    f.pending = [];
    f.collecting = false;
  };

  const rename = (word: string): string => {
    const dot = word.indexOf(".");
    const head = dot === -1 ? word : word.slice(0, dot);
    if (bound.has(head) || auto(head)) return alphabet.get(head) + (dot === -1 ? "" : word.slice(dot));
    return NOTATION[word] ?? word;
  };

  for (const t of tokens) {
    const f = stack[stack.length - 1]!;
    if (skippingBody) {
      if (!DECL_HEAD.has(t) && !MODIFIER.has(t)) continue;
      skippingBody = false;
    }
    if (MODIFIER.has(t)) {
      out.push(t);
      continue;
    }
    if (DECL_HEAD.has(t)) {
      stack.length = 1;
      stack[0] = { pending: [], collecting: true };
      out.push(t);
      expectDeclName = t !== "example";
      proving = PROVES.has(t);
      continue;
    }
    if (expectDeclName) {
      expectDeclName = false;
      if (/^[\p{L}_]/u.test(t)) {
        out.push("§decl");
        continue;
      }
    }
    if (BINDER_HEAD.has(t)) {
      f.pending = [];
      f.collecting = true;
      out.push(t);
      continue;
    }
    if (OPEN.has(t)) {
      stack.push({ pending: [], collecting: f.collecting });
      out.push(t);
      continue;
    }
    if (CLOSE.has(t)) {
      if (stack.length > 1) stack.pop();
      out.push(t);
      continue;
    }
    if (!keepBody && proving && t === ":=" && stack.length === 1) {
      skippingBody = true;
      out.push(t);
      continue;
    }
    if (/^[\p{L}_]/u.test(t)) {
      // `Type u` and `Sort v` name a universe, and a universe name is as
      // arbitrary as a variable: the pretty printer calls it `u_1` here and
      // `u_7` in the next declaration.
      const previous = out[out.length - 1];
      if ((previous === "Type" || previous === "Sort") && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(t)) {
        bound.add(t);
        out.push(alphabet.get(t));
        continue;
      }
      if (f.collecting) f.pending.push({ name: t, at: out.length });
      out.push(rename(t));
      continue;
    }
    if (/^\d+$/.test(t)) {
      out.push(meaningfulNumber(t) ? t : "#");
      continue;
    }
    if (f.collecting) {
      if (NAME_BIND.test(t)) bind(f);
      else {
        f.pending = [];
        f.collecting = false;
      }
    }
    out.push(t);
  }

  const joined = arrowize(out).join(" ");
  return joined.length > limit ? joined.slice(0, limit) : joined;
}

const CLOSER: Record<string, string> = { "(": ")", "{": "}", "[": "]", "⦃": "⦄", "⟨": "⟩" };

/**
 * `∀ (h : P), Q` and `P → Q` are the same statement, and Lean's pretty printer
 * prints the second whenever the name is unused. Source written by hand names
 * the hypothesis anyway, so an explicit binder nobody refers to is folded into
 * an arrow here — on both sides, which is what lets a pasted theorem meet an
 * indexed one. Implicit and instance binders keep their brackets, because that
 * is what the pretty printer does with them.
 */
function arrowize(tokens: string[]): string[] {
  if (tokens[0] !== "∀") return tokens;
  type Group = { open: string; names: string[]; type: string[] };
  const groups: Group[] = [];
  let i = 1;
  while (i < tokens.length && OPEN.has(tokens[i]!)) {
    let depth = 0;
    let end = i;
    for (; end < tokens.length; end++) {
      if (OPEN.has(tokens[end]!)) depth++;
      else if (CLOSE.has(tokens[end]!) && --depth === 0) break;
    }
    if (end >= tokens.length) return tokens;
    const inner = tokens.slice(i + 1, end);
    const colon = inner.indexOf(":");
    if (colon === -1) return tokens;
    groups.push({ open: tokens[i]!, names: inner.slice(0, colon), type: inner.slice(colon + 1) });
    i = end + 1;
  }
  if (groups.length === 0 || tokens[i] !== ",") return tokens;
  const body = tokens.slice(i + 1);

  const out: string[] = [];
  let telescope: Group[] = [];
  const flush = () => {
    if (telescope.length === 0) return;
    out.push("∀");
    for (const g of telescope) out.push(g.open, ...g.names, ":", ...g.type, CLOSER[g.open]!);
    out.push(",");
    telescope = [];
  };
  groups.forEach((group, at) => {
    const rest = [...groups.slice(at + 1).flatMap((g) => g.type), ...body];
    // `§2.card` is a use of `§2`: a projection is spelled as one token.
    const used = (name: string) => rest.some((t) => t === name || t.startsWith(`${name}.`));
    if (group.open !== "(" || group.names.some(used)) telescope.push(group);
    else {
      flush();
      // The pretty printer brackets a hypothesis whose own scope would
      // otherwise swallow the arrow, and this has to agree with it.
      const binds = group.type.some((t) => t === "→" || BINDER_HEAD.has(t));
      out.push(...(binds ? ["(", ...group.type, ")"] : group.type), "→");
    }
  });
  flush();
  return [...out, ...body];
}

/**
 * A declaration's *type*, in the shape the kernel prints it: binders lifted
 * into a leading `∀`, proof body dropped. Source arrives as
 * `theorem name (s : S) : P` while the index holds `∀ (s : S), P`, and this is
 * what makes those the same question.
 */
export function statementForm(source: string): string {
  const text = source.replace(LEAN_COMMENT, " ").trim();
  const head =
    /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+|scoped\s+|partial\s+|unsafe\s+)*(?:theorem|lemma|def|abbrev|instance|example)\s+[^\s:({\[]*/.exec(text);
  if (!head) return text;
  const rest = text.slice(head[0].length);
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if ("({[⦃⟨".includes(c)) depth++;
    else if (")}]⦄⟩".includes(c)) depth--;
    else if (c === ":" && depth === 0 && rest[i + 1] !== "=") {
      const binders = rest.slice(0, i).trim();
      const body = rest.slice(i + 1);
      const assign = topLevelAssign(body);
      const conclusion = (assign === -1 ? body : body.slice(0, assign)).trim();
      return binders ? `∀ ${binders}, ${conclusion}` : conclusion;
    }
  }
  return text;
}

function topLevelAssign(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]!;
    if ("({[⦃⟨".includes(c)) depth++;
    else if (")}]⦄⟩".includes(c)) depth--;
    else if (c === ":" && text[i + 1] === "=" && depth === 0) return i;
  }
  return -1;
}

/**
 * Declarations Lean generates for you: projections, injectivity lemmas,
 * equation lemmas, recursors, `sizeOf` specs. They are structurally identical
 * across every structure with the same field types, so they flood any
 * similarity report with matches nobody wrote and nobody can deduplicate.
 */
const GENERATED =
  /^(inj|injEq|sizeOf_spec|sizeOf|noConfusion|noConfusionType|rec|recOn|casesOn|below|brecOn|ibelow|binductionOn|ndrec|ndrecOn|mk|proof_\d+|match_\d+|eq_\d+|eq_def|unfold|induct|fun_cases|congr|congr_simp|congr_eq_\d+|hcongr(_\d+)?|ofNat|toCtorIdx|numArgs|_sunfold|_unfold|_eq_\d+)$|^_/;

export const isGenerated = (name: string): boolean =>
  name.includes("✝") || name.split(".").some((part) => GENERATED.test(part));

/** Lean fenced inside markdown, which is how the ledger carries most of it. */
const FENCE = /```lean[0-9]*\n([\s\S]*?)```/g;

export function leanBlocks(markdown: string): string[] {
  return [...markdown.matchAll(FENCE)].map((m) => m[1]!).filter((s) => s.trim().length > 0);
}

/** One declaration lifted out of a file of Lean, so a paste of several is
 *  compared as the things it declares rather than as one blob. */
export type LeanDecl = { name: string; kind: string; source: string };

const DECL_START = /^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+|scoped\s+|partial\s+|unsafe\s+)*(theorem|lemma|def|abbrev|instance|structure|inductive|class|example)\b[ \t]*([^\s:({\[]*)/;

export function extractDecls(source: string): LeanDecl[] {
  const body = leanBlocks(source).join("\n\n") || source;
  const lines = body.split("\n");
  const out: LeanDecl[] = [];
  let current: LeanDecl | null = null;
  for (const line of lines) {
    const start = DECL_START.exec(line);
    if (start && !/^\s/.test(line)) {
      if (current) out.push(current);
      current = { name: start[2] || "example", kind: start[1]!, source: line };
    } else if (current) {
      current.source += `\n${line}`;
    }
  }
  if (current) out.push(current);
  return out.map((d) => ({ ...d, source: d.source.trimEnd() }));
}

// --- Shingle sketches ------
// Normalization is what makes a trigram index useless: every normalized
// statement is mostly `§0`, brackets and arrows, so `norm % query` recalls a
// third of the corpus and takes seven seconds (measured, on 511k rows).
// Banded minhash asks the opposite question — do these two share whole runs of
// rare shingles — and answers it with one equality probe per band.

const SKETCH = 64;
const BAND = 4;

function shingleHashes(s: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + 6 <= s.length; i++) {
    let h = 2166136261;
    for (let j = i; j < i + 6; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    out.add(h >>> 0);
  }
  return out;
}

export function sketch(s: string): Int32Array {
  const out = new Int32Array(SKETCH).fill(0x7fffffff);
  for (const h of shingleHashes(s)) {
    for (let i = 0; i < SKETCH; i++) {
      const v = Math.imul(h ^ (i * 0x9e3779b1), 0x85ebca6b) >>> 1;
      if (v < out[i]!) out[i] = v;
    }
  }
  return out;
}

/** The sketch as `SKETCH / BAND` band signatures. Two units that agree on any
 *  one band are worth comparing properly; the rest of the corpus is not. */
export function bands(normalized: string): number[] {
  const sk = sketch(normalized);
  const out: number[] = [];
  for (let b = 0; b < SKETCH / BAND; b++) {
    let h = Math.imul(b + 1, 0x9e3779b1);
    for (let i = 0; i < BAND; i++) h = Math.imul(h ^ sk[b * BAND + i]!, 0x85ebca6b);
    out.push(h | 0);
  }
  return [...new Set(out)];
}

/** The stored form of one declaration: what it says with every arbitrary name
 *  replaced by its position, the hash that makes alpha-equality an indexed
 *  lookup, the band signatures that make near-equality one, and whether Lean
 *  wrote it rather than a person. */
export type NormalizedDecl = { norm: string; norm_hash: string; bands: number[]; generated: boolean };

export function normalizeDecl(name: string, statement: string): NormalizedDecl {
  const norm = alphaLean(statement);
  return {
    norm,
    norm_hash: createHash("sha256").update(norm).digest("hex"),
    bands: bands(flatten(norm)),
    generated: isGenerated(name),
  };
}

/**
 * The normal form with its numbering thrown away, which is the form to
 * *compare* — never the form to identify by.
 *
 * Numbering by first occurrence is what makes `§0 + §1 = §1 + §0` different
 * from `§0 + §0 = §0 + §0`, so identity needs it. Similarity cannot afford it:
 * one extra typeclass binder shifts every index after it, and two statements
 * that say the same thing stop sharing substrings. Measured against
 * `Finset.sum_le_card_nsmul` from a concrete instance of it, flattening moves
 * the true match from 0.27 to 0.46 while the best false match drops from 0.37
 * to 0.30 — a reordering, not a rescaling.
 */
export const flatten = (norm: string): string => norm.replace(/§\d+/g, "§");

// --- Compression distance ------

const DEFLATE = { level: 6, memLevel: 9 } as const;

const compressed = (buf: Buffer, dictionary?: Buffer): number =>
  zlib.deflateRawSync(buf, dictionary ? { ...DEFLATE, dictionary } : DEFLATE).length;

/** A query, prepared once for scoring against many candidates. */
export type Query = { buffer: Buffer; size: number };

export const prepare = (normalized: string): Query => {
  const buffer = Buffer.from(normalized);
  return { buffer, size: compressed(buffer) };
};

/**
 * Similarity in [0,1] from conditional compression. C(xy) is taken as
 * C(x) + C(y|x), and C(y|x) is what deflate emits for the candidate with the
 * query installed as its preset dictionary: one compression per candidate
 * instead of the two a concatenation costs, and exact rather than
 * window-limited, because deflate's 32 KB history covers any unit compared
 * here.
 */
export function similarity(query: Query, candidate: string, candidateSize?: number): number {
  const y = Buffer.from(candidate);
  const cy = candidateSize ?? compressed(y);
  if (cy === 0) return 0;
  const cxy = query.size + compressed(y, query.buffer);
  const ncd = (cxy - Math.min(query.size, cy)) / Math.max(query.size, cy);
  return Number(Math.max(0, Math.min(1, 1 - ncd)).toFixed(4));
}

export const compressedSize = (normalized: string): number => compressed(Buffer.from(normalized));
