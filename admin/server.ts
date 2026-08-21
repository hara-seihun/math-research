// The editor behind https://lemma.ing/admin: edit the Markdown the site
// and the `guides` tool are built from, preview a real build of it, publish it
// live, and commit it. The working tree is the draft; git and site/public are
// what is live.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REPO = process.env.REPO_DIR ?? resolve(import.meta.dir, "..");
const SITE = join(REPO, "site");
const STATE = process.env.STATE_DIR ?? "/var/lib/math-admin";
const PASSWORD_FILE = process.env.ADMIN_PASSWORD_FILE ?? join(STATE, "password");
const PREVIEW_OUT = join(STATE, "preview");
const PREVIEW_BASE = "/admin/preview";
const PUBLISH_TMP = join(SITE, ".publish-tmp");
const LIVE_OUT = join(SITE, "public");
const MCP_URL = process.env.MATH_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const PORT = Number(process.env.PORT ?? 8790);
const SESSION_DAYS = 30;

type Ran = { ok: boolean; output: string };

async function run(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Ran> {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: code === 0, output: `${out}${err}`.trim() };
}

const git = (...args: string[]) => run(["git", ...args]);

let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => {});
  return next;
}

function password(): Buffer {
  if (!existsSync(PASSWORD_FILE)) {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(PASSWORD_FILE, `${randomBytes(18).toString("base64url")}\n`, { mode: 0o600 });
    console.log(`minted a new admin password in ${PASSWORD_FILE}`);
  }
  return Buffer.from(readFileSync(PASSWORD_FILE, "utf8").trim());
}

const SECRET = password();

const stamp = (expiry: number) => `${expiry}.${createHmac("sha256", SECRET).update(String(expiry)).digest("base64url")}`;

function authorized(request: Request): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  const token = /(?:^|;\s*)math_admin=([^;]+)/.exec(cookie)?.[1];
  if (!token) return false;
  const expiry = Number(token.split(".")[0]);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = Buffer.from(stamp(expiry));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const failures: number[] = [];
function throttled(): boolean {
  const cutoff = Date.now() - 60_000;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= 10;
}

type Doc = { path: string; slug: string; title: string; content: string };

const ROOTS = [
  { dir: join(SITE, "content"), rel: "site/content", kind: "page" as const },
  { dir: join(REPO, "guides"), rel: "guides", kind: "guide" as const },
];

function docFile(path: string): { abs: string; kind: "page" | "guide" } | null {
  const root = ROOTS.find((candidate) => path.startsWith(`${candidate.rel}/`));
  if (!root) return null;
  const name = path.slice(root.rel.length + 1);
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) return null;
  return { abs: join(root.dir, name), kind: root.kind };
}

function slugOf(path: string, content: string): string {
  const meta = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
  const declared = meta && /^slug:\s*(.+)$/m.exec(meta)?.[1].trim();
  if (declared) return declared === "." ? "" : declared;
  return `guides/${path.split("/").pop()!.replace(/\.md$/, "")}`;
}

function titleOf(path: string, content: string): string {
  const meta = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
  return (meta && /^title:\s*(.+)$/m.exec(meta)?.[1].trim()) || /^#\s+(.+)$/m.exec(content)?.[1].trim() || path;
}

function docs(): Doc[] {
  const listed = ROOTS.flatMap((root, rank) =>
    readdirSync(root.dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const path = `${root.rel}/${name}`;
        const content = readFileSync(join(root.dir, name), "utf8");
        const doc: Doc = { path, slug: slugOf(path, content), title: titleOf(path, content), content };
        // Home page, then the rest of the pages, then the guides: the order
        // someone editing the site thinks in.
        return { doc, order: `${rank}${name === "index.md" ? "" : name}` };
      }),
  );
  return listed.sort((a, b) => a.order.localeCompare(b.order)).map((entry) => entry.doc);
}

async function state() {
  const [status, head] = await Promise.all([
    git("status", "--porcelain", "--untracked-files=all", "--", "site/content", "guides"),
    git("log", "-1", "--format=%h %cr — %s"),
  ]);
  const changed = status.output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).pop()!);
  return { docs: docs(), changed, head: head.output, previewBase: PREVIEW_BASE };
}

type Save = { path: string; content: string };

function write(saves: Save[]): string | null {
  for (const save of saves) {
    const file = docFile(save.path);
    if (!file) return `refusing to write ${save.path}`;
    if (typeof save.content !== "string") return `${save.path}: no content`;
  }
  for (const save of saves) writeFileSync(docFile(save.path)!.abs, save.content);
  return null;
}

const build = (out: string, base: string) =>
  run(["bun", "run", "build.ts"], {
    cwd: SITE,
    env: { SITE_OUT: out, SITE_BASE: base, MATH_MCP_URL: MCP_URL },
  });

