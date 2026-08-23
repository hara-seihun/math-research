-- math-research: open contribution network for mathematics.
--
-- Two layers of truth:
--   * `event` is the append-only ledger. Every state change is an event.
--   * `contribution` (+ friends) is the materialized current state, always
--     rebuildable by folding `event` from the beginning.
--
-- Everything is a contribution on one ladder. A theorem is a contribution; so
-- is a problem, a refactor proposal, a review, and so is an *edge*. A link
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
-- identity materializes only when someone actually claims authorship, whether by
-- presenting a key, by authorizing over OAuth, or by contributing over an
-- MCP session, which mints one key and hands it back exactly once.
--
-- `role` is the trust ladder. Anyone may submit (everything lands at T0).
-- Only a *trusted* identity (role 'trusted' or 'operator') may move anything
-- along the review ladder; 'operator' additionally administers trust and the
-- server itself. To start, exactly one identity is an operator and there are
-- no other trusted identities. Trust expands later by granting the role.
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
  kind            text not null,          -- submitted | verification | tier-changed | retracted | superseded | restored | refactor-applied | refactor-rejected | amendment-applied | amendment-rejected | impact-assessment-applied | impact-assessment-rejected | flagged | identity-updated | imported | role-granted
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
-- Evidence tiers, an editorial ladder climbed only by trusted review:
--   0 recorded   submitted; visible and searchable immediately
--   1 triaged    a trusted reviewer confirmed it is actual mathematics,
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
--
-- `origin` is priority, and it is a different question from tier, status and
-- state: was this entry's headline claim first established here, or was it
-- already established outside this ledger? 'external' means the second,
-- whether the claim was quoted from a paper, replayed, independently verified,
-- or rediscovered here after the fact, and `origin_source` must then name
-- what established it. Recording external mathematics is welcome and is what
-- makes a settled question legible; claiming it as ours is not, so the public
-- all-time board of settled questions reads this column. Using an external
-- result inside your own argument does not make your entry external: origin
-- describes the entry's own headline claim, not its bibliography.
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
                    check (status in ('active', 'retracted', 'superseded', 'rejected')),
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
  lean_verified     boolean not null default false,
  impact_reach      real,
  impact_advance    real,
  impact_closure    real,
  impact_assessments integer not null default 0,
  origin            text not null default 'ledger',   -- 'ledger' | 'external'
  origin_source     text,                             -- required when origin = 'external'
  -- When this entry reached the all-time board, null while it is off it. A
  -- transition time rather than a predicate: "what reached the board today"
  -- is not "what was submitted today and is on the board", because review
  -- certifies a week-old closure and the day it did so is the news. Derived
  -- by refresh_board and never hand-set.
  board_at          timestamptz
);
-- 'rejected' arrived after the first deployments, so the constraint is
-- rewritten rather than declared once. Re-appliable: drop by the name Postgres
-- gives an inline column check, then add the current spelling.
alter table contribution drop constraint if exists contribution_status_check;
alter table contribution add constraint contribution_status_check
  check (status in ('active', 'retracted', 'superseded', 'rejected'));

alter table contribution add column if not exists state text;
alter table contribution add column if not exists names_norm text[] not null default '{}';
alter table contribution add column if not exists names_text text not null default '';
alter table contribution add column if not exists lean_verified boolean not null default false;
alter table contribution add column if not exists impact_reach real;
alter table contribution add column if not exists impact_advance real;
alter table contribution add column if not exists impact_closure real;
alter table contribution add column if not exists impact_assessments integer not null default 0;
alter table contribution add column if not exists origin text not null default 'ledger';
alter table contribution add column if not exists origin_source text;
alter table contribution add column if not exists board_at timestamptz;
-- The board is the smallest population here and the most read, so it is an
-- index rather than a scan with a filter.
create index if not exists contribution_board_at_idx on contribution (board_at desc) where board_at is not null;
alter table contribution drop constraint if exists contribution_origin_check;
alter table contribution add constraint contribution_origin_check
  check (origin in ('ledger', 'external') and (origin = 'ledger' or origin_source is not null));
alter table contribution alter column search drop expression if exists;

-- A review is a judgement *about* mathematics, not a claim of its own, so it
-- is the one kind that carries no tier. The ladder records how far review has
-- got with a claim; a review has nothing to climb, and reviewing a review is a
-- regress the queue used to pay for. Reviews were tiered like everything else,
-- so every review was born at T0 and matched review_queue's `tier <= max_tier`
-- on the same terms as an unproved theorem -- and, being unreviewed, sorted
-- ahead of it. The lane's own output became the bulk of its own intake: in one
-- 92-minute wave on 2026-08-21, 63% of the entries adjudicated were reviews,
-- one entry was read 127 times, and 829 reviews existed that reviewed nothing
-- but other reviews. Those are deleted; this is why they cannot come back.
--
-- Null is the representation rather than a kind list in each query, so the
-- queue's own arithmetic excludes reviews: `null <= 1` is null, not true.
alter table contribution alter column tier drop not null;
update contribution set tier = null where kind = 'review' and tier is not null;
alter table contribution drop constraint if exists contribution_tier_check;
alter table contribution add constraint contribution_tier_check
  check ((tier is null) = (kind = 'review') and (tier is null or tier between 0 and 3));

