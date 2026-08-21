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
--
-- Bodies are searched through `contribution.search`, which carries the body
-- text at weight D alongside title/summary at weight A. A tsvector here too
-- would be unreachable: a search predicate that ORs a column of this table
-- against a column of `contribution` spans two tables, which no index can
-- satisfy, so the planner hash-joins the whole corpus and filters. That plan
-- was measured at 1.06 s and 1.3 GB of buffer traffic per query.
create table if not exists artifact (
  hash       text primary key,            -- sha256(content), hex
  media_type text not null default 'text/markdown',
  content    text not null,
  size_bytes integer not null,
  created_at timestamptz not null default now()
);
drop index if exists artifact_search_idx;
alter table artifact drop column if exists search;

-- The append-only event ledger.
create table if not exists event (
  seq             bigserial primary key,
  kind            text not null,          -- submitted | verification | tier-changed | retracted | superseded | refactor-applied | refactor-rejected | amendment-applied | amendment-rejected | flagged | identity-updated | imported | role-granted
  contribution_id uuid,
  identity_id     text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists event_contribution_idx on event (contribution_id, seq);
create index if not exists event_identity_idx on event (identity_id, seq);
-- news({since}) resolves a clock time to a sequence number. Without this the
-- planner walks the ledger backwards from the head filtering every row it
-- passes, so the cost of asking for "the last 6 hours" grows with the age of
-- the corpus rather than the size of the answer.
create index if not exists event_created_at_idx on event (created_at, seq);
-- Every panel of a news packet asks the same shape of question: one kind of
-- event, inside one window of the ledger. Indexed the other way round from
-- the sequence alone, each panel was a parallel scan of the whole ledger.
create index if not exists event_kind_seq_idx on event (kind, seq desc);

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
  -- The whole searchable document, title/summary at weight A and the artifact
  -- body at weight D, so one index answers "does this entry match?" and one
  -- ts_rank ranks a title hit above a body hit. Maintained by trigger rather
  -- than GENERATED because it reads the artifact row.
  search            tsvector,
  -- names as normalize_ref folds them, so resolving an entry by an alias is
  -- an index lookup instead of an unnest per row: `names_norm` for the exact
  -- lookup, the same names joined for the trigram one.
  names_norm        text[] not null default '{}',
  names_text        text not null default '',
  -- Derived from `verification`, kept by trigger. As a subquery in the public
  -- view this was re-evaluated per row on every read path, sometimes hoisted
  -- by the planner and sometimes not (5.9 ms vs 96 ms for one count).
  lean_verified     boolean not null default false
);
alter table contribution add column if not exists state text;
alter table contribution add column if not exists names_norm text[] not null default '{}';
alter table contribution add column if not exists names_text text not null default '';
alter table contribution add column if not exists lean_verified boolean not null default false;
alter table contribution alter column search drop expression if exists;

-- Everything derived from a contribution's own columns, in one place, so the
-- search document and the folded names cannot drift from the row they
-- describe. The artifact is content-addressed and immutable, so the body only
-- has to be re-read when the hash changes.
create or replace function contribution_search_doc(p_title text, p_summary text, p_hash text)
  returns tsvector language sql stable as $$
  select setweight(to_tsvector('english', coalesce(p_title, '') || ' ' || coalesce(p_summary, '')), 'A')
      || setweight(to_tsvector('english',
           left(coalesce((select a.content from artifact a where a.hash = p_hash), ''), 200000)), 'D')
$$;

create or replace function contribution_derived() returns trigger language plpgsql as $$
begin
  new.search := contribution_search_doc(new.title, new.summary, new.artifact_hash);
  new.names_norm := coalesce(array(select normalize_ref(n) from unnest(new.names) n), '{}');
  new.names_text := coalesce(array_to_string(new.names_norm, ' | '), '');
  return new;
end $$;
drop trigger if exists contribution_derived_trg on contribution;
create trigger contribution_derived_trg
  before insert or update of title, summary, artifact_hash, names on contribution
  for each row execute function contribution_derived();

