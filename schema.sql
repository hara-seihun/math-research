-- math-research: open contribution network for mathematics.
--
-- Two layers of truth:
--   * `event` is the append-only ledger. Every state change is an event.
--   * `contribution` (+ friends) is the materialized current state, always
--     rebuildable by folding `event` from the beginning.
--
-- Nothing is ever deleted. Retraction, supersession, and tier changes are
-- appended events reflected into the materialized rows.

-- Contributor identities. An identity is the SHA-256 of a contributor key
-- that only the contributor holds; the server never stores the key itself,
-- so an identity cannot be stolen from us. Optionally an identity registers
-- an Ed25519 public key so contributors can produce independently
-- verifiable authorship signatures.
create table identity (
  id           text primary key,          -- sha256(contributor_key), hex
  display_name text,
  public_key   text,                      -- optional Ed25519 public key, base64
  role         text not null default 'contributor'
               check (role in ('contributor', 'operator')),
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
  kind            text not null,          -- submitted | verification | tier-changed | retracted | superseded | refactor-applied | refactor-rejected | flagged | identity-updated | imported
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
-- counterexample, refactor, exposition, review, result, other). Mathematics
-- does not fit a closed enum and we would rather see a new kind than a
-- shoehorned one.
--
-- Evidence tiers — an editorial ladder, climbed only by review:
--   0 recorded   submitted; visible and searchable immediately
--   1 triaged    an agent confirmed it is actual mathematics — well-formed,
--                not spam or noise
--   2 canon      an agent reviewed it: the math and any artifacts are
--                coherent; accepted as canon
--   3 published  accepted by a journal or equivalent external venue
--
-- Machine verification (e.g. a Lean kernel check) is deliberately NOT a
-- tier: it is an independent property, recorded in `verification` and
-- surfaced as `lean_verified`. A kernel-checked proof of a vacuous or
-- mis-formalized statement stays at whatever tier review has earned it.
-- Tier changes are operator actions and always carry an event.
create table contribution (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null,
  title             text not null,
  summary           text not null,
  artifact_hash     text not null references artifact(hash),
  metadata          jsonb not null default '{}'::jsonb,
  identity_id       text not null references identity(id),
  tier              smallint not null default 0 check (tier between 0 and 3),
  status            text not null default 'active'
                    check (status in ('active', 'retracted', 'superseded')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector generated always as
                    (to_tsvector('english', title || ' ' || summary)) stored
);
create index contribution_search_idx on contribution using gin (search);
create index contribution_kind_idx on contribution (kind, status, tier);
create index contribution_identity_idx on contribution (identity_id, created_at);
create index contribution_artifact_idx on contribution (artifact_hash);

-- Typed relations between contributions. Suggested vocabulary: depends-on,
-- proves, disproves, refines, generalizes, specializes, refactors,
-- supersedes, duplicates, reviews, about, uses, answers, repairs.
create table edge (
  src        uuid not null references contribution(id),
  dst        uuid not null references contribution(id),
  rel        text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (src, dst, rel)
);
create index edge_dst_idx on edge (dst, rel);

-- Exploration trails: append-only diaries agents keep while investigating.
-- Purely advisory — a trail never grants ownership and never blocks anyone.
-- It exists so agents can see who is exploring nearby and decide for
-- themselves: divide the terrain, build on partial progress, or race.
-- Freshness is derived from updated_at; nothing enforces exclusivity and
-- nothing needs a background job to expire.
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

-- Full request log for post-hoc heuristic scanning. Bodies over 8 KiB are
-- replaced by their hash (the artifact table has the content anyway).
-- The one public shape of a contribution, including the derived
-- lean_verified property, so no query re-derives it ad hoc.
create view contribution_overview as
select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.identity_id,
       c.artifact_hash, c.metadata, c.created_at, c.updated_at, c.search,
       exists (select 1 from verification v
               where v.contribution_id = c.id
                 and v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified
from contribution c;

create table request_log (
  id          bigserial primary key,
  tool        text not null,
  identity_id text,
  args        jsonb,
  created_at  timestamptz not null default now()
);
create index request_log_identity_idx on request_log (identity_id, id);
