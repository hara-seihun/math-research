import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandPins } from "./pinned.ts";

// Guides are files on disk published by two flows that do not restart the
// server: `tools/deploy.sh --site` and the /admin content editor. The shelf
// therefore re-reads whenever the directory's contents actually change,
// detected by a stat fingerprint on every access — a handful of files, so the
// check costs microseconds and no publish path can serve stale doctrine.
//
// Facts the code owns are holes in that prose rather than copies of it:
// `{{mathlib_version}}` and friends are filled in from the Lake project as a
// guide is loaded, so an agent reading a guide in-band and a reader on the
// site are told the same thing, and neither can be told last year's version.

const GUIDES_DIR = process.env.GUIDES_DIR ?? join(import.meta.dir, "../../guides");

export type Guide = {
  name: string;
  /** The guide's own H1: what it is. */
  about: string;
  /**
   * Its `when:` front matter: the words that should make a reader reach for
   * it. This is a retrieval trigger, not a summary — the same convention a
   * skill description follows, and the one nearly everybody gets wrong by
   * writing a description of the content instead of the conditions for
   * wanting it. It is what the MCP prompt for this guide advertises, so a
   * client scanning prompt descriptions can tell which guide answers the
   * question in front of it without fetching all five.
   */
  when: string;
  markdown: string;
};

/** Front matter is `when:` and nothing else, so it is read, not parsed. */
function split(raw: string): { when: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) return { when: "", body: raw };
  const when = /^when:\s*(.+)$/m.exec(match[1]);
  return { when: when?.[1].trim() ?? "", body: raw.slice(match[0].length) };
}

function fingerprint(): string {
  const parts: string[] = [];
  for (const file of readdirSync(GUIDES_DIR).sort()) {
    if (!file.endsWith(".md")) continue;
    const stat = statSync(join(GUIDES_DIR, file));
    parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
  }
  return parts.join("|");
}

function load(): Map<string, Guide> {
  const shelf = new Map<string, Guide>();
  for (const file of readdirSync(GUIDES_DIR).sort()) {
    if (!file.endsWith(".md")) continue;
    const { when, body } = split(expandPins(readFileSync(join(GUIDES_DIR, file), "utf8")));
    const name = file.replace(/\.md$/, "");
    shelf.set(name, { name, about: body.split("\n")[0]?.replace(/^#\s*/, "") ?? "", when, markdown: body });
  }
  return shelf;
}

let shelf = new Map<string, Guide>();
let seen = "";

function current(): Map<string, Guide> {
  const now = fingerprint();
  if (now !== seen) {
    shelf = load();
    seen = now;
  }
  return shelf;
}

export const guideNames = (): string[] => [...current().keys()];
export const guideList = (): { name: string; about: string }[] =>
  [...current().values()].map(({ name, about }) => ({ name, about }));
export const guides = (): Guide[] => [...current().values()];
export const guide = (name: string): Guide | undefined =>
  current().get(name.replace(/\.md$/, ""));
