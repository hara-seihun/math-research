import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The practical shelf is files on disk that change only when the instance is
// redeployed or the content editor publishes, so it is read once rather than
// stat-ed and re-read on every hello and every guides call.

const GUIDES_DIR = process.env.GUIDES_DIR ?? join(import.meta.dir, "../../guides");

export type Guide = { name: string; about: string; markdown: string };

function load(): Map<string, Guide> {
  const shelf = new Map<string, Guide>();
  for (const file of readdirSync(GUIDES_DIR).sort()) {
    if (!file.endsWith(".md")) continue;
    const markdown = readFileSync(join(GUIDES_DIR, file), "utf8");
    const name = file.replace(/\.md$/, "");
    shelf.set(name, { name, about: markdown.split("\n")[0]?.replace(/^#\s*/, "") ?? "", markdown });
  }
  return shelf;
}

let shelf = load();

/** The content editor publishes into GUIDES_DIR; the deploy restarts us, but
 *  a `--site` publish does not, so the shelf is re-read on SIGHUP. */
process.on("SIGHUP", () => {
  shelf = load();
});

export const guideNames = (): string[] => [...shelf.keys()];
export const guideList = (): { name: string; about: string }[] =>
  [...shelf.values()].map(({ name, about }) => ({ name, about }));
export const guide = (name: string): Guide | undefined => shelf.get(name.replace(/\.md$/, ""));