create index if not exists contribution_search_idx on contribution using gin (search);
-- Titles, lowered, because that is exactly what search's fuzzy fallback asks
-- for. The index this replaces covered `title || ' ' || summary` without the
-- lower() the server actually wrote, so it matched no query ever issued: 159
-- MB carrying zero lifetime scans while every text search sequentially
-- scanned the corpus. Over the summary too it is worse than useless even when
-- it does match — trigram similarity across a whole summary nominates a
-- quarter of the corpus and rechecks every candidate, 2.1 s to return two
-- rows. A misspelling is a misremembered name, so titles are the surface
-- worth searching that way.
drop index if exists contribution_trgm_idx;
create index if not exists contribution_title_trgm_idx
  on contribution using gin (lower(title) gin_trgm_ops);
create index if not exists contribution_kind_idx on contribution (kind, status, tier);
create index if not exists contribution_notability_idx on contribution (status, notability desc);
create index if not exists contribution_tags_idx on contribution using gin (tags);
create index if not exists contribution_names_norm_idx on contribution using gin (names_norm);
create index if not exists contribution_names_trgm_idx on contribution using gin (names_text gin_trgm_ops);
drop index if exists contribution_names_idx;
create index if not exists contribution_embedding_idx on contribution using hnsw (embedding vector_cosine_ops);
create index if not exists contribution_identity_idx on contribution (identity_id, created_at);
create index if not exists contribution_artifact_idx on contribution (artifact_hash);
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
-- No door searches trail prose: `trails` browses by recency, by trail id, and
-- by the entries a trail touches. These indexed a full-text search that does
-- not exist, and every trail write paid to maintain them. If trail search is
-- wanted later it is these two lines back, and the tsvector columns are still
-- here to build it from.
drop index if exists trail_search_idx;
drop index if exists trail_entry_search_idx;
create unique index if not exists trail_import_key_idx
  on trail ((metadata->>'import_key')) where metadata ? 'import_key';

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
-- Reached with the array-overlap operator, which is what `trails` and the
-- "who else is here" panel of get/frontier ask with. Asked as `unnest(...)
-- where c = any(...)` instead, no index applies and every lookup unnests
-- every trail entry in the table.
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

-- `contribution.lean_verified` is this table's projection onto the row every
-- read path already touches. Derived here rather than by the verifier, so the
-- fact and its cache cannot disagree no matter who writes the verification.
create or replace function sync_lean_verified() returns trigger language plpgsql as $$
declare
  cid uuid := coalesce(new.contribution_id, old.contribution_id);
  now_verified boolean;
begin
  select exists (select 1 from verification v
                 where v.contribution_id = cid
                   and v.method = 'lean-kernel' and v.outcome = 'passed')
    into now_verified;
  update contribution set lean_verified = now_verified
   where id = cid and lean_verified is distinct from now_verified;
  return null;
end $$;
drop trigger if exists verification_lean_verified on verification;
create trigger verification_lean_verified
  after insert or update or delete on verification
  for each row execute function sync_lean_verified();

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
       c.lean_verified, c.state
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
-- for settling known questions. Settlement credit is also weighted by the
-- settling edge's tier: asserting an answer at T0 cannot earn the same credit
-- as a reviewed connection. Parallel assertions of one (src,dst,rel) reduce
-- to their strongest active edge, matching the graph's traversal semantics.
-- Every weight is read from config at run time.
create or replace function refresh_notability(ids uuid[] default null) returns void language plpgsql as $$
declare
  w jsonb;
  settle_rels text[];
