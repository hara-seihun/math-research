/**
 * Patch verification and publication.
 *
 * This is the trusted half: it owns git, the library checkout, and the
 * database, and it never compiles anything itself. A patch travels:
 *
 *   submit(kind='patch')            a unified diff against the library
 *     → verification 'patch-build'  queued like any other verification
 *     → patch_check                 content-addressed by (repo, base, diff)
 *     → worktree + git apply        conflicts are reported, never merged blind
 *     → SPOOL/in/patch-<id>/        sources + compile order for the sandbox
 *     → SPOOL/out/patch-<id>/       oleans + what the kernel said
 *     → set_tier 2                  review decides, exactly as for a proof
 *     → publish                     re-verified at head, committed, installed
 *
 * Publication re-runs the check against the repository's current head before
 * it commits, so a patch reviewed against a base that has since moved is
 * blocked with its reason rather than applied to a tree it was never tested
 * against. Nothing here can push: the guest holds no GitHub credential, so
 * publication lands as a local commit and the host's tools/publish-lemma-lib.sh
 * carries it to the public repository.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sql } from "../src/db.ts";
import { unsoundTokens } from "../src/lean.ts";
import {
  addedLines,
  extractDiff,
  MAX_DIFF_BYTES,
  patchCheckId,
  PATCH_REPO,
  type PatchDetail,
} from "../src/patch.ts";
import type { PatchDecl, PatchJob, PatchModule, PatchResult } from "./patch-job.ts";

const REPO_DIR = process.env.PATCH_REPO_DIR ?? "/srv/lemma-lib";
/** Modules are `<LIB>/<path>.lean`, with `<LIB>.lean` as the umbrella. */
const LIB = process.env.PATCH_LIB ?? "LemmaLib";
const BUILD_LIB = process.env.PATCH_BUILD_LIB ?? join(REPO_DIR, ".lake/build/lib/lean");
const STATE_DIR = process.env.PATCH_STATE_DIR ?? "/var/lib/math-research/patch-work";
const SPOOL = process.env.SPOOL_DIR ?? "/var/lib/lean-spool";
const SPOOL_IN = join(SPOOL, "in");
const SPOOL_OUT = join(SPOOL, "out");
const JOB_TIMEOUT_MS = Number(process.env.PATCH_TIMEOUT_MS ?? 1_800_000);
/** Beyond this the rebuild is a library-wide event, not a patch. */
const MAX_REBUILD = Number(process.env.PATCH_MAX_REBUILD ?? 500);
const INDEX_SCRIPT = process.env.DECL_INDEX_SCRIPT ?? "/srv/math-research/tools/index-decls.sh";
const INDEXED_COMMIT = process.env.PATCH_INDEXED_COMMIT ?? join(STATE_DIR, "indexed-commit");

const worktreeDir = (id: string) => join(STATE_DIR, "worktrees", id);
const oleanDir = (id: string) => join(STATE_DIR, "oleans", id);

type Run = { code: number; stdout: string; stderr: string };

