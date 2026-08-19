/**
 * Sandboxed Lean runner. The only process that executes untrusted Lean code
 * (elaboration is code execution), so it runs as its own user with no
 * network and no database access — see the `lean-runner` systemd unit. Its
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
import { mkdirSync, readdirSync, existsSync, rmSync, renameSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";

const SPOOL = process.env.SPOOL_DIR ?? "/var/lib/lean-spool";
const SPOOL_IN = join(SPOOL, "in");
const SPOOL_OUT = join(SPOOL, "out");
const WORK_DIR = process.env.WORK_DIR ?? "/var/lib/lean-runner/work";
const LEAN_DIR = process.env.LEAN_DIR ?? "/srv/math-research/lean";
const READY = join(LEAN_DIR, ".ready");
const CONCURRENCY = Number(process.env.LEAN_CONCURRENCY ?? 2);
const TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS ?? 600_000);
const AUDIT_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;

/**
 * Environment (LEAN_PATH, toolchain PATH, …) captured by the project owner at
 * setup time via `lake env env > .env-cache`. Running lake here would need
 * git and ownership of the checkout — exactly what this sandbox must not
 * have — so we only ever read the cached snapshot.
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
}

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
      let (_, axState) := ((CollectAxioms.collect name).run env).run {}
      let typeStr \u2190 liftTermElabM do
        return (\u2190 Meta.ppExpr info.type).pretty
      let json := Json.mkObj [
        ("name", Json.str name.toString),
        ("type", Json.str typeStr),
        ("axioms", Json.arr (axState.axioms.map (Json.str \u00b7.toString)))
      ]
      logInfo s!"AUDIT{json.compress}"
`;
}

type Decl = { name: string; type: string; axioms: string[] };

async function runLean(args: string[], cwd: string, timeoutMs: number, extraLeanPath?: string) {
  const env = { ...process.env, ...leanEnv };
  if (extraLeanPath) env.LEAN_PATH = `${env.LEAN_PATH}:${extraLeanPath}`;
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
  return { exitCode, output: stdout + stderr, timedOut: proc.killed };
}

async function runCheck(id: string) {
  const work = join(WORK_DIR, id);
  const moduleName = `Check${id}`;
  const result: Record<string, unknown> = { ok: false };
  try {
    mkdirSync(work, { recursive: true });
    // The sandbox mounts spool and work as separate bind mounts, so a rename
    // would fail with EXDEV — copy and unlink instead.
    copyFileSync(join(SPOOL_IN, `${id}.lean`), join(work, `${moduleName}.lean`));
    rmSync(join(SPOOL_IN, `${id}.lean`));

    const compile = await runLean(
      [`--root=${work}`, `-o`, join(work, `${moduleName}.olean`), join(work, `${moduleName}.lean`)],
      work,
      TIMEOUT_MS,
    );
    result.exit_code = compile.exitCode;
    result.timed_out = compile.timedOut;
    result.output = compile.output.slice(-4000);
    // A compile that "succeeds" while reporting a sorry is not a pass.
    if (compile.exitCode === 0 && !compile.timedOut && !/declaration uses 'sorry'/.test(compile.output)) {
      result.ok = true;
      const auditFile = join(work, `Audit${id}.lean`);
      writeFileSync(auditFile, auditSource(moduleName));
      const audit = await runLean([`--root=${work}`, auditFile], work, AUDIT_TIMEOUT_MS, work);
      if (audit.exitCode === 0 && !audit.timedOut) {
        const decls: Decl[] = [];
        for (const match of audit.output.matchAll(/AUDIT(\{.*\})/g)) {
          try {
            decls.push(JSON.parse(match[1]!));
          } catch {
            /* skip unparsable line */
          }
        }
        result.audit_ok = decls.length > 0;
        result.decls = decls;
        if (decls.length === 0) result.audit_error = "audit produced no declarations";
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

let running = 0;
const claimed = new Set<string>();

function tick() {
  if (!existsSync(READY)) return;
  for (const file of readdirSync(SPOOL_IN)) {
    if (running >= CONCURRENCY) break;
    if (!file.endsWith(".lean")) continue;
    const id = basename(file, ".lean");
    if (claimed.has(id)) continue;
    claimed.add(id);
    running++;
    runCheck(id)
      .catch((error) => console.error(`check ${id} crashed:`, error))
      .finally(() => {
        claimed.delete(id);
        running--;
      });
  }
}

mkdirSync(WORK_DIR, { recursive: true });
await loadLeanEnv();
console.log(`lean runner (sandboxed): spool=${SPOOL} work=${WORK_DIR} concurrency=${CONCURRENCY}`);
setInterval(tick, POLL_MS);
