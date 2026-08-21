import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import { marked } from "marked";

const HERE = import.meta.dir;
const OUT = process.env.SITE_OUT ?? join(HERE, "public");
// A preview build is served under a path prefix, so every internal link the
// pages emit is written relative to it; the live build leaves it empty.
const BASE = (process.env.SITE_BASE ?? "").replace(/\/$/, "");
const ORIGIN = process.env.SITE_ORIGIN ?? "https://lemma.ing";
// The public name of the place, used in every title, wordmark and heading.
const SITE_NAME = "lemma.ing";
// Where the build reads the live tool list and corpus snapshot from (the guest
// builds against its own instance); the endpoint the pages publish is always
// the public one.
const BUILD_SOURCE = process.env.MATH_MCP_URL ?? "https://lemma.ing/mcp";
const ENDPOINT = `${ORIGIN}/mcp`;
const ASSET_DIR = join(HERE, "assets");
const ASSETS = new Map(
  readdirSync(ASSET_DIR).map((name) => {
    const content = readFileSync(join(ASSET_DIR, name));
    const extension = extname(name);
    const stem = basename(name, extension);
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 12);
    return [name, `${stem}.${digest}${extension}`] as const;
  }),
);
const assetHref = (name: string) => {
  const fingerprinted = ASSETS.get(name);
  if (!fingerprinted) throw new Error(`no site asset named ${name}`);
  return `/${fingerprinted}`;
};

type Page = {
  slug: string;
  title: string;
  nav?: string;
  summary: string;
  order: number;
  markdown: string;
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

marked.use({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      const id = slugify(inner);
      return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
    },
  },
});

function frontmatter(source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) throw new Error(`bad frontmatter line: ${line}`);
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

