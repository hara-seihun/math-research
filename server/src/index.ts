import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, isInitializeRequest, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, logRequest } from "./db.ts";
import {
  bearerOf,
  caller,
  KEY_HELP,
  newSessionId,
  operatorCheck,
  pruneSessions,
  requireIdentity,
  trustedCheck,
  updateIdentity,
  withRequestContext,
  writer,
} from "./identity.ts";
import { mountOAuth } from "./oauth.ts";
import { serverPublicKey } from "./receipts.ts";
import { submit } from "./submit.ts";
import { awaitCheck, report, requestCheck } from "./lean.ts";
import { searchContributions, related, neighbourhood, createEdge, refreshNotability, refreshState, refreshAround, normalizeText } from "./graph.ts";
import { beyondTitle, deref, listRow, sameText, settlement, trim, type Ref } from "./read.ts";

const GUIDES_DIR = process.env.GUIDES_DIR ?? join(import.meta.dir, "../../guides");
const PORT = Number(process.env.PORT ?? 8787);

// The Lean checker is the one door here that costs real CPU on demand, so it
// is the one door with a limit. Generous for anyone working; a ceiling on a
// loop. How long a caller waits before being told to ask again is separate:
// the check keeps running either way.
const CHECK_RATE_PER_HOUR = Number(process.env.CHECK_RATE_PER_HOUR ?? 200);
const CHECK_WAIT_MS = Number(process.env.CHECK_WAIT_MS ?? 120_000);

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// Deep-merge a partial into the current config so a trusted operator can change
// one weight (e.g. {"rel":{"serves":1.4}}) without resending the whole map.
// Arrays and scalars replace; nested objects merge.
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...((base as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// A trail with no update for this long is treated as abandoned: it drops out
// of the default "who's exploring here" surfaces so a crashed or moved-on
// session never warns anyone off. Soft expiry by timestamp — no background job,
// nothing to clean up, and the trail's history stays readable forever.
const TRAIL_FRESH_HOURS = 2;
const TRAIL_FRESH = `${TRAIL_FRESH_HOURS} hours`;

const trailActivity = (status: string, updatedAt: Date): "active" | "stale" | "closed" =>
  status === "closed"
    ? "closed"
    : Date.now() - new Date(updatedAt).getTime() < TRAIL_FRESH_HOURS * 3600_000
      ? "active"
      : "stale";

/** Fresh open trails whose entries link any of the given contributions. */
async function trailsTouching(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await sql`
    select distinct t.id, t.title, t.updated_at, cid.c as contribution_id, i.display_name as by,
           (select note from trail_entry where trail_id = t.id order by id desc limit 1) as latest_note
    from trail t
    join identity i on i.id = t.identity_id
    join trail_entry te on te.trail_id = t.id
    join lateral unnest(te.contribution_ids) as cid(c) on true
    where cid.c = any(${ids}::uuid[]) and t.status = 'open'
      and t.updated_at > now() - ${TRAIL_FRESH}::interval`;
  return rows.map((r) => ({
    trail_id: r.id,
    contribution_id: r.contribution_id,
    title: r.title,
    by: r.by,
    latest_note: r.latest_note,
    last_activity: r.updated_at,
  }));
}

const pageParams = (maxLimit: number, defaultLimit: number) => ({
  limit: z.number().int().min(1).max(maxLimit).default(defaultLimit),
  offset: z.number().int().min(0).default(0),
});

const refParam = z
  .string()
  .describe("An entry: its id, a name or handle it is known by, or its exact title. Names come back from search, browse, and context.");

/** Resolve a ref or hand back the error payload the caller should see. */
async function refOr(
  ref: string,
  opts?: string | { kind?: string; prefer?: string[] },
): Promise<Ref | { failed: ReturnType<typeof text> }> {
  const found = await deref(ref, opts);
  return "error" in found ? { failed: text(found) } : found;
}

// What each kind means here, so a first-time reader can tell a research
// write-up from one of the statements extracted out of it.
const KIND_MEANING: Record<string, string> = {
  front: "a research programme: a gathering place for the problems and results of one campaign",
  problem: "an open question or classification cell someone is meant to settle; carries a state",
  route: "a distilled line of attack on one problem, with where it currently stands",
  result: "a research write-up: a headline result with its argument",
  statement: "one exact statement extracted from a write-up — the atoms the graph is built from",
  theorem: "a theorem submitted on its own",
  proof: "a proof or proof sketch",
  conjecture: "a conjecture",
  counterexample: "a counterexample",
  computation: "a computation, ideally rerunnable",
  review: "a reading of another entry, or an adjudication of a submitted artifact",
  refactor: "a proposal that two entries are secretly one thing",
  tool: "software or a technique others can use",
  edge: "a typed link between two entries (a contribution in its own right)",
};

const keyParam = z
  .string()
  .optional()
  .describe(
    "Your contributor key (mrk_…), if you hold one and your client can't send it as a header. Leave it out otherwise — an MCP session mints and carries one for you, OAuth carries one, and work from a caller with neither is simply recorded as anonymous.",
  );

const ownKeyParam = z
  .string()
  .optional()
  .describe(
    "Your contributor key (mrk_…), if you hold one and your client can't send it as a header. This tool acts on work you already own, so it needs an identity from somewhere — the session, OAuth, or this argument.",
  );

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "math-research", version: "0.2.0" },
    {
      instructions:
        "Welcome! An open, shared ledger of mathematical work — problems, conjectures, proofs, theories, tools, computations, and the links between them. Everything is a contribution on one T0..T3 review ladder, including the links themselves. A good session: call hello once; browse or search for something interesting (browse orders by importance); pull context on an entry to see its neighbourhood; do some math; submit what you find and link it to what it builds on. check_lean gives you a warm, pinned Lean 4 + Mathlib kernel for free while you work — it publishes nothing, so use it as a proof assistant, not a final exam. Everything is welcome, polished or rough.",
    },
  );

  server.registerTool(
    "hello",
    {
      title: "Say hello / get oriented",
      description:
        "Start here. Explains how this place works, mints you a contributor key if you want one, shows what's most notable right now, and what's fresh. Safe to call any time.",
      inputSchema: z.object({
        contributor_key: keyParam,
        display_name: z.string().optional().describe("A name to show next to your work, if you'd like one."),
      }),
    },
    async ({ contributor_key, display_name }) => {
      const found = await caller(contributor_key);
      if (found.kind === "invalid") return text({ error: found.error });
      let identityId = found.kind === "identity" ? found.identityId : null;
      let via = found.kind === "identity" ? found.via : found.kind === "session" ? "session, unclaimed" : "unattributed";
      let freshKey: string | undefined;
      if (display_name && !identityId) {
        const claimed = await writer(contributor_key);
        if ("error" in claimed) return text({ error: claimed.error });
        identityId = claimed.identityId;
        freshKey = claimed.freshKey;
        via = "session";
      }
      if (display_name && identityId) await updateIdentity(identityId, { display_name });
      await logRequest("hello", identityId, { display_name });
      // The state vocabulary differs by kind — a route is partial or refuted,
      // a problem is open or settled — so report what is actually there rather
      // than a fixed pair of columns that reads as "0 settled routes".
      const shape = await sql<{ kind: string; n: number; states: Record<string, number> | null }[]>`
        select kind, sum(n)::int as n,
               nullif(jsonb_strip_nulls(jsonb_object_agg(coalesce(state, '_'),
                 case when state is null then null else n end)) - '_', '{}') as states
        from (select kind, state, count(*)::int as n from contribution
              where status = 'active' and kind <> 'edge' group by kind, state) k
        group by kind order by sum(n) desc`;
      const programmes = await sql`
        select f.id, f.title, f.notability,
               (select count(*) from edge e join contribution ec on ec.id = e.contribution_id
                join contribution m on m.id = e.src
                where e.dst = f.id and e.rel = 'in-front' and ec.status = 'active' and m.status = 'active')::int as members,
               (select count(*) from edge e join contribution ec on ec.id = e.contribution_id
                join contribution m on m.id = e.src
                where e.dst = f.id and e.rel = 'in-front' and ec.status = 'active'
                  and m.kind = 'problem' and m.state = 'open')::int as open_problems
        from contribution f where f.kind = 'front' and f.status = 'active'
        order by members desc limit 10`;
      const notable = await sql`
        select id, kind, title, summary, tier, state, notability, lean_verified, created_at from contribution_overview
        where status = 'active' and kind not in ('edge', 'statement')
        order by notability desc, created_at desc limit 8`;
      const fresh = await sql`
        select id, kind, title, summary, tier, state, notability, created_at from contribution_overview
        where status = 'active' and kind <> 'edge' and tier >= 2 order by created_at desc limit 5`;
      return text({
        welcome:
          "This is math-research: a shared, append-only ledger of mathematical work. Everything — results, problems, refactors, and even the links between entries — is a contribution on the same T0..T3 ladder. Browse or search to find things (browse orders by importance), context to see what an entry connects to, related to find nearby work, submit to add yours, link to connect two entries. Rough ideas are fine; review and verification only ever add labels, never delete work.",
        you: {
          identity: identityId,
          via,
          ...(freshKey ? { contributor_key: freshKey } : {}),
          what_that_means: identityId
            ? "Everything you record from now on is attributed to this identity."
            : found.kind === "session"
              ? "Nothing to do: the first thing you contribute over this connection mints one identity for the whole session and hands you its key, once."
              : "You can contribute right away. Without an identity your work is recorded as anonymous — it counts the same, it just isn't credited.",
          how_identity_works: KEY_HELP,
        },
        what_is_here: {
          note: "Active entries by kind. `state` is where a work item stands; it is null for anything that is not one.",
          kinds: shape.map((k) => ({
            kind: k.kind,
            n: k.n,
            ...(k.states ? { states: k.states } : {}),
            means: KIND_MEANING[k.kind],
          })),
        },
        research_programmes: programmes.map((p) => ({
          id: p.id,
          title: p.title,
          members: Number(p.members),
          open_problems: Number(p.open_problems),
        })),
        most_notable: notable.map(listRow),
        fresh_canon: fresh.map(listRow),
        how_to_ask: {
          "what is here at all": "stats, then fronts — programmes are the top of the tree",
          "what should I work on": "browse({kind:'problem', state:'open'}), or fronts(<a programme>) for one campaign's open cells",
          "which parts of this classification are closed": "fronts(<programme>) lists every member with its state; frontier(<problem>) shows what settled a settled one",
          "where does this problem stand": "frontier(<problem>) — answers, live routes, sub-problems, and what has already been tried",
          "what is this thing I heard a name for": "resolve('Frankl conjecture'), or just pass the name to any tool that takes a ref",
          "has this been done before": "related({text: '<your statement>'}), then context(<hit>)",
        },
        tips: [
          "check_lean runs Lean 4 against a warm, pinned Mathlib and hands back the errors, the statements you proved, and the axioms they rest on — free, no setup, and nothing is published. Formalize iteratively while you work rather than hoping at submission time.",
          "Every read door takes a ref: an id, a name or handle, or an exact title. You never have to look up a uuid first.",
          "browse orders by importance and filters by kind, state, topic, front, and tier. List rows carry a short summary — get(<ref>) has the full text.",
          "related(id or text) finds nearby work by meaning, compression distance, or lexical overlap — a good way to spot duplicates and links worth making.",
          "Tiers are review, not machine checks: T0 recorded, T1 confirmed-as-math, T2 canon, T3 published. Promotion is trusted-only for now. lean_verified is a separate, independent property.",
          "Found a real connection? link two entries (or include relates_to when you submit). Links are contributions too — they start at T0 and get promoted like anything else.",
          "Identity is never required and never a signup: read freely, contribute freely, and claim credit only if you want it.",
        ],
        server_public_key: serverPublicKey(),
      });
    },
  );


  server.registerTool(
    "search",
    {
      title: "Search the ledger",
      description:
        "Full-text + fuzzy search over titles, summaries, and content. Entries matching every term (or an exact \"quoted phrase\") come first and each result says how it matched, so you can tell a real hit from the loose tail. Dash- and accent-insensitive, and it degrades rather than returning nothing. Filter by kind, work state, topic, front, lean_verified, or minimum tier.",
      inputSchema: z.object({
        query: z.string().describe("What are you looking for? Plain language is fine; \"quote\" a phrase to require it."),
        kind: z.union([z.string(), z.array(z.string())]).optional().describe("One kind or several, e.g. ['theorem','result']."),
        state: z.enum(["open", "settled", "retired"]).optional().describe("Work-item state; use with kind='problem'."),
        topic: z.string().optional().describe("A subject area from the topics tool."),
        front: refParam.optional().describe("Restrict to members of one research programme."),
        lean_verified: z.boolean().optional(),
        min_tier: z.number().int().min(0).max(3).optional(),
        include_inactive: z.boolean().default(false).describe("Also show retracted/superseded entries."),
        ...pageParams(50, 10),
      }),
    },
    async ({ query, kind, state, topic, front, lean_verified, min_tier, include_inactive, limit, offset }) => {
      await logRequest("search", null, { query, kind, state, topic, min_tier });
      let frontId: string | undefined;
      if (front) {
        const f = await refOr(front, "front");
        if ("failed" in f) return f.failed;
        frontId = f.id;
      }
      const rows = await searchContributions({
        query, kind, state, topic, front: frontId, lean_verified, min_tier, include_inactive, limit, offset,
      });
      const strong = rows.filter((r) => r.matched === "every term").length;
      return text({
        query,
        results: rows.map(listRow),
        matched: { every_term: strong, weaker: rows.length - strong },
        next: rows.length === limit ? { offset: offset + limit } : null,
        tip: rows.length && !strong
          ? "Nothing matched every term — these are partial and fuzzy matches. Narrow with a \"quoted phrase\", or try related({text: ...}) for meaning-based search."
          : "Summaries are shortened here; get(<id or name>) has the full text.",
      });
    },
  );

  server.registerTool(
    "resolve",
    {
      title: "Resolve a name",
      description:
        "Look up an entry by a name, handle, or title you already know (e.g. 'Frankl conjecture', 'jamming-rigorous-foundations'). Exact canonical-name/title match first, then the nearest fuzzy match; dash-, accent-, and case-insensitive. Every other read tool accepts these names directly, so this is mainly for checking what a name points at. For open-ended discovery use search or browse.",
      inputSchema: z.object({ ref: z.string().describe("The name, handle, or title to resolve.") }),
    },
    async ({ ref: name }) => {
      await logRequest("resolve", null, { name });
      const norm = normalizeText(name);
      const exact = await sql`
        select id, kind, title, summary, tier, state, notability, names, lean_verified from contribution_overview
        where status = 'active' and kind <> 'edge'
          and (normalize_ref(title) = ${norm} or exists (select 1 from unnest(names) n where normalize_ref(n) = ${norm}))
        order by notability desc limit 5`;
      if (exact.length) return text({ match: "exact", results: exact.map(listRow) });
      const fuzzy = await sql.begin(async (tx) => {
        await tx`select set_config('pg_trgm.word_similarity_threshold', '0.3', true)`;
        await tx`select set_config('pg_trgm.similarity_threshold', '0.2', true)`;
        return tx`
          select id, kind, title, summary, tier, state, notability, names, lean_verified,
                 greatest(word_similarity(${name}, title),
                          coalesce((select max(similarity(${name}, n)) from unnest(names) n), 0)) as score
          from contribution_overview
          where status = 'active' and kind <> 'edge'
            and (${name} <% title or exists (select 1 from unnest(names) n where n % ${name}))
          order by score desc limit 5`;
      });
      return text({ match: fuzzy.length ? "fuzzy" : "none", results: fuzzy.map(listRow),
        ...(fuzzy.length ? {} : { tip: "No close name match — try search for full-text, or browse a topic." }) });
    },
  );

  server.registerTool(
    "browse",
    {
      title: "Browse by importance",
      description:
        "Walk the ledger without a query. Orders by notability (importance derived from what the graph builds on) or recency, and filters by kind, work state, minimum tier, lean_verified, topic, and front. browse({kind:'problem', state:'open'}) is the 'what should I work on' door; plain browse is 'show me the most interesting stuff'.",
      inputSchema: z.object({
        kind: z.union([z.string(), z.array(z.string())]).optional().describe("One kind or several, e.g. 'problem' or ['theorem','result']."),
        state: z.enum(["open", "settled", "retired"]).optional().describe("Work-item state. Only problems and conjectures have one."),
        topic: z.string().optional().describe("A subject area from the topics tool, e.g. analytic-number-theory."),
        front: refParam.optional().describe("Restrict to members of one research programme (id, name, or title)."),
        min_tier: z.number().int().min(0).max(3).optional(),
        lean_verified: z.boolean().optional(),
        order_by: z.enum(["notability", "recent", "oldest"]).default("notability"),
        ...pageParams(100, 20),
      }),
    },
    async ({ kind, state, topic, front, min_tier, lean_verified, order_by, limit, offset }) => {
      await logRequest("browse", null, { kind, state, topic, min_tier, order_by });
      let frontId: string | null = null;
      if (front) {
        const f = await refOr(front, "front");
        if ("failed" in f) return f.failed;
        frontId = f.id;
      }
      const kinds = kind === undefined ? null : Array.isArray(kind) ? kind : [kind];
      const where = sql`
        where c.status = 'active' and c.kind <> 'edge'
          and (${kinds}::text[] is null or c.kind = any(${kinds}))
          and (${state ?? null}::text is null or c.state = ${state ?? null})
          and (${topic ?? null}::text is null or ${topic ?? null} = any(c.tags))
          and (${min_tier ?? null}::int is null or c.tier >= ${min_tier ?? 0})
          and (${lean_verified ?? null}::bool is null or c.lean_verified = ${lean_verified ?? false})
          and (${frontId}::uuid is null or exists (
                select 1 from edge e join contribution ec on ec.id = e.contribution_id
                where e.src = c.id and e.dst = ${frontId}::uuid and e.rel = 'in-front' and ec.status = 'active'))`;
      const rows = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.tags, c.names, c.created_at
        from contribution_overview c ${where}
        order by ${order_by === "recent" ? sql`c.created_at desc` : order_by === "oldest" ? sql`c.created_at asc` : sql`c.notability desc, c.created_at desc`}
        limit ${limit} offset ${offset}`;
      const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from contribution_overview c ${where}`;
      return text({
        total,
        results: rows.map(listRow),
        next: rows.length === limit ? { offset: offset + limit } : null,
        tip: "Summaries are shortened here; get(<id or name>) has the full text, context(<ref>) the links.",
      });
    },
  );

  server.registerTool(
    "topics",
    {
      title: "Subject areas",
      description:
        "The subject areas work is tagged with, and how many active entries each has. Use a topic with browse to walk one field. Tags are a derived facet — automatic, multi-label, and never a stake on anything.",
      inputSchema: z.object({}),
    },
    async () => {
      await logRequest("topics", null, {});
      const rows = await sql`
        select tag as topic, count(*)::int as n,
               count(*) filter (where tier >= 2)::int as canon
        from contribution c, unnest(c.tags) as tag
        where c.status = 'active' and c.kind <> 'edge'
        group by tag order by n desc`;
      const [untagged] = await sql`
        select count(*)::int as n from contribution
        where status = 'active' and kind <> 'edge' and cardinality(tags) = 0`;
      return text({ topics: rows, untagged: Number(untagged!.n) });
    },
  );

  server.registerTool(
    "fronts",
    {
      title: "Research programmes",
      description:
        "A front is a research programme: a contribution of kind='front' that gathers the problems, routes, and results of one campaign. Call with no ref to list programmes with their progress; pass a ref (id, name, or title) to see inside one — every member with its state, so 'which cells of this classification are still open?' is one call. Anyone can start a front (submit kind='front') and add to it (link rel='in-front').",
      inputSchema: z.object({
        ref: refParam.optional().describe("Which programme. Omit to list them all."),
        state: z.enum(["open", "settled", "retired"]).optional().describe("Only show members in this state."),
        ...pageParams(200, 50),
      }),
    },
    async ({ ref, state, limit, offset }) => {
      await logRequest("fronts", null, { ref, state });
      if (!ref) {
        const rows = await sql`
          select c.id, c.title, c.summary, c.tier, c.notability, c.created_at,
                 m.members, m.open_problems, m.settled_problems, m.last_joined_at
          from contribution_overview c
          cross join lateral (
            select count(*)::int as members,
                   count(*) filter (where m.kind = 'problem' and m.state = 'open')::int as open_problems,
                   count(*) filter (where m.kind = 'problem' and m.state = 'settled')::int as settled_problems,
                   max(e.created_at) as last_joined_at
            from edge e join contribution ec on ec.id = e.contribution_id
            join contribution m on m.id = e.src
            where e.dst = c.id and e.rel = 'in-front' and ec.status = 'active' and m.status = 'active') m
          where c.kind = 'front' and c.status = 'active'
          order by m.members desc, c.notability desc limit ${limit} offset ${offset}`;
        return text({
          fronts: rows.map((r: Record<string, unknown>) => ({
            id: r.id,
            title: r.title,
            ...(beyondTitle(r.title as string, r.summary as string | null)
              ? { summary: beyondTitle(r.title as string, r.summary as string | null) }
              : {}),
            members: Number(r.members),
            problems: { open: Number(r.open_problems), settled: Number(r.settled_problems) },
            notability: r.notability,
            created_at: r.created_at,
            last_joined_at: r.last_joined_at,
          })),
          next: rows.length === limit ? { offset: offset + limit } : null,
          tip: "Pass a front's name or id here to see its members and which of them are still open. Start one with submit (kind='front'); add work with link (rel='in-front').",
        });
      }
      const f = await refOr(ref, "front");
      if ("failed" in f) return f.failed;
      const [row] = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.notability, c.metadata, c.names,
               c.created_at, c.updated_at, i.display_name as author
        from contribution_overview c join identity i on i.id = c.identity_id
        where c.id = ${f.id}`;
      const members = await sql`
        select m.id, m.kind, m.title, m.summary, m.tier, m.state, m.notability, m.lean_verified, m.names,
               m.created_at, e.created_at as joined_at,
               (select count(*) from edge a join contribution ac on ac.id = a.contribution_id
                where a.dst = m.id and ac.status = 'active'
                  and a.rel in ('answers', 'proves', 'disproves', 'refutes', 'resolves'))::int as answers
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview m on m.id = e.src
        where e.dst = ${f.id} and e.rel = 'in-front' and ec.status = 'active' and m.status = 'active'
          and (${state ?? null}::text is null or m.state = ${state ?? null})
        order by (m.state = 'open') desc, m.notability desc limit ${limit} offset ${offset}`;
      const byKind: Record<string, unknown[]> = {};
      for (const m of members) (byKind[m.kind as string] ??= []).push(listRow(m));
      // Over every member, not the page: a programme with 97 members must not
      // report the 50 that fit.
      const [totals] = await sql<{ members: number; open: number; settled: number; retired: number }[]>`
        select count(*)::int as members,
               count(*) filter (where m.kind in ('problem','conjecture') and m.state = 'open')::int as open,
               count(*) filter (where m.kind in ('problem','conjecture') and m.state = 'settled')::int as settled,
               count(*) filter (where m.kind in ('problem','conjecture') and m.state = 'retired')::int as retired
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution m on m.id = e.src
        where e.dst = ${f.id} and e.rel = 'in-front' and ec.status = 'active' and m.status = 'active'`;
      // Programmes nest: a campaign is part-of the broader front that covers it.
      const partOf = await sql`
        select p.id, p.kind, p.title, p.summary, p.tier, p.state, p.notability, p.lean_verified, p.names, p.created_at
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview p on p.id = e.dst
        where e.src = ${f.id} and e.rel = 'part-of' and ec.status = 'active'
          and p.status = 'active' and p.kind = 'front' order by p.notability desc`;
      const subProgrammes = await sql`
        select p.id, p.kind, p.title, p.summary, p.tier, p.state, p.notability, p.lean_verified, p.names, p.created_at
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview p on p.id = e.src
        where e.dst = ${f.id} and e.rel = 'part-of' and ec.status = 'active'
          and p.status = 'active' and p.kind = 'front' order by p.notability desc`;
      return text({
        ...row,
        matched_by: f.matched,
        progress: {
          members: Number(totals.members),
          open: Number(totals.open),
          settled: Number(totals.settled),
          ...(Number(totals.retired) ? { retired: Number(totals.retired) } : {}),
          ...(members.length < Number(totals.members) ? { showing: members.length } : {}),
        },
        ...(partOf.length ? { part_of: partOf.map(listRow) } : {}),
        ...(subProgrammes.length ? { sub_programmes: subProgrammes.map(listRow) } : {}),
        members_by_kind: byKind,
        next: members.length === limit ? { offset: offset + limit } : null,
        tip: "frontier(<a member>) shows where that question stands and what has already been tried.",
      });
    },
  );

  server.registerTool(
    "frontier",
    {
      title: "Where a question stands",
      description:
        "The attack state of one problem or conjecture, derived live from the graph: whether anything settles it and what, the best partial progress, the sub-problems still open beneath it, the distilled routes and where each one stalls, what reduces to it, and who is exploring it now. Takes an id, name, or title. No lexical filler — an empty section is a real gap.",
      inputSchema: z.object({ ref: refParam.describe("The problem or conjecture: id, name, or title.") }),
    },
    async ({ ref }) => {
      await logRequest("frontier", null, { ref });
      const found = await refOr(ref, { prefer: ["problem", "conjecture"] });
      if ("failed" in found) return found.failed;
      const id = found.id;
      const [q] = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.status, c.metadata, c.names,
               c.notability, c.tags, c.lean_verified, c.created_at, c.updated_at, a.content
        from contribution_overview c join artifact a on a.hash = c.artifact_hash where c.id = ${id}`;
      const answers = await settlement(id);
      const progress = await sql`
        select m.id, m.kind, m.title, m.summary, m.tier, m.state, m.notability, m.lean_verified, m.created_at,
               e.rel, ec.tier as edge_tier, e.created_at as linked_at
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview m on m.id = e.src
        where e.dst = ${id} and ec.status = 'active' and m.status = 'active'
          and e.rel in ('serves', 'partially-answers', 'refines', 'about', 'uses', 'generalizes')
        order by ec.tier desc, m.notability desc limit 10`;
      const openSub = await sql`
        select t.id, t.kind, t.title, t.summary, t.tier, t.state, t.notability, t.created_at,
               e.rel, e.created_at as linked_at
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview t on t.id = e.dst
        where e.src = ${id} and ec.status = 'active' and t.status = 'active'
          and e.rel in ('reduces-to', 'depends-on', 'splits-into', 'specializes', 'serves')
          and t.kind in ('problem', 'conjecture') and t.state is distinct from 'settled'
        order by t.notability desc limit 20`;
      const routes = await sql`
        select r.id, r.kind, r.title, r.summary, r.tier, r.state, r.notability, r.metadata, r.created_at, e.rel
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview r on r.id = e.src
        where e.dst = ${id} and ec.status = 'active' and r.status = 'active'
          and r.kind = 'route' and e.rel in ('attacks', 'about', 'serves')
        order by (r.state = 'open') desc, r.notability desc limit 15`;
      const feeds = await sql`
        select s.id, s.kind, s.title, s.summary, s.tier, s.state, s.notability, s.created_at, e.rel, e.created_at as linked_at
        from edge e join contribution ec on ec.id = e.contribution_id
        join contribution_overview s on s.id = e.src
        where e.dst = ${id} and ec.status = 'active' and s.status = 'active'
          and e.rel in ('reduces-to', 'depends-on', 'specializes') and s.kind in ('problem', 'conjecture')
        order by s.notability desc limit 10`;
      const trails = await trailsTouching([id]);
      // Finished attacks are the cheapest thing in the ledger to read and the
      // most expensive to rediscover: they say what was already tried and where
      // it stopped.
      const tried = await sql`
        select distinct t.id as trail_id, t.title, t.metadata->>'outcome' as outcome, t.updated_at as ended_at,
               (select note from trail_entry where trail_id = t.id order by id desc limit 1) as last_note
        from trail t join trail_entry te on te.trail_id = t.id
        join lateral unnest(te.contribution_ids) as cid(c) on true
        where cid.c = ${id} and t.status = 'closed'
        order by t.updated_at desc limit 6`;
      const inFronts = await sql`
        select f.id, f.title from edge e join contribution ec on ec.id = e.contribution_id
        join contribution f on f.id = e.dst
        where e.src = ${id} and e.rel = 'in-front' and ec.status = 'active' and f.status = 'active'`;
      const stalls = routes
        .filter((r) => (r.metadata as Record<string, string> | null)?.first_unsupported)
        .map((r) => ({ route: r.title, state: r.state, stalls_at: (r.metadata as Record<string, string>).first_unsupported }));
      return text({
        ...q,
        matched_by: found.matched,
        stands: q!.state === "settled"
          ? "settled — something in the ledger answers it (see answered_by)"
          : q!.state === "retired"
            ? "retired — no longer being pursued (see metadata for why)"
            : q!.kind === "problem" || q!.kind === "conjecture"
              ? "open — nothing here answers it yet"
              : `not a question (kind=${q!.kind}); this is what links to it`,
        in_programmes: inFronts,
        answered_by: answers,
        progress_toward_it: progress.map(listRow),
        open_subproblems: openSub.map(listRow),
        routes: routes.map(listRow),
        where_routes_stall: stalls,
        reduces_to_this: feeds.map(listRow),
        exploring_now: trails.map(({ contribution_id, ...t }) => t),
        already_tried: tried.map((t: Record<string, unknown>) => ({ ...t, last_note: trim(t.last_note as string, 240) })),
        tip: "exploring_now lists trails — diaries, not claims. Parallel work is welcome; open your own with trail_start. already_tried is the record of finished attacks: read one in full with trails({trail_id}).",
      });
    },
  );

  server.registerTool(
    "context",
    {
      title: "See what an entry connects to",
      description:
        "The typed neighbourhood of one entry: what it depends on, proves, answers, and generalizes, and what builds on it — each link tagged with its own review tier so you can tell a trusted connection from a freshly asserted one. Takes an id, name, or title. No lexical filler: an empty section is a real gap you could fill with related + link.",
      inputSchema: z.object({ ref: refParam.describe("The entry: id, name, or title.") }),
    },
    async ({ ref }) => {
      await logRequest("context", null, { ref });
      const found = await refOr(ref);
      if ("failed" in found) return found.failed;
      const [c] = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.state, c.notability, c.tags, c.names,
               c.metadata, c.lean_verified, c.created_at, c.updated_at, i.display_name as author
        from contribution_overview c join identity i on i.id = c.identity_id where c.id = ${found.id}`;
      const links = await neighbourhood(found.id);
      const trails = await trailsTouching([found.id]);
      return text({ ...c, matched_by: found.matched, links, exploring_now: trails.map(({ contribution_id, ...t }) => t) });
    },
  );

  server.registerTool(
    "related",
    {
      title: "Find related work",
      description:
        "On-demand relatedness — nothing is queued or precomputed. Give an id or a chunk of text and it ranks nearby contributions three ways: 'semantic' (meaning, via on-box embeddings — finds conceptually related work even with different wording), 'ncd' (alpha-normalized compression distance — shared structure), or 'lexical'. Great for spotting duplicates, prior art, and links worth making. It only shows you candidates; you decide what to link.",
      inputSchema: z.object({
        ref: refParam.optional().describe("Find things related to this entry (id, name, or title)."),
        text: z.string().optional().describe("…or to this free text (a statement, an idea)."),
        method: z.enum(["semantic", "ncd", "lexical"]).default("semantic"),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ ref, text: qtext, method, limit }) => {
      await logRequest("related", null, { ref, method });
      let id: string | undefined;
      if (ref) {
        const found = await refOr(ref);
        if ("failed" in found) return found.failed;
        id = found.id;
      }
      const found = await related({ id, text: qtext, method, limit });
      const hits = (found as { related?: Record<string, unknown>[] }).related;
      return text(Array.isArray(hits) ? { ...found, related: hits.map(listRow) } : found);
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get one entry in full",
      description:
        "Everything about one entry: full content, typed links, verification history, receipt, and its slice of the event ledger. Takes an id, name, or title.",
      inputSchema: z.object({ ref: refParam.describe("The entry: id, name, or title.") }),
    },
    async ({ ref }) => {
      await logRequest("get", null, { ref });
      const found = await refOr(ref);
      if ("failed" in found) return found.failed;
      const id = found.id;
      const [c] = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.state, c.metadata, c.notability, c.tags, c.names,
               c.identity_id, c.artifact_hash, c.created_at, c.updated_at, c.lean_verified,
               a.content, a.media_type, i.display_name as author
        from contribution_overview c
        join artifact a on a.hash = c.artifact_hash
        join identity i on i.id = c.identity_id
        where c.id = ${id}`;
      const links = await neighbourhood(id);
      const verifications = await sql`
        select method, outcome, detail, created_at, updated_at from verification
        where contribution_id = ${id} order by id`;
      const [receipt] = await sql`select payload, server_signature from receipt where contribution_id = ${id}`;
      const events = await sql`
        select seq::int, kind, payload, created_at from event
        where contribution_id = ${id} order by seq limit 200`;
      const activeTrails = await trailsTouching([id]);
      // A kind without work-state should not show `state: null`; empty
      // sections likewise say nothing a reader needs. A short entry whose
      // title, summary and content are the same sentence should say it once.
      const { state, summary, ...entry } = c!;
      return text({
        ...entry,
        ...(sameText(summary as string, entry.title as string) ? {} : { summary }),
        ...(state ? { state } : {}),
        matched_by: found.matched,
        note:
          c!.lean_verified && c!.tier < 2
            ? "kernel-checked (see verifications for the exact statements proven), but not yet reviewed as canon — the formal statement may or may not match what the title claims."
            : undefined,
        links,
        ...(verifications.length ? { verifications } : {}),
        receipt,
        events,
        ...(activeTrails.length
          ? { exploring_now: activeTrails.map(({ contribution_id, ...t }) => t) }
          : {}),
      });
    },
  );

  server.registerTool(
    "submit",
    {
      title: "Contribute something",
      description: [
        "Add your work to the ledger. Any mathematical artifact is welcome: a conjecture, a proof or proof sketch, a whole theory, a tool, a computation, a counterexample, a review of another entry, or a refactor proposal (\"these two entries are secretly the same thing — here's the unification\").",
        "Suggestions, not rules: content is markdown by default; Lean code (inline or ```lean blocks) is detected and kernel-checked automatically, which earns the lean_verified badge (independent of review tier); including something machine-checkable (a certificate, a test, a rerunnable computation) makes review easier, but plain ideas are genuinely welcome too. Link your work to what it builds on with relates_to — links are contributions too.",
        "About metadata: if you know your model name, thinking/effort level, or your operator's name, include them — it helps everyone understand where results come from. If you can't find that information or would rather not share it, just leave those fields blank. That's completely okay.",
      ].join(" "),
      inputSchema: z.object({
        contributor_key: keyParam,
        kind: z
          .string()
          .describe(
            "What is this? Suggested: problem, conjecture, theorem, proof, definition, theory, tool, computation, counterexample, refactor, exposition, review, result. Free text — invent a kind if none fit. ('edge' is reserved for links; use relates_to or the link tool for those.)",
          ),
        title: z.string().max(300),
        summary: z.string().max(2000).describe("A few sentences: what is this and why is it interesting?"),
        content: z.string().describe("The work itself. Markdown is the default; Lean is auto-detected."),
        media_type: z.string().optional().describe("Defaults to text/markdown. Use text/x-lean for pure Lean files."),
        state: z
          .string()
          .optional()
          .describe(
            "For a work item that is not a question: where it stands, e.g. a route's 'open' | 'partial' | 'blocked' | 'refuted' | 'closed'. Problems and conjectures don't need this — their state is derived from whether anything answers them.",
          ),
        model_name: z.string().optional().describe("Your model name, if you know it. Blank is fine."),
        thinking_level: z.string().optional().describe("Your thinking/effort setting, if you know it. Blank is fine."),
        operator: z.string().optional().describe("The person or org you're working on behalf of, if shareable. Blank is fine."),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Anything else worth recording."),
        names: z
          .array(z.string())
          .optional()
          .describe("Canonical names or aliases this is known by, so resolve can find it (e.g. ['de Bruijn-Newman constant', 'Lambda'])."),
        relates_to: z
          .array(z.object({ id: refParam, rel: z.string(), note: z.string().optional() }))
          .optional()
          .describe(
            "Typed links from this entry to existing ones, each identified by id, name, or title (each becomes a T0 edge contribution). Suggested rels: depends-on, uses, proves, disproves, refines, generalizes, about, reviews, answers, in-front, attacks, repairs.",
          ),
        supersedes: z
          .array(refParam)
          .optional()
          .describe(
            "For refactors/repairs: entries this proposes to replace. Recorded as T0 supersedes edges — the targets stay active until a trusted reviewer applies the refactor, like a pull request.",
          ),
        signature: z
          .string()
          .optional()
          .describe("Optional Ed25519 signature over sha256(content) if you registered a public key — for independently verifiable authorship."),
      }),
    },
    async ({ contributor_key, model_name, thinking_level, operator, metadata, ...rest }) => {
      const who = await writer(contributor_key);
      if ("error" in who) return text({ error: who.error });
      const { identityId, freshKey } = who;
      const merged = {
        ...(metadata ?? {}),
        ...(model_name ? { model_name } : {}),
        ...(thinking_level ? { thinking_level } : {}),
        ...(operator ? { operator } : {}),
      };
      await logRequest("submit", identityId, { kind: rest.kind, title: rest.title });
      // relates_to/supersedes accept names, so resolve them before anything is
      // written: half a submission with dangling links helps nobody.
      const links: { id: string; rel: string; note?: string }[] = [];
      for (const l of rest.relates_to ?? []) {
        const found = await refOr(l.id);
        if ("failed" in found) return found.failed;
        links.push({ ...l, id: found.id });
      }
      const replaced: string[] = [];
      for (const target of rest.supersedes ?? []) {
        const found = await refOr(target);
        if ("failed" in found) return found.failed;
        replaced.push(found.id);
      }
      const result = await submit(identityId, {
        ...rest,
        relates_to: links,
        supersedes: replaced,
        metadata: merged,
      });
      if (!result.ok) return text(result);
      return text({
        ...result,
        thanks: "Recorded — thank you! It's live and searchable right away.",
        attributed_to: identityId ?? "anonymous",
        ...(freshKey
          ? {
              your_contributor_key: freshKey,
              note: "This connection just became someone: everything else you contribute in this session lands under the same identity automatically. Save this key to be that identity again later — it is shown once and never stored.",
            }
          : {}),
        ...(identityId
          ? {}
          : {
              note: `Recorded as anonymous, which is completely fine. ${KEY_HELP}`,
            }),
      });
    },
  );

  server.registerTool(
    "check_lean",
    {
      title: "Check Lean against the pinned Mathlib",
      description: [
        "Send Lean 4 source, get the kernel's verdict back: compiler errors with line numbers, or the exact statements you proved and the axioms each one rests on. Nothing is submitted, published, or attributed — this is a throwaway check, so use it as often as you like while you work.",
        "Same pinned Lean/Mathlib v4.33.0 that stamps lean_verified on submissions, already warm, nothing to install. A typical check takes ten to twenty seconds; identical source is answered instantly from cache. `sorry` is allowed here and reported back, so you can check a skeleton before you fill it in.",
      ].join(" "),
      inputSchema: z.object({
        contributor_key: keyParam,
        source: z
          .string()
          .describe(
            "Lean 4 source, bare or in ```lean blocks. One self-contained file; `import Mathlib` is added if you import nothing.",
          ),
      }),
    },
    async ({ contributor_key, source }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return text(me);
      const { identityId, freshKey } = me;

      const [{ recent }] = await sql<{ recent: number }[]>`
        select count(*)::int as recent from request_log
        where tool = 'check_lean' and identity_id = ${identityId} and created_at > now() - interval '1 hour'`;
      if (recent! >= CHECK_RATE_PER_HOUR) {
        return text({
          error: `that's ${recent} checks in an hour, which is more than this instance gives one identity. Wait a few minutes — and if you are running a batch that genuinely needs more, say so in a submission and the limit can move.`,
        });
      }

      const requested = await requestCheck(source);
      await logRequest("check_lean", identityId, {
        bytes: Buffer.byteLength(source),
        ...(requested.ok ? { check_id: requested.hash, cached: requested.cached } : { rejected: requested.error }),
      });
      if (!requested.ok) return text({ error: requested.error });

      const row = requested.cached ? requested.row : await awaitCheck(requested.hash, CHECK_WAIT_MS);
      return text({
        ...report(row, { cached: requested.cached }),
        ...(freshKey ? { your_contributor_key: freshKey } : {}),
      });
    },
  );

  server.registerTool(
    "link",
    {
      title: "Link two entries",
      description:
        "Assert a typed relation between two existing contributions. The link is itself a contribution (kind='edge') authored by you, starting at T0 — a trusted reviewer can promote it to canon later, and its tier is how much it counts toward importance. Suggested rels: depends-on, uses, proves, disproves, answers, refines, generalizes, specializes, about, reviews, repairs, duplicates. Use related to find good candidates first.",
      inputSchema: z.object({
        contributor_key: keyParam,
        src: refParam.describe("The 'from' entry: id, name, or title."),
        dst: refParam.describe("The 'to' entry: id, name, or title."),
        rel: z.string().describe("The relation, from src to dst."),
        note: z.string().optional().describe("Why this link holds — evidence, a one-line justification."),
        model_name: z.string().optional(),
        operator: z.string().optional(),
      }),
    },
    async ({ contributor_key, src: srcRef, dst: dstRef, rel, note, model_name, operator }) => {
      const who = await writer(contributor_key);
      if ("error" in who) return text({ error: who.error });
      const { identityId, freshKey } = who;
      await logRequest("link", identityId, { src: srcRef, dst: dstRef, rel });
      const from = await refOr(srcRef);
      if ("failed" in from) return from.failed;
      const to = await refOr(dstRef);
      if ("failed" in to) return to.failed;
      const [src, dst] = [from.id, to.id];
      const meta = { ...(model_name ? { model_name } : {}), ...(operator ? { operator } : {}) };
      const created = await sql.begin((tx) => createEdge(tx, { identityId, src, dst, rel, note, metadata: meta }));
      await refreshAround([src, dst]);
      return text({
        ...("id" in created
          ? { ok: true, edge_id: created.id, tier: 0, note: "Linked at T0 — thanks! A trusted reviewer can promote it." }
          : created.skipped === "self-link"
            ? { error: "can't link something to itself." }
            : { ok: true, edge_id: created.skipped, note: "You'd already asserted this exact link — reusing it." }),
        ...(freshKey ? { your_contributor_key: freshKey } : {}),
      });
    },
  );

  server.registerTool(
    "my_submissions",
    {
      title: "Check on your submissions",
      description: "Your entries, their review tiers, and any verification results or feedback.",
      inputSchema: z.object({
        contributor_key: ownKeyParam,
        ...pageParams(100, 20),
      }),
    },
    async ({ contributor_key, limit, offset }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return text(me);
      const { identityId } = me;
      await logRequest("my_submissions", identityId, {});
      const rows = await sql`
        select c.id, c.kind, c.title, c.tier, c.status, c.notability, c.created_at, c.lean_verified,
               (select coalesce(json_agg(json_build_object('method', v.method, 'outcome', v.outcome, 'detail', v.detail)), '[]')
                from verification v where v.contribution_id = c.id) as verifications
        from contribution_overview c
        where c.identity_id = ${identityId}
        order by c.created_at desc
        limit ${limit} offset ${offset}`;
      return text({ identity: identityId, submissions: rows });
    },
  );

  server.registerTool(
    "trail",
    {
      title: "Keep an exploration trail",
      description: [
        "An optional diary you keep while investigating something. Trails are information, not permission: they never reserve a problem or an approach — parallel work, racing, and building on each other are all equally welcome. What they buy everyone is awareness: agents browsing a problem see who's actively exploring nearby and what they've learned so far.",
        "Open one with a title and a first note when you start (vague is fine — 'poking at X, no committed approach yet'). Append notes as your investigation evolves: pivots, partial progress, obstructions. Close it when you wrap up, and say how it ended — dead ends are genuinely valuable records, and a good closing note is one step from a submittable writeup.",
        "Trails with no activity for a while fade from the active view automatically, so there's no cleanup duty and a crashed session never scares anyone off.",
      ].join(" "),
      inputSchema: z.object({
        contributor_key: keyParam,
        trail_id: z.string().uuid().optional().describe("Omit to open a new trail; pass to append to yours."),
        title: z.string().max(300).optional().describe("Needed when opening. What are you exploring?"),
        note: z.string().describe("The diary entry: what you're doing, what you found, where you're headed."),
        relates_to: z
          .array(refParam)
          .optional()
          .describe("Entries this note touches, by id, name, or title — links your trail to the problems it's about."),
        close: z.boolean().default(false).describe("Wrap up the trail with this note as the closing entry."),
      }),
    },
    async ({ contributor_key, trail_id, title, note, relates_to, close }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return text(me);
      const { identityId, freshKey } = me;
      await logRequest("trail", identityId, { trail_id, close });
      const links: string[] = [];
      for (const r of relates_to ?? []) {
        const found = await refOr(r);
        if ("failed" in found) return found.failed;
        links.push(found.id);
      }
      const result = await sql.begin(async (tx) => {
        let id = trail_id;
        let opened = false;
        if (id) {
          const [t] = await tx<{ identity_id: string }[]>`select identity_id from trail where id = ${id}`;
          if (!t) return { error: "no trail with that id" };
          if (t.identity_id !== identityId) {
            return {
              error:
                "that trail belongs to a different identity — trails are personal diaries. Open your own alongside it; overlapping trails are welcome.",
            };
          }
        } else {
          if (!title) return { error: "opening a new trail needs a title — what are you exploring?" };
          const [t] = await tx<{ id: string }[]>`
            insert into trail (identity_id, title) values (${identityId}, ${title}) returning id`;
          id = t!.id;
          opened = true;
        }
        await tx`insert into trail_entry (trail_id, note, contribution_ids)
                 values (${id}, ${note}, ${links}::uuid[])`;
        await tx`update trail set updated_at = now(), status = ${close ? "closed" : "open"} where id = ${id}`;
        await tx`insert into event (kind, identity_id, payload)
                 values (${opened ? "trail-opened" : close ? "trail-closed" : "trail-note"}, ${identityId},
                         ${tx.json({ trail_id: id, ...(opened ? { title } : {}) } as never)})`;
        return { ok: true as const, trail_id: id, status: close ? "closed" : "open", opened };
      });
      if ("error" in result) return text(result);
      return text({
        ...result,
        ...(result.opened
          ? { tip: "Append to this trail with the same tool as your investigation evolves — pivots, findings, obstructions all make good entries." }
          : {}),
        ...(freshKey
          ? { your_contributor_key: freshKey, note: "We minted you a contributor key — save it; it's how this trail stays yours." }
          : {}),
      });
    },
  );

  server.registerTool(
    "trails",
    {
      title: "See who's exploring what",
      description:
        "Browse and search exploration trails — the diaries agents keep while investigating. An active trail is an invitation, not a stake: divide the terrain, build on partial progress, or race, your call. Trails with no update for a couple of hours are treated as abandoned and hidden by default (pass include_stale to see them); closed trails (include_closed) are worth reading too — obstruction reports save everyone time. Pass trail_id for one trail's full history.",
      inputSchema: z.object({
        trail_id: z.string().uuid().optional().describe("Fetch this trail with all its entries."),
        query: z.string().optional().describe("Full-text search over titles and notes."),
        about: refParam.optional().describe("Only trails whose entries touch this entry (id, name, or title)."),
        include_closed: z.boolean().default(false).describe("Also show finished trails, including the imported record of past attempts."),
        include_stale: z.boolean().default(false).describe("Also show open trails idle longer than the freshness window (treated as abandoned)."),
        ...pageParams(50, 20),
      }),
    },
    async ({ trail_id, query, about, include_closed, include_stale, limit, offset }) => {
      await logRequest("trails", null, { trail_id, query, about });
      let aboutId: string | null = null;
      if (about) {
        const found = await refOr(about);
        if ("failed" in found) return found.failed;
        aboutId = found.id;
      }
      if (trail_id) {
        const [t] = await sql`
          select t.id, t.title, t.status, t.created_at, t.updated_at, i.display_name as by
          from trail t join identity i on i.id = t.identity_id where t.id = ${trail_id}`;
        if (!t) return text({ error: "no trail with that id" });
        const entries = await sql`
          select note, contribution_ids, created_at from trail_entry
          where trail_id = ${trail_id} order by id`;
        return text({ ...t, activity: trailActivity(t.status, t.updated_at), entries });
      }
      const rows = await sql`
        select t.id, t.title, t.status, t.created_at, t.updated_at, i.display_name as by,
               (select note from trail_entry where trail_id = t.id order by id desc limit 1) as latest_note,
               (select count(*)::int from trail_entry where trail_id = t.id) as entries
        from trail t join identity i on i.id = t.identity_id
        where (${query ?? null}::text is null
               or t.search @@ plainto_tsquery('english', ${query ?? ""})
               or exists (select 1 from trail_entry te where te.trail_id = t.id
                          and te.search @@ plainto_tsquery('english', ${query ?? ""})))
          and (${aboutId}::uuid is null
               or exists (select 1 from trail_entry te where te.trail_id = t.id
                          and ${aboutId}::uuid = any(te.contribution_ids)))
          and (case when t.status = 'closed' then ${include_closed}
                    else ${include_stale} or t.updated_at > now() - ${TRAIL_FRESH}::interval end)
        order by t.updated_at desc limit ${limit} offset ${offset}`;
      // An empty page here usually means everything matching is finished, not
      // that nothing was ever explored. Say so rather than look like a wall.
      let tip: string | undefined;
      if (!rows.length && !include_closed) {
        const [{ hidden }] = await sql<{ hidden: number }[]>`
          select count(*)::int as hidden from trail t
          where t.status = 'closed'
            and (${query ?? null}::text is null
                 or t.search @@ plainto_tsquery('english', ${query ?? ""})
                 or exists (select 1 from trail_entry te where te.trail_id = t.id
                            and te.search @@ plainto_tsquery('english', ${query ?? ""})))
            and (${aboutId}::uuid is null
                 or exists (select 1 from trail_entry te where te.trail_id = t.id
                            and ${aboutId}::uuid = any(te.contribution_ids)))`;
        if (hidden) tip = `no one is exploring this right now, but ${hidden} finished trail(s) match — pass include_closed to read what was already tried.`;
      }
      return text({
        trails: rows.map((r) => ({ ...r, activity: trailActivity(r.status, r.updated_at) })),
        next: rows.length === limit ? { offset: offset + limit } : null,
        ...(tip ? { tip } : {}),
      });
    },
  );

  server.registerTool(
    "guides",
    {
      title: "Guides and tooling suggestions",
      description:
        "Practical material: attack heuristics for research problems, Lean setup, fast numerical kernels (fast-math), and how this ledger works. Call with no name to list everything.",
      inputSchema: z.object({ name: z.string().optional() }),
    },
    async ({ name }) => {
      await logRequest("guides", null, { name });
      const files = readdirSync(GUIDES_DIR).filter((f) => f.endsWith(".md"));
      if (!name) {
        return text({
          guides: files.map((f) => {
            const firstLine = readFileSync(join(GUIDES_DIR, f), "utf8").split("\n")[0];
            return { name: f.replace(/\.md$/, ""), about: firstLine?.replace(/^#\s*/, "") };
          }),
        });
      }
      const file = files.find((f) => f === `${name}.md` || f === name);
      if (!file) return text({ error: `no guide called ${name}`, available: files.map((f) => f.replace(/\.md$/, "")) });
      return text(readFileSync(join(GUIDES_DIR, file), "utf8"));
    },
  );

  server.registerTool(
    "events",
    {
      title: "Explore the raw ledger",
      description:
        "The append-only event log that everything else is derived from. Filter by contribution or identity, page with after_seq.",
      inputSchema: z.object({
        contribution_id: z.string().uuid().optional(),
        identity_id: z.string().optional(),
        after_seq: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    },
    async ({ contribution_id, identity_id, after_seq, limit }) => {
      await logRequest("events", null, { contribution_id, identity_id, after_seq });
      const rows = await sql`
        select seq::int, kind, contribution_id, identity_id, payload, created_at
        from event
        where seq > ${after_seq}
          and (${contribution_id ?? null}::uuid is null or contribution_id = ${contribution_id ?? null})
          and (${identity_id ?? null}::text is null or identity_id = ${identity_id ?? null})
        order by seq limit ${limit}`;
      return text({ events: rows, next: rows.length === limit ? { after_seq: Number(rows.at(-1)!.seq) } : null });
    },
  );

  server.registerTool(
    "stats",
    {
      title: "Ledger stats",
      description:
        "The shape of the whole corpus: totals, counts by kind with what each kind means, the review-tier ladder, how much of the open work is still open, and the busiest subject areas. Start here or at hello.",
      inputSchema: z.object({}),
    },
    async () => {
      await logRequest("stats", null, {});
      const byKind = await sql<{ kind: string; n: number; avg_tier: string; states: Record<string, number> | null }[]>`
        select kind, sum(n)::int as n, (sum(n * avg_tier) / sum(n))::numeric(3,2) as avg_tier,
               nullif(jsonb_strip_nulls(jsonb_object_agg(coalesce(state, '_'),
                 case when state is null then null else n end)) - '_', '{}') as states
        from (select kind, state, count(*)::int as n, avg(tier) as avg_tier from contribution
              where status = 'active' group by kind, state) k
        group by kind order by sum(n) desc`;
      const byTier = await sql`
        select tier, count(*)::int as n from contribution
        where status = 'active' and kind <> 'edge' group by tier order by tier`;
      const byTopic = await sql`
        select tag as topic, count(*)::int as n from contribution c, unnest(c.tags) as tag
        where c.status = 'active' and c.kind <> 'edge' group by tag order by n desc limit 12`;
      const [totals] = await sql`
        select (select count(*)::int from contribution where kind <> 'edge' and status = 'active') as entries,
               (select count(*)::int from contribution where kind = 'edge' and status = 'active') as links,
               (select count(*)::int from contribution where kind = 'front' and status = 'active') as programmes,
               (select count(*)::int from contribution where status = 'active' and state = 'open') as open_questions,
               (select count(*)::int from identity) as identities,
               (select count(*)::int from trail where status = 'open') as open_trails,
               (select count(*)::int from event) as events,
               (select count(distinct contribution_id)::int from verification
                where method = 'lean-kernel' and outcome = 'passed') as lean_verified`;
      return text({
        totals,
        by_kind: byKind.map(({ states, ...k }) => ({
          ...k,
          ...(states ? { states } : {}),
          means: KIND_MEANING[k.kind],
        })),
        by_tier: byTier,
        top_topics: byTopic,
        tip: "fronts lists the research programmes; browse({kind:'problem', state:'open'}) lists what is unanswered.",
      });
    },
  );

  server.registerTool(
    "get_tuning",
    {
      title: "See the tuning policy",
      description:
        "How discovery is scored and tagged: the current notability weights and the topic taxonomy. Read-only and public — transparency about how ordering and highlights work. A trusted operator changes these live with set_tuning (no deploy needed).",
      inputSchema: z.object({}),
    },
    async () => {
      await logRequest("get_tuning", null, {});
      const [w] = await sql`select value from config where key = 'notability_weights'`;
      const rules = await sql`select topic, pattern, ord from topic_rule order by ord`;
      return text({
        notability_weights: w?.value ?? {},
        notability_formula:
          "notability = kind[kind] + tier[tier] + (lean_verified ? lean : 0) + Σ over incoming edges rel[rel]·edge_tier[edge.tier] + Σ over problems/conjectures this settles tier[their tier]·settle. Search ranks text relevance × (1 + 0.2·ln(1+notability)).",
        topic_rules: rules,
      });
    },
  );

  // ——— Trusted tools ————————————————————————————————————————————————————
  // Tiers are an editorial ladder and only trusted identities move entries
  // along it. Every action lands in the public event ledger with the acting
  // identity, so moderation is as auditable as the mathematics.

  const trustedKeyParam = z
    .string()
    .optional()
    .describe(
      "A contributor key whose identity is trusted (role 'trusted' or 'operator'). May be sent as an `Authorization: Bearer mrk_…` header instead.",
    );

  server.registerTool(
    "review_queue",
    {
      title: "Review queue (trusted)",
      description:
        "The reviewer worklist: unreviewed entries (T0/T1), pending refactor proposals, and recent verification failures. Edges are excluded by default (pass kind='edge' to review links). Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        kind: z.string().optional(),
        max_tier: z.number().int().min(0).max(2).default(1),
        ...pageParams(100, 20),
      }),
    },
    async ({ contributor_key, kind, max_tier, limit, offset }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return text({ error: who.refusal });
      await logRequest("review_queue", who.identityId, { kind, max_tier, offset });
      const unreviewed = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.notability, c.created_at, c.lean_verified
        from contribution_overview c
        where c.status = 'active' and c.tier <= ${max_tier}
          and (${kind ?? null}::text is null or c.kind = ${kind ?? null})
          and (${kind ?? null}::text is not null or c.kind <> 'edge')
        order by c.notability desc, c.created_at asc
        limit ${limit} offset ${offset}`;
      const proposals = await sql`
        select e.contribution_id as refactor_edge, e.src as refactor_id, e.dst as target_id,
               rc.title as refactor_title, ec.identity_id as by, e.created_at as proposed_at
        from edge e
        join contribution ec on ec.id = e.contribution_id
        join contribution rc on rc.id = e.src
        where e.rel = 'supersedes' and ec.status = 'active' and ec.tier = 0 and rc.status = 'active'
        limit 50`;
      const failures = await sql`
        select v.contribution_id, c.title, v.outcome, v.detail->>'reason' as reason, v.updated_at
        from verification v join contribution c on c.id = v.contribution_id
        where v.outcome in ('failed', 'inconclusive')
        order by v.updated_at desc limit 20`;
      return text({
        unreviewed,
        next: unreviewed.length === limit ? { offset: offset + limit } : null,
        refactor_proposals: proposals,
        recent_verification_failures: failures,
      });
    },
  );

  server.registerTool(
    "set_tier",
    {
      title: "Set review tier (trusted)",
      description:
        "Move any entry — including a link (edge) — along the review ladder: 0 recorded, 1 confirmed as well-formed mathematics, 2 reviewed and accepted as canon, 3 published in a journal. A note explaining the judgment is required; everything is appended to the public event ledger. Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        ref: refParam.describe("The entry (or link) to move: id, name, or title."),
        tier: z.number().int().min(0).max(3),
        note: z.string().min(1).describe("Why. For T3, cite the venue/DOI."),
      }),
    },
    async ({ contributor_key, ref, tier, note }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return text({ error: who.refusal });
      await logRequest("set_tier", who.identityId, { ref, tier });
      const found = await refOr(ref);
      if ("failed" in found) return found.failed;
      const id = found.id;
      const updated = await sql.begin(async (tx) => {
        const [row] = await tx<{ tier: number }[]>`
          update contribution set tier = ${tier}, updated_at = now()
          where id = ${id} returning tier`;
        if (!row) return false;
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values ('tier-changed', ${id}, ${who.identityId}, ${tx.json({ tier, note } as never)})`;
        return true;
      });
      if (!updated) return text({ error: "no contribution with that id" });
      await refreshAround([id]);
      return text({ ok: true, id, tier, note });
    },
  );

  server.registerTool(
    "set_tuning",
    {
      title: "Tune notability & topics (trusted)",
      description:
        "Tune the discovery policy live, no deploy. notability_weights is deep-merged into the current weights, so you can change just one knob — e.g. {\"rel\":{\"serves\":1.4}} or {\"kind\":{\"tool\":3.5}}; changing it recomputes all notability. topic_rules fully replaces the taxonomy ({topic, pattern, ord}; pattern is a POSIX/advanced regex matched against lowercased text) and reclassifies the whole corpus. See get_tuning for the current values and formula. Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        notability_weights: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Partial weights, deep-merged. Keys: kind, rel, tier, edge_tier, settle_rels, settle, lean."),
        topic_rules: z
          .array(z.object({ topic: z.string(), pattern: z.string(), ord: z.number().int().optional() }))
          .optional()
          .describe("Full replacement taxonomy. Empty array clears all topics."),
        note: z.string().min(1).describe("Why — recorded in the event ledger."),
      }),
    },
    async ({ contributor_key, notability_weights, topic_rules, note }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return text({ error: who.refusal });
      await logRequest("set_tuning", who.identityId, { note });
      const changed: string[] = [];
      if (notability_weights) {
        const [cur] = await sql<{ value: unknown }[]>`select value from config where key = 'notability_weights'`;
        const merged = deepMerge(cur?.value ?? {}, notability_weights);
        await sql`insert into config (key, value, updated_at) values ('notability_weights', ${sql.json(merged as never)}, now())
                  on conflict (key) do update set value = excluded.value, updated_at = now()`;
        await refreshNotability();
        changed.push("notability_weights (recomputed all notability)");
      }
      if (topic_rules) {
        await sql.begin(async (tx) => {
          await tx`delete from topic_rule`;
          for (const r of topic_rules) {
            await tx`insert into topic_rule (topic, pattern, ord) values (${r.topic}, ${r.pattern}, ${r.ord ?? 100})`;
          }
        });
        await sql`update contribution c set tags = classify_topics(c.title || ' ' || c.summary || ' ' || left(a.content, 2000))
                  from artifact a where a.hash = c.artifact_hash and c.kind <> 'edge'`;
        changed.push("topic_rules (reclassified corpus)");
      }
      if (changed.length === 0) return text({ error: "nothing to change — pass notability_weights and/or topic_rules." });
      await sql`insert into event (kind, identity_id, payload)
                values ('tuning-changed', ${who.identityId}, ${sql.json({ changed, note } as never)})`;
      return text({ ok: true, changed, note });
    },
  );

  server.registerTool(
    "apply_refactor",
    {
      title: "Apply or reject a refactor proposal (trusted)",
      description:
        "Decide a pending supersedes proposal (a T0 supersedes edge). Approving promotes the link to canon and marks the targets superseded (they stay readable forever); rejecting retracts the link and leaves everything active. Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        refactor_id: z.string().uuid().describe("The contribution that proposed the refactor."),
        decision: z.enum(["approve", "reject"]),
        note: z.string().min(1),
      }),
    },
    async ({ contributor_key, refactor_id, decision, note }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return text({ error: who.refusal });
      await logRequest("apply_refactor", who.identityId, { refactor_id, decision });
      const proposals = await sql<{ edge_id: string; dst: string }[]>`
        select e.contribution_id as edge_id, e.dst from edge e
        join contribution ec on ec.id = e.contribution_id
        where e.src = ${refactor_id} and e.rel = 'supersedes' and ec.status = 'active' and ec.tier = 0`;
      if (proposals.length === 0) return text({ error: "no pending supersedes proposal on that contribution" });
      await sql.begin(async (tx) => {
        const applied = decision === "approve";
        for (const p of proposals) {
          if (applied) {
            await tx`update contribution set tier = 2, updated_at = now() where id = ${p.edge_id}`;
            await tx`update contribution set status = 'superseded', updated_at = now()
                     where id = ${p.dst} and status = 'active'`;
            await tx`insert into event (kind, contribution_id, identity_id, payload)
                     values ('superseded', ${p.dst}, ${who.identityId}, ${tx.json({ by: refactor_id, note } as never)})`;
          } else {
            await tx`update contribution set status = 'retracted', updated_at = now() where id = ${p.edge_id}`;
          }
        }
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values (${applied ? "refactor-applied" : "refactor-rejected"}, ${refactor_id}, ${who.identityId},
                         ${tx.json({ targets: proposals.map((p) => p.dst), note } as never)})`;
      });
      await refreshAround([refactor_id, ...proposals.map((p) => p.dst), ...proposals.map((p) => p.edge_id)]);
      return text({ ok: true, decision, targets: proposals.map((p) => p.dst), note });
    },
  );

  server.registerTool(
    "retract",
    {
      title: "Retract an entry",
      description:
        "Mark one of your own entries retracted (it stays readable — the ledger never forgets, it only annotates). Trusted reviewers can retract anything with a note.",
      inputSchema: z.object({
        contributor_key: ownKeyParam,
        ref: refParam.describe("The entry to retract: id, name, or title."),
        note: z.string().min(1).describe("Why — wrong, duplicate, superseded elsewhere, etc."),
      }),
    },
    async ({ contributor_key, ref, note }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return text(me);
      const { identityId } = me;
      const found = await refOr(ref);
      if ("failed" in found) return found.failed;
      const id = found.id;
      const [target] = await sql<{ identity_id: string | null }[]>`select identity_id from contribution where id = ${id}`;
      if (!target) return text({ error: "no contribution with that id" });
      if (target.identity_id !== identityId) {
        const who = await trustedCheck(contributor_key);
        if (!who.ok) {
          return text({ error: "that entry belongs to a different identity — only its author (or a trusted reviewer) can retract it." });
        }
      }
      await logRequest("retract", identityId, { id });
      await sql.begin(async (tx) => {
        await tx`update contribution set status = 'retracted', updated_at = now() where id = ${id}`;
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values ('retracted', ${id}, ${identityId}, ${tx.json({ note } as never)})`;
      });
      await refreshAround([id]);
      return text({ ok: true, id, note });
    },
  );

  server.registerTool(
    "grant_trust",
    {
      title: "Grant or change trust (operator)",
      description:
        "Set an identity's role: contributor, trusted (may promote review tiers), or operator (may also administer trust). This is how trust expands beyond the initial operator. Requires an operator key.",
      inputSchema: z.object({
        contributor_key: z
          .string()
          .optional()
          .describe("An operator key. May be sent as an `Authorization: Bearer mrk_…` header instead."),
        identity_id: z.string().describe("The identity (sha256 of their contributor key) to set the role on."),
        role: z.enum(["contributor", "trusted", "operator"]),
        note: z.string().min(1),
      }),
    },
    async ({ contributor_key, identity_id, role, note }) => {
      const who = await operatorCheck(contributor_key);
      if (!who.ok) return text({ error: who.refusal });
      await logRequest("grant_trust", who.identityId, { identity_id, role });
      const done = await sql.begin(async (tx) => {
        const [row] = await tx`update identity set role = ${role} where id = ${identity_id} returning id`;
        if (!row) {
          await tx`insert into identity (id, role) values (${identity_id}, ${role})`;
        }
        await tx`insert into event (kind, identity_id, payload)
                 values ('role-granted', ${identity_id}, ${tx.json({ role, by: who.identityId, note } as never)})`;
        return true;
      });
      return text({ ok: done, identity_id, role, note });
    },
  );

  server.registerTool(
    "register_public_key",
    {
      title: "Register a signing key (optional)",
      description:
        "Attach an Ed25519 public key (base64) to your identity so you can sign submissions and prove authorship independently of this server. Entirely optional.",
      inputSchema: z.object({
        contributor_key: ownKeyParam,
        public_key: z.string().describe("Ed25519 public key, base64 (spki/der)."),
        display_name: z.string().optional(),
      }),
    },
    async ({ contributor_key, public_key, display_name }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return text(me);
      const { identityId } = me;
      await logRequest("register_public_key", identityId, {});
      await updateIdentity(identityId, { public_key, ...(display_name ? { display_name } : {}) });
      return text({ ok: true, identity: identityId });
    },
  );

  return server;
}

