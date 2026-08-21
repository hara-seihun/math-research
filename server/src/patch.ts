/**
 * Patches: a change to the library itself, submitted the way everything else
 * here is submitted.
 *
 * A refactor of the ledger says "these two entries are one thing". A patch
 * says the same about the Lean library the ledger is built on — "these three
 * modules are one module", "this proof belongs upstream of that one", "this
 * statement was wrong and here is the fix" — as an ordinary unified diff
 * against `hara-seihun/mathlibplus`. It is verified by applying it and
 * rebuilding every module it touches and everything that imports them, and it
 * reaches the repository only when review promotes it to canon.
 *
 * This module owns the vocabulary. server/verifier/patches.ts owns applying,
 * building, and publishing.
 */
import { sha256hex } from "./identity.ts";

export const PATCH_REPO = process.env.PATCH_REPO_NAME ?? "mathlibplus";

/** A patch is text, and a big one is a signal to split the work, not a reason
 *  to grow the ledger's row size. */
export const MAX_DIFF_BYTES = 512 * 1024;

/**
 * Fenced ```diff blocks win; otherwise the content is the diff.
 *
 * Only newlines are trimmed, never spaces. A hunk's context lines are a
 * leading space plus the line, so a diff whose last context line is blank ends
 * with a line that is exactly one space — and trimming it leaves a hunk one
 * line shorter than its own header says, which git rejects as a corrupt patch.
 */
export function extractDiff(content: string): string {
  const blocks = [...content.matchAll(/```(?:diff|patch)\n([\s\S]*?)```/g)].map((m) => m[1]);
  const diff = (blocks.length > 0 ? blocks.join("\n") : content).replace(/^\n+/, "").replace(/\n+$/, "");
  return diff.trim() ? `${diff}\n` : "";
}

const DIFF_HEAD = /^(diff --git |--- |Index: )/;

/** Content that is a diff and nothing else. `kind: 'patch'` and
 *  `media_type: 'text/x-diff'` are the explicit ways to say so; this catches
 *  the caller who simply pasted one. */
export const looksLikeDiff = (content: string): boolean => {
  const diff = extractDiff(content);
  return DIFF_HEAD.test(diff) && /^(\+\+\+ |@@ |rename to |deleted file|new file)/m.test(diff);
};

export const isPatchSubmission = (kind: string, mediaType: string, content: string): boolean =>
  kind === "patch" || mediaType === "text/x-diff" || looksLikeDiff(content);

/** A check is a pure function of the runner contract plus repository, base,
 *  and diff. Bump this when the runner changes what a pass or failure means;
 *  otherwise an infrastructure failure stays cached after its cause is fixed. */
export const PATCH_CHECK_VERSION = 4;
export const patchCheckId = (repo: string, base: string, diff: string): string =>
  sha256hex(`${PATCH_CHECK_VERSION}\n${repo}\n${base}\n${diff}`);

/** Lines the patch adds, which is where anything unsound would arrive. */
export const addedLines = (diff: string): string =>
  diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

export type PatchDetail = {
  base_commit?: string;
  head_commit?: string;
  reason?: string;
  conflict?: string;
  changed_modules?: string[];
  deleted_modules?: string[];
  rebuilt_modules?: string[];
  /** Modules in the rebuild set that do not build at the base commit either. */
  already_broken?: string[];
  still_broken?: string[];
  files?: { status: string; path: string }[];
  built?: string[];
  failed_module?: string;
  errors?: string;
  decl_summary?: { module: string; proved: number; stated: number }[];
  foreign_axioms?: string[];
  elapsed_ms?: number;
  commit?: string;
};