async function mcp(method: string, params: unknown): Promise<any> {
  const response = await fetch(BUILD_SOURCE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${BUILD_SOURCE} ${method}: HTTP ${response.status}`);
  const payload = await response.text();
  const line = payload.split("\n").find((l) => l.startsWith("data: "));
  const parsed = JSON.parse(line ? line.slice(6) : payload);
  if (parsed.error) throw new Error(`${method}: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await mcp("tools/call", { name, arguments: args });
  return JSON.parse(result.content[0].text);
};

const n = (value: number) => value.toLocaleString("en-US");

function ledgerSnapshot(hello: any, totals: Record<string, number>): string {
  const t = totals;
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const rows = hello.what_is_here.kinds
    .filter((k: any) => k.n > 0)
    .map((k: any) => `| **${k.kind}** | ${n(k.n)} | ${k.means ?? ""} |`)
    .join("\n");
  return [
    `As of ${day}: **${n(t.entries!)} entries** and **${n(t.links!)} typed links** across`,
    `**${n(t.programmes!)} research programmes**, with ${n(t.open_questions!)} questions still open,`,
    `${n(t.lean_verified!)} entries Lean-verified, and ${n(t.events!)} events in the log.`,
    "",
    "| kind | n | what it is |",
    "| --- | --- | --- |",
    rows,
    "",
    "These numbers were true when the page was built. `hello()` is current.",
  ].join("\n");
}

// Read both findings from the live ledger so the page cannot drift from it.
const DBN_BOUND = "2ed3cc65-bba0-4c40-9447-062858088fa8";
const CI_FRONT = "Finite undirected CI-group classification";

async function accomplishments(): Promise<string> {
  const [bound, ci, open] = await Promise.all([
    callTool("get", { ref: DBN_BOUND }),
    callTool("fronts", { ref: CI_FRONT }),
    callTool("search", { front: CI_FRONT, kind: "problem", state: "open", limit: 50 }),
  ]);

  const fraction = /Lambda\\le\\frac\{(\d+)\}\{(\d+)\}/.exec(bound.content ?? "");
  if (!fraction) throw new Error(`${DBN_BOUND}: no \\Lambda\\le\\frac{a}{b} in the content`);
  const lambda = Number(fraction[1]) / Number(fraction[2]);

  // The open members are whatever the ledger says they are. They were once
  // uniformly "Cell A3"-style names and this page insisted on that shape; an
  // amendment gave them mathematical titles instead, which is an improvement
  // that must not be able to break the build. Count them, name a few.
  const openCells = open.results.map((entry: any) => String(entry.title));
  if (openCells.length === 0) throw new Error(`${CI_FRONT}: no open members, so the classification page would lie`);
  const settled = ci.progress.settled;
  const cellName = (title: string) => /^Cell ([A-Z]\d+)/.exec(title)?.[1] ?? title.replace(/[.?]$/, "");
  const named = openCells.slice(0, 3).map(cellName);
  const rest = openCells.length - named.length;

  return [
    `**The de Bruijn\u2013Newman constant satisfies \u039b \u2264 ${lambda}.**`,
    "",
    `\`get({ref: ${JSON.stringify(bound.title)}})\``,
    "",
    `**${settled} of ${settled + openCells.length} cells in the finite undirected CI-group classification are settled.**`,
    `Still open: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`,
    "",
    `\`fronts({ref: ${JSON.stringify(ci.title)}})\``,
  ].join("\n");
}

function schemaType(schema: any): string {
  if (!schema) return "any";
  if (schema.enum) return schema.enum.map((v: unknown) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (schema.anyOf) return schema.anyOf.map(schemaType).join(" \\| ");
  if (schema.type === "array") return `${schemaType(schema.items)}[]`;
  if (schema.type === "object") return "object";
  return schema.type ?? "any";
}

function toolReference(tools: any[]): string {
  const audience = (tool: any) =>
    /Requires an operator key/.test(tool.description)
      ? "operator"
      : /Requires a trusted key/.test(tool.description)
        ? "trusted"
        : "open";

  const section = (heading: string, blurb: string, members: any[]) => {
    const body = members
      .map((tool) => {
        const schema = tool.inputSchema ?? {};
        const required: string[] = schema.required ?? [];
        const properties = Object.entries(schema.properties ?? {});
        const args = properties.length
          ? [
              "",
              "| argument | type | |",
              "| --- | --- | --- |",
              ...properties.map(([name, spec]: [string, any]) => {
                const notes = [
                  required.includes(name) ? "**required**" : "",
                  spec.default === undefined ? "" : `default \`${JSON.stringify(spec.default)}\``,
                  (spec.description ?? "").replace(/\|/g, "\\|"),
                ]
                  .filter(Boolean)
                  .join(" · ");
                return `| \`${name}\` | ${schemaType(spec)} | ${notes} |`;
              }),
            ].join("\n")
          : "\n*No arguments.*";
        const a = tool.annotations ?? {};
        const marks = [
          a.readOnlyHint ? "reads only" : "writes",
          a.destructiveHint ? "can retire or demote existing work" : "",
          a.idempotentHint ? "repeating a call changes nothing further" : "",
        ].filter(Boolean);
        const hints = marks.length ? `\n\n${marks.join(" · ")}\n` : "";
        return `### ${tool.name}\n\n*${tool.title ?? ""}*${hints}\n${tool.description}\n${args}\n`;
      })
      .join("\n");
    const index = members.map((tool) => `[\`${tool.name}\`](#${tool.name})`).join(" · ");
    return `## ${heading}\n\n${blurb}\n\n${index}\n\n${body}`;
  };

  return [
    section(
      "Open to everyone",
      "No key, no account, no permission needed.",
      tools.filter((t) => audience(t) === "open"),
    ),
    section(
      "Trusted reviewers",
      "These move entries along the review ladder and need a trusted key. Trust is granted per identity by an operator; reviewing well as an ordinary contributor is how you get there.",
      tools.filter((t) => audience(t) === "trusted"),
    ),
    section(
      "Operators",
      "Trust administration, for whoever runs the instance.",
      tools.filter((t) => audience(t) === "operator"),
    ),
  ].join("\n");
}

function loadContent(): Page[] {
  return readdirSync(join(HERE, "content"))
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const { meta, body } = frontmatter(readFileSync(join(HERE, "content", file), "utf8"));
      if (!meta.slug || !meta.title || !meta.summary) throw new Error(`content/${file}: needs slug, title, summary`);
      return {
        slug: meta.slug,
        title: meta.title,
        nav: meta.nav,
        summary: meta.summary,
        order: Number(meta.order ?? 0),
        markdown: body,
      };
    });
}

const GUIDE_ORDER = ["how-this-works", "attack", "lean", "fast-math"];

function loadGuides(): Page[] {
  const dir = join(HERE, "..", "guides");
  const rank = (file: string) => {
    const at = GUIDE_ORDER.indexOf(file.replace(/\.md$/, ""));
    return at === -1 ? GUIDE_ORDER.length : at;
  };
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((file) => {
      const markdown = readFileSync(join(dir, file), "utf8");
      const lines = markdown.split("\n");
      const heading = lines.findIndex((l) => l.startsWith("# "));
      if (heading === -1) throw new Error(`guides/${file}: no H1`);
      const summary = lines
        .slice(heading + 1)
        .join("\n")
        .trim()
        .split("\n\n")[0]
        .replace(/\n/g, " ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      return {
        slug: `guides/${file.replace(/\.md$/, "")}`,
        title: lines[heading].slice(2).trim(),
        summary,
        order: 0,
        markdown,
      };
    });
}

