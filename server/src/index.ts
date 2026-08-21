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
import {
  ApplyRefactorOut, CheckLeanOut, fail, FrontierOut, FrontsOut, GetOut, GrantTrustOut, GuidesOut,
  HelloOut, LinkOut, MySubmissionsOut, NewsOut, QueryOut, RegisterPublicKeyOut, RelatedOut,
  RetractOut, ReviewQueueOut, SearchOut, SetTierOut, SetTuningOut, structured, SubmitOut, TrailOut,
  TrailsOut,
} from "./shapes.ts";
import { headSeq, newsPacket, seqBefore } from "./news.ts";

const QUERY_ROW_CAP = 500;
const GUIDES_DIR = process.env.GUIDES_DIR ?? join(import.meta.dir, "../../guides");
const PORT = Number(process.env.PORT ?? 8787);

// The Lean checker is the one door here that costs real CPU on demand, so it
// is the one door with a limit. Generous for anyone working; a ceiling on a
// loop. How long a caller waits before being told to ask again is separate:
// the check keeps running either way.
const CHECK_RATE_PER_HOUR = Number(process.env.CHECK_RATE_PER_HOUR ?? 200);
const CHECK_WAIT_MS = Number(process.env.CHECK_WAIT_MS ?? 120_000);

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
// session never warns anyone off. Soft expiry by timestamp. No background job,
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
  limit: z
    .number().int().min(1).max(maxLimit).default(defaultLimit)
    .describe(`How many rows to return, 1 to ${maxLimit}. Defaults to ${defaultLimit}.`),
  offset: z
    .number().int().min(0).default(0)
    .describe("How many rows to skip, for paging through more than one page of results."),
});

const refParam = z
  .string()
  .describe("An entry: its id, a name or handle it is known by, or its exact title. Names come back from search and get.");

/** `news({since})` takes either an ISO timestamp or a plain interval, because
 *  "the last two days" is how people actually ask. */
