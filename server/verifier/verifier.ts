/**
 * Lean verification daemon. Polls for pending lean-kernel verifications,
 * checks them against the pinned Mathlib project with bounded concurrency,
 * and records outcomes. A pass lifts the contribution to tier 3 (the
 * artifact is machine-verified; statement fidelity is tracked separately).
 *
 * If the Lean project isn't built yet (no .ready marker), pending checks
 * simply wait — no cold fallback, no silent skip.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db.ts";

const LEAN_DIR = process.env.LEAN_DIR ?? join(import.meta.dir, "../../lean");
const CHECK_DIR = join(LEAN_DIR, "checks");
const READY = join(LEAN_DIR, ".ready");
const CONCURRENCY = Number(process.env.LEAN_CONCURRENCY ?? 2);
const TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS ?? 600_000);
const POLL_MS = 5_000;

const FORBIDDEN = /\b(sorry|admit|native_decide)\b/;

function extractLean(content: string): string {
  const blocks = [...content.matchAll(/```lean\n([\s\S]*?)```/g)].map((m) => m[1]);
  const source = blocks.length > 0 ? blocks.join("\n\n") : content;
  return source.includes("import ") ? source : `import Mathlib\n\n${source}`;
}

async function runCheck(id: number, contributionId: string, content: string) {
  const source = extractLean(content);
  const outcome = async (result: string, detail: Record<string, unknown>) => {
    await sql.begin(async (tx) => {
      await tx`update verification set outcome = ${result}, detail = ${tx.json(detail as never)},
               updated_at = now() where id = ${id}`;
      await tx`insert into event (kind, contribution_id, payload)
               values ('verification', ${contributionId},
                       ${tx.json({ method: "lean-kernel", outcome: result, ...detail } as never)})`;
      if (result === "passed") {
        await tx`update contribution set tier = greatest(tier, 3), updated_at = now()
                 where id = ${contributionId} and status = 'active'`;
        await tx`insert into event (kind, contribution_id, payload)
                 values ('tier-changed', ${contributionId}, ${tx.json({ tier: 3, via: "lean-kernel" } as never)})`;
      }
    });
  };

  const forbidden = source.match(FORBIDDEN);
  if (forbidden) {
    await outcome("failed", { reason: `contains ${forbidden[0]}, which bypasses the kernel` });
    return;
  }

  const file = join(CHECK_DIR, `check_${id}.lean`);
  writeFileSync(file, source);
  try {
    const proc = Bun.spawn(["lake", "env", "lean", file], {
      cwd: LEAN_DIR,
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = (stdout + stderr).slice(-4000);
    if (exitCode === 0 && !/warning: .*sorry/i.test(output)) {
      await outcome("passed", { output });
    } else if (proc.killed) {
      await outcome("inconclusive", { reason: `timed out after ${TIMEOUT_MS / 1000}s`, output });
    } else {
      await outcome("failed", { exit_code: exitCode, output });
    }
  } catch (error) {
    await outcome("inconclusive", { reason: String(error) });
  } finally {
    rmSync(file, { force: true });
  }
}

let running = 0;

async function tick() {
  if (!existsSync(READY)) return;
  while (running < CONCURRENCY) {
    const claimed = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: number; contribution_id: string; content: string }[]>`
        select v.id, v.contribution_id, a.content
        from verification v
        join contribution c on c.id = v.contribution_id
        join artifact a on a.hash = c.artifact_hash
        where v.method = 'lean-kernel' and v.outcome = 'pending'
        order by v.id
        for update of v skip locked
        limit 1`;
      if (!row) return null;
      await tx`update verification set detail = jsonb_set(detail, '{claimed_at}', to_jsonb(now())),
               updated_at = now() where id = ${row.id} and outcome = 'pending'`;
      return row;
    });
    if (!claimed) break;
    running++;
    runCheck(claimed.id, claimed.contribution_id, claimed.content)
      .catch((error) => console.error(`check ${claimed.id} crashed:`, error))
      .finally(() => {
        running--;
      });
  }
}

mkdirSync(CHECK_DIR, { recursive: true });
console.log(`lean verifier: project=${LEAN_DIR} concurrency=${CONCURRENCY} ready=${existsSync(READY)}`);
setInterval(() => tick().catch((error) => console.error("tick failed:", error)), POLL_MS);