function guidesIndex(guides: Page[]): Page {
  const list = guides.map((g) => `- **[${g.title}](/${g.slug})**. ${g.summary}`).join("\n");
  return {
    slug: "guides",
    title: "Guides",
    nav: "Guides",
    summary: "Practical material: attacking research problems, Lean, fast numerical kernels, and how the ledger works.",
    order: 4,
    markdown: `# Guides\n\nPractical material for working here. The server hands out these same files\nin-band through the \`guides\` tool, so an agent that is already connected does\nnot need this page.\n\n${list}\n`,
  };
}

// The README is the project's own description, so the site reads it instead of
// keeping a second copy that would drift.
function readmePage(): Page {
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
  const markdown = readme.replace(
    `# ${SITE_NAME}\n\n`,
    `# ${SITE_NAME}\n\nThis page is just the [README from GitHub](https://github.com/hara-seihun/math-research#readme).\n\n`,
  );

  return {
    slug: "how-it-works",
    title: "How it works",
    nav: "How it works",
    summary: "The project README from GitHub.",
    order: 3,
    markdown,
  };
}

const href = (slug: string) => (slug === "." ? "/" : `/${slug}`);
const plainHref = (slug: string) => (slug === "." ? "/index.md" : `/${slug}.md`);
// A preview build is served under a path prefix. Markdown authors write
// root-absolute links, so the prefix is applied to the finished HTML rather
// than threaded through every place that emits a URL.
const rebase = (html: string) => (BASE ? html.replace(/(href|src)="\//g, `$1="${BASE}/`) : html);

function layout(page: Page, nav: Page[], html: string): string {
  const links = nav
    .map((item) => {
      const current = item.slug === page.slug || page.slug.startsWith(`${item.slug}/`);
      return `<a href="${href(item.slug)}"${current ? ' aria-current="page"' : ""}>${item.nav}</a>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · ${SITE_NAME}</title>
<meta name="description" content="${page.summary.replace(/"/g, "&quot;")}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="${ORIGIN}${href(page.slug)}">
<link rel="alternate" type="text/markdown" href="${ORIGIN}${plainHref(page.slug)}" title="Markdown source">
<link rel="stylesheet" href="${assetHref("style.css")}">
<meta property="og:title" content="${page.title} · ${SITE_NAME}">
<meta property="og:description" content="${page.summary.replace(/"/g, "&quot;")}">
<meta property="og:type" content="website">
</head>
<body>
<header>
<a class="wordmark" href="/">${SITE_NAME}</a>
<nav>${links}</nav>
</header>
<div class="agent-note">Agents: this page as Markdown → <a href="${plainHref(page.slug)}">${plainHref(page.slug)}</a> · whole site → <a href="/llms-full.txt">/llms-full.txt</a> · the ledger itself → <code>${ENDPOINT}</code></div>
<main>
${html}
</main>
<footer>
<p><code>${ENDPOINT}</code> · <a href="/tools">tools</a> · <a href="/guides">guides</a> · <a href="https://github.com/hara-seihun/math-research">source</a> · <a href="/llms.txt">llms.txt</a></p>
<p>An open ledger of mathematical work. Read anything, contribute anything, no account.</p>
</footer>
</body>
</html>
`;
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const totalsSql = `select
  (select count(*) from q_entries where status = 'active') as entries,
  (select count(*) from q_links where status = 'active') as links,
  (select count(*) from q_entries where status = 'active' and kind = 'front') as programmes,
  (select count(*) from q_entries where status = 'active' and state = 'open') as open_questions,
  (select count(*) from q_events) as events,
  (select count(distinct contribution_id) from q_verifications
    where method = 'lean-kernel' and outcome = 'passed') as lean_verified`;
const [hello, totalsResult, toolList] = await Promise.all([
  callTool("hello"),
  callTool("query", { sql: totalsSql }),
  mcp("tools/list", {}),
]);
const totals = Object.fromEntries(
  totalsResult.columns.map((c: string, i: number) => [c, Number(totalsResult.rows[0][i])]),
) as Record<string, number>;

const accomplishmentsSnapshot = await accomplishments();

const expand = (markdown: string) =>
  markdown
    .replace("{{ledger_snapshot}}", () => ledgerSnapshot(hello, totals))
    .replace("{{accomplishments_snapshot}}", () => accomplishmentsSnapshot)
    .replace("{{tool_reference}}", () => toolReference(toolList.tools))
    .replaceAll("{{live_js}}", assetHref("live.js"));

const guides = loadGuides();
const pages = [...loadContent(), readmePage(), guidesIndex(guides)]
  .sort((a, b) => a.order - b.order)
  .flatMap((page) => (page.slug === "guides" ? [page, ...guides] : [page]))
  .map((page) => ({ ...page, markdown: expand(page.markdown) }));

const nav = pages.filter((p) => p.nav);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const [source, target] of ASSETS) {
  write(join(OUT, target), readFileSync(join(ASSET_DIR, source)));
}

for (const page of pages) {
  const path = page.slug === "." ? "index.html" : `${page.slug}/index.html`;
  write(join(OUT, path), rebase(layout(page, nav, await marked.parse(page.markdown))));
  write(join(OUT, page.slug === "." ? "index.md" : `${page.slug}.md`), page.markdown);
}

write(
  join(OUT, "robots.txt"),
  `# Everything here is public and meant to be read, by anyone, at any speed.
