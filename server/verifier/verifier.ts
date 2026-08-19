/**
 * Lean verification orchestrator. This process owns the database and never
 * touches untrusted Lean code. The actual compilation happens in a separate,
 * sandboxed `runner.ts` process (own user, no network, no database access);
 * the two communicate through a file spool:
 *
 *   verifier --(<id>.lean)--> SPOOL/in --> runner --(<id>.json)--> SPOOL/out
 *
 * A verification outcome never changes a contribution's tier: tiers are an
 * editorial ladder climbed through operator review. A kernel pass is recorded
 * as an independent `lean-kernel: passed` property, along with the exact
 * statements that were proven and the axioms they depend on.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db.ts";

const SPOOL = process.env.SPOOL_DIR ?? "/var/lib/lean-spool";
const SPOOL_IN = join(SPOOL, "in");
const SPOOL_OUT = join(SPOOL, "out");
const TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS ?? 600_000);
const GRACE_MS = 120_000; // runner queueing + audit slack on top of the compile timeout
const POLL_MS = 5_000;

// Defense in depth only — the real gate is the axiom audit reported by the
// runner. These tokens either bypass the kernel or smuggle unproven facts.
const FORBIDDEN = /\b(sorry|admit|native_decide|extern|implemented_by|ofReduceBool|ofReduceNat)\b/;

// Axioms a clean Mathlib development may depend on. Anything else (including
// sorryAx and user-declared axioms) fails the audit.
const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

function extractLean(content: string): string {
  const blocks = [...content.matchAll(/```lean\n([\s\S]*?)```/g)].map((m) => m[1]);
  const source = blocks.length > 0 ? blocks.join("\n\n") : content;
  return source.includes("import ") ? source : `import Mathlib\n\n${source}`;
}

type RunnerResult = {
  ok: boolean;
  exit_code?: number;
  timed_out?: boolean;
  output?: string;
  decls?: { name: string; type: string; axioms: string[] }[];
  audit_ok?: boolean;
  audit_error?: string;
};

async function record(id: number, contributionId: string, result: string, detail: Record<string, unknown>) {
  await sql.begin(async (tx) => {
    await tx`update verification set outcome = ${result}, detail = ${tx.json(detail as never)},
             updated_at = now() where id = ${id}`;
    await tx`insert into event (kind, contribution_id, payload)
             values ('verification', ${contributionId},
                     ${tx.json({ method: "lean-kernel", outcome: result, ...detail } as never)})`;
  });
}

/** In-flight checks: verification id -> { contributionId, deadline }. */
const inflight = new Map<number, { contributionId: string; deadline: number }>();

async function spool() {
  const claimed = await sql.begin(async (tx) => {
    const rows = await tx<{ id: number; contribution_id: string; content: string }[]>`
      select v.id, v.contribution_id, a.content
      from verification v
      join contribution c on c.id = v.contribution_id
      join artifact a on a.hash = c.artifact_hash
      where v.method = 'lean-kernel' and v.outcome = 'pending'
        and (v.detail->>'claimed_at') is null
      order by v.id
      for update of v skip locked
      limit 4`;
    for (const row of rows) {
      await tx`update verification set detail = jsonb_set(detail, '{claimed_at}', to_jsonb(now())),
               updated_at = now() where id = ${row.id}`;
    }
    return rows;
  });

  for (const row of claimed) {
    const source = extractLean(row.content);
    const forbidden = source.match(FORBIDDEN);
    if (forbidden) {
      await record(row.id, row.contribution_id, "failed", {
        reason: `contains \`${forbidden[0]}\`, which can bypass or smuggle past the kernel`,
      });
      continue;
    }
    writeFileSync(join(SPOOL_IN, `${row.id}.lean.tmp`), source);
    // Atomic rename so the runner never sees a half-written file.
    await Bun.$`mv ${join(SPOOL_IN, `${row.id}.lean.tmp`)} ${join(SPOOL_IN, `${row.id}.lean`)}`.quiet();
    inflight.set(row.id, { contributionId: row.contribution_id, deadline: Date.now() + TIMEOUT_MS + GRACE_MS });
  }
}

async function collect() {
  for (const [id, meta] of inflight) {
    const resultPath = join(SPOOL_OUT, `${id}.json`);
    if (existsSync(resultPath)) {
      let result: RunnerResult;
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        await record(id, meta.contributionId, "inconclusive", { reason: `unreadable runner result: ${error}` });
        rmSync(resultPath, { force: true });
        inflight.delete(id);
        continue;
      }
      rmSync(resultPath, { force: true });
      inflight.delete(id);

      if (result.timed_out) {
        await record(id, meta.contributionId, "inconclusive", {
          reason: `compilation timed out after ${TIMEOUT_MS / 1000}s`,
          output: result.output,
        });
      } else if (!result.ok) {
        await record(id, meta.contributionId, "failed", { exit_code: result.exit_code, output: result.output });
      } else if (!result.audit_ok || !result.decls) {
        await record(id, meta.contributionId, "inconclusive", {
          reason: "compiled, but the axiom/statement audit did not complete",
          audit_error: result.audit_error,
          output: result.output,
        });
      } else {
        const badAxioms = result.decls.flatMap((d) => d.axioms.filter((a) => !ALLOWED_AXIOMS.has(a)));
        if (badAxioms.length > 0) {
          await record(id, meta.contributionId, "failed", {
            reason: `depends on axioms outside {propext, Classical.choice, Quot.sound}: ${[...new Set(badAxioms)].join(", ")}`,
            decls: result.decls,
          });
        } else {
          await record(id, meta.contributionId, "passed", {
            decls: result.decls,
            note: "kernel-checked; the statements listed in decls are exactly what was proven",
          });
        }
      }
      continue;
    }
    if (Date.now() > meta.deadline) {
      rmSync(join(SPOOL_IN, `${id}.lean`), { force: true });
      inflight.delete(id);
      await record(id, meta.contributionId, "inconclusive", {
        reason: "no runner result within the deadline (runner down or overloaded?)",
      });
    }
  }
}

/** On startup, re-adopt claims that were spooled but never resolved. */
async function recover() {
  const rows = await sql<{ id: number; contribution_id: string }[]>`
    select v.id, v.contribution_id from verification v
    where v.method = 'lean-kernel' and v.outcome = 'pending'
      and (v.detail->>'claimed_at') is not null`;
  for (const row of rows) {
    // Re-spool from scratch: clear the claim so the next tick picks it up.
    rmSync(join(SPOOL_IN, `${row.id}.lean`), { force: true });
    rmSync(join(SPOOL_OUT, `${row.id}.json`), { force: true });
    await sql`update verification set detail = detail - 'claimed_at' where id = ${row.id}`;
  }
  if (rows.length > 0) console.log(`re-queued ${rows.length} orphaned pending check(s)`);
}

mkdirSync(SPOOL_IN, { recursive: true });
mkdirSync(SPOOL_OUT, { recursive: true });
await recover();
console.log(`lean verifier (orchestrator): spool=${SPOOL} timeout=${TIMEOUT_MS}ms`);
setInterval(
  () =>
    spool()
      .then(collect)
      .catch((error) => console.error("tick failed:", error)),
  POLL_MS,
);
