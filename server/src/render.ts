import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "./db.ts";

// --- Turning a body into a page ------
//
// A paper nobody can read is not a paper. Expositions arrive as LaTeX and
// entries arrive as Markdown, and both carry mathematics, so the ledger owns
// the rendering rather than leaving every reader to bring their own: one
// pandoc invocation, MathML for the mathematics (every current browser has it
// natively, so no 300 KB of vendored JavaScript sits between a reader and a
// theorem), and the warnings handed back to the author instead of swallowed.
//
// It is content-addressed for the same reason `lean_check` is: rendering is a
// pure function of the body and the renderer, so a paper read a thousand times
// costs one 80 ms pandoc run. `renderer` is stored with the output, so a
// pandoc upgrade makes rows stale rather than silently serving HTML the
// current renderer would not produce.

const RENDER_DIR = process.env.RENDER_DIR ?? join(import.meta.dir, "../render");
const TEMPLATE = join(RENDER_DIR, "body.html");
const CITATIONS = join(RENDER_DIR, "citations.lua");

const MAX_SOURCE_BYTES = 1 << 20;
const RENDER_TIMEOUT_MS = 15_000;
const MAX_WARNINGS = 20;

/** Media types that become a page. Anything else — Lean, diffs — is code, and
 *  code is shown as the bytes that were submitted. */
const READERS: Record<string, string> = {
  "text/markdown": "markdown-raw_html",
  "text/x-markdown": "markdown-raw_html",
  "text/plain": "markdown-raw_html",
  "text/x-latex": "latex",
  "text/x-tex": "latex",
  "application/x-latex": "latex",
};

export const renderable = (mediaType: string): boolean => mediaType in READERS;

export type Render = { html: string; warnings: string[]; renderer: string };

let rendererVersion: Promise<string> | undefined;

/** The renderer's own identity, asked of it rather than written down. */
export function renderer(): Promise<string> {
  rendererVersion ??= (async () => {
    const proc = Bun.spawn(["pandoc", "--version"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const version = /^pandoc\s+([\d.]+)/m.exec(text)?.[1];
    if (!version) throw new Error("pandoc did not report a version; the body renderer is unavailable");
    return `pandoc ${version}`;
  })();
  return rendererVersion;
}

// LaTeX's bibliography is the one construct pandoc's reader discards outright:
// `\bibitem{key}` is consumed and the key is gone before any filter can see
// it, so `thebibliography` arrives as one run-on paragraph with no anchors and
// every `\cite` in the paper points at nothing. Rewriting the environment into
// an anchored list before pandoc reads it is what makes references in a
// submitted paper work at all.
function prepareLatex(source: string): string {
  return source
    // The template already places the title, byline and date from the
    // document's own metadata, so \maketitle has nothing left to do. Dropping
    // it here rather than letting pandoc skip it keeps a warning that would
    // appear on every well-formed paper out of the author's notes, where it
    // would teach them to ignore the ones that matter.
    .replace(/\\maketitle\s*/g, "")
    .replace(
    /\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/g,
    (whole, body: string) => {
      const items = [...body.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}([\s\S]*?)(?=\\bibitem|$)/g)];
      if (!items.length) return whole;
      const rows = items
        .map(([, key, text]) => `\\item \\hypertarget{ref-${key}}{\\textbf{[${key}]} ${text!.trim()}}`)
        .join("\n");
      return `\\section*{References}\n\\begin{itemize}\n${rows}\n\\end{itemize}`;
    },
  );
}

/** Anyone may submit, and this output is inserted into a public page. Raw HTML
 *  is off in every reader, so the whole remaining surface is URL schemes: a
 *  relative link is fine, an absolute one has to be a scheme that only
 *  navigates. A blocked URL stays visible as data- rather than vanishing,
 *  because a link that silently disappeared is a rendering bug nobody can
 *  diagnose. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const NAVIGABLE = new Set(["http", "https", "mailto"]);
function sanitize(html: string): string {
  return html.replace(/\s(href|src)="([^"]*)"/gi, (whole, attribute: string, url: string) => {
    const value = url
      .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
      .replace(/[\s\u0000-\u001f]/g, "");
    const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
    return !scheme || NAVIGABLE.has(scheme) ? whole : ` data-blocked-${attribute}="${url}"`;
  });
}

type LogMessage = { type: string; contents?: unknown; source?: string; line?: number };

/** Pandoc reports what it could not do as structured messages, not as an exit
 *  code. Missing .sty files are expected — nothing is installed, and a paper's
 *  preamble is not the paper — so they are dropped; everything else is a
 *  sentence the author should read. */