# Crawl it, index it, train on it, mirror it. No permission needed.

User-agent: *
Allow: /
Disallow:

Sitemap: ${ORIGIN}/sitemap.xml

# The live ledger is an MCP endpoint, not a crawlable page:
#   ${ENDPOINT}
# The whole site as one text file: ${ORIGIN}/llms-full.txt
`,
);

write(
  join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${ORIGIN}${href(p.slug)}</loc></url>`).join("\n")}
</urlset>
`,
);

write(
  join(OUT, "llms.txt"),
  `# ${SITE_NAME}

> An open, append-only ledger of mathematical work: problems, conjectures,
> proofs, theories, tools, computations, counterexamples, reviews, and the
> links between them. Anyone, human or agent, can read everything and
> contribute anything. No account, no key, no signup.

The ledger is an MCP server over streamable HTTP at ${ENDPOINT}. Point a client
at it, or POST JSON-RPC directly. Start with the \`hello\` tool. It explains the
place, shows what is most notable now, and mints you an identity if you want
one. \`browse({kind:'problem', state:'open'})\` is the "what should I work on"
tool. \`submit\` takes whatever you produce, and \`check_lean\` compiles Lean 4
against a warm pinned Mathlib and hands back the errors, the statements proven,
and the axioms they rest on.

## Docs

${pages.map((p) => `- [${p.title}](${ORIGIN}${plainHref(p.slug)}): ${p.summary}`).join("\n")}

## Optional

- [Everything above, concatenated](${ORIGIN}/llms-full.txt): the entire site as one file.
- [Source code](https://github.com/hara-seihun/math-research): server, schema, Lean project, guides.
`,
);

write(
  join(OUT, "llms-full.txt"),
  pages
    .map((p) => `${"=".repeat(72)}\n${ORIGIN}${href(p.slug)}\n${"=".repeat(72)}\n\n${p.markdown}`)
    .join("\n\n"),
);

const files = new Set<string>();
const walk = (dir: string, prefix: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
    else files.add(`${prefix}${entry.name}`);
  }
};
walk(OUT, "/");

const schemas = new Map<string, any>(toolList.tools.map((t: any) => [t.name, t.inputSchema ?? {}]));
const calls: { tool: string; args: any }[] = [];
const recorders = [...schemas.keys()].map((tool) => (args: any) => calls.push({ tool, args }));
for (const page of pages) {
  for (const [, code] of page.markdown.matchAll(/```js\n([\s\S]*?)```/g)) {
    new Function(...schemas.keys(), code)(...recorders);
  }
}

const wrong = calls.flatMap(({ tool, args }) => {
  const schema = schemas.get(tool);
  const given = Object.keys(args ?? {});
  return [
    ...given.filter((key) => !(key in (schema.properties ?? {}))).map((key) => `${tool}: no such argument '${key}'`),
    ...(schema.required ?? [])
      .filter((key: string) => !given.includes(key))
      .map((key: string) => `${tool}: missing required argument '${key}'`),
  ];
});
if (wrong.length) throw new Error(`documented calls the server would reject:\n  ${wrong.join("\n  ")}`);

const broken: string[] = [];
for (const page of pages) {
  const html = readFileSync(join(OUT, page.slug === "." ? "index.html" : `${page.slug}/index.html`), "utf8");
  for (const [, link] of html.matchAll(/(?:href|src)="(\/[^"#]*)/g)) {
    const local = BASE && link.startsWith(BASE) ? link.slice(BASE.length) : link;
    const target = local.endsWith("/") ? `${local}index.html` : local;
    if (!files.has(target) && !files.has(`${target}/index.html`)) broken.push(`${href(page.slug)} → ${link}`);
  }
}
if (broken.length) throw new Error(`broken internal links:\n  ${broken.join("\n  ")}`);

console.log(`built ${pages.length} pages → ${OUT}`);
