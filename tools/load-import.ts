/**
 * Load a Projects Research export (tools/export-projects-research.py) into the
 * ledger. Idempotent and reconciling: `import_key` is the identity, so a rerun
 * updates what the frozen predecessor now says instead of duplicating it, and
 * every change is appended to the public event ledger like any other.
 *
 * Bulk, not row-at-a-time: the export is staged into temp tables and the whole
 * load is a handful of set operations, so 60k contributions and 85k links land
 * in well under a minute.
 *
 * The export is a full snapshot, so reconciling includes taking things *out*:
 * anything this identity imported that the export no longer asserts is
 * retracted (appended, never deleted). Without that, fixing the exporter could
 * only ever add, and a bad batch would stay in the corpus forever.
 *
 * Usage: bun run tools/load-import.ts [--withdraw-limit=FRACTION]
 *          EXPORTDIR IDENTITY_KEY_FILE "Display Name"
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql } from "../server/src/db.ts";

const argv = process.argv.slice(2);
const flags = new Map(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = ""] = a.slice(2).split("=", 2);
      return [k, v] as const;
    }),
);
const [dir, keyFile, displayName] = argv.filter((a) => !a.startsWith("--"));
// A truncated or mis-generated export must not be able to empty the corpus, so
// a withdrawal bigger than this fraction of what is currently imported aborts
// the load and says so instead. The accident this catches is always large, so
// small withdrawals are never gated: needing a flag to drop a handful of bad
// links would only teach everyone to pass the flag.
const withdrawLimit = Number(flags.get("withdraw-limit") ?? 0.1);
const WITHDRAW_FLOOR = 100;
if (!dir || !keyFile || !(withdrawLimit >= 0 && withdrawLimit <= 1)) {
  console.error(
    'usage: load-import.ts [--withdraw-limit=FRACTION] EXPORTDIR IDENTITY_KEY_FILE "Display Name"',
  );
  process.exit(2);
}

if (!existsSync(keyFile)) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  writeFileSync(keyFile, "mrk_" + Buffer.from(bytes).toString("hex"), { mode: 0o600 });
  console.log(`minted new import identity key at ${keyFile}`);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const identityId = sha256(readFileSync(keyFile, "utf8").trim());

// Staging lives in temp tables, so the whole load has to run on one connection.
const db = await sql.reserve();
await db`insert into identity (id, display_name) values (${identityId}, ${displayName ?? "import"})
         on conflict (id) do update set display_name = coalesce(identity.display_name, excluded.display_name)`;

type Contribution = {
  import_key: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  media_type?: string;
  tier: number;
  state?: string;
  status?: string;
  names?: string[];
  created_at: string;
  metadata: Record<string, unknown>;
};
type Edge = { src: string; dst: string; rel: string; note: string | null; tier: number };
type Trail = { import_key: string; title: string; created_at: string; about: string[]; notes: string[]; outcome?: string };

const readJsonl = <T,>(name: string): T[] =>
  readFileSync(`${dir}/${name}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

const contributions = readJsonl<Contribution>("contributions.jsonl");
const edgeRecords = readJsonl<Edge>("edges.jsonl");
const trailRecords = existsSync(`${dir}/trails.jsonl`) ? readJsonl<Trail>("trails.jsonl") : [];
console.log(`read ${contributions.length} contributions, ${edgeRecords.length} edges, ${trailRecords.length} trails`);

const CHUNK = 2000;
async function insertChunked<T extends Record<string, unknown>>(table: string, rows: T[], columns: string[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db`insert into ${db(table)} ${db(rows.slice(i, i + CHUNK) as never[], ...(columns as never[]))}`;
  }
}

// ——— Stage ————————————————————————————————————————————————————————————
await db`
  create temp table imp_contribution (
    import_key text primary key, kind text, title text, summary text, content text,
    media_type text, tier int, state text, status text, names text[],
    created_at timestamptz, metadata text, hash text, id uuid)`;
await db`
  create temp table imp_edge (
    src_key text, dst_key text, rel text, note text, tier int,
    src uuid, dst uuid, id uuid)`;
await db`
  create temp table imp_trail (
    import_key text primary key, title text, created_at timestamptz,
    about text[], notes text[], metadata text, id uuid)`;

await insertChunked(
  "imp_contribution",
  contributions.map((c) => ({
    import_key: c.import_key,
    kind: c.kind,
    title: c.title.slice(0, 300),
    summary: c.summary.slice(0, 2000),
    content: c.content,
    media_type: c.media_type ?? "text/markdown",
    tier: c.tier,
    state: c.state ?? null,
    status: c.status ?? "active",
    names: [...new Map((c.names ?? []).map((n) => [n.trim().toLowerCase(), n.trim()])).values()].filter(Boolean).slice(0, 12),
    created_at: c.created_at,
    metadata: JSON.stringify({ ...c.metadata, import_key: c.import_key }),
    hash: sha256(c.content),
  })),
  ["import_key", "kind", "title", "summary", "content", "media_type", "tier", "state", "status", "names", "created_at", "metadata", "hash"],
);
await insertChunked(
  "imp_edge",
  edgeRecords.map((e) => ({ src_key: e.src, dst_key: e.dst, rel: e.rel, note: e.note, tier: e.tier ?? 2 })),
  ["src_key", "dst_key", "rel", "note", "tier"],
);
await insertChunked(
  "imp_trail",
  trailRecords.map((t) => ({
    import_key: t.import_key,
    title: t.title.slice(0, 300),
    created_at: t.created_at,
    about: t.about,
    notes: t.notes,
    metadata: JSON.stringify({ import_key: t.import_key, imported_from: "projects-research", ...(t.outcome ? { outcome: t.outcome } : {}) }),
  })),
  ["import_key", "title", "created_at", "about", "notes", "metadata"],
);
console.log("staged");

// ——— Artifacts ————————————————————————————————————————————————————————
await db`
  insert into artifact (hash, media_type, content, size_bytes)
  select distinct on (hash) hash, media_type, content, octet_length(content)
  from imp_contribution
  on conflict (hash) do nothing`;

// ——— Contributions: insert what is new, reconcile what changed ——————————
await db`
  update imp_contribution i set id = c.id
  from contribution c where c.metadata->>'import_key' = i.import_key`;

const inserted = (
  await db`
    insert into contribution
      (kind, title, summary, artifact_hash, metadata, identity_id, tier, status, state, names, tags, created_at)
    select i.kind, i.title, i.summary, i.hash, i.metadata::jsonb, ${identityId}, i.tier, i.status, i.state, i.names,
           classify_topics(i.title || ' ' || i.summary || ' ' || left(i.content, 2000)), i.created_at
    from imp_contribution i where i.id is null`
).count;
await db`
  update imp_contribution i set id = c.id
  from contribution c where c.metadata->>'import_key' = i.import_key and i.id is null`;

const [{ changed }] = await db<{ changed: number }[]>`
  with updated as (
    update contribution c
       set kind = i.kind, title = i.title, summary = i.summary, artifact_hash = i.hash,
           -- The export owns the metadata of what it imported, so it replaces
           -- rather than merges: a key the exporter stops emitting (a Lean
           -- declaration that turned out to state rather than prove something)
           -- has to actually go away.
           metadata = i.metadata::jsonb, tier = greatest(c.tier, i.tier), status = i.status,
           -- Questions carry a derived state and the export deliberately has
           -- no opinion about it; only a stated state overwrites.
           state = coalesce(i.state, c.state), names = i.names,
           created_at = i.created_at, updated_at = now(),
           -- Never trade an inherited topic for no topic at all.
           tags = coalesce(nullif(classify_topics(i.title || ' ' || i.summary || ' ' || left(i.content, 2000)), '{}'), c.tags)
      from imp_contribution i
     where c.id = i.id
       and (c.kind, c.title, c.summary, c.artifact_hash, c.status, c.names, c.metadata)
           is distinct from (i.kind, i.title, i.summary, i.hash, i.status, i.names, i.metadata::jsonb)
    returning c.id, i.import_key
  )
  select count(*)::int as changed from updated`;

await db`
  insert into event (kind, contribution_id, identity_id, payload)
  select 'imported', i.id, ${identityId},
         jsonb_build_object('import_key', i.import_key, 'kind', i.kind, 'tier', i.tier, 'state', i.state)
  from imp_contribution i
  where i.id is not null and not exists (
    select 1 from event e where e.contribution_id = i.id and e.kind = 'imported'
      and e.payload->>'kind' = i.kind and e.payload->>'state' is not distinct from i.state)`;
console.log(`contributions: ${inserted} new, ${changed} reconciled`);

// ——— Links (each link is itself a contribution) ————————————————————————
await db`
  update imp_edge e set src = s.id, dst = d.id
  from imp_contribution s, imp_contribution d
  where e.src_key = s.import_key and e.dst_key = d.import_key`;
await db`delete from imp_edge where src is null or dst is null or src = dst`;
await db`create index imp_edge_endpoint_idx on imp_edge (src, dst, rel)`;
await db`
  update imp_edge i set id = e.contribution_id
  from edge e join contribution ec on ec.id = e.contribution_id
  where e.src = i.src and e.dst = i.dst and e.rel = i.rel
    and ec.identity_id = ${identityId} and ec.status = 'active'`;

await db`
  insert into artifact (hash, media_type, content, size_bytes)
  select distinct on (h) h, 'text/plain', body, octet_length(body) from (
    select encode(sha256(convert_to('edge:' || src || ':' || dst || ':' || rel || ':' || coalesce(note, rel), 'utf8')), 'hex') as h,
           coalesce(note, rel) as body
    from imp_edge where id is null) x
  on conflict (hash) do nothing`;

const links = (
  await db`
    insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id, tier, created_at)
    select 'edge', i.rel, coalesce(left(i.note, 2000), i.rel || ' link'),
           encode(sha256(convert_to('edge:' || i.src || ':' || i.dst || ':' || i.rel || ':' || coalesce(i.note, i.rel), 'utf8')), 'hex'),
           jsonb_build_object('src', i.src, 'dst', i.dst, 'rel', i.rel, 'imported_from', 'projects-research'),
           ${identityId}, i.tier, now()
    from imp_edge i where i.id is null`
).count;
await db`
  insert into edge (contribution_id, src, dst, rel)
  select c.id, (c.metadata->>'src')::uuid, (c.metadata->>'dst')::uuid, c.metadata->>'rel'
  from contribution c
  where c.kind = 'edge' and c.identity_id = ${identityId}
    and not exists (select 1 from edge e where e.contribution_id = c.id)`;
await db`
  insert into event (kind, contribution_id, identity_id, payload)
  select 'submitted', c.id, ${identityId},
         jsonb_build_object('kind', 'edge', 'src', e.src, 'dst', e.dst, 'rel', e.rel)
  from edge e join contribution c on c.id = e.contribution_id
  where c.identity_id = ${identityId}
    and not exists (select 1 from event ev where ev.contribution_id = c.id)`;
console.log(`links: ${links} new`);

// ——— Withdrawal: what the export no longer asserts ————————————————————
// Reconciling a full snapshot has to be able to remove, or an exporter fix can
// never correct what a previous run already published. Removal here means what
// it means everywhere else in this ledger: status 'retracted' plus a
// 'retracted' event. The rows stay readable, the reads and refresh_state stop
// counting them, and the decision is in the public event log.
const [{ edges_gone, links_live, entries_gone, entries_live }] = await db<
  { edges_gone: number; links_live: number; entries_gone: number; entries_live: number }[]
>`
  with mine as (
    select c.id, c.kind = 'edge' as is_edge,
           case when c.kind = 'edge'
                then not exists (
                  select 1 from edge e join imp_edge i
                    on i.src = e.src and i.dst = e.dst and i.rel = e.rel
                   where e.contribution_id = c.id)
                else not exists (
                  select 1 from imp_contribution i
                   where i.import_key = c.metadata->>'import_key') end as gone
      from contribution c
     where c.identity_id = ${identityId} and c.status = 'active'
       and (case when c.kind = 'edge' then c.metadata->>'imported_from' = 'projects-research'
                 else c.metadata ? 'import_key' end)
  )
  select count(*) filter (where is_edge and gone)::int      as edges_gone,
         count(*) filter (where is_edge)::int               as links_live,
         count(*) filter (where not is_edge and gone)::int  as entries_gone,
         count(*) filter (where not is_edge)::int           as entries_live
    from mine`;

const overLimit = (gone: number, live: number) =>
  gone > WITHDRAW_FLOOR && gone > live * withdrawLimit;
if (overLimit(edges_gone, links_live) || overLimit(entries_gone, entries_live)) {
  console.error(
    `refusing to withdraw ${entries_gone}/${entries_live} entries and ${edges_gone}/${links_live} links: ` +
      `more than ${(withdrawLimit * 100).toFixed(0)}% of what is imported. ` +
      `Check the export is complete, or rerun with --withdraw-limit=<fraction> if it really did shrink that much.`,
  );
  db.release();
  await sql.end();
  process.exit(1);
}

const withdrawn = (
  await db`
    with gone as (
      select c.id, c.kind
        from contribution c
       where c.identity_id = ${identityId} and c.status = 'active'
         and (case when c.kind = 'edge'
                   then c.metadata->>'imported_from' = 'projects-research'
                     and not exists (
                       select 1 from edge e join imp_edge i
                         on i.src = e.src and i.dst = e.dst and i.rel = e.rel
                        where e.contribution_id = c.id)
                   else c.metadata ? 'import_key'
                     and not exists (
                       select 1 from imp_contribution i
                        where i.import_key = c.metadata->>'import_key') end)
    ), retracted as (
      update contribution c set status = 'retracted', updated_at = now()
       where c.id in (select id from gone) returning c.id, c.kind
    )
    insert into event (kind, contribution_id, identity_id, payload)
    select 'retracted', r.id, ${identityId},
           jsonb_build_object('note', 'withdrawn: the Projects Research export no longer asserts this',
                              'kind', r.kind, 'source', 'load-import')
      from retracted r`
).count;
console.log(`withdrawn: ${withdrawn} (${entries_gone} entries, ${edges_gone} links)`);

// ——— Kernel verifications ————————————————————————————————————————————
// Only a *proved* declaration is a kernel check. `lean_statement` names Lean
// that states the entry and proves nothing, so it is provenance and never a
// verification — and an entry demoted from one to the other loses the
// verification an earlier load gave it.
const [{ verified }] = await db<{ verified: number }[]>`
  with added as (
    insert into verification (contribution_id, method, outcome, detail)
    select i.id, 'lean-kernel', 'passed', jsonb_build_object('imported', true, 'lean_decl', i.metadata::jsonb->>'lean_decl')
    from imp_contribution i
    where i.metadata::jsonb ? 'lean_decl' and i.id is not null
      and not exists (select 1 from verification v where v.contribution_id = i.id and v.method = 'lean-kernel' and v.outcome = 'passed')
    returning contribution_id
  )
  select count(*)::int as verified from added`;
const unverified = (
  await db`
    delete from verification v
     using contribution c
     where c.id = v.contribution_id and c.identity_id = ${identityId}
       and v.method = 'lean-kernel' and v.detail->>'imported' = 'true'
       and not (c.metadata ? 'lean_decl')`
).count;
console.log(`lean verifications: ${verified} new, ${unverified} withdrawn`);

// ——— Attempt records become closed trails ————————————————————————————
await db`
  update imp_trail t set id = tr.id from trail tr
  where tr.metadata->>'import_key' = t.import_key`;
const trails = (
  await db`
    insert into trail (identity_id, title, status, metadata, created_at, updated_at)
    select ${identityId}, t.title, 'closed', t.metadata::jsonb, t.created_at, t.created_at
    from imp_trail t where t.id is null`
).count;
await db`
  update imp_trail t set id = tr.id from trail tr
  where tr.metadata->>'import_key' = t.import_key and t.id is null`;
await db`
  insert into trail_entry (trail_id, note, contribution_ids, created_at)
  select t.id, note, array_remove(array(select c.id from imp_contribution c where c.import_key = any(t.about)), null), t.created_at
  from imp_trail t, unnest(t.notes) as note
  where t.id is not null and not exists (select 1 from trail_entry e where e.trail_id = t.id)`;
console.log(`trails: ${trails} new`);

await db`select refresh_state(null)`;
// Twice: a statement inherits from its write-up, then a cell from the
// programme that just inherited one.
const [{ tagged }] = await db<{ tagged: string }[]>`
  select (select inherit_topics()) + (select inherit_topics()) as tagged`;
await db`select refresh_notability(null)`;
console.log(`state refreshed, ${tagged} entries given inherited topics, notability refreshed`);
db.release();
await sql.end();
