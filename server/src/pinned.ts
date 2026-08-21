/**
 * What the kernel is pinned to, read from the Lake project that pins it.
 *
 * The version used to be a literal typed into seven hand-maintained places --
 * the README, two site pages, two guides, a tool description, a design note --
 * against one real source, so a bump was a grep nobody would win. Prose asks
 * here instead: `{{mathlib_version}}` and `{{lean_version}}` are expanded into
 * the guides the server hands out, into the tool descriptions, and into every
 * page the site build writes. `test/doc-ssot.sh` keeps the literal from
 * growing back.
 *
 * Standalone on purpose -- node:fs and nothing else -- because the site build
 * imports it from outside the server's project.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEAN_DIR = process.env.LEAN_DIR ?? join(import.meta.dir, "../../lean");

const read = (file: string) => readFileSync(join(LEAN_DIR, file), "utf8");

/** `leanprover/lean4:v4.33.0` -> `v4.33.0`. */
export function leanVersion(): string {
  const raw = read("lean-toolchain").trim();
  const at = raw.lastIndexOf(":");
  return at === -1 ? raw : raw.slice(at + 1);
}

/** The `rev` of the mathlib dependency the Lake project requires. */
export function mathlibVersion(): string {
  const requires = read("lakefile.toml").split("[[require]]").slice(1);
  const mathlib = requires.find((block) => /name\s*=\s*"mathlib"/.test(block));
  if (!mathlib) throw new Error(`${LEAN_DIR}/lakefile.toml: nothing requires mathlib`);
  const rev = /rev\s*=\s*"([^"]+)"/.exec(mathlib);
  if (!rev) throw new Error(`${LEAN_DIR}/lakefile.toml: the mathlib require has no rev`);
  return rev[1];
}

/** Every fact prose is allowed to ask this module for. */
export const pins = (): Record<string, string> => ({
  mathlib_version: mathlibVersion(),
  lean_version: leanVersion(),
});

/**
 * Fill `{{mathlib_version}}`-style holes. An unknown placeholder is left alone:
 * the site build has its own, larger expander and runs over the same text.
 */
export function expandPins(markdown: string): string {
  const filled = pins();
  return markdown.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => filled[name] ?? whole);
}
