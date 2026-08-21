// Computes a semantic vector for every contribution that lacks one, calling
// the local embedding server (llama.cpp, bge-small). This is both the backfill
// and the steady-state worker: it drains the null-embedding backlog, then
// polls for newly submitted work. Edges get no embedding.
import { sql } from "../src/db.ts";

const EMBEDDER = process.env.EMBEDDER_URL ?? "http://127.0.0.1:8090";
const BATCH = 16;
// bge-small hard-caps at 512 tokens per sequence and dense math text tokenizes
// heavily, so we cap chars for the batch attempt and, if a batch trips the
// limit, fall back to per-item embedding with shrinking caps down to a floor
// that is always under 512 tokens, so one long entry never stalls the backfill.
const BATCH_CHARS = 900;
const SHRINK = [900, 600, 400, 256];

function vec(a: number[]): string {
  return `[${a.join(",")}]`;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${EMBEDDER}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts }),
  });
  if (!res.ok) throw new Error(`embedder ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => d.embedding);
}

async function embedOne(full: string): Promise<number[]> {
  for (const cap of SHRINK) {
    try {
      const [e] = await embedBatch([full.slice(0, cap)]);
      return e!;
    } catch (err) {
      if (cap === SHRINK.at(-1)) throw err;
    }
  }
  throw new Error("unreachable");
}

async function waitForEmbedder(): Promise<void> {
  for (;;) {
    try {
      if ((await fetch(`${EMBEDDER}/health`)).ok) return;
    } catch {}
    await Bun.sleep(2000);
  }
}

await waitForEmbedder();
let done = 0;
for (;;) {
  const rows = await sql<{ id: string; title: string; summary: string; content: string }[]>`
    select c.id, c.title, c.summary, left(a.content, 2000) as content
    from contribution c join artifact a on a.hash = c.artifact_hash
    where c.kind <> 'edge' and c.embedding is null
    order by c.notability desc, c.created_at desc limit ${BATCH}`;
  if (rows.length === 0) {
    await Bun.sleep(10000);
    continue;
  }
  const full = rows.map((r) => `${r.title}\n${r.summary}\n${r.content}`);
  let embs: number[][];
  try {
    embs = await embedBatch(full.map((t) => t.slice(0, BATCH_CHARS)));
  } catch {
    // A too-long member tripped the batch; embed each row individually so the
    // long ones shrink and the rest still make progress.
    embs = [];
    for (const t of full) {
      try {
        embs.push(await embedOne(t));
      } catch (e) {
        console.error(String(e));
        embs.push([]);
      }
    }
  }
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      if (embs[i]!.length === 0) continue;
      await tx`update contribution set embedding = ${vec(embs[i]!)}::vector where id = ${rows[i]!.id}`;
    }
  });
  done += rows.length;
  if (done % 3200 === 0) console.log(`embedded ${done}`);
}