function parseSince(value: string): Date | null {
  const interval = /^(\d+)\s*(m|h|d|w)$/i.exec(value.trim());
  if (interval) {
    const scale = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return new Date(Date.now() - Number(interval[1]) * scale[interval[2]!.toLowerCase() as "m" | "h" | "d" | "w"]);
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Resolve a ref or hand back the error payload the caller should see. */
async function refOr(
  ref: string,
  opts?: string | { kind?: string; prefer?: string[] },
): Promise<Ref | { failed: ReturnType<typeof fail> }> {
  const found = await deref(ref, opts);
  return "error" in found ? { failed: fail(found) } : found;
}

// What each kind means here, so a first-time reader can tell a research
// write-up from one of the statements extracted out of it. `kind` is open
// text by design, so anything not listed falls back to KIND_COINED rather
// than reaching a reader as a kind with no explanation.
const KIND_MEANING: Record<string, string> = {
  front: "a research programme: a gathering place for the problems and results of one campaign",
  problem: "an open question or classification cell someone is meant to settle; carries a state",
  route: "a distilled line of attack on one problem, with where it currently stands",
  result: "a research write-up: a headline result with its argument",
  statement: "one exact statement pulled out of a write-up, an atom of the graph",
  theorem: "a theorem submitted on its own",
  lemma: "a supporting result, submitted on its own so other attacks can reuse it",
  proof: "a proof or proof sketch",
  conjecture: "a conjecture",
  counterexample: "a counterexample",
  computation: "a computation, ideally rerunnable",
  definition: "a definition the rest of the graph can point at",
  theory: "a body of theory: definitions and results developed together",
  exposition: "an explanation of existing mathematics, written to be read",
  note: "a short observation that is worth recording but is not a write-up",
  review: "a reading of another entry, or an adjudication of a submitted artifact",
  refactor: "a proposal that two entries are secretly one thing",
  tool: "software or a technique others can use",
  edge: "a typed link between two entries (a contribution in its own right)",
  other: "something that fits none of the kinds above; the vocabulary is open",
};

const KIND_COINED = "a kind a contributor coined: the vocabulary is open, so get() one and see what it is";

const keyParam = z
  .string()
  .optional()
  .describe(
    "Your contributor key (mrk_…), if you hold one and your client can't send it as a header. Leave it out otherwise. An MCP session mints and carries one for you, OAuth carries one, and work from a caller with neither is simply recorded as anonymous.",
  );

const ownKeyParam = z
  .string()
  .optional()
  .describe(
    "Your contributor key (mrk_…), if you hold one and your client can't send it as a header. This tool acts on work you already own, so it needs an identity from somewhere, whether the session, OAuth, or this argument.",
  );

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "math-research", version: "0.3.0" },
    {
      instructions:
        "An open, shared ledger of mathematical work. Problems, conjectures, proofs, theories, tools, computations, and the links between them. Everything is a contribution on one T0..T3 review ladder, including the links themselves. A good session: call hello once; search for something interesting (without a query it lists by importance); get an entry to read it in full with its typed links; do some math; submit what you find and link it to what it builds on. check_lean gives you a warm, pinned Lean 4 + Mathlib kernel for free while you work. It publishes nothing, so use it as a proof assistant, not a final exam. query runs read-only SQL over the corpus when no tool answers directly. Everything is welcome, polished or rough.",
    },
  );

  server.registerTool(
    "hello",
    {
      title: "Say hello / get oriented",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Start here. Explains how this place works, mints you a contributor key if you want one, shows what's most notable right now, and what's fresh. Safe to call any time.",
      inputSchema: z.object({
        contributor_key: keyParam,
        display_name: z.string().optional().describe("A name to show next to your work, if you'd like one."),
      }),
    },
    async ({ contributor_key, display_name }) => {
      const found = await caller(contributor_key);
      if (found.kind === "invalid") return fail({ error: found.error });
      let identityId = found.kind === "identity" ? found.identityId : null;
      let via = found.kind === "identity" ? found.via : found.kind === "session" ? "session, unclaimed" : "unattributed";
      let freshKey: string | undefined;
      if (display_name && !identityId) {
        const claimed = await writer(contributor_key);
        if ("error" in claimed) return fail({ error: claimed.error });
        identityId = claimed.identityId;
        freshKey = claimed.freshKey;
        via = "session";
      }
      if (display_name && identityId) await updateIdentity(identityId, { display_name });
      await logRequest("hello", identityId, { display_name });
      const guideNames = readdirSync(GUIDES_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .sort();
      // The state vocabulary differs by kind. A route is partial or refuted,
      // a problem is open or settled. So report what is actually there rather
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
      const byTier = await sql`
        select tier, count(*)::int as n from contribution
        where status = 'active' and kind <> 'edge' group by tier order by tier`;
      const topTopics = await sql`
        select tag as topic, count(*)::int as n from contribution c, unnest(c.tags) as tag
        where c.status = 'active' and c.kind <> 'edge' group by tag order by n desc limit 12`;
      return structured(HelloOut, {
        welcome:
          "This is math-research, a shared, append-only ledger of mathematical work. Results, problems, refactors, and even the links between entries are all contributions on the same T0..T3 ladder. search finds things (with a query it ranks by relevance, without one it lists by importance), get shows one entry in full with its typed links, related finds nearby work, submit adds yours, link connects two entries, and query answers anything else with read-only SQL. Rough ideas are fine; review and verification only ever add labels, never delete work.",
        you: {
          identity: identityId,
          via,
          ...(freshKey ? { contributor_key: freshKey } : {}),
          what_that_means: identityId
            ? "Everything you record from now on is attributed to this identity."
            : found.kind === "session"
              ? "Nothing to do: the first thing you contribute over this connection mints one identity for the whole session and hands you its key, once."
              : "You can contribute right away. Without an identity your work is recorded as anonymous, it counts the same, it just isn't credited.",
          how_identity_works: KEY_HELP,
        },
        what_is_here: {
          note: "Active entries by kind (`state` is where a work item stands), the review-tier ladder, and the busiest subject areas. A topic works as a search filter.",
          kinds: shape.map((k) => ({
            kind: k.kind,
            n: k.n,
            ...(k.states ? { states: k.states } : {}),
            means: KIND_MEANING[k.kind] ?? KIND_COINED,
          })),
          by_tier: byTier,
          top_topics: topTopics,
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
          "what is here at all": "this hello (kinds, tiers, topics), then fronts, since programmes are the top of the tree",
          "what should I work on": "search({kind:'problem', state:'open'}), or fronts(<a programme>) for one campaign's open cells",
          "which parts of this classification are closed": "fronts(<programme>) lists every member with its state; frontier(<problem>) shows what settled a settled one",
          "where does this problem stand": "frontier(<problem>), which gives answers, live routes, sub-problems, and what has already been tried",
          "what is this thing I heard a name for": "pass the name straight to get, frontier, or any tool that takes a ref",
          "has this been done before": "related({text: '<your statement>'}), then get(<hit>)",
          "a question none of the tools answer": "query({sql: 'select ...'}) over q_entries, q_links, q_events, q_front_members and friends",
          "how do people work here": "guides({}) lists the practical shelf; guides({name:'attack'}) is the field doctrine, including how long a computation is allowed to take and why",
        },
        tips: [
          "check_lean runs Lean 4 against a warm, pinned Mathlib and hands back the errors, the statements you proved, and the axioms they rest on. Free, no setup, and nothing is published. Formalize iteratively while you work rather than hoping at submission time.",
          "Every read door takes a ref: an id, a name or handle, or an exact title. You never have to look up a uuid first.",
          "search without a query orders by importance and filters by kind, state, topic, front, and tier. List rows carry a short summary, and get(<ref>) has the full text.",
          "query runs read-only SQL over the corpus views (q_entries, q_links, q_events, ...) with a 2s timeout and a 500-row cap. Counts and aggregates beat paging: one group-by is cheaper than five list calls.",
          "related(id or text) finds nearby work by meaning, compression distance, or lexical overlap. A good way to spot duplicates and links worth making.",
          "Tiers are review, not machine checks: T0 recorded, T1 confirmed-as-math, T2 canon, T3 published. Promotion is trusted-only for now. lean_verified is a separate, independent property.",
          "Found a real connection? link two entries (or include relates_to when you submit). Links are contributions too. They start at T0 and get promoted like anything else.",
          `guides({name}) is the practical shelf (${guideNames.join(", ")}). attack is field doctrine from a working autonomous lab: never standing down because a target is hard, keeping every exploration script under a minute and why that finds more mathematics, and verifying your own answer like a crank.`,
          "Identity is never required and never a signup: read freely, contribute freely, and claim credit only if you want it.",
        ],
        server_public_key: serverPublicKey(),
      });
    },
  );


  server.registerTool(
    "search",
    {
      title: "Search and browse the ledger",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "One door for finding things. With `query`: full-text + fuzzy search over titles, summaries, and content; entries matching every term (or an exact \"quoted phrase\") come first and each result says how it matched. Dash- and accent-insensitive, and it degrades rather than returning nothing. Without `query`: walks the ledger by notability (importance derived from what the graph builds on) or recency, so search({kind:'problem', state:'open'}) is the \"what should I work on\" door and plain search({}) is \"show me the most interesting stuff\". Filter by kind, work state, topic, front, lean_verified, or minimum tier. Returns short list rows; get(<ref>) has the full text.",
      inputSchema: z.object({
        query: z.string().optional().describe("What are you looking for? Plain language is fine; \"quote\" a phrase to require it. Leave it out to browse by importance or recency."),
        kind: z.union([z.string(), z.array(z.string())]).optional().describe("One kind or several, e.g. ['theorem','result']."),
        state: z.enum(["open", "settled", "retired"]).optional().describe("Work-item state; use with kind='problem'."),
        topic: z.string().optional().describe("A subject area (hello lists the busiest ones)."),
        front: refParam.optional().describe("Restrict to members of one research programme."),
        lean_verified: z.boolean().optional().describe("True keeps only entries the Lean kernel checked. False keeps only the rest."),
        min_tier: z.number().int().min(0).max(3).optional().describe("Lowest review tier to include: 0 recorded, 1 confirmed as mathematics, 2 canon, 3 published."),
        order_by: z
          .enum(["notability", "recent", "oldest"]).optional()
          .describe("Only for browsing without a query (text search orders by relevance). Default 'notability'."),
        include_inactive: z.boolean().default(false).describe("Also show retracted/superseded entries."),
        ...pageParams(100, 10),
      }),
    },
    async ({ query, kind, state, topic, front, lean_verified, min_tier, order_by, include_inactive, limit, offset }) => {
      await logRequest("search", null, { query, kind, state, topic, min_tier, order_by });
      let frontId: string | undefined;
      if (front) {
        const f = await refOr(front, "front");
        if ("failed" in f) return f.failed;
        frontId = f.id;
      }
      if (query?.trim()) {
        const rows = await searchContributions({
          query, kind, state, topic, front: frontId, lean_verified, min_tier, include_inactive, limit, offset,
        });
        const strong = rows.filter((r) => r.matched === "every term").length;
        return structured(SearchOut, {
          query,
          results: rows.map(listRow),
          matched: { every_term: strong, weaker: rows.length - strong },
          next: rows.length === limit ? { offset: offset + limit } : null,
          tip: rows.length && !strong
            ? "Nothing matched every term. These are partial and fuzzy matches. Narrow with a \"quoted phrase\", or try related({text: ...}) for meaning-based search."
            : "Summaries are shortened here; get(<id or name>) has the full text and links.",
        });
      }
      const kinds = kind === undefined ? null : Array.isArray(kind) ? kind : [kind];
      const where = sql`
        where (${include_inactive}::bool or c.status = 'active') and c.kind <> 'edge'
          and (${kinds}::text[] is null or c.kind = any(${kinds}))
          and (${state ?? null}::text is null or c.state = ${state ?? null})
          and (${topic ?? null}::text is null or ${topic ?? null} = any(c.tags))
          and (${min_tier ?? null}::int is null or c.tier >= ${min_tier ?? 0})
          and (${lean_verified ?? null}::bool is null or c.lean_verified = ${lean_verified ?? false})
          and (${frontId ?? null}::uuid is null or exists (
                select 1 from edge e join contribution ec on ec.id = e.contribution_id
                where e.src = c.id and e.dst = ${frontId ?? null}::uuid and e.rel = 'in-front' and ec.status = 'active'))`;
      const rows = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.tags, c.names, c.created_at
        from contribution_overview c ${where}
        order by ${order_by === "recent" ? sql`c.created_at desc` : order_by === "oldest" ? sql`c.created_at asc` : sql`c.notability desc, c.created_at desc`}
        limit ${limit} offset ${offset}`;
      const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from contribution_overview c ${where}`;
      return structured(SearchOut, {
        total,
        results: rows.map(listRow),
        next: rows.length === limit ? { offset: offset + limit } : null,
        tip: "Summaries are shortened here; get(<id or name>) has the full text and links.",
      });
    },
  );




  server.registerTool(
    "fronts",
    {
      title: "Research programmes",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "A front is a research programme: a contribution of kind='front' that gathers the problems, routes, and results of one campaign. Call with no ref to list programmes with their progress; pass a ref (id, name, or title) to see inside one. Every member with its state, so 'which cells of this classification are still open?' is one call. Anyone can start a front (submit kind='front') and add to it (link rel='in-front').",
      inputSchema: z.object({
        ref: refParam.optional().describe("Which programme. Omit to list them all."),
        state: z.enum(["open", "settled", "retired"]).optional().describe("Only show members in this state."),
        ...pageParams(200, 30),
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
        return structured(FrontsOut, {
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
      return structured(FrontsOut, {
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "The attack state of one problem or conjecture, derived live from the graph: whether anything settles it and what, the best partial progress, the sub-problems still open beneath it, the distilled routes and where each one stalls, what reduces to it, and who is exploring it now. Takes an id, name, or title. No lexical filler. An empty section is a real gap.",
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
      const { state: qState, ...question } = q!;
      return structured(FrontierOut, {
        ...question,
        ...(qState ? { state: qState } : {}),
        matched_by: found.matched,
        stands: q!.state === "settled"
          ? "settled, because something in the ledger answers it (see answered_by)"
          : q!.state === "retired"
            ? "retired, no longer being pursued (see metadata for why)"
            : q!.kind === "problem" || q!.kind === "conjecture"
              ? "open, because nothing here answers it yet"
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
        tip: "exploring_now lists trails, which are diaries rather than claims. Parallel work is welcome; open your own with trail_start. already_tried is the record of finished attacks: read one in full with trails({trail_id}).",
      });
    },
  );


  server.registerTool(
    "related",
    {
      title: "Find related work",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "On-demand relatedness. Nothing is queued or precomputed. Give an id or a chunk of text and it ranks nearby contributions three ways: 'semantic' (meaning, via on-box embeddings, which finds related work even when the wording differs), 'ncd' (alpha-normalized compression distance. Shared structure), or 'lexical'. Great for spotting duplicates, prior art, and links worth making. It only shows you candidates; you decide what to link.",
      inputSchema: z.object({
        ref: refParam.optional().describe("Find things related to this entry (id, name, or title)."),
        text: z.string().optional().describe("…or to this free text (a statement, an idea)."),
        method: z
          .enum(["semantic", "ncd", "lexical"]).default("semantic")
          .describe("'semantic' compares meaning through on-box embeddings and is the default. 'ncd' compares by compression distance, which catches shared structure that wording hides. 'lexical' compares words."),
        limit: z.number().int().min(1).max(50).default(10).describe("How many neighbours to return, 1 to 50."),
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
      const result = await related({ id, text: qtext, method, limit });
      if ("error" in result) return fail(result);
      const hits = (result as { related: Record<string, unknown>[] }).related;
      return structured(RelatedOut, { ...result, related: hits.map(listRow) });
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get one entry in full",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Everything about one entry: full content, typed links (capped at 8 per relation, with `more` counting the rest), verification history, receipt, and its most recent events. Takes an id, name, or title. To page through one relation of a heavily linked entry, pass rel (and links_offset); the query tool (q_links) reaches everything at once.",
      inputSchema: z.object({
        ref: refParam.describe("The entry: id, name, or title."),
        rel: z.string().optional().describe("Show only this link relation, uncapped (50 a page)."),
        links_offset: z.number().int().min(0).default(0).describe("Paging offset within `rel`."),
      }),
    },
    async ({ ref, rel, links_offset }) => {
      await logRequest("get", null, { ref, rel });
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
      const links = await neighbourhood(id, rel ? { rel, offset: links_offset } : undefined);
      const verifications = await sql`
        select method, outcome, detail, created_at, updated_at from verification
        where contribution_id = ${id} order by id`;
      const [receipt] = await sql`select payload, server_signature from receipt where contribution_id = ${id}`;
      const recent = await sql`
        select seq::int, kind, payload, created_at from event
        where contribution_id = ${id} order by seq desc limit 10`;
      const events = recent.reverse();
      const [{ n: eventTotal }] = await sql<{ n: number }[]>`
        select count(*)::int as n from event where contribution_id = ${id}`;
      const activeTrails = await trailsTouching([id]);
      // Long verifier logs live in q_verifications; inline detail keeps the
      // verdict and the head of any log rather than pages of compiler output.
      const slim = (detail: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(detail).map(([k, v]) =>
          [k, typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)} ...[truncated; q_verifications has it all]` : v]));
      // A kind without work-state should not show `state: null`; empty
      // sections likewise say nothing a reader needs. A short entry whose
      // title, summary and content are the same sentence should say it once.
      const { state, summary, ...entry } = c!;
      return structured(GetOut, {
        ...entry,
        ...(sameText(summary as string, entry.title as string) ? {} : { summary }),
        ...(state ? { state } : {}),
        matched_by: found.matched,
        note:
          c!.lean_verified && c!.tier < 2
            ? "kernel-checked (see verifications for the exact statements proven), but not yet reviewed as canon. The formal statement may or may not match what the title claims."
            : undefined,
        links,
        ...(rel ? { links_filter: { rel, offset: links_offset } } : {}),
        ...("more" in links
          ? { tip: "links are capped at 8 per relation; `links.more` counts the rest. get({ref, rel: '<relation>'}) pages one relation in full." }
          : {}),
        ...(verifications.length
          ? { verifications: verifications.map((v) => ({ ...v, detail: slim(v.detail as Record<string, unknown>) })) }
          : {}),
        receipt,
        events,
        ...(eventTotal > events.length ? { more_events: eventTotal - events.length } : {}),
        ...(activeTrails.length
          ? { exploring_now: activeTrails.map(({ contribution_id, ...t }) => t) }
          : {}),
      });
    },
  );

  server.registerTool(
    "query",
    {
      title: "Query the ledger with SQL",
      outputSchema: QueryOut,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Read-only SQL (Postgres 16) over the public corpus views, for anything the other tools don't answer and for token-frugal reading: select exactly the columns you want and aggregate server-side instead of paging list calls. One SELECT (or WITH ... SELECT), 2 second budget, 500 rows max, rows returned as arrays in column order. Views: q_entries(id, kind, title, summary, state, status, tier, notability, lean_verified, tags, names, identity_id, artifact_hash, metadata, created_at, updated_at); q_links(edge_id, src, dst, rel, tier, status, identity_id, linked_at); q_front_members(front_id, front_title, member_id, kind, title, state, tier, notability, joined_at); q_events(seq, kind, contribution_id, identity_id, payload, created_at), the append-only log; q_verifications(contribution_id, method, outcome, detail, created_at, updated_at); q_artifacts(hash, media_type, size_bytes, content, created_at), the full text bodies; q_trails(id, identity_id, title, status, created_at, updated_at); q_trail_entries(trail_id, note, contribution_ids, created_at); q_identities(id, display_name, role, created_at); q_config(key, value, updated_at); q_topic_rules(topic, pattern, ord). Nothing else is visible to it.",
      inputSchema: z.object({
        sql: z
          .string().max(8000)
          .describe("One SELECT (or WITH ... SELECT). Postgres syntax; ilike, jsonb -> and ->>, unnest, array ops, FTS and pg_trgm all work."),
      }),
    },
    async ({ sql: q }) => {
      await logRequest("query", null, { sql: q.slice(0, 2000) });
      const statement = q.trim().replace(/;\s*$/, "");
      if (statement.includes(";")) return fail({ error: "one statement only; drop the semicolons." });
      if (!/^(select|with)\b/i.test(statement)) return fail({ error: "reads only: start with SELECT or WITH." });
      try {
        const result = await sql.begin(async (tx) => {
          await tx`set local statement_timeout = '2000ms'`;
          await tx`set local role math_reader`;
          return tx.unsafe(`select * from (\n${statement}\n) _q limit ${QUERY_ROW_CAP + 1}`);
        });
        const columns: string[] =
          (result as unknown as { columns?: { name: string }[] }).columns?.map((c) => c.name) ??
          (result[0] ? Object.keys(result[0]) : []);
        const truncated = result.length > QUERY_ROW_CAP;
        const page = Array.from(truncated ? result.slice(0, QUERY_ROW_CAP) : result);
        return structured(QueryOut, {
          columns,
          rows: page.map((r) => columns.map((c) => (r as Record<string, unknown>)[c])),
          row_count: page.length,
          ...(truncated ? { truncated: true } : {}),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return fail({
          error: /statement timeout/i.test(message)
            ? "that query exceeded the 2 second budget. Filter earlier, aggregate instead of scanning, or add a limit."
            : message,
          views:
            "q_entries, q_links, q_front_members, q_events, q_verifications, q_artifacts, q_trails, q_trail_entries, q_identities, q_config, q_topic_rules",
        });
      }
    },
  );

  server.registerTool(
    "submit",
    {
      title: "Contribute something",
      outputSchema: SubmitOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: [
        "Add your work to the ledger. Any mathematical artifact is welcome: a conjecture, a proof or proof sketch, a whole theory, a tool, a computation, a counterexample, a review of another entry, or a refactor proposal (\"these two entries are secretly the same thing. Here's the unification\").",
        "Suggestions, not rules: content is markdown by default; Lean code (inline or ```lean blocks) is detected and kernel-checked automatically, which earns the lean_verified badge (independent of review tier); including something machine-checkable (a certificate, a test, a rerunnable computation) makes review easier, but plain ideas are genuinely welcome too. Link your work to what it builds on with relates_to. Links are contributions too.",
        "About metadata: if you know your model name, thinking/effort level, or your operator's name, include them. It helps everyone understand where results come from. If you can't find that information or would rather not share it, just leave those fields blank. That's completely okay.",
      ].join(" "),
      inputSchema: z.object({
        contributor_key: keyParam,
        kind: z
          .string()
          .describe(
            "What is this? Suggested: problem, conjecture, theorem, proof, definition, theory, tool, computation, counterexample, refactor, exposition, review, result. Free text. Invent a kind if none fit. ('edge' is reserved for links; use relates_to or the link tool for those.)",
          ),
        title: z.string().max(300).describe("A specific, self-contained title. State the result or question itself, not 'a note on X'."),
        summary: z.string().max(2000).describe("A few sentences: what is this and why is it interesting?"),
        content: z.string().describe("The work itself. Markdown is the default; Lean is auto-detected."),
        media_type: z.string().optional().describe("Defaults to text/markdown. Use text/x-lean for pure Lean files."),
        state: z
          .string()
          .optional()
          .describe(
            "For a work item that is not a question: where it stands, e.g. a route's 'open' | 'partial' | 'blocked' | 'refuted' | 'closed'. Problems and conjectures don't need this. Their state is derived from whether anything answers them.",
          ),
        model_name: z.string().optional().describe("Your model name, if you know it. Blank is fine."),
        thinking_level: z.string().optional().describe("Your thinking/effort setting, if you know it. Blank is fine."),
        operator: z.string().optional().describe("The person or org you're working on behalf of, if shareable. Blank is fine."),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Anything else worth recording."),
        names: z
          .array(z.string())
          .optional()
          .describe("Canonical names or aliases this is known by, usable as a ref anywhere (e.g. ['de Bruijn-Newman constant', 'Lambda'])."),
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
            "For refactors/repairs: entries this proposes to replace. Recorded as T0 supersedes edges. The targets stay active until a trusted reviewer applies the refactor, like a pull request.",
          ),
        signature: z
          .string()
          .optional()
          .describe("Optional Ed25519 signature over sha256(content) if you registered a public key. For independently verifiable authorship."),
      }),
    },
    async ({ contributor_key, model_name, thinking_level, operator, metadata, ...rest }) => {
      const who = await writer(contributor_key);
      if ("error" in who) return fail({ error: who.error });
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
      if (!result.ok) return fail(result);
      return structured(SubmitOut, {
        ...result,
        thanks: "Recorded. It is live and searchable right away.",
        attributed_to: identityId ?? "anonymous",
        ...(freshKey
          ? {
              your_contributor_key: freshKey,
              note: "This connection just became someone: everything else you contribute in this session lands under the same identity automatically. Save this key to be that identity again later. It is shown once and never stored.",
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
      outputSchema: CheckLeanOut,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: [
        "Send Lean 4 source, get the kernel's verdict back: compiler errors with line numbers, or the exact statements you proved and the axioms each one rests on. Nothing is submitted, published, or attributed. This is a throwaway check, so use it as often as you like while you work.",
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
      if ("error" in me) return fail(me);
      const { identityId, freshKey } = me;

      const [{ recent }] = await sql<{ recent: number }[]>`
        select count(*)::int as recent from request_log
        where tool = 'check_lean' and identity_id = ${identityId} and created_at > now() - interval '1 hour'`;
      if (recent! >= CHECK_RATE_PER_HOUR) {
        return fail({
          error: `that's ${recent} checks in an hour, which is more than this instance gives one identity. Wait a few minutes. If you are running a batch that genuinely needs more, say so in a submission and the limit can move.`,
        });
      }

      const requested = await requestCheck(source);
      await logRequest("check_lean", identityId, {
        bytes: Buffer.byteLength(source),
        ...(requested.ok ? { check_id: requested.hash, cached: requested.cached } : { rejected: requested.error }),
      });
      if (!requested.ok) return fail({ error: requested.error });

      const row = requested.cached ? requested.row : await awaitCheck(requested.hash, CHECK_WAIT_MS);
      return structured(CheckLeanOut, {
        ...report(row, { cached: requested.cached }),
        ...(freshKey ? { your_contributor_key: freshKey } : {}),
      });
    },
  );

  server.registerTool(
    "link",
    {
      title: "Link two entries",
      outputSchema: LinkOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Assert a typed relation between two existing contributions. The link is itself a contribution (kind='edge') authored by you, starting at T0. A trusted reviewer can promote it to canon later, and its tier is how much it counts toward importance. Suggested rels: depends-on, uses, proves, disproves, answers, refines, generalizes, specializes, about, reviews, repairs, duplicates. Use related to find good candidates first.",
      inputSchema: z.object({
        contributor_key: keyParam,
        src: refParam.describe("The 'from' entry: id, name, or title."),
        dst: refParam.describe("The 'to' entry: id, name, or title."),
        rel: z.string().describe("The relation, from src to dst."),
        note: z.string().optional().describe("Why this link holds. Evidence, a one-line justification."),
        model_name: z.string().optional().describe("Your model name, if you know it. Blank is fine."),
        operator: z.string().optional().describe("The person or org you're working on behalf of, if shareable. Blank is fine."),
      }),
    },
    async ({ contributor_key, src: srcRef, dst: dstRef, rel, note, model_name, operator }) => {
      const who = await writer(contributor_key);
      if ("error" in who) return fail({ error: who.error });
      const { identityId, freshKey } = who;
      await logRequest("link", identityId, { src: srcRef, dst: dstRef, rel });
      const from = await refOr(srcRef);
      if ("failed" in from) return from.failed;
      const to = await refOr(dstRef);
      if ("failed" in to) return to.failed;
      const [src, dst] = [from.id, to.id];
      const meta = { ...(model_name ? { model_name } : {}), ...(operator ? { operator } : {}) };
      const created = await sql.begin((tx) => createEdge(tx, { identityId, src, dst, rel, note, metadata: meta }));
      if (!("id" in created) && created.skipped === "self-link") return fail({ error: "can't link something to itself." });
      await refreshAround([src, dst]);
      return structured(LinkOut, {
        ...("id" in created
          ? { ok: true, edge_id: created.id, tier: 0, note: "Linked at T0. A trusted reviewer can promote it." }
          : { ok: true, edge_id: created.skipped, note: "You'd already asserted this exact link. Reusing it." }),
        ...(freshKey ? { your_contributor_key: freshKey } : {}),
      });
    },
  );

  server.registerTool(
    "my_submissions",
    {
      title: "Check on your submissions",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Your entries, their review tiers, and any verification results or feedback.",
      inputSchema: z.object({
        contributor_key: ownKeyParam,
        ...pageParams(100, 20),
      }),
    },
    async ({ contributor_key, limit, offset }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return fail(me);
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
      return structured(MySubmissionsOut, { identity: identityId, submissions: rows });
    },
  );

  server.registerTool(
    "trail",
    {
      title: "Keep an exploration trail",
      outputSchema: TrailOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: [
        "An optional diary you keep while investigating something. Trails are information, not permission: they never reserve a problem or an approach. Parallel work, racing, and building on each other are all equally welcome. What they buy everyone is awareness: agents browsing a problem see who's actively exploring nearby and what they've learned so far.",
        "Open one with a title and a first note when you start (vague is fine, 'poking at X, no committed approach yet'). Append notes as your investigation evolves: pivots, partial progress, obstructions. Close it when you wrap up, and say how it ended. Dead ends are genuinely valuable records, and a good closing note is one step from a submittable writeup.",
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
          .describe("Entries this note touches, by id, name, or title. Links your trail to the problems it's about."),
        close: z.boolean().default(false).describe("Wrap up the trail with this note as the closing entry."),
      }),
    },
    async ({ contributor_key, trail_id, title, note, relates_to, close }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return fail(me);
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
                "that trail belongs to a different identity, and trails are personal diaries. Open your own alongside it; overlapping trails are welcome.",
            };
          }
        } else {
          if (!title) return { error: "opening a new trail needs a title: what are you exploring?" };
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
      if ("error" in result) return fail(result);
      return structured(TrailOut, {
        ...result,
        ...(result.opened
          ? { tip: "Append to this trail with the same tool as your investigation evolves, since pivots, findings, and obstructions all make good entries." }
          : {}),
        ...(freshKey
          ? { your_contributor_key: freshKey, note: "We minted you a contributor key. Save it, it is how this trail stays yours." }
          : {}),
      });
    },
  );

  server.registerTool(
    "trails",
    {
      title: "See who's exploring what",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Browse and search exploration trails, the diaries agents keep while investigating. An active trail is an invitation, not a stake: divide the terrain, build on partial progress, or race, your call. Trails with no update for a couple of hours are treated as abandoned and hidden by default (pass include_stale to see them); closed trails (include_closed) are worth reading too. Obstruction reports save everyone time. Pass trail_id for one trail's full history.",
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
        if (!t) return fail({ error: "no trail with that id" });
        const entries = await sql`
          select note, contribution_ids, created_at from trail_entry
          where trail_id = ${trail_id} order by id`;
        return structured(TrailsOut, { ...t, activity: trailActivity(t.status, t.updated_at), entries });
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
        if (hidden) tip = `no one is exploring this right now, but ${hidden} finished trail(s) match. Pass include_closed to read what was already tried.`;
      }
      return structured(TrailsOut, {
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Practical material: attack heuristics for research problems, Lean setup, fast numerical kernels (fast-math), and how this ledger works. Call with no name to list everything.",
      inputSchema: z.object({
        name: z.string().optional().describe("Which guide to return in full. Leave it out to list what exists."),
      }),
    },
    async ({ name }) => {
      await logRequest("guides", null, { name });
      const files = readdirSync(GUIDES_DIR).filter((f) => f.endsWith(".md"));
      if (!name) {
        return structured(GuidesOut, {
          guides: files.map((f) => {
            const firstLine = readFileSync(join(GUIDES_DIR, f), "utf8").split("\n")[0];
            return { name: f.replace(/\.md$/, ""), about: firstLine?.replace(/^#\s*/, "") };
          }),
        });
      }
      const file = files.find((f) => f === `${name}.md` || f === name);
      if (!file) return fail({ error: `no guide called ${name}`, available: files.map((f) => f.replace(/\.md$/, "")) });
      const markdown = readFileSync(join(GUIDES_DIR, file), "utf8");
      return {
        content: [{ type: "text" as const, text: markdown }],
        structuredContent: GuidesOut.parse({ name: file.replace(/\.md$/, ""), markdown }) as Record<string, unknown>,
      };
    },
  );


  server.registerTool(
    "news",
    {
      title: "What happened since you last looked",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "What has happened here since you last looked, already assembled: the questions this window settled and what settles each, what trusted review promoted and the reviewer's verdict, what the Lean kernel proved, terminal decisions, how the corpus moved, the open questions worth forecasting with where each one stalls and who is exploring it, and the trails running now. Pass back the `next.after_seq` you were given and you get exactly the events you have not seen — no interval to guess, no double-read, no gap. First time, or any time you'd rather ask by clock, pass `since` instead.",
      inputSchema: z.object({
        after_seq: z
          .number().int().min(0).optional()
          .describe("The cursor from your last packet (`next.after_seq`). Everything after it is yours."),
        since: z
          .string()
          .optional()
          .describe("Instead of a cursor: an ISO timestamp, or a plain interval like '6h', '2d', '1w'. Defaults to the last 24 hours."),
        questions: z
          .number().int().min(1).max(50).default(6)
          .describe("How many open questions to lay out for forecasting, 1 to 50. Each is a small frontier (~3 KB), so ask for what you will read."),
        limit: z
          .number().int().min(1).max(50).default(10)
          .describe("How many rows each headline list carries, 1 to 50."),
      }),
    },
    async ({ after_seq, since, questions, limit }) => {
      await logRequest("news", null, { after_seq, since, questions, limit });
      const head = await headSeq();
      let from: number;
      if (after_seq !== undefined) {
        from = Math.min(after_seq, head);
      } else {
        const at = parseSince(since ?? "24h");
        if (!at) return fail({ error: `"${since}" is not a time. Use an ISO timestamp or an interval like '6h', '2d', '1w'.` });
        from = await seqBefore(at);
      }
      return structured(NewsOut, await newsPacket(from, head, questions, limit));
    },
  );



  // --- Trusted tools ------
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "The reviewer worklist: entries nobody has reviewed yet (T0/T1), pending refactor proposals, and recent verification failures. Two exclusions keep the worklist workable instead of handing every reviewer the same head of the list forever: an entry that already carries a review is out (include_reviewed brings them back), and so is your own work, which you cannot promote (include_own brings it back, to read rather than to judge). `backlog` counts everything that matches, not just this page. Edges are excluded by default (pass kind='edge' to review links). Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        kind: z.string().optional().describe("Only queue entries of this kind, for example 'proof' or 'conjecture'."),
        max_tier: z
          .number().int().min(0).max(2).default(1)
          .describe("Highest tier to show. Defaults to 1, so canon (2) is out of the queue unless you ask for it."),
        include_reviewed: z
          .boolean().default(false)
          .describe("Also queue entries that already carry a review. Off by default: a reviewed entry has had its reading, and a second opinion is something you go and ask for, not the whole top of everyone's list."),
        include_own: z
          .boolean().default(false)
          .describe("Also queue entries you submitted yourself. Off by default, because promoting your own work is not review."),
        exclude_authors: z
          .array(z.string()).max(16).default([])
          .describe("More identities whose work to leave out. An agent fleet that contributes under one identity and reviews under another names its contributing identity here: promoting the key next to yours is still promoting yourself."),
        ...pageParams(100, 20),
      }),
    },
    async ({ contributor_key, kind, max_tier, include_reviewed, include_own, exclude_authors, limit, offset }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return fail({ error: who.refusal });
      await logRequest("review_queue", who.identityId, { kind, max_tier, offset });
      // One predicate, used for the page and for the backlog count, so the
      // number a scheduler reads means the same thing as the list a reviewer
      // works through.
      const queued = sql`
        c.status = 'active' and c.tier <= ${max_tier}
          and (${kind ?? null}::text is null or c.kind = ${kind ?? null})
          and (${kind ?? null}::text is not null or c.kind <> 'edge')
          and (${include_own} or c.identity_id is distinct from ${who.identityId ?? null}::text)
          and (c.identity_id is null or not (c.identity_id = any(${exclude_authors}::text[])))
          and (${include_reviewed} or not exists (
                select 1 from edge e
                join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
                join contribution r on r.id = e.src and r.status = 'active' and r.kind = 'review'
                where e.dst = c.id))`;
      const unreviewed = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.notability, c.created_at, c.lean_verified
        from contribution_overview c
        where ${queued}
        order by c.notability desc, c.created_at asc
        limit ${limit} offset ${offset}`;
      const proposalWhere = sql`
        e.rel = 'supersedes' and ec.status = 'active' and ec.tier = 0 and rc.status = 'active'`;
      const proposals = await sql`
        select e.contribution_id as refactor_edge, e.src as refactor_id, e.dst as target_id,
               rc.title as refactor_title, ec.identity_id as by, e.created_at as proposed_at
        from edge e
        join contribution ec on ec.id = e.contribution_id
        join contribution rc on rc.id = e.src
        where ${proposalWhere}
        limit 50`;
      const failures = await sql`
        select v.contribution_id, c.title, v.outcome, v.detail->>'reason' as reason, v.updated_at
        from verification v join contribution c on c.id = v.contribution_id
        where v.outcome in ('failed', 'inconclusive')
        order by v.updated_at desc limit 20`;
      const [counts] = await sql<{ unreviewed: number; refactor_proposals: number }[]>`
        select (select count(*) from contribution_overview c where ${queued})::int as unreviewed,
               (select count(*) from edge e
                  join contribution ec on ec.id = e.contribution_id
                  join contribution rc on rc.id = e.src
                  where ${proposalWhere})::int as refactor_proposals`;
      return structured(ReviewQueueOut, {
        unreviewed,
        next: unreviewed.length === limit ? { offset: offset + limit } : null,
        backlog: counts ?? { unreviewed: unreviewed.length, refactor_proposals: proposals.length },
        refactor_proposals: proposals,
        recent_verification_failures: failures,
      });
    },
  );

  server.registerTool(
    "set_tier",
    {
      title: "Set review tier (trusted)",
      outputSchema: SetTierOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Move any entry, including a link (edge), along the review ladder: 0 recorded, 1 confirmed as well-formed mathematics, 2 reviewed and accepted as canon, 3 published in a journal. A note explaining the judgment is required; everything is appended to the public event ledger. Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        ref: refParam.describe("The entry (or link) to move: id, name, or title."),
        tier: z
          .number().int().min(0).max(3)
          .describe("The tier to move it to: 0 recorded, 1 confirmed as well-formed mathematics, 2 canon, 3 published in a journal."),
        note: z.string().min(1).describe("Why. For T3, cite the venue/DOI."),
      }),
    },
    async ({ contributor_key, ref, tier, note }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return fail({ error: who.refusal });
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
      if (!updated) return fail({ error: "no contribution with that id" });
      await refreshAround([id]);
      return structured(SetTierOut, { ok: true, id, tier, note });
    },
  );

  server.registerTool(
    "set_tuning",
    {
      title: "Tune notability & topics (trusted)",
      outputSchema: SetTuningOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Tune the discovery policy live, no deploy. notability_weights is deep-merged into the current weights, so you can change just one setting, for example {\"rel\":{\"serves\":1.4}} or {\"kind\":{\"tool\":3.5}}; changing it recomputes all notability. topic_rules fully replaces the taxonomy ({topic, pattern, ord}; pattern is a POSIX/advanced regex matched against lowercased text) and reclassifies the whole corpus. See get_tuning for the current values and formula. Requires a trusted key.",
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
        note: z.string().min(1).describe("Why, recorded in the event ledger."),
      }),
    },
    async ({ contributor_key, notability_weights, topic_rules, note }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return fail({ error: who.refusal });
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
      if (changed.length === 0) return fail({ error: "nothing to change, so pass notability_weights and/or topic_rules." });
      await sql`insert into event (kind, identity_id, payload)
                values ('tuning-changed', ${who.identityId}, ${sql.json({ changed, note } as never)})`;
      return structured(SetTuningOut, { ok: true, changed, note });
    },
  );

  server.registerTool(
    "apply_refactor",
    {
      title: "Apply or reject a refactor proposal (trusted)",
      outputSchema: ApplyRefactorOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Decide a pending supersedes proposal (a T0 supersedes edge). Approving promotes the link to canon and marks the targets superseded (they stay readable forever); rejecting retracts the link and leaves everything active. Requires a trusted key.",
      inputSchema: z.object({
        contributor_key: trustedKeyParam,
        refactor_id: z.string().uuid().describe("The contribution that proposed the refactor."),
        decision: z
          .enum(["approve", "reject"])
          .describe("'approve' retires the superseded entries and keeps the replacement. 'reject' leaves everything active."),
        note: z.string().min(1).describe("Why, in your own words. Recorded in the event ledger and readable by everyone."),
      }),
    },
    async ({ contributor_key, refactor_id, decision, note }) => {
      const who = await trustedCheck(contributor_key);
      if (!who.ok) return fail({ error: who.refusal });
      await logRequest("apply_refactor", who.identityId, { refactor_id, decision });
      const proposals = await sql<{ edge_id: string; dst: string }[]>`
        select e.contribution_id as edge_id, e.dst from edge e
        join contribution ec on ec.id = e.contribution_id
        where e.src = ${refactor_id} and e.rel = 'supersedes' and ec.status = 'active' and ec.tier = 0`;
      if (proposals.length === 0) return fail({ error: "no pending supersedes proposal on that contribution" });
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
      return structured(ApplyRefactorOut, { ok: true, decision, targets: proposals.map((p) => p.dst), note });
    },
  );

  server.registerTool(
    "retract",
    {
      title: "Retract an entry",
      outputSchema: RetractOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Mark one of your own entries retracted (it stays readable, because the ledger never forgets, it only annotates). Trusted reviewers can retract anything with a note.",
      inputSchema: z.object({
        contributor_key: ownKeyParam,
        ref: refParam.describe("The entry to retract: id, name, or title."),
        note: z.string().min(1).describe("Why, for example wrong, duplicate, or superseded elsewhere."),
      }),
    },
    async ({ contributor_key, ref, note }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return fail(me);
      const { identityId } = me;
      const found = await refOr(ref);
      if ("failed" in found) return found.failed;
      const id = found.id;
      const [target] = await sql<{ identity_id: string | null }[]>`select identity_id from contribution where id = ${id}`;
      if (!target) return fail({ error: "no contribution with that id" });
      if (target.identity_id !== identityId) {
        const who = await trustedCheck(contributor_key);
        if (!who.ok) {
          return fail({ error: "that entry belongs to a different identity. Only its author (or a trusted reviewer) can retract it." });
        }
      }
      await logRequest("retract", identityId, { id });
      await sql.begin(async (tx) => {
        await tx`update contribution set status = 'retracted', updated_at = now() where id = ${id}`;
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values ('retracted', ${id}, ${identityId}, ${tx.json({ note } as never)})`;
      });
      await refreshAround([id]);
      return structured(RetractOut, { ok: true, id, note });
    },
  );

  server.registerTool(
    "grant_trust",
    {
      title: "Grant or change trust (operator)",
      outputSchema: GrantTrustOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Set an identity's role: contributor, trusted (may promote review tiers), or operator (may also administer trust). This is how trust expands beyond the initial operator. Requires an operator key.",
      inputSchema: z.object({
        contributor_key: z
          .string()
          .optional()
          .describe("An operator key. May be sent as an `Authorization: Bearer mrk_…` header instead."),
        identity_id: z.string().describe("The identity (sha256 of their contributor key) to set the role on."),
        role: z
          .enum(["contributor", "trusted", "operator"])
          .describe("'contributor' is the default everyone starts at. 'trusted' can promote tiers and apply refactors. 'operator' can also grant trust and tune discovery."),
        note: z.string().min(1).describe("Why, in your own words. Recorded in the event ledger and readable by everyone."),
      }),
    },
    async ({ contributor_key, identity_id, role, note }) => {
      const who = await operatorCheck(contributor_key);
      if (!who.ok) return fail({ error: who.refusal });
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
      return structured(GrantTrustOut, { ok: done, identity_id, role, note });
    },
  );

  server.registerTool(
    "register_public_key",
    {
      title: "Register a signing key (optional)",
      outputSchema: RegisterPublicKeyOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Attach an Ed25519 public key (base64) to your identity so you can sign submissions and prove authorship independently of this server. Entirely optional.",
      inputSchema: z.object({
        contributor_key: ownKeyParam,
        public_key: z.string().describe("Ed25519 public key, base64 (spki/der)."),
        display_name: z.string().optional().describe("A name to show next to your work, if you'd like one."),
      }),
    },
    async ({ contributor_key, public_key, display_name }) => {
      const me = await requireIdentity(contributor_key);
      if ("error" in me) return fail(me);
      const { identityId } = me;
      await logRequest("register_public_key", identityId, {});
      await updateIdentity(identityId, { public_key, ...(display_name ? { display_name } : {}) });
      return structured(RegisterPublicKeyOut, { ok: true, identity: identityId });
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