async function run(cmd: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO_DIR,
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const git = (args: string[], opts: { cwd?: string; stdin?: string } = {}) => run(["git", ...args], opts);

export const repoPresent = () => existsSync(join(REPO_DIR, ".git"));

export async function headCommit(): Promise<string | null> {
  const rev = await git(["rev-parse", "HEAD"]);
  return rev.code === 0 ? rev.stdout.trim() : null;
}

const moduleOf = (path: string): string | null => {
  if (path === `${LIB}.lean`) return LIB;
  return path.startsWith(`${LIB}/`) && path.endsWith(".lean")
    ? path.slice(0, -".lean".length).replaceAll("/", ".")
    : null;
};

const pathOf = (module: string) => `${module.replaceAll(".", "/")}.lean`;

const resolvePatchDetail = (id: string, outcome: string, detail: PatchDetail) =>
  sql`update patch_check set outcome = ${outcome}, detail = ${sql.json(detail as never)}, updated_at = now()
      where id = ${id}`;

async function recordVerification(id: number, contributionId: string, outcome: string, detail: Record<string, unknown>) {
  await sql.begin(async (tx) => {
    await tx`update verification set outcome = ${outcome}, detail = detail || ${tx.json(detail as never)},
             updated_at = now() where id = ${id}`;
    await tx`insert into event (kind, contribution_id, payload)
             values ('verification', ${contributionId},
                     ${tx.json({ method: "patch-build", outcome, ...detail } as never)})`;
  });
}

/** Give every pending patch verification a check to wait on, refusing here
 *  what cannot be a patch at all rather than spending a build slot on it. */
export async function adoptPatches() {
  const rows = await sql<{ id: number; contribution_id: string; content: string; metadata: Record<string, unknown> }[]>`
    select v.id, v.contribution_id, a.content, c.metadata
    from verification v
    join contribution c on c.id = v.contribution_id
    join artifact a on a.hash = c.artifact_hash
    where v.method = 'patch-build' and v.outcome = 'pending' and (v.detail->>'check_id') is null
    order by v.id limit 10`;
  if (rows.length === 0) return;

  const head = await headCommit();
  for (const row of rows) {
    const diff = extractDiff(row.content);
    const meta = (row.metadata ?? {}) as { repo?: string; base_commit?: string };
    const repo = meta.repo ?? PATCH_REPO;
    if (!diff) {
      await recordVerification(row.id, row.contribution_id, "failed", { reason: "no diff in that content" });
      continue;
    }
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
      await recordVerification(row.id, row.contribution_id, "failed", {
        reason: `the diff is over ${MAX_DIFF_BYTES >> 10} KiB. Split it into patches that stand on their own.`,
      });
      continue;
    }
    if (repo !== PATCH_REPO) {
      await recordVerification(row.id, row.contribution_id, "failed", {
        reason: `this ledger builds '${PATCH_REPO}', not '${repo}'.`,
      });
      continue;
    }
    const unsound = unsoundTokens(addedLines(diff));
    if (unsound.length > 0) {
      await recordVerification(row.id, row.contribution_id, "failed", {
        reason: `the patch adds \`${unsound[0]}\`, which bypasses or smuggles past the kernel`,
      });
      continue;
    }
    if (!head) {
      await recordVerification(row.id, row.contribution_id, "unavailable", {
        reason: `no ${PATCH_REPO} checkout on this instance, so patches cannot be built here`,
      });
      continue;
    }
    let base = meta.base_commit?.trim() || head;
    if (base !== head) {
      const known = await git(["cat-file", "-e", `${base}^{commit}`]);
      if (known.code !== 0) {
        await recordVerification(row.id, row.contribution_id, "failed", {
          reason: `base_commit ${base} is not a commit in ${PATCH_REPO}`,
        });
        continue;
      }
    }
    const checkId = patchCheckId(repo, base, diff);
    await sql`insert into patch_check (id, repo, base_commit, diff)
              values (${checkId}, ${repo}, ${base}, ${diff}) on conflict do nothing`;
    await sql`update verification
              set detail = detail || ${sql.json({ check_id: checkId, base_commit: base, repo } as never)},
                  updated_at = now()
              where id = ${row.id}`;
  }
}

type Prepared =
  | { ok: true; job: PatchJob; detail: PatchDetail }
  | { ok: false; outcome: "failed" | "inconclusive"; detail: PatchDetail };

/** Apply the diff to a scratch worktree and work out what has to be rebuilt:
 *  the modules it touches, and everything that imports them. */
