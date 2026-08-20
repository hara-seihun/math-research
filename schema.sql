-- math-research: open contribution network for mathematics.
--
-- Two layers of truth:
--   * `event` is the append-only ledger. Every state change is an event.
--   * `contribution` (+ friends) is the materialized current state, always
--     rebuildable by folding `event` from the beginning.
--
-- Everything is a contribution on one ladder. A theorem is a contribution; so
-- is a problem, a refactor proposal, a review — and so is an *edge*. A link
-- between two contributions is itself a contribution (kind='edge') with its
-- own author, model/operator metadata, and tier. That means the graph climbs
-- the same T0..T3 review ladder as the mathematics: a freshly asserted link is
-- a T0 edge, a trusted-reviewed link is a T2 edge, and importance is measured
-- from edges weighted by their own tier.
--
-- Nothing is ever deleted. Retraction, supersession, and tier changes are
-- appended events reflected into the materialized rows.

create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists vector;

-- Contributor identities. An identity is the SHA-256 of a contributor key
-- that only the contributor holds; the server never stores the key itself,
-- so an identity cannot be stolen from us. Optionally an identity registers
-- an Ed25519 public key so contributors can produce independently
-- verifiable authorship signatures.
--
-- Identity is never a toll. Reading needs nothing, contributing needs
-- nothing (unattributed work is recorded with identity_id null), and an
-- identity materializes only when someone actually claims authorship — by
-- presenting a key, by authorizing over OAuth, or by contributing over an
-- MCP session, which mints one key and hands it back exactly once.
--
-- `role` is the trust ladder. Anyone may submit (everything lands at T0).
-- Only a *trusted* identity (role 'trusted' or 'operator') may move anything
-- along the review ladder; 'operator' additionally administers trust and the
-- server itself. To start, exactly one identity is an operator and there are
-- no other trusted identities — trust expands later by granting the role.
create table if not exists identity (
  id           text primary key,          -- sha256(contributor_key), hex
  display_name text,
  public_key   text,                      -- optional Ed25519 public key, base64
  role         text not null default 'contributor'
               check (role in ('contributor', 'trusted', 'operator')),
  created_at   timestamptz not null default now()
);

-- Content-addressed immutable artifacts. All submission bodies live here.
create table if not exists artifact (
  hash       text primary key,            -- sha256(content), hex
  media_type text not null default 'text/markdown',
  content    text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now(),
  search     tsvector generated always as (to_tsvector('english', left(content, 200000))) stored
);
create index if not exists artifact_search_idx on artifact using gin (search);