-- Submitters do not choose a tier -- it is the column default -- so a review
-- arrives wanting the default and the default is wrong for exactly one kind.
-- Normalising it here keeps every insert path (submit, edges, imports, admin)
-- from having to remember. An *explicit* promotion is a different act: it is
-- the caller being wrong, and the check constraint above refuses it loudly.
create or replace function contribution_tier_rule() returns trigger language plpgsql as $$
begin
  if new.kind = 'review' then new.tier := null; end if;
  return new;
end $$;
drop trigger if exists contribution_tier_rule_trg on contribution;
create trigger contribution_tier_rule_trg
  before insert on contribution
  for each row execute function contribution_tier_rule();

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
-- it does match, since trigram similarity across a whole summary nominates a
-- quarter of the corpus and rechecks every candidate, 2.1 s to return two
-- rows. A misspelling is a misremembered name, so titles are the surface
-- worth searching that way.
drop index if exists contribution_trgm_idx;
create index if not exists contribution_title_trgm_idx
  on contribution using gin (lower(title) gin_trgm_ops);
create index if not exists contribution_kind_idx on contribution (kind, status, tier);
create index if not exists contribution_notability_idx on contribution (status, notability desc);
-- The reviewer worklist, which is the one read whose population is everything
-- *not* yet judged. Links are contributions too and there are tens of
-- thousands of unreviewed ones, so the queue's scan is the largest in the
-- server and the only one that gets slower the further review falls behind.
create index if not exists contribution_queue_idx
  on contribution (tier, notability desc, created_at) where status = 'active';
create index if not exists contribution_tags_idx on contribution using gin (tags);
create index if not exists contribution_names_norm_idx on contribution using gin (names_norm);
create index if not exists contribution_names_trgm_idx on contribution using gin (names_text gin_trgm_ops);
drop index if exists contribution_names_idx;
create index if not exists contribution_embedding_idx on contribution using hnsw (embedding vector_cosine_ops);
-- The default ef_search of 40 caps every vector query at roughly forty rows
-- however many were asked for, which quietly turned a 150-candidate
-- nomination into 39. Related and search both ask for more than that.
alter role current_user set hnsw.ef_search = 200;
create index if not exists contribution_identity_idx on contribution (identity_id, created_at);
create index if not exists contribution_artifact_idx on contribution (artifact_hash);

-- Content-addressed evidence blobs: certificates, receipts, pinned inputs,
-- archives. Bytes live on disk under FILE_ROOT/objects/<aa>/<hash>, uploaded
-- over HTTP (PUT /files/<sha256>) and served at GET /files/<hash>; this table
-- is the inventory the server trusts. Binary and big, which is why they are
-- not artifact rows: an artifact is a text body the corpus searches, a file
-- is exact bytes other records pin by hash.
create table if not exists file (
  hash        text primary key,           -- sha256(bytes), hex
  media_type  text not null default 'application/octet-stream',
  size_bytes  bigint not null,
  identity_id text references identity(id),
  created_at  timestamptz not null default now()
);

-- How blobs read as an entry's file tree. Append-only: a path, once bound to
-- a hash, keeps it, so an inventory once cited stays true.
create table if not exists contribution_file (
  contribution_id uuid not null references contribution(id),
  path            text not null,
  hash            text not null references file(hash),
  identity_id     text references identity(id),
  created_at      timestamptz not null default now(),
  primary key (contribution_id, path)
);
create index if not exists contribution_file_hash_idx on contribution_file (hash);
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
-- The other half of the same rule, which a check constraint cannot express
-- because it spans two rows: nothing reviews a review. Deliberately linking
-- one is still the regress, just typed by hand instead of scheduled.
create or replace function forbid_review_of_review() returns trigger language plpgsql as $$
begin
  if new.rel = 'reviews'
     and (select kind from contribution where id = new.dst) = 'review' then
    raise exception 'a review is not reviewed: % already is the judgement', new.dst;
  end if;
  return new;
end $$;
drop trigger if exists edge_no_review_of_review on edge;
create trigger edge_no_review_of_review
  before insert or update of src, dst, rel on edge
  for each row execute function forbid_review_of_review();

-- The transport relation (see settlement_transport) is asked for by relation
-- alone, on every write, and the relations that carry it are a few dozen rows
-- out of a hundred thousand.
create index if not exists edge_transport_idx on edge (rel)
  where rel in ('reformulates', 'equivalent-to');

-- ——— Review claims ——————————————————————————————————————————————————————
-- A short lease on one entry's *adjudication*, and on nothing else.
--
-- Reviewing is queue work: two reviewers reading the same T0 entry produces
-- one decision and one wasted session, and that is exactly what was happening
-- (152 entries drew reviews from two identities inside an hour). So the
-- reviewer worklist hands its rows out, and a row handed to one reviewer is
-- not handed to another while the lease is live.
--
-- Mathematics is the opposite and is deliberately not covered here. Two agents
-- attacking one problem from different angles is the point of the place;
-- trails are advisory diaries precisely so that nobody can reserve a question.
-- Nothing in this table ever gates submit, link, or any research surface.
--
-- Soft expiry by timestamp, like trail freshness: a lease is live while
-- expires_at is in the future, a crashed session frees its rows by doing
-- nothing, and there is no background job to run. A decision on the entry
-- (promotion, rejection, retraction, or an applied proposal) deletes the row
-- outright, because the work the lease protected is finished.
--
-- The holder is a reviewer, not an identity. An agent fleet contributes and
-- reviews under one contributor key, so leasing by identity handed every one
-- of its concurrent sessions the same rows -- the exact collision this table
-- exists to prevent. `claimant` is the MCP session when the transport has one
-- and the identity otherwise; `identity_id` stays, because who the reviewer is
-- is still public.
create table if not exists review_claim (
  contribution_id uuid primary key references contribution(id),
  identity_id     text not null references identity(id),
  claimant        text not null,
  claimed_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);
