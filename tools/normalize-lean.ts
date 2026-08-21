/**
 * Bring the alpha-normalized columns up to date.
 *
 *   bun tools/normalize-lean.ts            everything stale or missing
 *   bun tools/normalize-lean.ts --all      re-normalize regardless of version
 *
 * `lean_decl` is written by tools/index-decls.sh, which loads pretty-printed
 * statements straight from the oleans and knows nothing about normalization;
 * `lean_unit` is written by the verifier, which does. Both are brought here
 * because the normalizer's version is a fact about the row, so a change to the
 * normalizer is a job with a finite amount of work in it rather than a corpus
 * written in two conventions at once.
 *
 * Run by tools/deploy.sh after the schema, and by tools/index-decls.sh after a
 * rebuild of the index.
 */
import { sql } from "../server/src/db.ts";
import { NORM_VERSION, normalizeDecl } from "../server/src/similarity.ts";

const all = process.argv.includes("--all");
const BATCH = 5000;

async function backfillDecls(): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = await sql<{ module: string; name: string; statement: string }[]>`
      select module, name, statement from lean_decl
      where ${all} or norm_v is distinct from ${NORM_VERSION}
      limit ${BATCH}`;
    if (rows.length === 0) return done;
    const values = rows.map((row) => {
      const { norm, norm_hash, generated } = normalizeDecl(row.name, row.statement);
      return { module: row.module, name: row.name, norm, norm_hash, norm_v: NORM_VERSION, generated };
    });
    // Every column of a VALUES list arrives as text over the wire, so the
    // casts are what make this an update rather than a type error.
    await sql`
      update lean_decl d
      set norm = v.norm, norm_hash = v.norm_hash, norm_v = v.norm_v::int, generated = v.generated::boolean
      from (values ${sql(values.map((v) => [v.module, v.name, v.norm, v.norm_hash, String(v.norm_v), String(v.generated)]) as never)})
        as v(module, name, norm, norm_hash, norm_v, generated)
      where d.module = v.module and d.name = v.name`;
    done += rows.length;
    process.stdout.write(`\rlean_decl: ${done}`);
    if (rows.length < BATCH) return done;
  }
}

/** Units the verifier recorded before this table existed are recoverable from
 *  the checks themselves, which is where the kernel's answer has always been
 *  kept. */
async function adoptChecks(): Promise<number> {
  const rows = await sql<{ source_hash: string; decls: { name: string; type: string; proof?: boolean }[] }[]>`
    select k.source_hash, k.detail->'decls' as decls
    from lean_check k
    where k.outcome = 'passed' and jsonb_array_length(coalesce(k.detail->'decls', '[]'::jsonb)) > 0
      and not exists (select 1 from lean_unit u where u.check_hash = k.source_hash)`;
  let done = 0;
  for (const row of rows) {
    const values = row.decls
      .filter((d) => d.name && d.type)
      .map((d) => {
        const { norm, norm_hash, generated } = normalizeDecl(d.name, d.type);
        return {
          check_hash: row.source_hash, name: d.name, statement: d.type,
          is_proof: d.proof === true, norm, norm_hash, norm_v: NORM_VERSION, generated,
        };
      });
    if (values.length === 0) continue;
    await sql`insert into lean_unit ${sql(values as never)} on conflict (check_hash, name) do update set
                statement = excluded.statement, is_proof = excluded.is_proof, norm = excluded.norm,
                norm_hash = excluded.norm_hash, norm_v = excluded.norm_v, generated = excluded.generated`;
    done += values.length;
  }
  return done;
}

async function backfillUnits(): Promise<number> {
  const rows = await sql<{ check_hash: string; name: string; statement: string }[]>`
    select check_hash, name, statement from lean_unit
    where ${all} or norm_v is distinct from ${NORM_VERSION}`;
  for (const row of rows) {
    const { norm, norm_hash, generated } = normalizeDecl(row.name, row.statement);
    await sql`update lean_unit set norm = ${norm}, norm_hash = ${norm_hash}, norm_v = ${NORM_VERSION},
              generated = ${generated} where check_hash = ${row.check_hash} and name = ${row.name}`;
  }
  return rows.length;
}

const started = Date.now();
const adopted = await adoptChecks();
const units = await backfillUnits();
const decls = await backfillDecls();
console.log(`\nnormalizer v${NORM_VERSION}: ${decls} library declarations, ${units} ledger units (${adopted} adopted from checks) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await sql.end();
