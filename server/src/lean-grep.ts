import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOTS = {
  Mathlib: {
    root: process.env.LEAN_GREP_MATHLIB_ROOT ?? "/srv/math-research/lean/.lake/packages/mathlib",
    prefix: "Mathlib",
  },
  MathlibPlus: {
    root: process.env.LEAN_GREP_MATHLIBPLUS_ROOT ?? "/srv/mathlibplus",
    prefix: "MathlibPlus",
  },
} as const;

export type LeanLibrary = keyof typeof ROOTS;

type RawHit = { library: LeanLibrary; path: string; line: number; text: string };
export type LeanGrepHit = RawHit & {
  module: string;
  before: { line: number; text: string }[];
  after: { line: number; text: string }[];
};

export type LeanGrepParams = {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  libraries: LeanLibrary[];
  module?: string;
  context: number;
  limit: number;
};

const MODULE = /^[A-Za-z0-9_'.\/-]+$/;
const SEARCH_TIMEOUT_MS = 2_000;

function pathspecs(library: LeanLibrary, module: string | undefined): string[] {
  const { prefix } = ROOTS[library];
  if (!module) return [`${prefix}/*.lean`];
  if (!MODULE.test(module)) throw new Error("module may contain only Lean name or path characters.");
  let path = module.replace(/\.lean$/, "").replaceAll(".", "/").replace(/^\/+|\/+$/g, "");
  const namedLibrary = path.split("/")[0];
  if ((namedLibrary === "Mathlib" || namedLibrary === "MathlibPlus") && namedLibrary !== prefix) return [];
  if (path !== prefix && !path.startsWith(`${prefix}/`)) path = `${prefix}/${path}`;
  return [`${path}.lean`, `${path}/*.lean`];
}

async function grepLibrary(
  library: LeanLibrary,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
  module: string | undefined,
  limit: number,
): Promise<{ hits: RawHit[]; more: boolean }> {
  const { root } = ROOTS[library];
  const paths = pathspecs(library, module);
  if (paths.length === 0) return { hits: [], more: false };
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "core.quotePath=false",
      "-C",
      root,
      "grep",
      "--no-color",
      "-n",
      "-I",
      regex ? "-E" : "-F",
      ...(caseSensitive ? [] : ["-i"]),
      "-e",
      query,
      "--",
      ...paths,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const hits: RawHit[] = [];
  let buffer = "";
  let stopped = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SEARCH_TIMEOUT_MS);

  const take = (line: string) => {
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) return;
    hits.push({ library, path: match[1]!, line: Number(match[2]), text: match[3]! });
    if (hits.length > limit) {
      stopped = true;
      proc.kill();
    }
  };

  try {
    while (!stopped) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        take(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (stopped) break;
      }
    }
    if (!stopped) {
      buffer += decoder.decode();
      if (buffer) take(buffer);
    }
  } finally {
    clearTimeout(timer);
    if (stopped) await reader.cancel().catch(() => {});
  }

  const [code, errorText] = await Promise.all([proc.exited, stderr]);
  if (timedOut) throw new Error(`${library} source search exceeded ${SEARCH_TIMEOUT_MS / 1000} seconds.`);
  if (!stopped && code !== 0 && code !== 1) {
    throw new Error(errorText.trim().split("\n")[0] || `${library} source search exited ${code}`);
  }
  return { hits: hits.slice(0, limit), more: hits.length > limit };
}

function roundRobin(groups: RawHit[][], limit: number): RawHit[] {
  const merged: RawHit[] = [];
  for (let i = 0; merged.length < limit; i++) {
    let added = false;
    for (const group of groups) {
      if (group[i]) {
        merged.push(group[i]!);
        added = true;
        if (merged.length === limit) break;
      }
    }
    if (!added) break;
  }
  return merged;
}

export async function grepLean(params: LeanGrepParams): Promise<{
  matches: LeanGrepHit[];
  more: boolean;
  elapsed_ms: number;
}> {
  const started = performance.now();
  const perLibrary = await Promise.all(
    params.libraries.map((library) =>
      grepLibrary(library, params.query, params.regex, params.caseSensitive, params.module, params.limit),
    ),
  );
  const raw = roundRobin(perLibrary.map((result) => result.hits), params.limit);
  const files = new Map<string, Promise<string[]>>();
  const linesOf = (hit: RawHit) => {
    const key = `${hit.library}:${hit.path}`;
    let loaded = files.get(key);
    if (!loaded) {
      loaded = readFile(join(ROOTS[hit.library].root, hit.path), "utf8").then((source) => source.split("\n"));
      files.set(key, loaded);
    }
    return loaded;
  };
  const matches = await Promise.all(
    raw.map(async (hit): Promise<LeanGrepHit> => {
      const lines = await linesOf(hit);
      const before = lines
        .slice(Math.max(0, hit.line - 1 - params.context), hit.line - 1)
        .map((text, i) => ({ line: Math.max(1, hit.line - params.context) + i, text }));
      const after = lines
        .slice(hit.line, hit.line + params.context)
        .map((text, i) => ({ line: hit.line + i + 1, text }));
      return {
        ...hit,
        module: hit.path.replace(/\.lean$/, "").replaceAll("/", "."),
        before,
        after,
      };
    }),
  );
  return {
    matches,
    more: perLibrary.some((result) => result.more) || perLibrary.reduce((n, result) => n + result.hits.length, 0) > params.limit,
    elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
  };
}