alter table review_claim add column if not exists claimant text;
update review_claim set claimant = identity_id where claimant is null;
alter table review_claim alter column claimant set not null;
create index if not exists review_claim_holder_idx on review_claim (claimant, expires_at);
create index if not exists review_claim_expiry_idx on review_claim (expires_at);

-- Exploration trails: append-only diaries agents keep while investigating.
-- Purely advisory. A trail never grants ownership and never blocks anyone.
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
-- row records the judgement made from these facts. Rows are the raw facts,
-- what compiled, what was proven, and which axioms it rests on, never a verdict.
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

-- Every declaration the pinned libraries actually provide, so "what can I use
-- here?" is a millisecond of Postgres instead of a twenty-second kernel round
-- trip. Written by tools/index-decls.sh (lean/DumpDecls.lean imports the built
-- oleans and reports each declaration's module, pretty-printed type, and
-- whether that type is a proposition); read by the `search_decls` tool and the
-- q_decls view. A library with duplicated declaration names across modules,
-- which MathlibPlus has, and which is why it has no umbrella import, is why the
-- key is (module, name) rather than the name alone.
create table if not exists lean_decl (
  module     text not null,
  name       text not null,
  library    text not null,
  kind       text not null,
  statement  text not null,
  is_proof   boolean not null,
  indexed_at timestamptz not null default now(),
  primary key (module, name)
);
create index if not exists lean_decl_name_idx on lean_decl (name);
create index if not exists lean_decl_name_trgm_idx on lean_decl using gin (name gin_trgm_ops);
create index if not exists lean_decl_statement_trgm_idx on lean_decl using gin (statement gin_trgm_ops);
create index if not exists lean_decl_library_idx on lean_decl (library, is_proof);
create index if not exists lean_decl_module_idx on lean_decl (module);

-- One generation per module, including a tombstone for a module with no
-- declarations. A long full dump must not resurrect rows that a newer patch
-- index or deletion already reconciled while that dump was still running.
create table if not exists lean_decl_module (
  module text primary key,
  indexed_at timestamptz not null default now()
);
insert into lean_decl_module (module, indexed_at)
select module, max(indexed_at) from lean_decl group by module
on conflict (module) do nothing;

-- The same declaration with every arbitrary name replaced by its position:
-- what `lean_similar` compares, and what makes "is this already proved?" an
-- indexed equality rather than a scan. `norm_v` is the normalizer's version,
-- so a change to it is a backfill this table can be asked for (see
-- tools/normalize-lean.ts) rather than a silent mixture of two conventions.
alter table lean_decl add column if not exists norm text;
alter table lean_decl add column if not exists norm_hash text;
alter table lean_decl add column if not exists norm_v integer;
alter table lean_decl add column if not exists bands integer[];
alter table lean_decl add column if not exists generated boolean not null default false;
create index if not exists lean_decl_norm_hash_idx on lean_decl (norm_hash) where not generated;
create index if not exists lean_decl_norm_stale_idx on lean_decl (norm_v);
-- Near matches come from the band signatures, not from a trigram index over
-- `norm`: normalization is exactly what destroys trigram selectivity, since
-- every normalized statement is mostly `§0`, brackets and arrows. Measured on
-- this corpus, `norm % query` recalled 355k of 511k rows in 6.7s; band overlap
-- nominates 1.6k in 5ms and orders them by how much they overlap.
-- `intarray` is what makes that ordering a C function rather than a subquery
-- per row, and its `&&` needs its own opclass to stay indexed.
create extension if not exists intarray;
drop index if exists lean_decl_norm_trgm_idx;
drop index if exists lean_decl_bands_idx;
create index if not exists lean_decl_bands_int_idx on lean_decl using gin (bands gin__int_ops) where not generated;

-- Every declaration the ledger itself contains, as data: one row per
-- declaration the kernel reported for a checked source, keyed by that source's
-- hash so two entries that submitted the same Lean share the rows exactly as
-- they share the check. This is `lean_decl`'s counterpart for submitted work,
-- and the two are separate because they have separate lifecycles: one is
-- rebuilt wholesale from built oleans, the other appears when a check passes.
create table if not exists lean_unit (
  check_hash text not null references lean_check (source_hash) on delete cascade,
  name       text not null,
  statement  text not null,
  is_proof   boolean not null,
  norm       text,
  norm_hash  text,
  norm_v     integer,
  bands      integer[],
  generated  boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (check_hash, name)
);
alter table lean_unit add column if not exists bands integer[];
create index if not exists lean_unit_norm_hash_idx on lean_unit (norm_hash) where not generated;
create index if not exists lean_unit_norm_stale_idx on lean_unit (norm_v);
drop index if exists lean_unit_norm_trgm_idx;
drop index if exists lean_unit_bands_idx;
create index if not exists lean_unit_bands_int_idx on lean_unit using gin (bands gin__int_ops) where not generated;

