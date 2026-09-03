/**
 * Sandboxed Lean runner. The only process that executes untrusted Lean code
 * (elaboration is code execution), so it runs as its own user with no
 * network and no database access, as the `lean-runner` systemd unit shows. Its
 * whole world is:
 *
 *   SPOOL/in   *.lean files written by the orchestrator (verifier.ts)
 *   SPOOL/out  *.json results it writes back
 *   WORK_DIR   scratch space
 *
 * For each check it (1) compiles the submission against the pinned Mathlib,
 * then (2) compiles a trusted audit wrapper that imports the result and
 * reports, for every declaration: its name, its exact pretty-printed
 * statement, and the axioms it depends on. The orchestrator turns that into
 * the verification outcome; this process decides nothing.
 */
import { mkdirSync, readdirSync, existsSync, lstatSync, rmSync, renameSync, symlinkSync, writeFileSync, readFileSync, copyFileSync, cpSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { PatchJob, PatchModuleResult, PatchResult } from "./patch-job.ts";

const SPOOL = process.env.SPOOL_DIR ?? "/var/lib/lean-spool";
const SPOOL_IN = join(SPOOL, "in");
const SPOOL_OUT = join(SPOOL, "out");
const WORK_DIR = process.env.WORK_DIR ?? "/var/lib/lean-runner/work";
const LEAN_DIR = process.env.LEAN_DIR ?? "/srv/math-research/lean";
const READY = join(LEAN_DIR, ".ready");
const CONCURRENCY = Number(process.env.LEAN_CONCURRENCY ?? 2);
const TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS ?? 600_000);
const AUDIT_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;

/**
 * Environment (LEAN_PATH, toolchain PATH, …) captured by the project owner at
 * setup time via `lake env env > .env-cache`. Running lake here would need
 * git and ownership of the checkout, exactly what this sandbox must not
 * have, so we only ever read the cached snapshot.
 */
let leanEnv: Record<string, string> = {};