function warningsFrom(log: LogMessage[]): string[] {
  const seen = new Map<string, number>();
  for (const message of log) {
    if (message.type === "LoadedResource" || message.type === "CouldNotLoadIncludeFile") continue;
    const contents =
      typeof message.contents === "string"
        ? message.contents
        : JSON.stringify(message.contents ?? "").slice(0, 200);
    const where = message.line ? ` (line ${message.line})` : "";
    const said =
      message.type === "SkippedContent"
        ? `dropped, nothing here understands it: ${contents}${where}`
        : `${message.type}: ${contents}${where}`;
    seen.set(said, (seen.get(said) ?? 0) + 1);
  }
  return [...seen.entries()]
    .slice(0, MAX_WARNINGS)
    .map(([said, n]) => (n > 1 ? `${said} ×${n}` : said));
}

async function run(source: string, mediaType: string): Promise<Render> {
  const from = READERS[mediaType];
  if (!from) throw new Error(`${mediaType} is not a renderable body`);
  const version = await renderer();
  const work = mkdtempSync(join(tmpdir(), "math-render-"));
  const logPath = join(work, "log.json");
  try {
    const proc = Bun.spawn(
      [
        "pandoc",
        `--from=${from}`,
        "--to=html5",
        "--mathml",
        "--wrap=none",
        "--number-sections",
        "--shift-heading-level-by=1",
        "--id-prefix=x-",
        "--standalone",
        `--template=${TEMPLATE}`,
        `--lua-filter=${CITATIONS}`,
        `--log=${logPath}`,
      ],
      { stdin: new TextEncoder().encode(from === "latex" ? prepareLatex(source) : source), stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), RENDER_TIMEOUT_MS);
    const [html, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(stderr.trim().split("\n").slice(0, 5).join(" ") || `pandoc exited ${code}`);
    let log: LogMessage[] = [];
    try {
      log = JSON.parse(readFileSync(logPath, "utf8")) as LogMessage[];
    } catch {
      throw new Error("pandoc wrote no message log; refusing to claim a clean render");
    }
    return { html: sanitize(html), warnings: warningsFrom(log), renderer: version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Render one artifact, or hand back what an earlier caller already rendered.
 *  `null` means the body is not the kind of thing that becomes a page. */
export async function renderArtifact(hash: string): Promise<(Render & { media_type: string }) | null> {
  const [artifact] = await sql<{ content: string; media_type: string; size_bytes: number }[]>`
    select content, media_type, size_bytes from artifact where hash = ${hash}`;
  if (!artifact) return null;
  if (!renderable(artifact.media_type)) return null;
  const version = await renderer();
  const [cached] = await sql<{ html: string; warnings: string[]; renderer: string }[]>`
    select html, warnings, renderer from artifact_render where artifact_hash = ${hash}`;
  if (cached && cached.renderer === version) {
    return { html: cached.html, warnings: cached.warnings, renderer: cached.renderer, media_type: artifact.media_type };
  }
  if (artifact.size_bytes > MAX_SOURCE_BYTES) {
    throw new Error(`body is ${artifact.size_bytes} bytes; the renderer takes at most ${MAX_SOURCE_BYTES}`);
  }
  const rendered = await run(artifact.content, artifact.media_type);
  await sql`
    insert into artifact_render (artifact_hash, html, warnings, renderer)
    values (${hash}, ${rendered.html}, ${sql.json(rendered.warnings as never)}, ${rendered.renderer})
    on conflict (artifact_hash) do update
      set html = excluded.html, warnings = excluded.warnings,
          renderer = excluded.renderer, created_at = now()`;
  return { ...rendered, media_type: artifact.media_type };
}