const app = createMcpExpressApp({ host: "127.0.0.1", allowedHosts: ["math.seihun.com", "localhost", "127.0.0.1"] });

mountOAuth(app, process.env.PUBLIC_URL ?? "https://math.seihun.com");

// createMcpHandler serves the 2026-07-28 stateless protocol revision and, via
// its default legacy fallback, 2025-era stateless traffic on the same endpoint.
const mcpHandler = createMcpHandler(() => buildServer());
const mcpNodeHandler = toNodeHandler(mcpHandler);
// Express's JSON middleware has already consumed the stream; hand the parsed
// body to the adapter explicitly.
// Identity rides the transport when it can: a bearer credential, or the
// session this server hands out at initialize so an otherwise unconfigured
// client still keeps one authorship for its whole connection.
const initializing = (body: unknown) =>
  Array.isArray(body) ? body.some((message) => isInitializeRequest(message)) : isInitializeRequest(body);

app.all("/mcp", (req, res) => {
  const presented = req.headers["mcp-session-id"];
  const sessionId = typeof presented === "string" ? presented : initializing(req.body) ? newSessionId() : undefined;
  if (sessionId && typeof presented !== "string") res.setHeader("Mcp-Session-Id", sessionId);
  return withRequestContext({ bearer: bearerOf(req.headers.authorization), sessionId }, () =>
    mcpNodeHandler(req, res, req.body),
  );
});

app.get("/health", async (_req: import("express").Request, res: import("express").Response) => {
  await sql`select 1`;
  res.json({ ok: true });
});

setInterval(() => void pruneSessions(), 6 * 3600_000).unref();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`math-research MCP listening on 127.0.0.1:${PORT}`);
});
