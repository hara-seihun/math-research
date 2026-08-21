/**
 * Requests per second, against the live endpoint, for the similarity tools.
 *
 *   bun test/similarity-load.ts                       every case, 4s each
 *   bun test/similarity-load.ts --seconds=10 --concurrency=16
 *   bun test/similarity-load.ts --endpoint=http://127.0.0.1:8080/mcp
 *
 * Bounded by time rather than by request count, so a slow case reports a small
 * number instead of making the whole run slow.
 *
 * Every request carries a different query, because the server shares identical
 * anonymous reads across callers and a repeated one would measure the cache
 * rather than the tool. What this reports is the cold cost of an answer:
 * normalization, the band lookup, and NCD over what it nominated, across the
 * wire and through Postgres.
 */
const arg = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const ENDPOINT = arg("endpoint", "https://lemma.ing/mcp");
const SECONDS = Number(arg("seconds", "4"));
const CONCURRENCY = Number(arg("concurrency", "8"));

let id = 0;
async function call(tool: string, args: unknown): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6))
    : JSON.parse(text);
  const content = payload.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : payload;
}

/** A different question every time, built by renaming, so no answer can come
 *  from the shared read cache. */
const leanSource = (i: number): string =>
  `theorem load_case_${i} {α : Type*} (s${i} : Finset α) (f${i} : α → ℝ) (n${i} : ℝ) (h${i} : ∀ x ∈ s${i}, f${i} x ≤ n${i}) : ∑ j ∈ s${i}, f${i} j ≤ s${i}.card • n${i}`;

const names = await (async () => {
  const out = (await call("search_decls", { query: "Finset sum", proofs_only: true, limit: 60 })) as {
    results?: { name: string }[];
  };
  return (out.results ?? []).map((r) => r.name);
})();

const refs = await (async () => {
  const out = (await call("search", { query: "graph", limit: 60 })) as { results?: { id: string }[] };
  return (out.results ?? []).map((r) => r.id);
})();

type Case = { name: string; tool: string; args: (i: number) => unknown };

const CASES: Case[] = [
  { name: "lean_similar (source)", tool: "lean_similar", args: (i) => ({ source: leanSource(i), limit: 10 }) },
  { name: "lean_similar (name)", tool: "lean_similar", args: (i) => ({ name: names[i % names.length], limit: 10 }) },
  { name: "related ncd", tool: "related", args: (i) => ({ ref: refs[i % refs.length], method: "ncd", limit: 10 }) },
  { name: "related lexical", tool: "related", args: (i) => ({ ref: refs[i % refs.length], method: "lexical", limit: 10 }) },
  { name: "related semantic", tool: "related", args: (i) => ({ ref: refs[i % refs.length], method: "semantic", limit: 10 }) },
  { name: "search_decls", tool: "search_decls", args: (i) => ({ query: names[i % names.length] }) },
];

console.log(`${ENDPOINT} — ${SECONDS}s per case at concurrency ${CONCURRENCY}\n`);
console.log("case                    req/s   mean ms   p95 ms   errors");
console.log("----------------------  ------  --------  -------  ------");

for (const c of CASES) {
  if (c.tool === "related" && refs.length === 0) continue;
  const latencies: number[] = [];
  let errors = 0;
  let next = 0;
  const started = Date.now();
  const deadline = started + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const t0 = performance.now();
        try {
          const out = (await call(c.tool, c.args(next++))) as { error?: string };
          if (out?.error) errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(
    `${c.name.padEnd(22)}  ${(latencies.length / elapsed).toFixed(1).padStart(6)}  ${mean.toFixed(1).padStart(8)}  ${latencies[Math.floor(latencies.length * 0.95)]!.toFixed(1).padStart(7)}  ${String(errors).padStart(6)}`,
  );
}