async function prepare(id: string, base: string, diff: string): Promise<Prepared> {
  const dir = worktreeDir(id);
  rmSync(dir, { recursive: true, force: true });
  await git(["worktree", "prune"]);
  const added = await git(["worktree", "add", "--detach", dir, base]);
  if (added.code !== 0) {
    return { ok: false, outcome: "inconclusive", detail: { reason: `could not create a worktree at ${base}`, conflict: added.stderr.slice(-2000) } };
  }

  const patchFile = join(STATE_DIR, `${id}.diff`);
  writeFileSync(patchFile, diff);
  const applied = await git(["apply", "--index", "--3way", "--whitespace=nowarn", patchFile], { cwd: dir });
  rmSync(patchFile, { force: true });
  if (applied.code !== 0) {
    return {
      ok: false,
      outcome: "failed",
      detail: {
        base_commit: base,
        reason: `the patch does not apply to ${base.slice(0, 8)}`,
        conflict: `${applied.stdout}${applied.stderr}`.slice(-4000),
      },
    };
  }

  const status = await git(["diff", "--cached", "--name-status", "-M"], { cwd: dir });
  const files = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0]!, path: parts[parts.length - 1]!, from: parts.length > 2 ? parts[1]! : undefined };
    });

  const deleted = new Set<string>();
  const changed = new Set<string>();
  const isNew = new Set<string>();
  for (const f of files) {
    if (f.path === `${LIB}.lean` && f.status.startsWith("D")) {
      return {
        ok: false,
        outcome: "failed",
        detail: { base_commit: base, reason: `${LIB}.lean is the library umbrella and cannot be deleted` },
      };
    }
    const target = moduleOf(f.path);
    if (f.status.startsWith("D")) {
      if (target) deleted.add(target);
      continue;
    }
    if (target && (f.status.startsWith("A") || f.status.startsWith("R"))) isNew.add(target);
    if (f.status.startsWith("R") && f.from) {
      const gone = moduleOf(f.from);
      if (gone) deleted.add(gone);
    }
    if (target) changed.add(target);
  }

  // Every intra-library import in the patched tree, in one pass, so a rename
  // that leaves a dangling import fails here rather than in someone's session.
  const importsOf = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  const listing = await git(
    ["grep", "--cached", "-E", "-e", `^(public |private )?import ${LIB}`, "--", `${LIB}/`, `${LIB}.lean`],
    { cwd: dir },
  );
  for (const line of listing.stdout.split("\n")) {
    if (!line) continue;
    const sep = line.indexOf(":");
    const self = moduleOf(line.slice(0, sep));
    const imported = line.slice(sep + 1).replace(/^(public |private )?import\s+/, "").trim();
    if (!self || !imported) continue;
    importsOf.set(self, [...(importsOf.get(self) ?? []), imported]);
    importers.set(imported, [...(importers.get(imported) ?? []), self]);
  }

  const orphaned = [...deleted].filter((gone) => (importers.get(gone) ?? []).some((m) => !deleted.has(m)));
  if (orphaned.length > 0) {
    return {
      ok: false,
      outcome: "failed",
      detail: {
        base_commit: base,
        reason: `the patch deletes ${orphaned[0]} while ${importers.get(orphaned[0]!)!.filter((m) => !deleted.has(m)).slice(0, 5).join(", ")} still imports it`,
        deleted_modules: [...deleted],
      },
    };
  }

  // Everything downstream of a changed module is rebuilt: a statement whose
  // meaning moved has to be seen by the proofs that used it.
  const rebuild = new Set(changed);
  const builtAtBase = (module: string) => existsSync(join(BUILD_LIB, `${module.replaceAll(".", "/")}.olean`));
  const queue = [...changed, ...deleted];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const importer of importers.get(next) ?? []) {
      if (deleted.has(importer) || rebuild.has(importer)) continue;
      rebuild.add(importer);
      queue.push(importer);
    }
  }
  if (rebuild.size > MAX_REBUILD) {
    return {
      ok: false,
      outcome: "inconclusive",
      detail: {
        base_commit: base,
        reason: `${rebuild.size} modules would have to be rebuilt, past the ${MAX_REBUILD} this pipeline builds in one job. Split the patch, or rebuild the library.`,
        changed_modules: [...changed],
      },
    };
  }

  // Compile order: a module after everything it imports.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (module: string) => {
    if (seen.has(module) || !rebuild.has(module)) return;
    seen.add(module);
    for (const dep of importsOf.get(module) ?? []) visit(dep);
    order.push(module);
  };
  for (const module of rebuild) visit(module);

  const unavailable = order.filter((module) => !builtAtBase(module) && !isNew.has(module));
  if (unavailable.length > 0) {
    return {
      ok: false,
      outcome: "inconclusive",
      detail: {
        base_commit: base,
        reason: `the installed LemmaLib build is missing ${unavailable[0]}; refresh the library before checking patches`,
      },
    };
  }

  const src = join(dir, "src-job");
  rmSync(src, { recursive: true, force: true });
  const modules: PatchModule[] = [];
  for (const module of order) {
    const rel = pathOf(module);
    const from = join(dir, rel);
    if (!existsSync(from)) {
      return {
        ok: false,
        outcome: "failed",
        detail: { base_commit: base, reason: `${module} is imported but ${rel} does not exist after the patch` },
      };
    }
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    cpSync(from, join(src, rel));
    modules.push({
      module,
      path: rel,
      changed: changed.has(module),
      requires: (importsOf.get(module) ?? []).filter((dep) => rebuild.has(dep)),
    });
  }

  return {
    ok: true,
    job: { id, modules, deleted: [...deleted], timeout_ms: JOB_TIMEOUT_MS },
    detail: {
      base_commit: base,
      files: files.map((f) => ({ status: f.status, path: f.path })),
      changed_modules: [...changed],
      deleted_modules: [...deleted],
      rebuilt_modules: order.filter((m) => !changed.has(m)),
    },
  };
}

