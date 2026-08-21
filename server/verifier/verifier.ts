/**
 * Lean verification orchestrator. This process owns the database and never
 * touches untrusted Lean code. The actual compilation happens in a separate,
 * sandboxed `runner.ts` process (own user, no network, no database access);
 * the two communicate through a file spool:
 *
 *   verifier --(<hash>.lean)--> SPOOL/in --> runner --(<hash>.json)--> SPOOL/out
 *
 * There is exactly one execution queue, `lean_check`, keyed by the hash of the
 * source. The `check_lean` tool and contribution verification are both callers
 * of it, so a lemma checked interactively costs nothing to check again on
 * submission, and forty agents checking the same source cost one kernel run.
 *
 * A verification outcome never changes a contribution's tier: tiers are an
 * editorial ladder climbed through operator review. A kernel pass is recorded
 * as an independent `lean-kernel: passed` property, along with the exact
 * statements that were proven and the axioms they depend on.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, renameSync, watch } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db.ts";
import {
  extractLean,
  foreignAxioms,
  provesNothing,
  statedDecls,
  unsoundTokens,
  type CheckDetail,
  type Decl,
} from "../src/lean.ts";
import { sha256hex } from "../src/identity.ts";
import { recordUnits } from "../src/lean-similar.ts";
import {
  adoptPatches,
  collectPatches,
  judgePatches,
  publishPatches,
  repoPresent,
  revalidatePatches,
  spoolPatches,
} from "./patches.ts";

const SPOOL = process.env.SPOOL_DIR ?? "/var/lib/lean-spool";
const SPOOL_IN = join(SPOOL, "in");
const SPOOL_OUT = join(SPOOL, "out");
const TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS ?? 600_000);
const GRACE_MS = 120_000; // runner queueing + audit slack on top of the compile timeout
const RECONCILE_MS = 5_000;
const CLAIM_LIMIT = 4;

type RunnerResult = {
  ok: boolean;
  exit_code?: number;
  timed_out?: boolean;
  output?: string;
  decls?: Decl[];
  audit_ok?: boolean;
  audit_error?: string;
  declares_nothing?: boolean;
};

const names = (decls: Decl[]): string => decls.map((d) => d.name).join(", ");

/** Spooled checks: source hash -> deadline. */
const inflight = new Map<string, number>();
/** Spooled patch builds: check id -> deadline. Separate because a patch build
 *  is a library build and only one runs at a time. */
const patchesInflight = new Map<string, number>();

// A resolved check is also the moment the ledger learns which declarations it
// now contains: `lean_unit` is what `lean_similar` searches, and it is written
// here so a submission is comparable as soon as the kernel has spoken.
const resolveCheck = async (hash: string, outcome: string, detail: CheckDetail) => {
  await sql`update lean_check set outcome = ${outcome}, detail = ${sql.json(detail as never)}, updated_at = now()
            where source_hash = ${hash}`;
  if (detail.decls?.length) await recordUnits(hash, detail.decls);
};

/**
 * Give every pending contribution verification a check to wait on. Source that
 * cannot pass is refused here rather than spending a kernel slot on it.
 */
async function adopt() {
  const rows = await sql<{ id: number; contribution_id: string; content: string }[]>`
    select v.id, v.contribution_id, a.content
    from verification v
    join contribution c on c.id = v.contribution_id
    join artifact a on a.hash = c.artifact_hash
    where v.method = 'lean-kernel' and v.outcome = 'pending' and (v.detail->>'check_hash') is null
    order by v.id limit 20`;

  for (const row of rows) {
    const source = extractLean(row.content);
    const unsound = unsoundTokens(source);
    if (unsound.length > 0) {
      await record(row.id, row.contribution_id, "failed", {
        reason: `contains \`${unsound[0]}\`, which can bypass or smuggle past the kernel`,
      });
      continue;
    }
    const hash = sha256hex(source);
    await sql`insert into lean_check (source_hash, source) values (${hash}, ${source}) on conflict do nothing`;
    await sql`update verification set detail = jsonb_set(detail, '{check_hash}', to_jsonb(${hash}::text)),
              updated_at = now() where id = ${row.id}`;
  }
}