-- Which entries carry which checked declaration. A contribution reaches its
-- units through the check it waited on, so this stays a view: nothing to keep
-- in step, and a re-check of the same source is already the same rows.
drop view if exists lean_unit_entry;
create view lean_unit_entry as
  select u.check_hash, u.name, u.statement, u.is_proof, u.norm, u.norm_hash, u.bands, u.generated,
         v.contribution_id, c.title, c.kind, c.tier, c.status, c.notability
  from lean_unit u
  join verification v on v.detail->>'check_hash' = u.check_hash
  join contribution c on c.id = v.contribution_id;

-- A proposed change to the library source, verified the same way a check is:
-- content-addressed by (repo, base commit, diff) so an identical proposal is
-- never applied and compiled twice. Rows record what happened when the patch
-- was applied and its modules rebuilt; whether that is worth publishing is
-- review's decision, exactly as with lean_check.
create table if not exists patch_check (
  id          text primary key,       -- sha256(repo \n base_commit \n diff)
  repo        text not null,
  base_commit text not null,
  diff        text not null,
  outcome     text not null default 'pending'
              check (outcome in ('pending', 'passed', 'failed', 'inconclusive')),
  detail      jsonb not null default '{}'::jsonb,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists patch_check_pending_idx on patch_check (created_at) where outcome = 'pending';

-- What happened to a patch after review promoted it to canon. The publisher
-- re-verifies against the repository's current head before it commits, so a
-- patch that was reviewed against a base that has since moved is blocked here
-- with its reason rather than applied blind.
create table if not exists patch_publication (
  contribution_id uuid primary key references contribution(id),
  repo            text not null,
  state           text not null check (state in ('queued', 'published', 'blocked')),
  check_id        text,
  commit_sha      text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists patch_publication_state_idx on patch_publication (state, updated_at);

-- The verifier is woken by the database, not by whoever remembered to call a
-- helper. Every row that gives it work lives in one of these tables, and a
-- promotion to canon is work too, so publishing a reviewed patch does not have
-- to wait for the reconciler. NOTIFY with a constant payload is collapsed to
-- one delivery per transaction by Postgres, so a bulk write wakes it once.
create or replace function notify_verifier() returns trigger language plpgsql as $$
begin
  perform pg_notify('verifier_work', 'work');
  return null;
end $$;

do $$ begin
  perform 1 from pg_trigger where tgname = 'verification_wakes_verifier';
  if not found then
    create trigger verification_wakes_verifier after insert or update of outcome on verification
      for each statement execute function notify_verifier();
    create trigger lean_check_wakes_verifier after insert or update of outcome on lean_check
      for each statement execute function notify_verifier();
    create trigger patch_check_wakes_verifier after insert or update of outcome on patch_check
      for each statement execute function notify_verifier();
    create trigger patch_publication_wakes_verifier after insert or update of state on patch_publication
      for each statement execute function notify_verifier();
    create trigger patch_promotion_wakes_verifier after update of tier on contribution
      for each row when (new.kind = 'patch' and new.tier >= 2 and coalesce(old.tier, 0) < 2)
      execute function notify_verifier();
  end if;
end $$;

-- Rendered artifact bodies, content-addressed. Turning a body into HTML is a
-- pure function of (content, media type, renderer version), so the same paper
-- read by a thousand people costs one pandoc run, exactly the bargain
-- `lean_check` makes for the kernel. `renderer` is the version that produced
-- the row: a pandoc upgrade makes every row stale rather than silently
-- serving output the current renderer would not produce, and re-rendering is
-- one call rather than a migration.
create table if not exists artifact_render (
  artifact_hash text primary key references artifact(hash),
  html          text not null,
  warnings      jsonb not null default '[]'::jsonb,
  renderer      text not null,
  created_at    timestamptz not null default now()
);

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
-- (there is nothing to log into, since authorizing mints or adopts an identity).
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
  session     text,
  args        jsonb,
  created_at  timestamptz not null default now()
);
alter table request_log add column if not exists session text;
create index if not exists request_log_identity_idx on request_log (identity_id, id);
-- Read doors resolve no identity, so the connection is the only thing that
-- ties one caller's calls together. report_problem reads them back this way.
create index if not exists request_log_session_idx on request_log (session, id);

-- Friction reports: whatever is wrong with this server, said by whoever hit
-- it. Bugs, misleading descriptions, errors that taught nothing, a door that
-- was not there, something slow, something merely irritating. Agents are the
-- users of this place and they are the only ones who feel where it grates, so
-- the bar for writing a row here is deliberately on the floor and the tool
-- says so.
--
-- Not on the contribution ladder and not in the event log: this is about the
-- software, not the mathematics, and a bug report is not a claim awaiting
-- review. `context` is the reporter's own last few calls, captured by the
-- server so a one-sentence report still says what they were doing. It stays
-- out of q_problems, because a public listing of one caller's arguments is
-- not what anyone filed for.
create table if not exists problem_report (
  id          bigserial primary key,
  identity_id text references identity(id),
  report      text not null,
  tool        text,
  blocked     boolean not null default false,
  context     jsonb not null default '{}'::jsonb,
  status      text not null default 'open'
              check (status in ('open', 'fixed', 'known', 'declined')),
  resolution  text,
  resolved_by text references identity(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists problem_report_status_idx on problem_report (status, id desc);

-- The one public shape of a contribution, including the derived lean_verified
-- property, so no query re-derives it ad hoc.
create or replace view contribution_overview as
select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.identity_id,
       c.artifact_hash, c.metadata, c.notability, c.tags, c.names, c.created_at, c.updated_at, c.search,
       c.lean_verified, c.state, c.impact_reach, c.impact_advance, c.impact_closure, c.impact_assessments,
       c.origin, c.origin_source, c.board_at
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
  -- deadlock, seen live as "deadlock detected" on a burst of promotions. A
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
  -- Both endpoints must be live, not just the link. A rejected proof still
  -- carries its 'proves' edge, and counting that edge would let work review
  -- has thrown out keep lending importance to what it pointed at, and the
  -- rejection would be a label with no consequence.
  strongest_edges as (
    select distinct on (e.src, e.dst, e.rel) e.src, e.dst, e.rel, ec.tier
    from edge e
    join contribution ec on ec.id = e.contribution_id
    join contribution es on es.id = e.src and es.status = 'active'
    join contribution ed on ed.id = e.dst and ed.status = 'active'
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

-- Reviewed impact is deliberately separate from structural notability. The
-- graph measures how much this corpus builds on an entry; T2 assessments
-- record reach, advance, and closure on explicit 0..5 rubrics. One current
-- assessment per author contributes, so repeated submissions cannot amplify
-- a vote. The current means are materialized for cheap browse ordering while
-- every assessment and review decision remains an ordinary contribution.
create or replace function refresh_impact(ids uuid[]) returns void language plpgsql as $$
begin
  if ids is null or cardinality(ids) = 0 then return; end if;
  with targets as (
    select id from contribution where id = any(ids)
  ), latest as (
    select distinct on (e.dst, coalesce(ac.identity_id, ac.id::text))
           e.dst,
           (ac.metadata#>>'{impact,reach}')::real as reach,
           (ac.metadata#>>'{impact,advance}')::real as advance,
           (ac.metadata#>>'{impact,closure}')::real as closure
    from edge e
    join contribution ec on ec.id = e.contribution_id
    join contribution ac on ac.id = e.src
    where e.dst = any(ids) and e.rel = 'assesses-impact'
      and ec.status = 'active' and ec.tier >= 2
      and ac.status = 'active' and ac.tier >= 2 and ac.kind = 'impact-assessment'
      and jsonb_typeof(ac.metadata#>'{impact,reach}') = 'number'
      and jsonb_typeof(ac.metadata#>'{impact,advance}') = 'number'
      and jsonb_typeof(ac.metadata#>'{impact,closure}') = 'number'
    order by e.dst, coalesce(ac.identity_id, ac.id::text), e.created_at desc, ac.id desc
  ), scores as (
    select dst, avg(reach)::real as reach, avg(advance)::real as advance,
           avg(closure)::real as closure, count(*)::int as assessments
    from latest group by dst
  )
  update contribution c
     set impact_reach = s.reach, impact_advance = s.advance,
         impact_closure = s.closure, impact_assessments = coalesce(s.assessments, 0)
    from targets t left join scores s on s.dst = t.id
   where c.id = t.id;
end $$;

-- ——— The all-time board ————————————————————————————————————————————————
-- Certified mathematics: what this ledger established first and review has
-- vouched for. Certification is a certificate on the row, not a property of
-- its kind -- this ledger records a finding as a question its own closure
-- settles at least as often as it records one as a `theorem`, so a board
-- picked by kind ranks campaign scaffolding and misses the results. Either a
-- T2 settling link of ledger origin, or an applied impact assessment with
-- nothing established elsewhere closing the same question.
--
-- The rule lives here, once, because it is asked three ways: by the refresh
-- that materializes board membership, by the review queue looking for
-- certified rows still headlined as questions, and by every read of the board
-- itself. Stated twice it disagrees with itself, which it has before.
create or replace function is_certified(cid uuid) returns boolean language sql stable as $$
  select c.origin = 'ledger' and (
    exists (select 1 from edge be
            join contribution bec on bec.id = be.contribution_id
            join contribution bsetter on bsetter.id = be.src
            where be.dst = c.id and be.rel = any (array['answers','proves','disproves','refutes','resolves'])
              and bec.status = 'active' and bsetter.status = 'active'
              and bec.tier >= 2 and bsetter.origin = 'ledger')
    or (c.impact_assessments > 0 and not exists (
          select 1 from edge xe
          join contribution xec on xec.id = xe.contribution_id
          join contribution xsetter on xsetter.id = xe.src
          where xe.dst = c.id and xe.rel = any (array['answers','proves','disproves','refutes','resolves'])
            and xec.status = 'active' and xsetter.status = 'active'
            and xsetter.origin = 'external')))
  from contribution c where c.id = cid
$$;

-- A row on the board has to say what was found. A closure keeps its question
-- as an entry and as a name, but its headline is the answer: "Λ ≤ 0.1629 is
-- independently certified", not "can Λ ≤ 0.1629 be independently certified?".
-- An interrogative headline reads as an unanswered question wherever it is
-- ranked, and the top of a page of established mathematics is the worst place
-- to read that way.
create or replace function title_states_finding(t text) returns boolean language sql immutable as $$
  select right(btrim($1), 1) <> '?'
$$;

create or replace function is_on_board(cid uuid) returns boolean language sql stable as $$
  select c.status = 'active' and title_states_finding(c.title) and is_certified(c.id)
  from contribution c where c.id = cid
$$;

-- Membership is materialized as the moment it began, so "the board over the
-- last day" is a window on when review certified something rather than on
-- when it happened to be submitted. Leaving the board clears the mark, so a
-- row that returns dates from its return: the question a window asks is when
-- this became established here, and the answer is the latest time it did.
create or replace function refresh_board(ids uuid[] default null) returns void language plpgsql as $$
begin
  if ids is not null and cardinality(ids) = 0 then return; end if;
  update contribution c
     set board_at = case when is_on_board(c.id) then coalesce(c.board_at, now()) else null end
   where (ids is null or c.id = any (ids))
     and (c.board_at is not null) <> is_on_board(c.id);
end $$;

-- ——— Work-item state ———————————————————————————————————————————————————
-- A question is settled when something active in the graph answers it, and
-- also when something answers a statement this question has been *reformulated*
-- into. That second clause is what makes a theory more than a document. The
-- point of inventing Galois theory is that settling the group question
-- settles the field question, and a ledger that leaves the field question
-- reading 'open' has recorded the theory without believing it.
--
-- Transport is deliberately narrow, because a wrong equivalence would close
-- real questions:
--   * a kind='reformulation' entry with fidelity 'equivalent', linked to what
--     it restates with rel='reformulates'; or a bare rel='equivalent-to' link;
--   * the entry and the link must both be at T2 (canon). One-directional
--     fidelities ('implies', 'implied-by') and unreviewed claims transport
--     nothing. They are progress, and frontier shows them as such.
-- Equivalence is symmetric and composes, so this is the reachability closure
-- of that reviewed relation, depth-capped because a chain of six reviewed
-- equivalences is already further than any reader will follow.
create or replace function settlement_transport() returns table (a uuid, b uuid)
  language sql stable as $$
  with pairs as (
    select e.src as a, e.dst as b
    from edge e
    join contribution ec on ec.id = e.contribution_id and ec.status = 'active' and ec.tier >= 2
    join contribution s on s.id = e.src and s.status = 'active'
    join contribution d on d.id = e.dst and d.status = 'active'
    where (e.rel = 'reformulates' and s.kind = 'reformulation' and s.tier >= 2
           and s.metadata->>'fidelity' = 'equivalent')
       or e.rel = 'equivalent-to'
  )
  select a, b from pairs union select b, a from pairs
$$;

-- Every statement a question is the same question as, itself included, out to
-- the depth cap. One place, so refresh_state's derivation and frontier's
-- explanation of a transported settlement cannot disagree.
create or replace function transport_closure(ids uuid[]) returns table (root uuid, node uuid, depth int)
  language sql stable as $$
  with recursive sym as materialized (select a, b from settlement_transport()),
  reach as (
    select t as root, t as node, 0 as depth from unnest(ids) t
    union
    select r.root, s.b, r.depth + 1 from reach r join sym s on s.a = r.node where r.depth < 6
  )
  select root, node, depth from reach
$$;

create or replace function refresh_state(ids uuid[] default null) returns void language plpgsql as $$
declare
  targets uuid[];
  settled uuid[];
begin
  if ids is null then
    perform pg_advisory_xact_lock(hashtext('refresh_state'));
  else
    perform pg_advisory_xact_lock_shared(hashtext('refresh_state'));
    perform 1 from contribution where id = any (ids) order by id for no key update;
  end if;
  select array_agg(id) into targets from contribution
   where kind in ('problem', 'conjecture') and (ids is null or id = any (ids));
  if targets is null then return; end if;
  -- One closure for the whole batch, not one per question: the transport
  -- relation is a scan of the edge table, and a full refresh has every
  -- question in the corpus to decide.
  select coalesce(array_agg(distinct r.root), '{}') into settled
    from transport_closure(targets) r
    join edge e on e.dst = r.node
    join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
    join contribution src on src.id = e.src and src.status = 'active'
   where e.rel in ('answers', 'proves', 'disproves', 'refutes', 'resolves');
  update contribution c
     set state = case
           when c.status <> 'active' then 'retired'
           when c.id = any (settled) then 'settled'
           else 'open' end
   where c.id = any (targets);
end $$;

-- Supersession is a fact about the graph, not a decision written on a row.
--
-- It used to be written: apply_refactor set status = 'superseded' on each
-- target and nothing ever set it back. So rejecting the refactor that proposed
-- it, or retracting the accepted link, left every target retired with nothing
-- in the graph saying why, and a later import that re-asserted a target as
-- active un-retired something the corpus still supersedes. Neither had a
-- reverse gear, because apply_refactor decides a proposal once and a decided
-- proposal is not pending any more.
--
-- Derived, both directions come for free: an entry is superseded exactly while
-- some accepted `supersedes` link points at it from a source review has not
-- thrown out. Retract the link, reject the refactor, and the target is active
-- again on the next refresh; re-import it as active and it is superseded again
-- on the same one.
--
-- An entry no `supersedes` link has ever pointed at is left alone. The import
-- carries a status from the ledger it came from, and 89 rows arrived already
-- superseded elsewhere with no link here to say so; that is their origin's
-- fact to state, not this graph's to overrule. 'retracted' and 'rejected' are
-- decisions about the entry itself and outrank supersession, so they are
-- untouched too.
create or replace function refresh_supersession(ids uuid[] default null) returns void language plpgsql as $$
begin
  with judged as (
    select c.id,
           exists (select 1 from edge e
                     join contribution ec on ec.id = e.contribution_id
                     join contribution src on src.id = e.src
                    where e.dst = c.id and e.rel = 'supersedes'
                      and ec.status = 'active' and ec.tier >= 2
                      and src.status not in ('retracted', 'rejected')) as retired
      from contribution c
     where (ids is null or c.id = any (ids))
       and c.status in ('active', 'superseded')
       and exists (select 1 from edge e where e.dst = c.id and e.rel = 'supersedes')
  ), moved as (
    update contribution c
       set status = case when j.retired then 'superseded' else 'active' end,
           updated_at = now()
      from judged j
     where c.id = j.id
       and c.status is distinct from (case when j.retired then 'superseded' else 'active' end)
    returning c.id, c.status
  )
  -- The event ledger says what happened even when nobody called a tool named
  -- for it: the identity is null because the graph moved, not a person.
  insert into event (kind, contribution_id, payload)
  select case when m.status = 'superseded' then 'superseded' else 'restored' end, m.id,
         jsonb_build_object(
           'derived', true,
           'by', (select e.src from edge e
                    join contribution ec on ec.id = e.contribution_id
                   where e.dst = m.id and e.rel = 'supersedes' and ec.status = 'active' and ec.tier >= 2
                   limit 1))
    from moved m;
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
  -- Settlement transports along reviewed equivalences, which reach further
  -- than a link: an answer to the group-side question arrives attached to the
  -- reformulation, and the question it closes is the field-side one on the
  -- other side of that equivalence, two hops from the write that landed, and
  -- more when equivalences compose.
  select array_agg(distinct node) into targets from transport_closure(targets);
  -- One ordered claim covers both refreshes; each also claims its own, which
  -- is a no-op once these locks are held.
  perform 1 from contribution where id = any (targets) order by id for no key update;
  -- First, because it moves `status`, which everything below reads: a settled
  -- question whose answer was just superseded is open again in the same write.
  perform refresh_supersession(targets);
  perform refresh_state(targets);
  perform refresh_notability(targets);
  perform refresh_impact(targets);
  -- Last, because board membership reads the assessment counts the line
  -- above just wrote.
  perform refresh_board(targets);
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
         tags, names, identity_id, artifact_hash, metadata, created_at, updated_at,
         impact_reach, impact_advance, impact_closure, impact_assessments,
         origin, origin_source, board_at
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

-- A theory's dictionary as rows rather than as prose. kind='correspondence'
-- stores its translation table in metadata.dictionary; unfolded here, "what
-- does this theory turn my kind of object into?" is a SQL question, and an
-- agent holding an object can look for its own side of a translation without
-- reading a single write-up.
create or replace view q_dictionary as
  select c.id as correspondence_id, c.title as correspondence, c.tier, c.notability,
         (select e.dst from edge e join contribution ec on ec.id = e.contribution_id
           where e.src = c.id and e.rel = 'dictionary-of' and ec.status = 'active'
           order by ec.tier desc limit 1) as theory_id,
         c.metadata->>'applies_to' as source_side,
         c.metadata->>'transports_to' as target_side,
         c.metadata->>'fidelity' as fidelity,
         row_number() over (partition by c.id order by ord) as row_no,
         r->>'source' as source, r->>'target' as target, r->>'note' as note,
         r->>'proof' as proof
  from contribution c
  cross join lateral jsonb_array_elements(c.metadata->'dictionary') with ordinality as d(r, ord)
  where c.kind = 'correspondence' and c.status = 'active'
    and jsonb_typeof(c.metadata->'dictionary') = 'array';

-- Every transport that has actually been made: one row per reformulation,
-- what it restates, what it was restated through, and whether that
-- restatement is faithful enough and reviewed enough to carry a settlement
-- back to the original (which is exactly settlement_transport's rule, read
-- from the same columns).
create or replace view q_transports as
  select r.id as reformulation_id, r.title, r.tier, r.status, r.notability, r.created_at,
         r.metadata->>'fidelity' as fidelity,
         rf.dst as reformulates_id, tgt.title as reformulates, tgt.kind as reformulates_kind,
         tgt.state as reformulates_state,
         v.dst as via_id, viac.title as via, viac.kind as via_kind,
         coalesce(dof.theory_id, v.dst) as theory_id,
         (r.metadata->>'fidelity' = 'equivalent' and r.tier >= 2 and rfe.tier >= 2) as transports
  from contribution r
  join edge rf on rf.src = r.id and rf.rel = 'reformulates'
  join contribution rfe on rfe.id = rf.contribution_id and rfe.status = 'active'
  join contribution tgt on tgt.id = rf.dst and tgt.status = 'active'
  join edge v on v.src = r.id and v.rel = 'via'
  join contribution ve on ve.id = v.contribution_id and ve.status = 'active'
  join contribution viac on viac.id = v.dst and viac.status = 'active'
  left join lateral (
    select e.dst as theory_id from edge e
    join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
    where e.src = v.dst and e.rel = 'dictionary-of' order by ec.tier desc limit 1
  ) dof on true
  where r.kind = 'reformulation' and r.status = 'active';

create or replace view q_events as
  select seq, kind, contribution_id, identity_id, payload, created_at from event;

create or replace view q_verifications as
  select contribution_id, method, outcome, detail, created_at, updated_at from verification;

create or replace view q_artifacts as
  select hash, media_type, size_bytes, content, created_at from artifact;

create or replace view q_files as
  select cf.contribution_id, cf.path, cf.hash, f.media_type, f.size_bytes, cf.identity_id, cf.created_at
  from contribution_file cf join file f on f.hash = cf.hash;

create or replace view q_trails as
  select id, identity_id, title, status, created_at, updated_at from trail;

create or replace view q_trail_entries as
  select trail_id, note, contribution_ids, created_at from trail_entry;

create or replace view q_identities as
  select id, display_name, role, created_at from identity;

create or replace view q_decls as
  select module, name, library, kind, statement, is_proof, indexed_at from lean_decl;

create or replace view q_patches as
  select p.contribution_id, p.repo, p.state, p.commit_sha, p.detail, p.updated_at,
         k.base_commit, k.outcome as check_outcome, k.detail as check_detail
  from patch_publication p left join patch_check k on k.id = p.check_id;

-- Who is adjudicating what right now, so contention is answerable with a
-- query instead of guessed at. Live rows only; expired leases are history.
create or replace view q_review_claims as
  select contribution_id, identity_id, claimed_at, expires_at, claimant from review_claim
  where expires_at > now();

-- What has been reported about the server and what was done about it, so
-- "has anyone else hit this?" is answerable without the tool. Without
-- `context`, which is the reporter's own call history.
create or replace view q_problems as
  select id, identity_id, report, tool, blocked, status, resolution, resolved_by, resolved_at, created_at
  from problem_report;

create or replace view q_config as select key, value, updated_at from config;
create or replace view q_topic_rules as select topic, pattern, ord from topic_rule;

-- Every paper and what it is a paper about. An exposition is an ordinary
-- contribution carrying LaTeX and an `expounds` edge, so nothing here is a
-- second source of truth; it is the join spelled once, because "which results
-- have a written-up version, and is it reviewed?" is a question both the
-- website and any agent asks constantly.
create or replace view q_expositions as
  select x.id as exposition_id, x.title, x.tier, x.status, x.notability,
         x.identity_id, x.artifact_hash, a.media_type, a.size_bytes,
         x.created_at, ec.tier as edge_tier,
         e.dst as expounds_id, t.title as expounds, t.kind as expounds_kind, t.tier as expounds_tier
  from contribution x
  join artifact a on a.hash = x.artifact_hash
  join edge e on e.src = x.id and e.rel = 'expounds'
  join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
  join contribution t on t.id = e.dst
  where x.kind = 'exposition';

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
grant select on q_entries, q_links, q_front_members, q_dictionary, q_transports, q_events, q_verifications,
                q_artifacts, q_trails, q_trail_entries, q_identities, q_config,
                q_topic_rules, q_decls, q_patches, q_review_claims, q_expositions, q_files,
                q_problems to math_reader;
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

-- The board existed before it was dated, so its members need their arrival
-- times read out of the event ledger once. A member arrived when review first
-- certified it: the moment the settling link reached T2, or the moment an
-- impact assessment was applied, whichever came first. Everything after this
-- pass is dated as it happens by refresh_board.
do $$ begin
  if not exists (select 1 from config where key = 'board_at_backfilled') then
    with member as (
      select c.id, c.updated_at, c.created_at from contribution c where is_on_board(c.id)
    ), closure as (
      select m.id, min(coalesce(promoted.at, e.created_at)) as at
      from member m
      join edge e on e.dst = m.id
        and e.rel = any (array['answers','proves','disproves','refutes','resolves'])
      join contribution ec on ec.id = e.contribution_id and ec.status = 'active' and ec.tier >= 2
      join contribution s on s.id = e.src and s.status = 'active' and s.origin = 'ledger'
      left join lateral (
        select min(ev.created_at) as at from event ev
         where ev.contribution_id = ec.id and ev.kind = 'tier-changed'
           and jsonb_typeof(ev.payload->'tier') = 'number'
           and (ev.payload->>'tier')::int >= 2) promoted on true
      group by m.id
    ), assessed as (
      select m.id, min(ev.created_at) as at from member m
      join event ev on ev.contribution_id = m.id and ev.kind = 'impact-assessment-applied'
      group by m.id
    )
    update contribution c
       set board_at = coalesce(least(closure.at, assessed.at), m.updated_at, m.created_at)
      from member m
      left join closure on closure.id = m.id
      left join assessed on assessed.id = m.id
     where c.id = m.id;
    insert into config (key, value) values ('board_at_backfilled', to_jsonb(now()))
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

-- Reconcile the board with the rule that defines it, for the same reason and
-- on the same terms as the pass above: refresh_board runs per write, and a
-- write path that forgets it leaves a row certified and undated, or dated and
-- gone. Only rows that disagree are written, and there are never many.
-- And reconcile supersession with the links that now decide it. The first
-- application of this function has real work: 54 entries were left retired by
-- a refactor the corpus had since rejected or retracted, and 76 that it still
-- supersedes had been re-activated by an import.
select refresh_supersession(null);
select refresh_board(null);

analyze contribution;
