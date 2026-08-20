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
create table identity (
  id           text primary key,          -- sha256(contributor_key), hex
  display_name text,
  public_key   text,                      -- optional Ed25519 public key, base64
  role         text not null default 'contributor'
               check (role in ('contributor', 'trusted', 'operator')),
  created_at   timestamptz not null default now()
);

-- Content-addressed immutable artifacts. All submission bodies live here.
create table artifact (
  hash       text primary key,            -- sha256(content), hex
  media_type text not null default 'text/markdown',
  content    text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now(),
  search     tsvector generated always as (to_tsvector('english', left(content, 200000))) stored
);
create index artifact_search_idx on artifact using gin (search);

-- The append-only event ledger.
create table event (
  seq             bigserial primary key,
  kind            text not null,          -- submitted | verification | tier-changed | retracted | superseded | refactor-applied | refactor-rejected | flagged | identity-updated | imported | role-granted
  contribution_id uuid,
  identity_id     text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index event_contribution_idx on event (contribution_id, seq);
create index event_identity_idx on event (identity_id, seq);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'the event ledger is append-only';
end $$;
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
-- `notability` is a derived importance score (see refresh_notability): a
-- contribution's own tier/kind/verification plus how much the rest of the
-- graph builds on it, weighted by each incoming edge's own tier. It is the
-- gradient that ordering and highlights read from; never hand-set.
create table contribution (
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
  tags              text[] not null default '{}',  -- derived subject facet (see topics.ts)
  names             text[] not null default '{}',  -- canonical names/aliases for resolve
  embedding         vector(384),                    -- semantic vector (bge-small); see server/embedder/
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector generated always as
                    (to_tsvector('english', title || ' ' || summary)) stored
);
create index contribution_search_idx on contribution using gin (search);
create index contribution_trgm_idx on contribution using gin ((title || ' ' || summary) gin_trgm_ops);
create index contribution_kind_idx on contribution (kind, status, tier);
create index contribution_notability_idx on contribution (status, notability desc);
create index contribution_tags_idx on contribution using gin (tags);
create index contribution_names_idx on contribution using gin (names);
create index contribution_embedding_idx on contribution using hnsw (embedding vector_cosine_ops);
create index contribution_identity_idx on contribution (identity_id, created_at);
create index contribution_artifact_idx on contribution (artifact_hash);

-- A typed relation between two contributions. The edge *is* a contribution
-- (kind='edge'); this table is its structural sidecar, so traversal and
-- notability can join to the edge's own tier/status/author. Suggested rel
-- vocabulary: depends-on, uses, proves, disproves, answers, refines,
-- generalizes, specializes, refactors, supersedes, duplicates, reviews,
-- about, repairs. Multiple identities may assert the same (src,dst,rel);
-- each is its own contribution and the strongest active one wins in the graph.
create table edge (
  contribution_id uuid primary key references contribution(id),
  src             uuid not null references contribution(id),
  dst             uuid not null references contribution(id),
  rel             text not null,
  created_at      timestamptz not null default now()
);
create index edge_src_idx on edge (src, rel);
create index edge_dst_idx on edge (dst, rel);

-- Exploration trails: append-only diaries agents keep while investigating.
-- Purely advisory — a trail never grants ownership and never blocks anyone.
create table trail (
  id          uuid primary key default gen_random_uuid(),
  identity_id text not null references identity(id),
  title       text not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  search      tsvector generated always as (to_tsvector('english', title)) stored
);
create index trail_search_idx on trail using gin (search);
create index trail_status_idx on trail (status, updated_at);

create table trail_entry (
  id               bigserial primary key,
  trail_id         uuid not null references trail(id),
  note             text not null,
  contribution_ids uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  search           tsvector generated always as (to_tsvector('english', note)) stored
);
create index trail_entry_trail_idx on trail_entry (trail_id, id);
create index trail_entry_search_idx on trail_entry using gin (search);
create index trail_entry_contributions_idx on trail_entry using gin (contribution_ids);

-- Machine and review verification records. `method` vocabulary:
-- lean-kernel, exact-certificate, reproduction, review, imported.
create table verification (
  id              bigserial primary key,
  contribution_id uuid not null references contribution(id),
  method          text not null,
  outcome         text not null default 'pending'
                  check (outcome in ('pending', 'passed', 'failed', 'inconclusive', 'unavailable')),
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index verification_pending_idx on verification (method, outcome, id);
create index verification_contribution_idx on verification (contribution_id);

-- Server-signed submission receipts: an Ed25519 signature over the canonical
-- receipt payload, so a contributor can prove to anyone that this server
-- accepted exactly this artifact from exactly this identity at this time.
create table receipt (
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

create table mcp_session (
  id           text primary key,
  identity_id  text references identity(id),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index mcp_session_last_seen_idx on mcp_session (last_seen_at);

create table oauth_client (
  id            text primary key,
  secret_hash   text,                    -- sha256(client_secret), confidential clients only
  name          text,
  redirect_uris text[] not null default '{}',
  identity_id   text references identity(id),   -- client_credentials: the machine's own identity
  created_at    timestamptz not null default now()
);

create table oauth_code (
  code_hash      text primary key,
  client_id      text not null references oauth_client(id),
  identity_id    text not null references identity(id),
  redirect_uri   text not null,
  code_challenge text not null,           -- PKCE S256 only
  expires_at     timestamptz not null
);

-- Access tokens do not expire: an identity is a credential you hold, not a
-- session someone grants you. Revocation is deleting the row.
create table oauth_token (
  token_hash   text primary key,          -- sha256(access_token)
  identity_id  text not null references identity(id),
  client_id    text references oauth_client(id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index oauth_token_identity_idx on oauth_token (identity_id);

-- Full request log for post-hoc heuristic scanning. Bodies over 8 KiB are
-- replaced by their hash (the artifact table has the content anyway).
create table request_log (
  id          bigserial primary key,
  tool        text not null,
  identity_id text,
  args        jsonb,
  created_at  timestamptz not null default now()
);
create index request_log_identity_idx on request_log (identity_id, id);

-- The one public shape of a contribution, including the derived lean_verified
-- property, so no query re-derives it ad hoc.
create view contribution_overview as
select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.identity_id,
       c.artifact_hash, c.metadata, c.notability, c.tags, c.names, c.created_at, c.updated_at, c.search,
       exists (select 1 from verification v
               where v.contribution_id = c.id
                 and v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified
from contribution c;

-- ——— Tunable policy ————————————————————————————————————————————————————
-- The notability weights and the topic taxonomy live in the database as data,
-- not in code, so a trusted operator can tune them live over the MCP
-- (set_tuning) instead of shipping a deploy. Defaults come from
-- tools/tuning-defaults.sql (one source, loaded below).
create table config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table topic_rule (
  topic   text primary key,
  pattern text not null,   -- POSIX (advanced) regex matched against lower(text)
  ord     integer not null default 100
);

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

\ir tools/tuning-defaults.sql