/** Hand a prepared job to the sandbox. */
function spoolJob(id: string, job: PatchJob) {
  const staging = join(SPOOL_IN, `patch-${id}.staging`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(join(worktreeDir(id), "src-job"), join(staging, "src"), { recursive: true });
  writeFileSync(join(staging, "job.json"), JSON.stringify(job));
  renameSync(staging, join(SPOOL_IN, `patch-${id}`));
}

/** Claim pending checks and start them. One at a time: a patch build is a
 *  library build, not a lemma. */
export async function spoolPatches(inflight: Map<string, number>) {
  if (inflight.size > 0 || !repoPresent()) return;
  const [row] = await sql<{ id: string; base_commit: string; diff: string }[]>`
    update patch_check set claimed_at = now(), updated_at = now()
    where id in (
      select id from patch_check where outcome = 'pending' and claimed_at is null
      order by created_at for update skip locked limit 1)
    returning id, base_commit, diff`;
  if (!row) return;

  mkdirSync(STATE_DIR, { recursive: true });
  const prepared = await prepare(row.id, row.base_commit, row.diff);
  if (!prepared.ok) {
    rmSync(worktreeDir(row.id), { recursive: true, force: true });
    await git(["worktree", "prune"]);
    await resolvePatchDetail(row.id, prepared.outcome, prepared.detail);
    return;
  }
  if (prepared.job.modules.length === 0) {
    rmSync(worktreeDir(row.id), { recursive: true, force: true });
    await git(["worktree", "prune"]);
    await resolvePatchDetail(row.id, "passed", {
      ...prepared.detail,
      reason: "applies cleanly and touches no library module, so there is nothing to build",
      built: [],
    });
    return;
  }
  spoolJob(row.id, prepared.job);
  await sql`update patch_check set detail = ${sql.json(prepared.detail as never)}, updated_at = now() where id = ${row.id}`;
  inflight.set(row.id, Date.now() + JOB_TIMEOUT_MS + 300_000);
}

const declSummary = (decls: Record<string, PatchDecl[]> | undefined) =>
  Object.entries(decls ?? {}).map(([module, list]) => ({
    module,
    proved: list.filter((d) => d.proof === true).length,
    stated: list.filter((d) => d.proof !== true).length,
  }));

const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const foreignAxioms = (decls: Record<string, PatchDecl[]> | undefined) => [
  ...new Set(
    Object.values(decls ?? {})
      .flat()
      .flatMap((d) => d.axioms.filter((a) => !ALLOWED_AXIOMS.has(a))),
  ),
];

/** Collect finished builds, keeping the oleans: publication installs exactly
 *  what was verified rather than compiling a second time. */
export async function collectPatches(inflight: Map<string, number>) {
  for (const [id, deadline] of inflight) {
    const outDir = join(SPOOL_OUT, `patch-${id}`);
    const resultPath = join(outDir, "result.json");
    if (existsSync(resultPath)) {
      let parsed: PatchResult;
      try {
        parsed = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        await resolvePatchDetail(id, "inconclusive", { reason: `unreadable runner result: ${error}` });
        rmSync(outDir, { recursive: true, force: true });
        inflight.delete(id);
        continue;
      }
      const [existing] = await sql<{ detail: PatchDetail }[]>`select detail from patch_check where id = ${id}`;
      const detail: PatchDetail = {
        ...(existing?.detail ?? {}),
        built: parsed.built,
        elapsed_ms: parsed.elapsed_ms,
        decl_summary: declSummary(parsed.decls),
        foreign_axioms: foreignAxioms(parsed.decls),
      };
      const pureDeletion =
        (detail.deleted_modules?.length ?? 0) > 0 &&
        (detail.changed_modules ?? []).every((module) => module === LIB);
      if (parsed.ok && parsed.built.length === 0 && pureDeletion) {
        // A pure deletion introduces no Lean term to audit. `prepare` already
        // proved that no surviving source imports it, and publication removes
        // the old olean. Requiring a positive build would make cleanup of leaf
        // modules impossible, since a deletion builds nothing.
        rmSync(oleanDir(id), { recursive: true, force: true });
        mkdirSync(oleanDir(id), { recursive: true });
        await resolvePatchDetail(id, "passed", detail);
      } else if (parsed.ok && parsed.built.length === 0) {
        await resolvePatchDetail(id, "inconclusive", {
          ...detail,
          reason: "the patch changed no library module, so the kernel verified nothing",
        });
      } else if (parsed.ok) {
        rmSync(oleanDir(id), { recursive: true, force: true });
        mkdirSync(dirname(oleanDir(id)), { recursive: true });
        if (existsSync(join(outDir, "lib"))) cpSync(join(outDir, "lib"), oleanDir(id), { recursive: true });
        const foreign = detail.foreign_axioms ?? [];
        if (foreign.length > 0) {
          await resolvePatchDetail(id, "failed", {
            ...detail,
            reason: `the patched modules depend on axioms outside {propext, Classical.choice, Quot.sound}: ${foreign.join(", ")}`,
          });
        } else {
          await resolvePatchDetail(id, "passed", detail);
        }
      } else {
        await resolvePatchDetail(id, parsed.error ? "inconclusive" : "failed", {
          ...detail,
          reason:
            parsed.error ??
            (parsed.failed?.timed_out
              ? `${parsed.failed.module} did not finish building in time`
              : `${parsed.failed?.module ?? "the patch"} does not build`),
          failed_module: parsed.failed?.module,
          errors: parsed.failed?.output?.slice(-4000),
        });
      }
      rmSync(outDir, { recursive: true, force: true });
      rmSync(worktreeDir(id), { recursive: true, force: true });
      await git(["worktree", "prune"]);
      inflight.delete(id);
      continue;
    }
    if (Date.now() > deadline) {
      rmSync(join(SPOOL_IN, `patch-${id}`), { recursive: true, force: true });
      rmSync(worktreeDir(id), { recursive: true, force: true });
      await git(["worktree", "prune"]);
      inflight.delete(id);
      await resolvePatchDetail(id, "inconclusive", { reason: "no runner result within the deadline (runner down or overloaded?)" });
    }
  }
}

/** Turn resolved checks into the judgement the contribution carries. */
export async function judgePatches() {
  const rows = await sql<{ id: number; contribution_id: string; outcome: string; detail: PatchDetail; base_commit: string }[]>`
    select v.id, v.contribution_id, k.outcome, k.detail, k.base_commit
    from verification v join patch_check k on k.id = v.detail->>'check_id'
    where v.method = 'patch-build' and v.outcome = 'pending' and k.outcome <> 'pending'`;
  for (const row of rows) {
    const detail = row.detail ?? {};
    await recordVerification(row.id, row.contribution_id, row.outcome, {
      base_commit: row.base_commit,
      reason: detail.reason,
      changed_modules: detail.changed_modules,
      deleted_modules: detail.deleted_modules,
      rebuilt_modules: detail.rebuilt_modules?.length,
      built: detail.built?.length,
      decl_summary: detail.decl_summary,
      errors: detail.errors,
      note:
        row.outcome === "passed"
          ? "applies to LemmaLib, and every module it touches plus everything importing them builds against the pinned Mathlib. Publication happens if review promotes it to T2."
          : undefined,
    });
  }
}

/**
 * A patch verified against a base that is no longer head has not been shown to
 * apply to the library as it stands. Rather than let review promote a stale
 * result, every open patch is re-checked against the new head when the
 * repository moves, which is also what the publisher will demand.
 */
export async function revalidatePatches() {
  const head = await headCommit();
  if (!head) return;
  const rows = await sql<{ id: number; contribution_id: string; content: string; metadata: Record<string, unknown> }[]>`
    select v.id, v.contribution_id, a.content, c.metadata
    from verification v
    join contribution c on c.id = v.contribution_id
    join artifact a on a.hash = c.artifact_hash
    where v.method = 'patch-build' and v.outcome <> 'pending'
      and c.status = 'active'
      and coalesce(v.detail->>'base_commit', '') <> ${head}
      and coalesce(c.metadata->>'base_commit', '') = ''
      and not exists (select 1 from patch_publication p
                      where p.contribution_id = c.id
                        and (p.state = 'published' or p.repo <> ${PATCH_REPO}))
    limit 5`;
  for (const row of rows) {
    const diff = extractDiff(row.content);
    if (!diff) continue;
    const checkId = patchCheckId(PATCH_REPO, head, diff);
    await sql`insert into patch_check (id, repo, base_commit, diff)
              values (${checkId}, ${PATCH_REPO}, ${head}, ${diff}) on conflict do nothing`;
    await sql`update verification set outcome = 'pending',
              detail = detail || ${sql.json({ check_id: checkId, base_commit: head, revalidating: true } as never)},
              updated_at = now() where id = ${row.id}`;
  }
}

const shortId = (id: string) => id.slice(0, 8);

/**
 * Install exactly the oleans that were verified, so the build tree and the
 * commit describe the same library.
 *
 * Modes are set explicitly rather than left to the umask: this process runs
 * with a private one so that spool files stay between it and the runner, but
 * the build tree is the opposite kind of thing, since the sandbox reads it as
 * another user through a read-only bind mount, and an olean it cannot read is
 * a module that silently vanished from the library.
 */
function installOleans(checkId: string, deleted: string[]) {
  const built = oleanDir(checkId);
  const installed: string[] = [];
  const publicDir = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    for (let d = dir; d.startsWith(BUILD_LIB); d = dirname(d)) chmodSync(d, 0o755);
  };
  const walk = (dir: string, rel = "") => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const relPath = rel ? join(rel, entry) : entry;
      if (statSync(full).isDirectory()) walk(full, relPath);
      else {
        publicDir(dirname(join(BUILD_LIB, relPath)));
        cpSync(full, join(BUILD_LIB, relPath));
        chmodSync(join(BUILD_LIB, relPath), 0o644);
        installed.push(relPath);
      }
    }
  };
  if (existsSync(built)) walk(built);
  for (const module of deleted) {
    for (const ext of [".olean", ".ilean", ".c", ".trace", ".hash"]) {
      rmSync(join(BUILD_LIB, `${module.replaceAll(".", "/")}${ext}`), { force: true });
    }
  }
  return installed;
}

