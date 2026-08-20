-- One-time migration of the live database to the "everything is a contribution"
-- model: edges become contributions, notability is derived, roles gain
-- 'trusted', and search gains the trigram/unaccent machinery. Fresh installs
-- get all of this straight from schema.sql; this only transforms the DB that
-- was created from the previous schema. Guarded so a re-run is a no-op.

begin;

create extension if not exists pgcrypto;
create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists vector;

alter table identity drop constraint if exists identity_role_check;
alter table identity add constraint identity_role_check
  check (role in ('contributor', 'trusted', 'operator'));

alter table contribution add column if not exists notability real not null default 0;
alter table contribution add column if not exists tags text[] not null default '{}';
alter table contribution add column if not exists names text[] not null default '{}';
alter table contribution add column if not exists embedding vector(384);
create index if not exists contribution_trgm_idx
  on contribution using gin ((title || ' ' || summary) gin_trgm_ops);
create index if not exists contribution_notability_idx on contribution (status, notability desc);
create index if not exists contribution_tags_idx on contribution using gin (tags);
create index if not exists contribution_names_idx on contribution using gin (names);
create index if not exists contribution_embedding_idx on contribution using hnsw (embedding vector_cosine_ops);

-- Tunable policy moves into the database as data (config + topic_rule), so a
-- trusted operator tunes notability and the taxonomy live over the MCP.
create table if not exists config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists topic_rule (
  topic   text primary key,
  pattern text not null,
  ord     integer not null default 100
);
create or replace function classify_topics(t text) returns text[] language sql stable as $$
  select coalesce(array_agg(topic order by ord), '{}')
  from (select topic, ord from topic_rule where lower($1) ~ pattern order by ord limit 4) x;
$$;

-- Convert the old edge table (src,dst,rel,note) into edge contributions plus
-- the new structural sidecar. Detected by the presence of the old `note`
-- column; skipped entirely on a re-run.
do $$
declare
  import_identity text;
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'edge' and column_name = 'note') then

    select identity_id into import_identity
      from contribution where metadata ? 'import_key' limit 1;
    if import_identity is null then
      select id into import_identity from identity where role = 'operator' limit 1;
    end if;

    alter table edge rename to edge_old;

    create table edge (
      contribution_id uuid primary key references contribution(id),
      src             uuid not null references contribution(id),
      dst             uuid not null references contribution(id),
      rel             text not null,
      created_at      timestamptz not null default now()
    );

    -- edge contributions (carry src/dst/rel in metadata for the sidecar step)
    with e as (
      select src, dst, rel, created_at,
             left(coalesce(nullif(btrim(note), ''), rel), 4000) as content,
             coalesce(nullif(btrim(note), ''), rel || ' link') as summary,
             case when rel = 'supersedes' and btrim(note) = 'proposed' then 0 else 2 end as tier
      from edge_old
    ),
    art as (
      insert into artifact (hash, media_type, content, size_bytes)
      select distinct encode(digest('edge:' || src::text || ':' || dst::text || ':' || rel || ':' || content, 'sha256'), 'hex'),
             'text/plain', content, octet_length(content)
      from e
      on conflict do nothing
      returning 1
    )
    insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id, tier, created_at)
    select 'edge', rel, summary,
           encode(digest('edge:' || src::text || ':' || dst::text || ':' || rel || ':' || content, 'sha256'), 'hex'),
           jsonb_build_object('src', src::text, 'dst', dst::text, 'rel', rel, 'imported_from', 'projects-research'),
           import_identity, tier, created_at
    from e;

    insert into edge (contribution_id, src, dst, rel, created_at)
    select id, (metadata->>'src')::uuid, (metadata->>'dst')::uuid, metadata->>'rel', created_at
    from contribution
    where kind = 'edge' and not exists (select 1 from edge x where x.contribution_id = contribution.id);

    insert into event (kind, contribution_id, identity_id, payload)
    select 'submitted', e.contribution_id, c.identity_id,
           jsonb_build_object('kind', 'edge', 'src', e.src::text, 'dst', e.dst::text, 'rel', e.rel, 'imported', true)
    from edge e join contribution c on c.id = e.contribution_id
    where c.kind = 'edge'
      and not exists (select 1 from event ev where ev.contribution_id = e.contribution_id);

    drop table edge_old;  -- frees the old index names
    create index edge_src_idx on edge (src, rel);
    create index edge_dst_idx on edge (dst, rel);
  end if;
end $$;

-- refresh_notability references the new edge shape, so it is defined only after
-- the edge table has been migrated above. Config-driven (all weights in config).
drop function if exists kind_weight(text);
drop function if exists rel_weight(text);
create or replace function refresh_notability(ids uuid[] default null) returns void language plpgsql as $$
declare
  w jsonb;
  settle_rels text[];
begin
  select value into w from config where key = 'notability_weights';
  if w is null then w := '{}'::jsonb; end if;
  settle_rels := array(select jsonb_array_elements_text(
    coalesce(w->'settle_rels', '["answers","proves","disproves","refutes","serves"]'::jsonb)));

  with base as (
    select c.id,
           coalesce((w->'kind'->>c.kind)::real, (w->'kind'->>'_default')::real, 1.0)
             + coalesce((w->'tier'->>c.tier::text)::real, 0.0)
             + case when exists (select 1 from verification v
                                 where v.contribution_id = c.id
                                   and v.method = 'lean-kernel' and v.outcome = 'passed')
                    then coalesce((w->>'lean')::real, 2.0) else 0.0 end as own
    from contribution c
    where c.kind <> 'edge' and (ids is null or c.id = any (ids))
  ),
  incoming as (
    select e.dst as id,
           sum(coalesce((w->'rel'->>e.rel)::real, (w->'rel'->>'_default')::real, 0.5)
               * coalesce((w->'edge_tier'->>ec.tier::text)::real, 0.0)) as s
    from edge e join contribution ec on ec.id = e.contribution_id
    where ec.status = 'active' and (ids is null or e.dst = any (ids))
    group by e.dst
  ),
  settles as (
    select e.src as id,
           sum(coalesce((w->'tier'->>tgt.tier::text)::real, 0.0) * coalesce((w->>'settle')::real, 0.5)) as s
    from edge e
    join contribution ec on ec.id = e.contribution_id
    join contribution tgt on tgt.id = e.dst
    where ec.status = 'active' and e.rel = any (settle_rels)
      and tgt.kind in ('problem', 'conjecture')
      and (ids is null or e.src = any (ids))
    group by e.src
  )
  update contribution c
     set notability = round((b.own + coalesce(i.s, 0) + coalesce(s.s, 0))::numeric, 3)
    from base b
    left join incoming i on i.id = b.id
    left join settles s on s.id = b.id
   where c.id = b.id;
end $$;

drop view if exists contribution_overview;
create view contribution_overview as
select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.identity_id,
       c.artifact_hash, c.metadata, c.notability, c.tags, c.names, c.created_at, c.updated_at, c.search,
       exists (select 1 from verification v
               where v.contribution_id = c.id
                 and v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified
from contribution c;

\ir tuning-defaults.sql

-- Reclassify the whole corpus through the DB classifier so every tag comes
-- from one engine (submit-time tagging uses the same function).
update contribution c
   set tags = classify_topics(c.title || ' ' || c.summary || ' ' || left(a.content, 2000))
  from artifact a
 where a.hash = c.artifact_hash and c.kind <> 'edge';

select refresh_notability();

commit;