begin
  -- Lock ordering. Two refreshes running at once update overlapping rows in
  -- whatever order the planner picked, take row locks in opposite orders, and
  -- deadlock — seen live as "deadlock detected" on a burst of promotions. A
  -- scoped refresh therefore claims its rows up front in ascending id order,
  -- which every transaction agrees on; a whole-table refresh is short and rare
  -- enough to simply serialize.
  if ids is null then
    perform pg_advisory_xact_lock(hashtext('refresh_notability'));
  else
    -- Shared scoped refreshes may proceed together; a whole-table refresh
    -- takes the exclusive form above and waits for all of them. Row ordering
    -- alone cannot prevent a deadlock between a live scoped write and a full
    -- tuning refresh (observed on the first live calibration).
    perform pg_advisory_xact_lock_shared(hashtext('refresh_notability'));
    perform 1 from contribution where id = any (ids) order by id for no key update;
  end if;
  select value into w from config where key = 'notability_weights';
  if w is null then w := '{}'::jsonb; end if;
  settle_rels := array(select jsonb_array_elements_text(
    coalesce(w->'settle_rels', '["answers","proves","disproves","refutes","resolves"]'::jsonb)));

  with base as (
    select c.id,
           coalesce((w->'kind'->>c.kind)::real, (w->'kind'->>'_default')::real, 1.0)
             + coalesce((w->'tier'->>c.tier::text)::real, 0.0)
             + case when c.lean_verified then coalesce((w->>'lean')::real, 0.75) else 0.0 end as own
    from contribution c
    where c.kind <> 'edge' and (ids is null or c.id = any (ids))
  ),
  strongest_edges as (
    select distinct on (e.src, e.dst, e.rel) e.src, e.dst, e.rel, ec.tier
    from edge e
    join contribution ec on ec.id = e.contribution_id
    where ec.status = 'active'
      and (ids is null or e.src = any (ids) or e.dst = any (ids))
    order by e.src, e.dst, e.rel, ec.tier desc, e.created_at desc, e.contribution_id desc
  ),
  -- Damped, because incoming weight spans four orders of magnitude: a hub
  -- problem carries thousands of supporting edges and a fresh theorem carries
  -- two, and without damping the hub's pull is the only thing any ordering can
  -- see. ln keeps the ranking but puts every kind on one comparable scale.
  incoming as (
    select e.dst as id,
           coalesce((w->>'edge_scale')::real, 2.0)
             * ln(1 + sum(coalesce((w->'rel'->>e.rel)::real, (w->'rel'->>'_default')::real, 0.5)
                          * coalesce((w->'edge_tier'->>e.tier::text)::real, 0.0))) as s
    from strongest_edges e
    where ids is null or e.dst = any (ids)
    group by e.dst
  ),
  settles as (
    select e.src as id,
           sum(coalesce((w->'tier'->>tgt.tier::text)::real, 0.0)
               * coalesce((w->>'settle')::real, 0.5)
               * coalesce((w->'edge_tier'->>e.tier::text)::real, 0.0)) as s
    from strongest_edges e
    join contribution tgt on tgt.id = e.dst
    where e.rel = any (settle_rels)
      and tgt.kind in ('problem', 'conjecture') and tgt.status = 'active'
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
  if ids is null then
    perform pg_advisory_xact_lock(hashtext('refresh_state'));
  else
    perform pg_advisory_xact_lock_shared(hashtext('refresh_state'));
    perform 1 from contribution where id = any (ids) order by id for no key update;
  end if;
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

-- What one write can change: the entry itself, both ends of a link, and the
-- neighbours of an entry whose weight moved. Everything else in a 58k-row
-- table is unaffected, so a promotion or a retraction refreshes a handful of
-- rows instead of rewriting the corpus twice.
create or replace function refresh_around(ids uuid[]) returns void language plpgsql as $$
declare
  targets uuid[];
begin
  if ids is null or cardinality(ids) = 0 then return; end if;
  select array_agg(distinct t) into targets from (
    select unnest(ids) as t
    union select e.src from edge e where e.contribution_id = any (ids)
    union select e.dst from edge e where e.contribution_id = any (ids)
    union select e.dst from edge e where e.src = any (ids)
    union select e.src from edge e where e.dst = any (ids)
  ) x where t is not null;
  -- One ordered claim covers both refreshes; each also claims its own, which
  -- is a no-op once these locks are held.
  perform 1 from contribution where id = any (targets) order by id for no key update;
  perform refresh_state(targets);
  perform refresh_notability(targets);
end $$;

\ir tools/tuning-defaults.sql

-- ——— Query surface ——————————————————————————————————————————————————————
-- The `query` tool runs caller SQL against these views and nothing else: the
-- server switches to the math_reader role for the statement, and math_reader
-- can see only what is granted here. Base tables stay out of reach, which is
-- what keeps session keys, OAuth state, and the request log private. The
-- views execute with their owner's rights, so they must stay SELECTs over
-- public data.
create or replace view q_entries as
  select id, kind, title, summary, state, status, tier, notability, lean_verified,
         tags, names, identity_id, artifact_hash, metadata, created_at, updated_at
  from contribution_overview
  where kind <> 'edge';

create or replace view q_links as
  select ec.id as edge_id, e.src, e.dst, e.rel, ec.tier, ec.status,
         ec.identity_id, e.created_at as linked_at
  from edge e join contribution ec on ec.id = e.contribution_id;

create or replace view q_front_members as
  select e.dst as front_id, f.title as front_title, e.src as member_id,
         m.kind, m.title, m.state, m.tier, m.notability, e.created_at as joined_at
  from edge e
  join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
  join contribution f on f.id = e.dst
  join contribution_overview m on m.id = e.src
  where e.rel = 'in-front' and m.status = 'active';

create or replace view q_events as
  select seq, kind, contribution_id, identity_id, payload, created_at from event;

create or replace view q_verifications as
  select contribution_id, method, outcome, detail, created_at, updated_at from verification;

create or replace view q_artifacts as
  select hash, media_type, size_bytes, content, created_at from artifact;

create or replace view q_trails as
  select id, identity_id, title, status, created_at, updated_at from trail;

create or replace view q_trail_entries as
  select trail_id, note, contribution_ids, created_at from trail_entry;

create or replace view q_identities as
  select id, display_name, role, created_at from identity;

create or replace view q_config as select key, value, updated_at from config;
create or replace view q_topic_rules as select topic, pattern, ord from topic_rule;

-- Asked for by name rather than attempted-and-caught: Postgres checks the
-- privilege to create a role before it checks whether the role is already
-- there, so `exception when duplicate_object` never fires for a non-superuser
-- re-applying this file. It raised insufficient_privilege instead and took the
-- whole migration with it.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'math_reader') then
    create role math_reader nologin;
  end if;