-- The append-only event ledger.
create table if not exists event (
  seq             bigserial primary key,
  kind            text not null,          -- submitted | verification | tier-changed | retracted | superseded | refactor-applied | refactor-rejected | flagged | identity-updated | imported | role-granted
  contribution_id uuid,
  identity_id     text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists event_contribution_idx on event (contribution_id, seq);
create index if not exists event_identity_idx on event (identity_id, seq);

create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'the event ledger is append-only';
end $$;
drop trigger if exists event_append_only on event;
create trigger event_append_only
  before update or delete on event
  for each row execute function forbid_mutation();

-- Materialized current state of every contribution.
--
-- `kind` is deliberately free text with a suggested vocabulary (problem,
-- conjecture, theorem, proof, definition, theory, tool, computation,
-- counterexample, refactor, exposition, review, result, edge, other).
-- Mathematics does not fit a closed enum and we would rather see a new kind
-- than a shoehorned one.
--
-- Evidence tiers — an editorial ladder, climbed only by trusted review:
--   0 recorded   submitted; visible and searchable immediately
--   1 triaged    a trusted reviewer confirmed it is actual mathematics —
--                well-formed, not spam or noise
--   2 canon      a trusted reviewer confirmed the math and any artifacts are
--                coherent; accepted as canon
--   3 published  accepted by a journal or equivalent external venue
--
-- Machine verification (e.g. a Lean kernel check) is deliberately NOT a
-- tier: it is an independent property, recorded in `verification` and
-- surfaced as `lean_verified`. A kernel-checked proof of a vacuous or
-- mis-formalized statement stays at whatever tier review has earned it.
--
-- `state` is where a *work item* stands, which is a different question from
-- `status` (is this entry live?) and from `tier` (how far has review got?).
-- A problem is 'open', 'settled' (something active answers it), or 'retired';
-- a route is 'open' | 'partial' | 'blocked' | 'refuted' | 'closed'. Anything
-- that is not a work item has no state, and null means exactly that. Problem
-- state is derived from the graph by refresh_state and never hand-set, so
-- "which cells of this classification are still open?" is answerable from the
-- same edges that record the mathematics.
--
-- `notability` is a derived importance score (see refresh_notability): a
-- contribution's own tier/kind/verification plus how much the rest of the
-- graph builds on it, weighted by each incoming edge's own tier. It is the
-- gradient that ordering and highlights read from; never hand-set.
create table if not exists contribution (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null,
  title             text not null,
  summary           text not null,
  artifact_hash     text not null references artifact(hash),
  metadata          jsonb not null default '{}'::jsonb,
  identity_id       text references identity(id),   -- null = contributed anonymously
  tier              smallint not null default 0 check (tier between 0 and 3),
  status            text not null default 'active'
                    check (status in ('active', 'retracted', 'superseded')),
  notability        real not null default 0,
  state             text,                           -- work-item lifecycle; null when not a work item
  tags              text[] not null default '{}',  -- derived subject facet (see topics.ts)
  names             text[] not null default '{}',  -- canonical names/aliases for resolve
  embedding         vector(384),                    -- semantic vector (bge-small); see server/embedder/
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector generated always as
                    (to_tsvector('english', title || ' ' || summary)) stored
);
create index if not exists contribution_search_idx on contribution using gin (search);
create index if not exists contribution_trgm_idx on contribution using gin ((title || ' ' || summary) gin_trgm_ops);
create index if not exists contribution_kind_idx on contribution (kind, status, tier);
create index if not exists contribution_notability_idx on contribution (status, notability desc);
create index if not exists contribution_tags_idx on contribution using gin (tags);
create index if not exists contribution_names_idx on contribution using gin (names);
create index if not exists contribution_embedding_idx on contribution using hnsw (embedding vector_cosine_ops);
create index if not exists contribution_identity_idx on contribution (identity_id, created_at);
create index if not exists contribution_artifact_idx on contribution (artifact_hash);
alter table contribution add column if not exists state text;
create index if not exists contribution_state_idx on contribution (kind, state, notability desc);
-- Migrated work keeps the predecessor's identifier in metadata.import_key, and
-- the importer reconciles by it on every run.
create unique index if not exists contribution_import_key_idx
  on contribution ((metadata->>'import_key')) where metadata ? 'import_key';

-- A typed relation between two contributions. The edge *is* a contribution
-- (kind='edge'); this table is its structural sidecar, so traversal and
-- notability can join to the edge's own tier/status/author. Suggested rel
-- vocabulary: depends-on, uses, proves, disproves, answers, refines,
-- generalizes, specializes, refactors, supersedes, duplicates, reviews,
-- about, repairs. Multiple identities may assert the same (src,dst,rel);
-- each is its own contribution and the strongest active one wins in the graph.
create table if not exists edge (
  contribution_id uuid primary key references contribution(id),
  src             uuid not null references contribution(id),
  dst             uuid not null references contribution(id),
  rel             text not null,
  created_at      timestamptz not null default now()
);
create index if not exists edge_src_idx on edge (src, rel);
create index if not exists edge_dst_idx on edge (dst, rel);

-- Exploration trails: append-only diaries agents keep while investigating.
-- Purely advisory — a trail never grants ownership and never blocks anyone.
create table if not exists trail (
  id          uuid primary key default gen_random_uuid(),
  identity_id text not null references identity(id),
  title       text not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  search      tsvector generated always as (to_tsvector('english', title)) stored
);
alter table trail add column if not exists metadata jsonb not null default '{}'::jsonb;
create unique index if not exists trail_import_key_idx
  on trail ((metadata->>'import_key')) where metadata ? 'import_key';
create index if not exists trail_search_idx on trail using gin (search);
create index if not exists trail_status_idx on trail (status, updated_at);

create table if not exists trail_entry (
  id               bigserial primary key,
  trail_id         uuid not null references trail(id),
  note             text not null,
  contribution_ids uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  search           tsvector generated always as (to_tsvector('english', note)) stored
);
create index if not exists trail_entry_trail_idx on trail_entry (trail_id, id);
create index if not exists trail_entry_search_idx on trail_entry using gin (search);
create index if not exists trail_entry_contributions_idx on trail_entry using gin (contribution_ids);

-- Machine and review verification records. `method` vocabulary:
-- lean-kernel, exact-certificate, reproduction, review, imported.
create table if not exists verification (
  id              bigserial primary key,
  contribution_id uuid not null references contribution(id),
  method          text not null,
  outcome         text not null default 'pending'
                  check (outcome in ('pending', 'passed', 'failed', 'inconclusive', 'unavailable')),
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists verification_pending_idx on verification (method, outcome, id);
create index if not exists verification_contribution_idx on verification (contribution_id);

-- Kernel checks, content-addressed. A check is a pure function of (source,
-- pinned toolchain), so the same lemma checked by forty agents costs one
-- kernel run. Both callers share this table: the `check_lean` tool, which
-- creates nothing else, and contribution verification, whose `verification`
-- row records the judgement made from these facts. Rows are the raw facts —
-- what compiled, what was proven, which axioms it rests on — never a verdict.
create table if not exists lean_check (
  source_hash text primary key,          -- sha256(extracted source)
  source      text not null,
  outcome     text not null default 'pending'
              check (outcome in ('pending', 'passed', 'failed', 'inconclusive')),
  detail      jsonb not null default '{}'::jsonb,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists lean_check_pending_idx on lean_check (created_at) where outcome = 'pending';

-- Kernel checks, content-addressed. A check is a pure function of (source,
-- pinned toolchain), so the same lemma checked by forty agents costs one
-- kernel run. Both callers share this table: the `check_lean` tool, which
-- creates nothing else, and contribution verification, whose `verification`
-- row records the judgement made from these facts. Rows are the raw facts —
-- what compiled, what was proven, which axioms it rests on — never a verdict.
create table lean_check (
  source_hash text primary key,          -- sha256(extracted source)
  source      text not null,
  outcome     text not null default 'pending'
              check (outcome in ('pending', 'passed', 'failed', 'inconclusive')),
  detail      jsonb not null default '{}'::jsonb,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index lean_check_pending_idx on lean_check (created_at) where outcome = 'pending';

-- Server-signed submission receipts: an Ed25519 signature over the canonical
-- receipt payload, so a contributor can prove to anyone that this server
-- accepted exactly this artifact from exactly this identity at this time.
create table if not exists receipt (
  contribution_id  uuid primary key references contribution(id),
  payload          jsonb not null,
  server_signature text not null
);

-- ——— Transport identity ———————————————————————————————————————————————
-- Three ways to be someone, none of them required. A session is the zero
-- setup path: the server issues an Mcp-Session-Id at initialize, and the
-- first contribution over that connection mints one identity that the whole
-- session then shares. OAuth is the durable path for clients that speak it
-- (there is nothing to log into — authorizing mints or adopts an identity).
-- A contributor key presented as a bearer token or a tool argument always
-- wins over both.

create table if not exists mcp_session (
  id           text primary key,
  identity_id  text references identity(id),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists mcp_session_last_seen_idx on mcp_session (last_seen_at);

create table if not exists oauth_client (
  id            text primary key,
  secret_hash   text,                    -- sha256(client_secret), confidential clients only
  name          text,
  redirect_uris text[] not null default '{}',
  identity_id   text references identity(id),   -- client_credentials: the machine's own identity
  created_at    timestamptz not null default now()
);

create table if not exists oauth_code (
  code_hash      text primary key,
  client_id      text not null references oauth_client(id),
  identity_id    text not null references identity(id),
  redirect_uri   text not null,
  code_challenge text not null,           -- PKCE S256 only
  expires_at     timestamptz not null
);

-- Access tokens do not expire: an identity is a credential you hold, not a
-- session someone grants you. Revocation is deleting the row.
create table if not exists oauth_token (
  token_hash   text primary key,          -- sha256(access_token)
  identity_id  text not null references identity(id),
  client_id    text references oauth_client(id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists oauth_token_identity_idx on oauth_token (identity_id);

-- Full request log for post-hoc heuristic scanning. Bodies over 8 KiB are
-- replaced by their hash (the artifact table has the content anyway).
create table if not exists request_log (
  id          bigserial primary key,
  tool        text not null,
  identity_id text,
  args        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists request_log_identity_idx on request_log (identity_id, id);

-- The one public shape of a contribution, including the derived lean_verified
-- property, so no query re-derives it ad hoc.
create or replace view contribution_overview as
select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.identity_id,
       c.artifact_hash, c.metadata, c.notability, c.tags, c.names, c.created_at, c.updated_at, c.search,
       exists (select 1 from verification v
               where v.contribution_id = c.id
                 and v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified,
       c.state
from contribution c;

-- ——— Tunable policy ————————————————————————————————————————————————————
-- The notability weights and the topic taxonomy live in the database as data,
-- not in code, so a trusted operator can tune them live over the MCP
-- (set_tuning) instead of shipping a deploy. Defaults come from
-- tools/tuning-defaults.sql (one source, loaded below).
create table if not exists config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists topic_rule (
  topic   text primary key,
  pattern text not null,   -- POSIX (advanced) regex matched against lower(text)
  ord     integer not null default 100
);

-- Name folding, shared by every lookup door: unicode dashes to ascii, accents
-- stripped, lowercased. "de Bruijn–Newman" and "de bruijn-newman" are the same
-- name, and asking for an entry by the name written in its own summary works.
-- Everything this touches is schema-qualified: Postgres 17 runs CREATE INDEX
-- with a restricted search_path, so an unqualified dictionary name here fails
-- when the expression index below is built.
create or replace function normalize_ref(t text) returns text language sql immutable as $$
  select lower(public.unaccent('public.unaccent'::regdictionary,
                               pg_catalog.regexp_replace(coalesce(t, ''), '[‐-―−]', '-', 'g')))
$$;
create index if not exists contribution_ref_title_idx on contribution (normalize_ref(title));

-- Topic inheritance. A one-line extracted statement rarely names its own
-- field, but the write-up it came from does, and a classification cell's
-- programme does. Rather than leave half the corpus unbrowsable by subject, a
-- child with no topics of its own borrows its parent's. Idempotent, and it
-- never overwrites a classification the text earned itself.
create or replace function inherit_topics() returns bigint language plpgsql as $$
declare n bigint;
begin
  with parent as (
    select e.src as child, (array_agg(distinct t))[1:4] as tags
    from edge e
    join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
    join contribution p on p.id = e.dst and p.status = 'active'
    cross join lateral unnest(p.tags) as t
    where e.rel in ('part-of', 'in-front', 'answers', 'attacks')
    group by e.src
  )
  update contribution c set tags = parent.tags
  from parent where c.id = parent.child and cardinality(c.tags) = 0;
  get diagnostics n = row_count;
  return n;
end $$;

-- Subject classification, in one engine (Postgres regex) so submit-time
-- tagging and any reclassify agree exactly. Returns up to four topics.
create or replace function classify_topics(t text) returns text[] language sql stable as $$
  select coalesce(array_agg(topic order by ord), '{}')
  from (select topic, ord from topic_rule where lower($1) ~ pattern order by ord limit 4) x;
$$;

-- ——— Notability ———————————————————————————————————————————————————————
-- Importance is derived, never hand-set. A contribution scores for what it is
-- (kind, tier, kernel-verification), for how much the graph builds on it
-- (incoming edges, each weighted by that edge's own review tier so an
-- unreviewed T0 link barely counts and a trusted T2 link counts fully), and
-- for settling known questions. Every weight is read from config at run time.
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
  -- Damped, because incoming weight spans four orders of magnitude: a hub
  -- problem carries thousands of supporting edges and a fresh theorem carries
  -- two, and without damping the hub's pull is the only thing any ordering can
  -- see. ln keeps the ranking but puts every kind on one comparable scale.
  incoming as (
    select e.dst as id,
           coalesce((w->>'edge_scale')::real, 2.0)
             * ln(1 + sum(coalesce((w->'rel'->>e.rel)::real, (w->'rel'->>'_default')::real, 0.5)
                          * coalesce((w->'edge_tier'->>ec.tier::text)::real, 0.0))) as s
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
     set notability = round(greatest(b.own + coalesce(i.s, 0) + coalesce(s.s, 0), 0)::numeric, 3)
    from base b
    left join incoming i on i.id = b.id
    left join settles s on s.id = b.id
   where c.id = b.id;
end $$;

-- ——— Work-item state ———————————————————————————————————————————————————
-- A question is settled when something active in the graph answers it. That
-- is a fact about the edges, so it is derived here rather than declared, and
-- it stays true when a later answer arrives or a link is retracted. Routes
-- and other work items carry a state their author set; this only ever touches
-- question kinds.
create or replace function refresh_state(ids uuid[] default null) returns void language plpgsql as $$
begin
  update contribution c
     set state = case
           when c.status <> 'active' then 'retired'
           when exists (
             select 1 from edge e
             join contribution ec on ec.id = e.contribution_id
             join contribution src on src.id = e.src
             where e.dst = c.id and ec.status = 'active' and src.status = 'active'
               and e.rel in ('answers', 'proves', 'disproves', 'refutes', 'resolves')
           ) then 'settled'
           else 'open' end
   where c.kind in ('problem', 'conjecture')
     and (ids is null or c.id = any (ids));
end $$;

\ir tools/tuning-defaults.sql
