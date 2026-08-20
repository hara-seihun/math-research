/**
 * Kernel checks as a shared, content-addressed capability.
 *
 * A check is a pure function of (source, pinned toolchain), so it is stored by
 * the hash of its source and shared by everyone who asks for it: the
 * `check_lean` tool, which creates no contribution at all, and contribution
 * verification, which turns the same facts into `lean_verified`. Nothing here
 * decides whether a check *passes review* — it records what the kernel did.
 *
 * This module owns the request side. The verifier daemon owns execution.
 */
import { sql } from "./db.ts";
import { sha256hex } from "./identity.ts";

export const MAX_SOURCE_BYTES = 64 * 1024;

/** Pending checks nobody has started yet, beyond which we shed load instead of queueing. */
export const MAX_QUEUE_DEPTH = 32;

/**
 * Tokens that bypass the kernel or smuggle in unproven facts. Running them is
 * not a new risk — elaboration is already code execution inside the runner's
 * sandbox — so a check reports them and lets each caller apply its own policy.
 */
const UNSOUND = /\b(sorry|admit|native_decide|extern|implemented_by|ofReduceBool|ofReduceNat)\b/g;

export const unsoundTokens = (source: string): string[] => [...new Set(source.match(UNSOUND) ?? [])];

/**
 * Fenced blocks win; bare source is accepted; a file with no imports gets
 * Mathlib. The result is normalized so that the same proof pasted with
 * different surrounding whitespace is the same check.
 */
export function extractLean(content: string): string {
  const blocks = [...content.matchAll(/```lean\n([\s\S]*?)```/g)].map((m) => m[1]);
  const source = (blocks.length > 0 ? blocks.join("\n\n") : content).trim();
  if (!source) return "";
  return `${source.includes("import ") ? source : `import Mathlib\n\n${source}`}\n`;
}

export type Decl = { name: string; type: string; axioms: string[] };

export type CheckDetail = {
  exit_code?: number;
  timed_out?: boolean;
  output?: string;
  decls?: Decl[];
  audit_ok?: boolean;
  audit_error?: string;
  sorry?: boolean;
  reason?: string;
  elapsed_ms?: number;
};

export type CheckRow = {
  source_hash: string;
  outcome: "pending" | "passed" | "failed" | "inconclusive";
  detail: CheckDetail;
  created_at: Date;
  updated_at: Date;
};

export type CheckRequest =
  | { ok: true; hash: string; row: CheckRow; cached: boolean }
  | { ok: false; error: string };

/**
 * Ask for a check of this source, reusing the result if it has ever been run.
 * The insert wakes the verifier through NOTIFY; its own reconcile loop is what
 * guarantees the work happens if this notification is lost.
 */
export async function requestCheck(rawContent: string): Promise<CheckRequest> {
  const source = extractLean(rawContent);
  if (!source.trim()) return { ok: false, error: "no Lean source in that." };
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      error: `Lean source is over ${MAX_SOURCE_BYTES >> 10} KiB. One self-contained file per check — split shared definitions into their own check.`,
    };
  }

  const hash = sha256hex(source);
  const [existing] = await sql<CheckRow[]>`
    select source_hash, outcome, detail, created_at, updated_at from lean_check where source_hash = ${hash}`;
  if (existing) return { ok: true, hash, row: existing, cached: existing.outcome !== "pending" };

  const [{ depth }] = await sql<{ depth: number }[]>`
    select count(*)::int as depth from lean_check where outcome = 'pending' and claimed_at is null`;
  if (depth >= MAX_QUEUE_DEPTH) {
    return { ok: false, error: "the checker is saturated right now — try again in a minute." };
  }

  const [row] = await sql<CheckRow[]>`
    insert into lean_check (source_hash, source) values (${hash}, ${source})
    on conflict (source_hash) do update set source_hash = excluded.source_hash
    returning source_hash, outcome, detail, created_at, updated_at`;
  await sql.notify("lean_check", hash);
  return { ok: true, hash, row: row!, cached: false };
}

/** Wait for a check to resolve, or give up and let the caller ask again later. */
export async function awaitCheck(hash: string, timeoutMs: number): Promise<CheckRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<CheckRow[]>`
      select source_hash, outcome, detail, created_at, updated_at from lean_check where source_hash = ${hash}`;
    if (row!.outcome !== "pending" || Date.now() >= deadline) return row!;
    await Bun.sleep(500);
  }
}

/** Axioms a clean Mathlib development may depend on. */
export const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

export const foreignAxioms = (decls: Decl[]): string[] => [
  ...new Set(decls.flatMap((d) => d.axioms.filter((a) => !ALLOWED_AXIOMS.has(a)))),
];

/** The runner compiles in a scratch directory nobody else can act on. */
const scrubPaths = (output: string | undefined) => output?.replace(/\S*\/Check[0-9a-f]+\.lean/g, "check.lean");

/** What an agent gets back: the kernel's facts, in the order they matter. */
export function report(row: CheckRow, extras: { cached: boolean; queued?: boolean }) {
  const detail = row.detail ?? {};
  const decls = detail.decls ?? [];
  const foreign = foreignAxioms(decls);
  // The kernel accepts a proof that rests on sorryAx; calling that "passed"
  // reads as done to anyone skimming, and it is precisely not done.
  const incomplete = foreign.includes("sorryAx");
  const base = {
    status: row.outcome === "pending" ? ("running" as const) : incomplete ? ("incomplete" as const) : row.outcome,
    check_id: row.source_hash,
    cached: extras.cached,
    elapsed_seconds: detail.elapsed_ms != null ? Math.round(detail.elapsed_ms / 100) / 10 : undefined,
  };

  if (row.outcome === "pending") {
    return {
      ...base,
      note: "still compiling. Call check_lean again with the same source to pick the result up — the check keeps running and the answer is cached.",
    };
  }
  const proved = decls.map((d) => ({ name: d.name, statement: d.type, axioms: d.axioms }));
  if (row.outcome === "passed") {
    return {
      ...base,
      proved,
      foreign_axioms: foreign.length > 0 ? foreign : undefined,
      note: incomplete
        ? "it elaborates, but the declarations resting on sorryAx are holes, not proofs. Fill them and check again."
        : foreign.length > 0
          ? "the kernel accepted it, but it rests on axioms outside {propext, Classical.choice, Quot.sound}, so submitting it would not earn lean_verified."
          : "kernel-checked against the pinned Lean/Mathlib. `proved` is exactly what was proven — read the statements, not the names.",
    };
  }
  return {
    ...base,
    reason: detail.reason,
    sorry: detail.sorry || undefined,
    errors: scrubPaths(detail.output),
    proved: proved.length > 0 ? proved : undefined,
  };
}
