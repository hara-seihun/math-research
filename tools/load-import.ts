/**
 * Load an export produced by export-projects-research.py into the database.
 * Idempotent: rerunning skips contributions whose import_key already exists.
 *
 * Usage: bun run tools/load-import.ts OUTDIR IDENTITY_KEY_FILE "Display Name"
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { sql } from "../server/src/db.ts";
import { sha256hex as sha256 } from "../server/src/identity.ts";

const [dir, keyFile, displayName] = process.argv.slice(2);
if (!dir || !keyFile) {
  console.error('usage: load-import.ts OUTDIR IDENTITY_KEY_FILE "Display Name"');
  process.exit(2);
}

if (!existsSync(keyFile)) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  writeFileSync(keyFile, "mrk_" + Buffer.from(bytes).toString("hex"), { mode: 0o600 });
  console.log(`minted new import identity key at ${keyFile}`);
}
const identityId = sha256(readFileSync(keyFile, "utf8").trim());
await sql`insert into identity (id, display_name) values (${identityId}, ${displayName ?? "import"})
          on conflict (id) do update set display_name = coalesce(identity.display_name, excluded.display_name)`;

const existing = new Map<string, string>();
for (const row of await sql<{ id: string; key: string }[]>`
  select id, metadata->>'import_key' as key from contribution
  where metadata ? 'import_key'`) {
  existing.set(row.key, row.id);
}

const lines = readFileSync(`${dir}/contributions.jsonl`, "utf8").split("\n").filter(Boolean);
let inserted = 0;
for (const line of lines) {
  const record = JSON.parse(line);
  if (existing.has(record.import_key)) continue;
  const hash = sha256(record.content);
  const metadata = { ...record.metadata, import_key: record.import_key };
  const id = await sql.begin(async (tx: postgres.TransactionSql) => {
    await tx`insert into artifact (hash, media_type, content, size_bytes)
             values (${hash}, 'text/markdown', ${record.content}, ${Buffer.byteLength(record.content)})
             on conflict do nothing`;
    const [row] = await tx<{ id: string }[]>`
      insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id,
                                tier, fidelity_reviewed, created_at)
      values (${record.kind}, ${record.title}, ${record.summary}, ${hash},
              ${tx.json(metadata)}, ${identityId}, ${record.tier}, ${record.fidelity_reviewed},
              ${record.created_at ?? new Date().toISOString()})
      returning id`;
    await tx`insert into event (kind, contribution_id, identity_id, payload)
             values ('imported', ${row!.id}, ${identityId},
                     ${tx.json({ import_key: record.import_key, tier: record.tier })})`;
    if (record.tier === 3) {
      await tx`insert into verification (contribution_id, method, outcome, detail)
               values (${row!.id}, 'lean-kernel', 'passed',
                       ${tx.json({ imported: true, lean_decl: record.metadata.lean_decl ?? null })})`;
    }
    return row!.id;
  });
  existing.set(record.import_key, id);
  inserted++;
  if (inserted % 5000 === 0) console.log(`…${inserted}`);
}
console.log(`contributions: ${inserted} inserted, ${lines.length - inserted} already present`);

const edgeLines = readFileSync(`${dir}/edges.jsonl`, "utf8").split("\n").filter(Boolean);
let edges = 0;
for (const line of edgeLines) {
  const edge = JSON.parse(line);
  const src = existing.get(edge.src);
  const dst = existing.get(edge.dst);
  if (!src || !dst) continue;
  const result = await sql`insert into edge (src, dst, rel, note)
            values (${src}, ${dst}, ${edge.rel}, ${edge.note})
            on conflict do nothing`;
  edges += result.count;
}
console.log(`edges: ${edges} inserted of ${edgeLines.length} exported`);
await sql.end();