end $$;
grant usage on schema public to math_reader;
grant select on q_entries, q_links, q_front_members, q_events, q_verifications,
                q_artifacts, q_trails, q_trail_entries, q_identities, q_config,
                q_topic_rules to math_reader;
-- The server's own connection switches into this role per query statement.
-- Conditional for the same reason as the role itself: granting membership a
-- second time needs ADMIN on the role, which the owning user does not have,
-- so an unconditional grant makes this file apply exactly once.
do $$ begin
  if not pg_has_role(current_user, 'math_reader', 'member') then
    execute format('grant math_reader to %I', current_user);
  end if;
end $$;

-- ——— Derived-column backfill ————————————————————————————————————————————
-- Rows written before `search` carried the artifact body, before names were
-- folded, and before lean_verified was a column need one pass to catch up.
-- Touching `title` is what fires contribution_derived, so the three land
-- together. Guarded by a marker rather than by inspecting the data, because
-- this file is re-applied on every schema change and a 146k-row rewrite is
-- not something to repeat for nothing.
do $$ begin
  if not exists (select 1 from config where key = 'derived_columns_backfilled') then
    update contribution c set title = c.title;
    insert into config (key, value) values ('derived_columns_backfilled', to_jsonb(now()))
      on conflict (key) do nothing;
  end if;
end $$;

-- Reconcile lean_verified with the table it summarises. Deliberately not
-- guarded by the marker above, and deliberately not part of that pass: the
-- backfill takes minutes on a corpus this size, the verifier keeps working
-- throughout, and a verification that lands mid-pass fires the trigger only
-- for the bulk UPDATE to overwrite it with the value it read at snapshot
-- time. That is an ordinary lost update, it left five rows disagreeing on the
-- first run, and no amount of care in the backfill removes it while there is
-- a concurrent writer.
--
-- So this runs every time and repairs whatever drifted, from that race or any
-- future one. It is cheap because it only considers rows that carry a Lean
-- verification or claim to, and only writes the ones that actually disagree.
update contribution c
   set lean_verified = t.truth
  from (select c2.id,
               exists (select 1 from verification v
                       where v.contribution_id = c2.id
                         and v.method = 'lean-kernel' and v.outcome = 'passed') as truth
        from contribution c2
        where c2.lean_verified
           or exists (select 1 from verification v where v.contribution_id = c2.id
                                                    and v.method = 'lean-kernel')) t
 where c.id = t.id and c.lean_verified is distinct from t.truth;

analyze contribution;
