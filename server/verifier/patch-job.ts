/**
 * The contract between the orchestrator and the sandboxed runner for a patch
 * build. Deliberately dependency-free: the runner imports nothing else from
 * this repository, because it is the process that executes untrusted code.
 *
 * The orchestrator applies the diff (it owns git and the checkout); the runner
 * only ever sees a directory of Lean sources and a compile order, and hands
 * back oleans and what the kernel said about them.
 */

export type PatchModule = {
  /** Fully qualified module name, e.g. MathlibPlus.GroupTheory.Claim38444. */
  module: string;
  /** Path of its source relative to the job's `src/` root. */
  path: string;
  /** Changed by the patch (as opposed to rebuilt because it imports one). */
  changed: boolean;
};

export type PatchJob = {
  id: string;
  /** Compile order: every module appears after the ones it imports. */
  modules: PatchModule[];
  /** Modules the patch deletes; their oleans must not be used by the build. */
  deleted: string[];
  timeout_ms: number;
};

export type PatchModuleResult = {
  module: string;
  exit_code?: number;
  timed_out?: boolean;
  output?: string;
};

export type PatchDecl = { name: string; type: string; axioms: string[]; proof?: boolean };

export type PatchResult = {
  ok: boolean;
  built: string[];
  failed?: PatchModuleResult;
  modules?: PatchModuleResult[];
  /** Declarations of each changed module after the patch. */
  decls?: Record<string, PatchDecl[]>;
  audit_error?: string;
  error?: string;
  elapsed_ms?: number;
};