async function loadLeanEnv() {
  const cache = join(LEAN_DIR, ".env-cache");
  while (!existsSync(cache)) {
    console.log(`waiting for ${cache} (produced by lean setup)`);
    await Bun.sleep(15_000);
  }
  for (const line of readFileSync(cache, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) leanEnv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (!leanEnv.LEAN_PATH) throw new Error(".env-cache did not yield LEAN_PATH");

  // LemmaLib is built outside the check project in its own checkout. Append
  // its build tree rather than editing .env-cache, which `lake env env`
  // regenerates.
  const extra = process.env.EXTRA_LEAN_PATH;
  if (extra) {
    for (const dir of extra.split(":").filter(Boolean)) {
      if (!existsSync(dir)) throw new Error(`EXTRA_LEAN_PATH entry does not exist: ${dir}`);
    }
    leanEnv.LEAN_PATH = `${leanEnv.LEAN_PATH}:${extra}`;
    console.log(`extra LEAN_PATH: ${extra}`);
  }
}

// The audit reports every declaration the module added, and for each one the
// single fact that decides what a kernel pass is worth: is this declaration's
// *type* a proposition? `theorem foo : P` has type `P : Prop`, so the kernel
// checked a proof of P. `def Q : Prop := …` has type `Prop : Type`: it
// elaborates, it is a perfectly good formal statement, and it proves nothing.
// Only the kernel can tell those apart, so it is asked here rather than
// guessed later from a pretty-printed string.
function auditSource(moduleName: string): string {
  return `import ${moduleName}
open Lean Meta Elab Command in
run_cmd do
  let env \u2190 getEnv
  let some modIdx := env.getModuleIdx? \`${moduleName}
    | throwError "audited module not found"
  let mut count := 0
  for (name, info) in env.constants.toList do
    if env.getModuleIdxFor? name == some modIdx \u2227 !name.isInternal then
      if count \u2265 200 then break
      count := count + 1
      let (typeStr, axioms, isProof) \u2190 liftTermElabM do
        let fmt \u2190 Meta.ppExpr info.type
        let axs \u2190 collectAxioms name
        let prf \u2190 try Meta.isProp info.type catch _ => pure false
        return (fmt.pretty, axs, prf)
      let json := Json.mkObj [
        ("name", Json.str name.toString),
        ("type", Json.str typeStr),
        ("proof", Json.bool isProof),
        ("axioms", Json.arr (axioms.map (Json.str \u00b7.toString)))
      ]
      logInfo s!"AUDIT{json.compress}"
`;
}

type Decl = { name: string; type: string; axioms: string[]; proof?: boolean };

/** `before` shadows the published library: a patched module has to win over
 *  the olean already installed under the same module name, which is the whole
 *  point of building a patch. `after` is the check runner's scratch module,
 *  which exists nowhere else. */
async function runLean(
  args: string[],
  cwd: string,
  timeoutMs: number,
  extra?: { after?: string; before?: string },
) {
  const env = { ...process.env, ...leanEnv };
  if (extra?.after) env.LEAN_PATH = `${env.LEAN_PATH}:${extra.after}`;
  if (extra?.before) env.LEAN_PATH = `${extra.before}:${env.LEAN_PATH}`;
  const proc = Bun.spawn(["lean", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // killed-by-timeout ends with a signal and no exit code; a fast nonzero
  // exit is an ordinary failure, not a timeout.
  return { exitCode, output: stdout + stderr, timedOut: proc.signalCode != null, signal: proc.signalCode };
}

async function runCheck(id: string) {
  const work = join(WORK_DIR, id);
  const moduleName = `Check${id}`;
  const result: Record<string, unknown> = { ok: false };
  try {
    mkdirSync(work, { recursive: true });
    // The sandbox mounts spool and work as separate bind mounts, so a rename
    // would fail with EXDEV, so copy and unlink instead.
    copyFileSync(join(SPOOL_IN, `${id}.lean`), join(work, `${moduleName}.lean`));
    rmSync(join(SPOOL_IN, `${id}.lean`));

    const compile = await runLean(
      [`--root=${work}`, `-o`, join(work, `${moduleName}.olean`), join(work, `${moduleName}.lean`)],
      work,
      TIMEOUT_MS,
    );
    result.exit_code = compile.exitCode;
    result.timed_out = compile.timedOut;
    if (compile.signal) result.signal = compile.signal;
    result.output = compile.output.slice(-4000);
    // A compile that "succeeds" while reporting a sorry is not a pass.
    if (compile.exitCode === 0 && !compile.timedOut && !/declaration uses 'sorry'/.test(compile.output)) {
      result.ok = true;
      const auditFile = join(work, `Audit${id}.lean`);
      writeFileSync(auditFile, auditSource(moduleName));
      const audit = await runLean([`--root=${work}`, auditFile], work, AUDIT_TIMEOUT_MS, { after: work });
      if (audit.exitCode === 0 && !audit.timedOut) {
        const decls = parseAudit(audit.output);
        result.audit_ok = decls.length > 0;
        result.decls = decls;
        // The audit ran and found nothing to report: the file declares no
        // theorems (`#check` on someone else's, an `example`, a bare import).
        // That is not an audit failure, and the caller should not be told the
        // audit broke.
        if (decls.length === 0) result.declares_nothing = true;
      } else {
        result.audit_ok = false;
        result.audit_error = audit.timedOut ? "audit timed out" : audit.output.slice(-2000);
      }
    }
  } catch (error) {
    result.audit_ok = false;
    result.audit_error = String(error);
  } finally {
    rmSync(work, { recursive: true, force: true });
    writeFileSync(join(SPOOL_OUT, `${id}.json.tmp`), JSON.stringify(result));
    renameSync(join(SPOOL_OUT, `${id}.json.tmp`), join(SPOOL_OUT, `${id}.json`));
  }
}

const parseAudit = (output: string) => {
  const decls: Decl[] = [];
  for (const match of output.matchAll(/AUDIT(\{.*\})/g)) {
    try {
      decls.push(JSON.parse(match[1]!));
    } catch {
      /* skip unparsable line */
    }
  }
  return decls;
};

/**
 * A patch build: the orchestrator has already applied the diff and worked out
 * what has to be compiled and in which order, so this is the same job as a
 * check with more than one file in it. The oleans go back with the result,
 * because publication installs exactly what was verified rather than
 * compiling the library a second time.
 */
function linkChildren(source: string, target: string) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) symlinkSync(join(source, name), join(target, name));
}

/** Turn only the symlinked ancestor directories of one output file into real
 *  directories whose untouched children remain symlinks. */
function writableOverlayPath(base: string, overlay: string, rel: string): string {
  let source = base;
  let target = overlay;
  for (const part of dirname(rel).split("/")) {
    source = join(source, part);
    target = join(target, part);
    if (!existsSync(target)) {
      if (existsSync(source)) linkChildren(source, target);
      else mkdirSync(target, { recursive: true });
    } else if (lstatSync(target).isSymbolicLink()) {
      rmSync(target);
      linkChildren(source, target);
    }
  }
  const file = join(overlay, rel);
  rmSync(file, { force: true });
  return file;
}

async function runPatchJob(id: string) {
  const jobDir = join(SPOOL_IN, `patch-${id}`);
  const work = join(WORK_DIR, `patch-${id}`);
  const src = join(work, "src");
  const overlay = join(work, "overlay");
  const started = Date.now();
  const result: PatchResult = { ok: false, built: [] };
  const staging = join(SPOOL_OUT, `patch-${id}.staging`);
  try {
    const job: PatchJob = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
    rmSync(work, { recursive: true, force: true });
    mkdirSync(overlay, { recursive: true });
    cpSync(join(jobDir, "src"), src, { recursive: true });

    // Lean stops at the first LEAN_PATH root containing a module's directory;
    // a sparse output tree would therefore hide unchanged LemmaLib modules in
    // later roots. A sparse copy-on-write overlay provides the full namespace:
    // untouched subtrees are symlinks, while output ancestors become writable
    // directories with symlinked siblings.
    const base = (process.env.EXTRA_LEAN_PATH ?? "").split(":").find((dir) => existsSync(dir));
    if (!base) throw new Error("patch runner has no readable EXTRA_LEAN_PATH");
    linkChildren(base, overlay);
    for (const deleted of job.deleted) {
      writableOverlayPath(base, overlay, `${deleted.replaceAll(".", "/")}.olean`);
    }

    const deadline = started + job.timeout_ms;
    const modules: PatchModuleResult[] = [];
    const decls: Record<string, Decl[]> = {};
    for (const module of job.modules) {
      const rel = `${module.module.replaceAll(".", "/")}.olean`;
      const olean = writableOverlayPath(base, overlay, rel);
      mkdirSync(dirname(olean), { recursive: true });
      const budget = Math.min(TIMEOUT_MS, Math.max(1, deadline - Date.now()));
      const compiled = await runLean([`--root=${src}`, "-o", olean, join(src, module.path)], work, budget, { before: overlay });
      const report: PatchModuleResult = {
        module: module.module,
        exit_code: compiled.exitCode,
        timed_out: compiled.timedOut,
        output: compiled.output.slice(-4000),
      };
      modules.push(report);
      if (compiled.exitCode !== 0 || compiled.timedOut || /declaration uses 'sorry'/.test(compiled.output)) {
        result.failed = report;
        result.modules = modules;
        return;
      }
      result.built.push(module.module);
    }

    for (const module of job.modules.filter((m) => m.changed)) {
      const auditFile = join(work, `Audit_${module.module.replaceAll(".", "_")}.lean`);
      writeFileSync(auditFile, auditSource(module.module));
      const audit = await runLean([`--root=${work}`, auditFile], work, AUDIT_TIMEOUT_MS, { before: overlay, after: work });
      if (audit.exitCode !== 0 || audit.timedOut) {
        result.audit_error = audit.timedOut ? `audit of ${module.module} timed out` : audit.output.slice(-2000);
        result.error = `the axiom audit of ${module.module} did not complete`;
        result.modules = modules;
        return;
      }
      decls[module.module] = parseAudit(audit.output);
    }

    result.ok = true;
    result.modules = modules;
    result.decls = decls;
  } catch (error) {
    result.error = String(error);
  } finally {
    result.elapsed_ms = Date.now() - started;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    if (result.ok && existsSync(overlay)) {
      for (const module of result.built) {
        const rel = `${module.replaceAll(".", "/")}.olean`;
        mkdirSync(dirname(join(staging, "lib", rel)), { recursive: true });
        copyFileSync(join(overlay, rel), join(staging, "lib", rel));
      }
    }
    writeFileSync(join(staging, "result.json"), JSON.stringify(result));
    renameSync(staging, join(SPOOL_OUT, `patch-${id}`));
    rmSync(work, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
  }
}

let running = 0;
const claimed = new Set<string>();

function start(id: string, job: () => Promise<void>) {
  claimed.add(id);
  running++;
  job()
    .catch((error) => console.error(`${id} crashed:`, error))
    .finally(() => {
      claimed.delete(id);
      running--;
    });
}

function tick() {
  if (!existsSync(READY)) return;
  for (const file of readdirSync(SPOOL_IN)) {
    if (running >= CONCURRENCY) break;
    if (file.startsWith("patch-")) {
      if (file.endsWith(".staging") || claimed.has(file)) continue;
      if (!existsSync(join(SPOOL_IN, file, "job.json"))) continue;
      start(file, () => runPatchJob(file.slice("patch-".length)));
      continue;
    }
    if (!file.endsWith(".lean")) continue;
    const id = basename(file, ".lean");
    if (claimed.has(id)) continue;
    start(id, () => runCheck(id));
  }
}

mkdirSync(WORK_DIR, { recursive: true });
await loadLeanEnv();
console.log(`lean runner (sandboxed): spool=${SPOOL} work=${WORK_DIR} concurrency=${CONCURRENCY}`);
setInterval(tick, POLL_MS);