async function spool() {
  const claimed = await sql<{ source_hash: string; source: string }[]>`
    update lean_check set claimed_at = now(), updated_at = now()
    where source_hash in (
      select source_hash from lean_check
      where outcome = 'pending' and claimed_at is null
      order by created_at for update skip locked limit ${CLAIM_LIMIT})
    returning source_hash, source`;

  for (const row of claimed) {
    writeFileSync(join(SPOOL_IN, `${row.source_hash}.lean.tmp`), row.source);
    // Atomic same-directory rename so the runner never sees a half-written file.
    renameSync(join(SPOOL_IN, `${row.source_hash}.lean.tmp`), join(SPOOL_IN, `${row.source_hash}.lean`));
    inflight.set(row.source_hash, Date.now() + TIMEOUT_MS + GRACE_MS);
  }
}

function interpret(result: RunnerResult, elapsedMs: number): { outcome: string; detail: CheckDetail } {
  const detail: CheckDetail = {
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    output: result.output,
    elapsed_ms: elapsedMs,
  };
  if (result.timed_out) {
    return { outcome: "inconclusive", detail: { ...detail, reason: `compilation timed out after ${TIMEOUT_MS / 1000}s` } };
  }
  if (result.exit_code === undefined) {
    return { outcome: "inconclusive", detail: { ...detail, reason: "the runner failed before compiling", audit_error: result.audit_error } };
  }
  if (!result.ok) {
    const usedSorry = /declaration uses 'sorry'/.test(result.output ?? "");
    return {
      outcome: "failed",
      detail: {
        ...detail,
        sorry: usedSorry,
        reason: usedSorry ? "compiles, but a declaration is still `sorry`" : "does not compile",
      },
    };
  }
  // Compiles, declares nothing. Exploration (`#check`, `#print axioms`, a bare
  // import) legitimately lands here, so it is not a verification of anything
  // — but it is also not a broken audit, and saying so sends agents hunting a
  // failure that did not happen.
  if (result.declares_nothing) {
    return {
      outcome: "inconclusive",
      detail: {
        ...detail,
        declares_nothing: true,
        reason: "compiled cleanly, but declares no theorem — there is nothing to audit",
      },
    };
  }
  if (!result.audit_ok || !result.decls) {
    return {
      outcome: "inconclusive",
      detail: { ...detail, reason: "compiled, but the axiom/statement audit did not complete", audit_error: result.audit_error },
    };
  }
  return { outcome: "passed", detail: { ...detail, decls: result.decls, audit_ok: true } };
}

async function collect() {
  for (const [hash, deadline] of inflight) {
    const resultPath = join(SPOOL_OUT, `${hash}.json`);
    if (existsSync(resultPath)) {
      const [started] = await sql<{ claimed_at: Date }[]>`select claimed_at from lean_check where source_hash = ${hash}`;
      const elapsed = Date.now() - new Date(started!.claimed_at).getTime();
      let parsed: RunnerResult;
      try {
        parsed = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        await resolveCheck(hash, "inconclusive", { reason: `unreadable runner result: ${error}` });
        rmSync(resultPath, { force: true });
        inflight.delete(hash);
        continue;
      }
      rmSync(resultPath, { force: true });
      inflight.delete(hash);
      const { outcome, detail } = interpret(parsed, elapsed);
      await resolveCheck(hash, outcome, detail);
      continue;
    }
    if (Date.now() > deadline) {
      rmSync(join(SPOOL_IN, `${hash}.lean`), { force: true });
      inflight.delete(hash);
      await resolveCheck(hash, "inconclusive", { reason: "no runner result within the deadline (runner down or overloaded?)" });
    }
  }
}

async function record(id: number, contributionId: string, result: string, detail: Record<string, unknown>) {
  await sql.begin(async (tx) => {
    await tx`update verification set outcome = ${result}, detail = detail || ${tx.json(detail as never)},
             updated_at = now() where id = ${id}`;
    await tx`insert into event (kind, contribution_id, payload)
             values ('verification', ${contributionId},
                     ${tx.json({ method: "lean-kernel", outcome: result, ...detail } as never)})`;
  });
}

