// Tag the existing corpus with subject topics using the same classifier new
// submissions use (server/src/topics.ts) — one source of truth, no AI pass.
// Streams contributions in batches, classifies on title+summary+content head,
// and writes tags. Idempotent: re-running just recomputes the same labels.
//
//   bun run tools/backfill-topics.ts
import { sql } from "../server/src/db.ts";
import { classifyTopics } from "../server/src/topics.ts";

const BATCH = 2000;
let after = "00000000-0000-0000-0000-000000000000";
let done = 0;
let tagged = 0;

for (;;) {
  const rows = await sql<{ id: string; title: string; summary: string; content: string }[]>`
    select c.id, c.title, c.summary, left(a.content, 4000) as content
    from contribution c join artifact a on a.hash = c.artifact_hash
    where c.kind <> 'edge' and c.id > ${after}
    order by c.id limit ${BATCH}`;
  if (rows.length === 0) break;

  await sql.begin(async (tx) => {
    for (const r of rows) {
      const tags = classifyTopics(`${r.title}\n${r.summary}\n${r.content}`);
      await tx`update contribution set tags = ${tags}::text[] where id = ${r.id}`;
      if (tags.length) tagged++;
    }
  });

  done += rows.length;
  after = rows.at(-1)!.id;
  if (done % 10000 === 0) console.log(`…${done} classified (${tagged} tagged)`);
}

console.log(`done: ${done} contributions classified, ${tagged} received at least one topic`);
await sql.end();