async function publish(message: string): Promise<Ran & { commit?: string }> {
  rmSync(PUBLISH_TMP, { recursive: true, force: true });
  const built = await build(PUBLISH_TMP, "");
  if (!built.ok) {
    rmSync(PUBLISH_TMP, { recursive: true, force: true });
    return built;
  }

  const retired = `${LIVE_OUT}.retired`;
  rmSync(retired, { recursive: true, force: true });
  if (existsSync(LIVE_OUT)) renameSync(LIVE_OUT, retired);
  renameSync(PUBLISH_TMP, LIVE_OUT);
  rmSync(retired, { recursive: true, force: true });

  const staged = await git("add", "--", "site/content", "guides");
  if (!staged.ok) return staged;
  const pending = await git("diff", "--cached", "--name-only");
  if (!pending.output) return { ok: true, output: `${built.output}\nlive, and no text changed, so no commit` };

  const committed = await run([
    "git",
    "-c",
    "user.name=lemma.ing admin",
    "-c",
    "user.email=admin@lemma.ing",
    "commit",
    "-m",
    message.trim() || "site: edited at /admin",
    "--",
    "site/content",
    "guides",
  ]);
  if (!committed.ok) return committed;
  const head = await git("log", "-1", "--format=%h %s");
  return { ok: true, output: `${built.output}\n${committed.output}`, commit: head.output };
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
};

function previewFile(pathname: string): Response {
  const target = resolve(PREVIEW_OUT, pathname.slice(PREVIEW_BASE.length).replace(/^\/+/, ""));
  const file = existsSync(target) && statSync(target).isFile() ? target : join(target, "index.html");
  if (!file.startsWith(PREVIEW_OUT) || !existsSync(file)) {
    return new Response("no preview for this page yet, save it first", { status: 404 });
  }
  return new Response(Bun.file(file), {
    headers: { "content-type": MIME[file.split(".").pop()!] ?? "application/octet-stream", "cache-control": "no-store" },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const app = () =>
  new Response(readFileSync(join(import.meta.dir, "app.html")), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/admin";

    if (path === "/admin/api/login") {
      if (throttled()) return json({ error: "too many attempts, wait a minute" }, 429);
      const given = Buffer.from(String(((await request.json()) as { password?: string }).password ?? ""));
      const ok = given.length === SECRET.length && timingSafeEqual(given, SECRET);
      if (!ok) {
        failures.push(Date.now());
        await Bun.sleep(400);
        return json({ error: "wrong password" }, 401);
      }
      const expiry = Date.now() + SESSION_DAYS * 86_400_000;
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `math_admin=${stamp(expiry)}; Path=/admin; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    if (path === "/admin" || path === "/admin/index.html") return app();

    if (!authorized(request)) {
      if (path.startsWith("/admin/api/")) return json({ error: "unauthenticated" }, 401);
      return app();
    }

    if (path === "/admin/api/logout") {
      return new Response("{}", {
        headers: { "content-type": "application/json", "set-cookie": "math_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax" },
      });
    }

    if (path === "/admin/api/state") return json(await serial(state));

    if (path === "/admin/api/save" || path === "/admin/api/preview") {
      const body = (await request.json()) as { files?: Save[] };
      return json(
        await serial(async () => {
          const bad = write(body.files ?? []);
          if (bad) return { ok: false, output: bad, ...(await state()) };
          const built = path.endsWith("preview") ? await build(PREVIEW_OUT, PREVIEW_BASE) : { ok: true, output: "saved" };
          return { ...built, ...(await state()) };
        }),
      );
    }

    if (path === "/admin/api/publish") {
      const body = (await request.json()) as { files?: Save[]; message?: string };
      return json(
        await serial(async () => {
          const bad = write(body.files ?? []);
          if (bad) return { ok: false, output: bad, ...(await state()) };
          const result = await publish(body.message ?? "");
          if (result.ok) await build(PREVIEW_OUT, PREVIEW_BASE);
          return { ...result, ...(await state()) };
        }),
      );
    }

    if (path === "/admin/api/delete") {
      const body = (await request.json()) as { path?: string };
      return json(
        await serial(async () => {
          const file = docFile(body.path ?? "");
          if (!file || !existsSync(file.abs)) return { ok: false, output: `no such page: ${body.path}`, ...(await state()) };
          unlinkSync(file.abs);
          const built = await build(PREVIEW_OUT, PREVIEW_BASE);
          return {
            ...built,
            output: built.ok ? `deleted ${body.path}, publish to make that live` : built.output,
            ...(await state()),
          };
        }),
      );
    }

    if (path === "/admin/api/revert") {
      const body = (await request.json()) as { path?: string };
      return json(
        await serial(async () => {
          const file = docFile(body.path ?? "");
          if (!file) return { ok: false, output: `refusing to revert ${body.path}`, ...(await state()) };
          const reverted = await git("checkout", "--", body.path!);
          return { ...reverted, output: reverted.output || `reverted ${body.path}`, ...(await state()) };
        }),
      );
    }

    if (path.startsWith(PREVIEW_BASE)) return previewFile(url.pathname);

    return new Response("not found", { status: 404 });
  },
});

console.log(`admin editor on 127.0.0.1:${PORT}, repo ${REPO}`);