/** Turn resolved checks into the editorial judgement a contribution carries. */
async function judge() {
  const rows = await sql<{ id: number; contribution_id: string; outcome: string; detail: CheckDetail }[]>`
    select v.id, v.contribution_id, k.outcome, k.detail
    from verification v join lean_check k on k.source_hash = v.detail->>'check_hash'
    where v.method = 'lean-kernel' and v.outcome = 'pending' and k.outcome <> 'pending'`;

  for (const row of rows) {
    if (row.outcome === "passed") {
      const decls = row.detail.decls ?? [];
      const foreign = foreignAxioms(decls);
      if (foreign.length > 0) {
        await record(row.id, row.contribution_id, "failed", {
          reason: `depends on axioms outside {propext, Classical.choice, Quot.sound}: ${foreign.join(", ")}`,
          decls,
        });
      } else if (provesNothing(decls)) {
        // It compiled, so the source is good Lean and the check row says so.
        // But every declaration is a definition or a `def … : Prop` statement,
        // and lean_verified means the kernel checked a *proof*. Granting it
        // here would put the badge on open problems merely because someone
        // stated them well. Inconclusive, not failed: nothing is wrong.
        await record(row.id, row.contribution_id, "inconclusive", {
          reason: `compiles, but proves nothing: ${statedDecls(decls).length} declaration(s) — ${names(statedDecls(decls))} — are definitions or statements, not proofs`,
          decls,
        });
      } else {
        await record(row.id, row.contribution_id, "passed", {
          decls,
          note: "kernel-checked; the declarations marked proof:true are exactly what was proven, the rest are definitions and statements",
        });
      }
    } else {
      await record(row.id, row.contribution_id, row.outcome, {
        reason: row.detail.reason,
        exit_code: row.detail.exit_code,
        output: row.detail.output,
      });
    }
  }
}

/** Anything claimed but unresolved when this process died goes back on the queue. */
async function recover() {
  const claimed = await sql<{ source_hash: string }[]>`
    select source_hash from lean_check where outcome = 'pending' and claimed_at is not null`;
  for (const row of claimed) {
    rmSync(join(SPOOL_IN, `${row.source_hash}.lean`), { force: true });
    rmSync(join(SPOOL_OUT, `${row.source_hash}.json`), { force: true });
  }
  await sql`update lean_check set claimed_at = null where outcome = 'pending' and claimed_at is not null`;
  if (claimed.length > 0) console.log(`re-queued ${claimed.length} orphaned pending check(s)`);

  const patches = await sql<{ id: string }[]>`
    select id from patch_check where outcome = 'pending' and claimed_at is not null`;
  for (const row of patches) {
    rmSync(join(SPOOL_IN, `patch-${row.id}`), { recursive: true, force: true });
    rmSync(join(SPOOL_OUT, `patch-${row.id}`), { recursive: true, force: true });
  }
  await sql`update patch_check set claimed_at = null where outcome = 'pending' and claimed_at is not null`;
  if (patches.length > 0) console.log(`re-queued ${patches.length} orphaned pending patch build(s)`);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await adopt();
    await spool();
    await collect();
    await judge();
    await adoptPatches();
    await spoolPatches(patchesInflight);
    await collectPatches(patchesInflight);
    await judgePatches();
    await publishPatches();
    await revalidatePatches();
  } catch (error) {
    console.error("tick failed:", error);
  } finally {
    ticking = false;
  }
}

mkdirSync(SPOOL_IN, { recursive: true });
mkdirSync(SPOOL_OUT, { recursive: true });
await recover();
// A new check and a finished check both wake the loop immediately; the
// interval is the reconciler that makes the work happen anyway.
await sql.listen("lean_check", () => void tick());
watch(SPOOL_OUT, () => void tick());
console.log(
  `lean verifier (orchestrator): spool=${SPOOL} timeout=${TIMEOUT_MS}ms patches=${repoPresent() ? "on" : "no library checkout"}`,
);
setInterval(() => void tick(), RECONCILE_MS);
void tick();