/** Checks whose answer the new library invalidates: anything that imports a
 *  module that just changed, and every "unknown module" failure, since a
 *  module the patch adds is exactly what those were missing. Requeue linked
 *  contribution verifications before dropping the content cache; otherwise a
 *  stale `passed` verdict survives forever with no check row capable of
 *  replacing it. */
async function invalidateChecks(modules: string[]) {
  if (modules.length === 0) return 0;
  const pattern = `import (${modules.map((m) => m.replaceAll(".", "\\.")).join("|")})\\M`;
  const hashes = await sql<{ source_hash: string }[]>`
    select source_hash from lean_check
    where source ~ ${pattern}
       or (outcome = 'failed' and detail::text like ${"%does not exist%"})`;
  if (hashes.length === 0) return 0;
  const invalidated = hashes.map(({ source_hash }) => source_hash);
  await sql.begin(async (tx) => {
    await tx`with requeued as (
               update verification
               set outcome = 'pending', detail = (detail - 'check_hash') || '{"revalidating":true}'::jsonb,
                   updated_at = now()
               where method = 'lean-kernel' and detail->>'check_hash' = any(${invalidated}::text[])
               returning contribution_id)
             update contribution c set reviewed_at = null
             where c.reviewed_at is not null and c.id in (select contribution_id from requeued)`;
    await tx`delete from lean_check where source_hash = any(${invalidated}::text[])`;
  });
  return invalidated.length;
}

async function reindexDecls(modules: string[]) {
  if (modules.length === 0 || !existsSync(INDEX_SCRIPT)) return;
  await run([INDEX_SCRIPT, ...modules], { cwd: dirname(dirname(INDEX_SCRIPT)) });
}

/**
 * Publish everything review has promoted. Each patch is re-verified against
 * the current head first: `patch_check` is keyed by (repo, base, diff), so a
 * patch whose base is still head is a cache hit and costs nothing, and one
 * whose base has moved is genuinely rebuilt before a commit exists.
 */
export async function publishPatches() {
  if (!repoPresent()) return;
  const head = await headCommit();
  if (!head) return;

  const rows = await sql<{
    id: string;
    title: string;
    summary: string;
    content: string;
    identity_id: string | null;
    display_name: string | null;
  }[]>`
    select c.id, c.title, c.summary, a.content, c.identity_id, i.display_name
    from contribution c
    join artifact a on a.hash = c.artifact_hash
    left join identity i on i.id = c.identity_id
    left join patch_publication p on p.contribution_id = c.id
    where c.kind = 'patch' and c.status = 'active' and c.tier >= 2
      and (p.repo is null or p.repo = ${PATCH_REPO})
      and (p.state is null or p.state = 'queued'
           or (p.state = 'blocked' and (p.updated_at < now() - interval '10 minutes'
                                        or p.detail->>'head_commit' is distinct from ${head})))
    order by c.updated_at
    limit 1`;
  const row = rows[0];
  if (!row) return;

  const diff = extractDiff(row.content);
  let checkId = patchCheckId(PATCH_REPO, head, diff);

  // A README commit cannot invalidate Lean artifacts. Re-keying every patch
  // check on the Git commit made a concurrent prose edit rebuild the same
  // thirteen modules for another 55 seconds immediately before publication.
  const [prior] = await sql<{ id: string; base_commit: string }[]>`
    select id, base_commit from patch_check
    where repo = ${PATCH_REPO} and diff = ${diff} and outcome = 'passed'
    order by updated_at desc limit 1`;
  if (prior && prior.base_commit !== head) {
    const moved = await git(["diff", "--name-only", `${prior.base_commit}..${head}`]);
    const paths = moved.stdout.split("\n").filter(Boolean);
    const affectsLean = paths.some((path) =>
      path.endsWith(".lean") ||
      ["lakefile.toml", "lake-manifest.json", "lean-toolchain"].includes(path),
    );
    if (moved.code === 0 && !affectsLean) checkId = prior.id;
  }

  const block = async (reason: string, detail: PatchDetail = {}) => {
    await sql`insert into patch_publication (contribution_id, repo, state, check_id, detail)
              values (${row.id}, ${PATCH_REPO}, 'blocked', ${checkId}, ${sql.json({ ...detail, reason, head_commit: head } as never)})
              on conflict (contribution_id) do update
                set state = 'blocked', check_id = excluded.check_id, detail = excluded.detail, updated_at = now()`;
    await sql`insert into event (kind, contribution_id, payload)
              values ('patch-publish-blocked', ${row.id}, ${sql.json({ reason, head_commit: head } as never)})`;
  };

  const [check] = await sql<{ outcome: string; detail: PatchDetail }[]>`
    select outcome, detail from patch_check where id = ${checkId}`;
  if (!check) {
    await sql`insert into patch_check (id, repo, base_commit, diff)
              values (${checkId}, ${PATCH_REPO}, ${head}, ${diff}) on conflict do nothing`;
    await sql`insert into patch_publication (contribution_id, repo, state, check_id, detail)
              values (${row.id}, ${PATCH_REPO}, 'queued', ${checkId}, ${sql.json({ head_commit: head } as never)})
              on conflict (contribution_id) do update
                set state = 'queued', check_id = excluded.check_id, detail = excluded.detail, updated_at = now()`;
    return;
  }
  if (check.outcome === "pending") return;
  if (check.outcome !== "passed") {
    await block(check.detail?.reason ?? `the patch does not build against ${shortId(head)}`, check.detail ?? {});
    return;
  }
  if (!existsSync(oleanDir(checkId)) && (check.detail?.built?.length ?? 0) > 0) {
    // Verified once, artifacts since cleaned: rerun rather than install a
    // build nobody has.
    await sql`update patch_check set outcome = 'pending', claimed_at = null, updated_at = now() where id = ${checkId}`;
    return;
  }

  // The runner reads installed oleans directly. Do not replace them under a
  // check that has already been handed out; the next tick publishes as soon as
  // those checks return, then requeues every affected answer below.
  const [checkingLibrary] = await sql<{ busy: boolean }[]>`
    select exists (
      select 1 from lean_check
      where outcome = 'pending' and claimed_at is not null
        and source ~ ${"import[[:space:]]+LemmaLib\\M"}) as busy`;
  if (checkingLibrary?.busy) return;

  const author = row.display_name?.trim() || `contributor ${shortId(row.identity_id ?? "anonymous")}`;
  const email = `${row.identity_id ? shortId(row.identity_id) : "anonymous"}@contributors.lemma.ing`;
  const message = [
    row.title,
    "",
    row.summary,
    "",
    `Reviewed to T2 and applied from the lemma.ing ledger.`,
    `Contribution: https://lemma.ing/e/${row.id}`,
  ].join("\n");

  const patchFile = join(STATE_DIR, `publish-${row.id}.diff`);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(patchFile, diff);
  const applied = await git(["apply", "--index", "--3way", "--whitespace=nowarn", patchFile]);
  rmSync(patchFile, { force: true });
  if (applied.code !== 0) {
    await git(["reset", "--hard", head]);
    await block(`the patch no longer applies to ${shortId(head)}`, { conflict: `${applied.stdout}${applied.stderr}`.slice(-2000) });
    return;
  }

  const committed = await git(
    ["-c", `user.name=${author}`, "-c", `user.email=${email}`, "commit", "-m", message, "--author", `${author} <${email}>`],
    {},
  );
  if (committed.code !== 0) {
    await git(["reset", "--hard", head]);
    await block("nothing to commit, or git refused the commit", { conflict: `${committed.stdout}${committed.stderr}`.slice(-2000) });
    return;
  }
  const commit = (await headCommit()) ?? head;

  const changed = check.detail?.changed_modules ?? [];
  const deleted = check.detail?.deleted_modules ?? [];
  const installed = installOleans(checkId, deleted);
  const dropped = await invalidateChecks(["LemmaLib", ...changed, ...(check.detail?.rebuilt_modules ?? [])]);
  await reindexDecls(changed);
  if (deleted.length > 0) {
    await sql.begin(async (tx) => {
      await tx`delete from lean_decl where module = any(${deleted}::text[])`;
      await tx`insert into lean_decl_module (module, indexed_at)
               select unnest(${deleted}::text[]), now()
               on conflict (module) do update set indexed_at = excluded.indexed_at`;
    });
  }
  mkdirSync(dirname(INDEXED_COMMIT), { recursive: true });
  writeFileSync(INDEXED_COMMIT, `${commit}\n`, { mode: 0o644 });

  await sql`insert into patch_publication (contribution_id, repo, state, check_id, commit_sha, detail)
            values (${row.id}, ${PATCH_REPO}, 'published', ${checkId}, ${commit},
                    ${sql.json({ head_commit: head, installed: installed.length, invalidated_checks: dropped, changed_modules: changed, deleted_modules: deleted } as never)})
            on conflict (contribution_id) do update
              set state = 'published', check_id = excluded.check_id, commit_sha = excluded.commit_sha,
                  detail = excluded.detail, updated_at = now()`;
  await sql`insert into event (kind, contribution_id, payload)
            values ('patch-published', ${row.id},
                    ${sql.json({ repo: PATCH_REPO, commit, changed_modules: changed, deleted_modules: deleted, invalidated_checks: dropped } as never)})`;
  console.log(`published patch ${row.id} as ${shortId(commit)} (${installed.length} oleans, ${dropped} checks invalidated)`);
}
