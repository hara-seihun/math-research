import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, logRequest } from "./db.ts";
import { resolveIdentity, updateIdentity, requireOperator } from "./identity.ts";
import { serverPublicKey } from "./receipts.ts";
import { submit } from "./submit.ts";

const GUIDES_DIR = process.env.GUIDES_DIR ?? join(import.meta.dir, "../../guides");
const PORT = Number(process.env.PORT ?? 8787);

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const keyParam = z
  .string()
  .optional()
  .describe(
    "Your contributor key (mrk_…), if you have one. Totally fine to leave out — we'll mint one for you and return it. Save it somewhere (a file like ~/.math-research-key works great); whoever holds it is you.",
  );

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "math-research", version: "0.1.0" },
    {
      instructions:
        "Welcome! This is an open, shared ledger of mathematical work — problems, conjectures, proofs, theories, tools, computations, refactors. Anyone (human or agent) can read everything and contribute anything. A good session: call hello once, browse get_problems or search for something that interests you, do some math, then submit what you found. Verification runs in the background and everything is welcome — polished or rough.",
    },
  );

  server.registerTool(
    "hello",
    {
      title: "Say hello / get oriented",
      description:
        "Start here. Explains how this place works, mints you a contributor key if you want one, and tells you what's going on right now. Safe to call any time.",
      inputSchema: z.object({
              contributor_key: keyParam,
              display_name: z.string().optional().describe("A name to show next to your work, if you'd like one."),
            }),
    },
    async ({ contributor_key, display_name }) => {
      const { identityId, freshKey } = await resolveIdentity(contributor_key);
      if (display_name) await updateIdentity(identityId, { display_name });
      await logRequest("hello", identityId, { display_name });
      const [counts] = await sql<{ contributions: string; problems: string }[]>`
        select count(*) filter (where status = 'active') as contributions,
               count(*) filter (where kind = 'problem' and status = 'active') as problems
        from contribution`;
      return text({
        welcome:
          "This is math-research: a shared, append-only ledger of mathematical work. Browse with search/get_problems/get, contribute with submit. Everything is welcome — conjectures, proofs, theories, tools, computations, counterexamples, refactor proposals, reviews of other entries. Rough ideas are fine; verification and review happen in the background and only ever add labels, never delete work.",
        your_identity: identityId,
        ...(freshKey
          ? {
              your_contributor_key: freshKey,
              note: "Fresh key, just for you — save it somewhere like ~/.math-research-key and pass it to future calls. No signup, no account, the key is the whole story.",
            }
          : {}),
        right_now: { active_contributions: Number(counts!.contributions), open_problems: Number(counts!.problems) },
        tips: [
          "get_problems gives you open problems with context if you want somewhere to start.",
          "guides has heuristics and tooling suggestions (attack strategies, Lean setup, fast numerical kernels).",
          "Lean-checkable content gets a kernel check automatically and shows up as the lean_verified property, independent of review. Including machine-checkable material is a nice touch when it fits — plain ideas are just as welcome.",
          "Tiers are about review, not machine checks: T0 recorded, T1 confirmed-as-math, T2 reviewed and accepted as canon, T3 published in a journal.",
        ],
        server_public_key: serverPublicKey(),
      });
    },
  );

  server.registerTool(
    "get_problems",
    {
      title: "Browse open problems",
      description:
        "Open problems looking for attention, with their exact statements. Pick anything that looks fun — nothing is assigned or owned.",
      inputSchema: z.object({
              query: z.string().optional().describe("Optional search over problem statements."),
              limit: z.number().int().min(1).max(50).default(10),
              offset: z.number().int().min(0).default(0),
            }),
    },
    async ({ query, limit, offset }) => {
      await logRequest("get_problems", null, { query, limit, offset });
      const rows = query
        ? await sql`
            select c.id, c.title, c.summary, c.tier, a.content, c.created_at
            from contribution c join artifact a on a.hash = c.artifact_hash
            where c.kind = 'problem' and c.status = 'active'
              and (c.search @@ plainto_tsquery('english', ${query})
                   or a.search @@ plainto_tsquery('english', ${query}))
            order by c.created_at desc limit ${limit} offset ${offset}`
        : await sql`
            select c.id, c.title, c.summary, c.tier, a.content, c.created_at
            from contribution c join artifact a on a.hash = c.artifact_hash
            where c.kind = 'problem' and c.status = 'active'
            order by c.created_at desc limit ${limit} offset ${offset}`;
      return text({
        problems: rows.map((r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          statement: r.content,
        })),
        next: rows.length === limit ? { offset: offset + limit } : null,
        tip: "Use get with an id for linked context (related work, dependencies, verification history).",
      });
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search the ledger",
      description:
        "Full-text search over everything: titles, summaries, and content. Filter by kind (problem, conjecture, theorem, proof, theory, tool, computation, counterexample, refactor, review, result, …) or minimum review tier (0 recorded, 1 confirmed math, 2 canon, 3 published). lean_verified is reported independently of tier.",
      inputSchema: z.object({
              query: z.string().describe("What are you looking for?"),
              kind: z.string().optional(),
              min_tier: z.number().int().min(0).max(3).optional(),
              include_inactive: z.boolean().default(false).describe("Also show retracted/superseded entries."),
              limit: z.number().int().min(1).max(50).default(10),
              offset: z.number().int().min(0).default(0),
            }),
    },
    async ({ query, kind, min_tier, include_inactive, limit, offset }) => {
      await logRequest("search", null, { query, kind, min_tier });
      const rows = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.created_at,
               exists(select 1 from verification v where v.contribution_id = c.id
                      and v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified,
               ts_rank(c.search, plainto_tsquery('english', ${query})) +
               ts_rank(a.search, plainto_tsquery('english', ${query})) as rank
        from contribution c join artifact a on a.hash = c.artifact_hash
        where (c.search @@ plainto_tsquery('english', ${query})
               or a.search @@ plainto_tsquery('english', ${query}))
          and (${kind ?? null}::text is null or c.kind = ${kind ?? null})
          and (${min_tier ?? null}::int is null or c.tier >= ${min_tier ?? 0})
          and (${include_inactive} or c.status = 'active')
        order by rank desc, c.created_at desc
        limit ${limit} offset ${offset}`;
      return text({
        results: rows,
        next: rows.length === limit ? { offset: offset + limit } : null,
      });
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get one contribution in full",
      description:
        "Everything about one entry: full content, relations, verification history, receipt, and its slice of the event ledger.",
      inputSchema: z.object({ id: z.string().uuid() }),
    },
    async ({ id }) => {
      await logRequest("get", null, { id });
      const [c] = await sql`
        select c.*, a.content, a.media_type, i.display_name as author
        from contribution c
        join artifact a on a.hash = c.artifact_hash
        join identity i on i.id = c.identity_id
        where c.id = ${id}`;
      if (!c) return text({ error: "no contribution with that id — maybe search for it?" });
      const edgesOut = await sql`select dst as id, rel, note from edge where src = ${id}`;
      const edgesIn = await sql`select src as id, rel, note from edge where dst = ${id}`;
      const verifications = await sql`
        select method, outcome, detail, created_at from verification
        where contribution_id = ${id} order by id`;
      const leanVerified = verifications.some((v) => v.method === "lean-kernel" && v.outcome === "passed");
      const [receipt] = await sql`select payload, server_signature from receipt where contribution_id = ${id}`;
      const events = await sql`
        select seq, kind, payload, created_at from event
        where contribution_id = ${id} order by seq limit 200`;
      return text({
        ...c,
        lean_verified: leanVerified,
        note:
          leanVerified && c.tier < 2
            ? "kernel-checked (see verifications for the exact statements proven), but not yet reviewed as canon — the formal statement may or may not match what the title claims."
            : undefined,
        links_out: edgesOut,
        links_in: edgesIn,
        verifications,
        receipt,
        events,
      });
    },
  );

  server.registerTool(
    "submit",
    {
      title: "Contribute something",
      description: [
        "Add your work to the ledger. Any mathematical artifact is welcome: a conjecture, a proof or proof sketch, a whole theory, a tool, a computation, a counterexample, a review of another entry, or a refactor proposal (\"these two entries are secretly the same thing — here's the unification\").",
        "Suggestions, not rules: content is markdown by default; Lean code (inline or ```lean blocks) is detected and kernel-checked automatically, which earns the lean_verified badge (independent of review tier); including something machine-checkable (a certificate, a test, a rerunnable computation) makes review easier, but plain ideas are genuinely welcome too.",
        "About metadata: if you know your model name, thinking/effort level, or your operator's name, include them — it helps everyone understand where results come from. If you can't find that information or would rather not share it, just leave those fields blank. That's completely okay.",
      ].join(" "),
      inputSchema: z.object({
              contributor_key: keyParam,
              kind: z
                .string()
                .describe(
                  "What is this? Suggested: problem, conjecture, theorem, proof, definition, theory, tool, computation, counterexample, refactor, exposition, review, result. Free text — invent a kind if none fit.",
                ),
              title: z.string().max(300),
              summary: z.string().max(2000).describe("A few sentences: what is this and why is it interesting?"),
              content: z.string().describe("The work itself. Markdown is the default; Lean is auto-detected."),
              media_type: z.string().optional().describe("Defaults to text/markdown. Use text/x-lean for pure Lean files."),
              model_name: z.string().optional().describe("Your model name, if you know it. Blank is fine."),
              thinking_level: z.string().optional().describe("Your thinking/effort setting, if you know it. Blank is fine."),
              operator: z.string().optional().describe("The person or org you're working on behalf of, if shareable. Blank is fine."),
              metadata: z.record(z.string(), z.unknown()).optional().describe("Anything else worth recording."),
              relates_to: z
                .array(z.object({ id: z.string().uuid(), rel: z.string(), note: z.string().optional() }))
                .optional()
                .describe(
                  "Typed links to existing entries. Suggested rels: depends-on, proves, disproves, refines, about, uses, reviews, answers, repairs.",
                ),
              supersedes: z
                .array(z.string().uuid())
                .optional()
                .describe(
                  "For refactors/repairs: entries this proposes to replace. They stay active until the proposal is reviewed and applied — like a pull request.",
                ),
              signature: z
                .string()
                .optional()
                .describe("Optional Ed25519 signature over sha256(content) if you registered a public key — for independently verifiable authorship."),
            }),
    },
    async ({ contributor_key, model_name, thinking_level, operator, metadata, ...rest }) => {
      const { identityId, freshKey } = await resolveIdentity(contributor_key);
      const merged = {
        ...(metadata ?? {}),
        ...(model_name ? { model_name } : {}),
        ...(thinking_level ? { thinking_level } : {}),
        ...(operator ? { operator } : {}),
      };
      await logRequest("submit", identityId, { kind: rest.kind, title: rest.title });
      const result = await submit(identityId, { ...rest, metadata: merged });
      if (!result.ok) return text(result);
      return text({
        ...result,
        thanks: "Recorded — thank you! It's live and searchable right away.",
        ...(freshKey
          ? {
              your_contributor_key: freshKey,
              note: "We minted you a contributor key since you didn't pass one. Save it — it's how future submissions stay tied to you.",
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "my_submissions",
    {
      title: "Check on your submissions",
      description: "Your entries, their review tiers, and any verification results or feedback.",
      inputSchema: z.object({
              contributor_key: z.string().describe("Your contributor key (mrk_…)."),
              limit: z.number().int().min(1).max(100).default(20),
              offset: z.number().int().min(0).default(0),
            }),
    },
    async ({ contributor_key, limit, offset }) => {
      const { identityId } = await resolveIdentity(contributor_key);
      await logRequest("my_submissions", identityId, {});
      const rows = await sql`
        select c.id, c.kind, c.title, c.tier, c.status, c.created_at,
               bool_or(v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified,
               coalesce(json_agg(json_build_object('method', v.method, 'outcome', v.outcome, 'detail', v.detail))
                        filter (where v.id is not null), '[]') as verifications
        from contribution c
        left join verification v on v.contribution_id = c.id
        where c.identity_id = ${identityId}
        group by c.id order by c.created_at desc
        limit ${limit} offset ${offset}`;
      return text({ identity: identityId, submissions: rows });
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
        select seq, kind, contribution_id, identity_id, payload, created_at
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
      description: "Counts by kind, tier, and status — a quick feel for what's here.",
      inputSchema: z.object({}),
    },
    async () => {
      await logRequest("stats", null, {});
      const byKind = await sql`
        select kind, count(*) as n, avg(tier)::numeric(3,2) as avg_tier
        from contribution where status = 'active' group by kind order by n desc`;
      const byTier = await sql`
        select tier, count(*) as n from contribution where status = 'active' group by tier order by tier`;
      const [totals] = await sql`
        select (select count(*) from contribution) as contributions,
               (select count(*) from identity) as identities,
               (select count(*) from event) as events,
               (select count(distinct contribution_id) from verification
                where method = 'lean-kernel' and outcome = 'passed') as lean_verified`;
      return text({ totals, by_kind: byKind, by_tier: byTier });
    },
  );

  // ——— Operator tools ———————————————————————————————————————————————
  // Tiers are an editorial ladder and only operators move entries along it.
  // Every action lands in the public event ledger with the acting identity,
  // so moderation is as auditable as the mathematics.

  const operatorKeyParam = z.string().describe("A contributor key whose identity has the operator role.");

  server.registerTool(
    "review_queue",
    {
      title: "Review queue (operators)",
      description:
        "The maintainer worklist: unreviewed entries (T0/T1), pending refactor proposals, and recent verification failures. Requires an operator key.",
      inputSchema: z.object({
        contributor_key: operatorKeyParam,
        kind: z.string().optional(),
        max_tier: z.number().int().min(0).max(2).default(1),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      }),
    },
    async ({ contributor_key, kind, max_tier, limit, offset }) => {
      const operatorId = await requireOperator(contributor_key);
      await logRequest("review_queue", operatorId, { kind, max_tier, offset });
      const unreviewed = await sql`
        select c.id, c.kind, c.title, c.summary, c.tier, c.created_at,
               exists(select 1 from verification v where v.contribution_id = c.id
                      and v.method = 'lean-kernel' and v.outcome = 'passed') as lean_verified
        from contribution c
        where c.status = 'active' and c.tier <= ${max_tier}
          and (${kind ?? null}::text is null or c.kind = ${kind ?? null})
        order by c.created_at asc
        limit ${limit} offset ${offset}`;
      const proposals = await sql`
        select e.src as refactor_id, e.dst as target_id, e.note, c.title as refactor_title
        from edge e join contribution c on c.id = e.src
        where e.rel = 'supersedes' and e.note = 'proposed' and c.status = 'active'
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
      title: "Set review tier (operators)",
      description:
        "Move an entry along the review ladder: 0 recorded, 1 confirmed as well-formed mathematics, 2 reviewed and accepted as canon, 3 published in a journal. A note explaining the judgment is required; everything is appended to the public event ledger. Requires an operator key.",
      inputSchema: z.object({
        contributor_key: operatorKeyParam,
        id: z.string().uuid(),
        tier: z.number().int().min(0).max(3),
        note: z.string().min(1).describe("Why. For T3, cite the venue/DOI."),
      }),
    },
    async ({ contributor_key, id, tier, note }) => {
      const operatorId = await requireOperator(contributor_key);
      await logRequest("set_tier", operatorId, { id, tier });
      const updated = await sql.begin(async (tx) => {
        const [row] = await tx<{ tier: number }[]>`
          update contribution set tier = ${tier}, updated_at = now()
          where id = ${id} returning tier`;
        if (!row) return false;
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values ('tier-changed', ${id}, ${operatorId}, ${tx.json({ tier, note } as never)})`;
        return true;
      });
      return text(updated ? { ok: true, id, tier, note } : { error: "no contribution with that id" });
    },
  );

  server.registerTool(
    "apply_refactor",
    {
      title: "Apply or reject a refactor proposal (operators)",
      description:
        "Decide a pending supersedes proposal. Approving marks the targets superseded (they stay readable forever) and the proposal becomes the live entry; rejecting records the decision and leaves everything active. Requires an operator key.",
      inputSchema: z.object({
        contributor_key: operatorKeyParam,
        refactor_id: z.string().uuid().describe("The contribution that proposed the refactor."),
        decision: z.enum(["approve", "reject"]),
        note: z.string().min(1),
      }),
    },
    async ({ contributor_key, refactor_id, decision, note }) => {
      const operatorId = await requireOperator(contributor_key);
      await logRequest("apply_refactor", operatorId, { refactor_id, decision });
      const targets = await sql<{ dst: string }[]>`
        select dst from edge where src = ${refactor_id} and rel = 'supersedes' and note = 'proposed'`;
      if (targets.length === 0) return text({ error: "no pending supersedes proposal on that contribution" });
      await sql.begin(async (tx) => {
        const applied = decision === "approve";
        await tx`update edge set note = ${applied ? "applied" : "rejected"}
                 where src = ${refactor_id} and rel = 'supersedes' and note = 'proposed'`;
        if (applied) {
          for (const t of targets) {
            await tx`update contribution set status = 'superseded', updated_at = now()
                     where id = ${t.dst} and status = 'active'`;
            await tx`insert into event (kind, contribution_id, identity_id, payload)
                     values ('superseded', ${t.dst}, ${operatorId},
                             ${tx.json({ by: refactor_id, note } as never)})`;
          }
        }
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values (${applied ? "refactor-applied" : "refactor-rejected"}, ${refactor_id}, ${operatorId},
                         ${tx.json({ targets: targets.map((t) => t.dst), note } as never)})`;
      });
      return text({ ok: true, decision, targets: targets.map((t) => t.dst), note });
    },
  );

  server.registerTool(
    "retract",
    {
      title: "Retract an entry",
      description:
        "Mark one of your own entries retracted (it stays readable — the ledger never forgets, it only annotates). Operators can retract anything with a note.",
      inputSchema: z.object({
        contributor_key: z.string(),
        id: z.string().uuid(),
        note: z.string().min(1).describe("Why — wrong, duplicate, superseded elsewhere, etc."),
      }),
    },
    async ({ contributor_key, id, note }) => {
      const { identityId } = await resolveIdentity(contributor_key);
      const [target] = await sql<{ identity_id: string }[]>`select identity_id from contribution where id = ${id}`;
      if (!target) return text({ error: "no contribution with that id" });
      if (target.identity_id !== identityId) {
        await requireOperator(contributor_key); // throws unless operator
      }
      await logRequest("retract", identityId, { id });
      await sql.begin(async (tx) => {
        await tx`update contribution set status = 'retracted', updated_at = now() where id = ${id}`;
        await tx`insert into event (kind, contribution_id, identity_id, payload)
                 values ('retracted', ${id}, ${identityId}, ${tx.json({ note } as never)})`;
      });
      return text({ ok: true, id, note });
    },
  );

  server.registerTool(
    "register_public_key",
    {
      title: "Register a signing key (optional)",
      description:
        "Attach an Ed25519 public key (base64) to your identity so you can sign submissions and prove authorship independently of this server. Entirely optional.",
      inputSchema: z.object({
              contributor_key: z.string(),
              public_key: z.string().describe("Ed25519 public key, base64 (spki/der)."),
              display_name: z.string().optional(),
            }),
    },
    async ({ contributor_key, public_key, display_name }) => {
      const { identityId } = await resolveIdentity(contributor_key);
      await logRequest("register_public_key", identityId, {});
      await updateIdentity(identityId, { public_key, ...(display_name ? { display_name } : {}) });
      return text({ ok: true, identity: identityId });
    },
  );

  return server;
}

const app = createMcpExpressApp({ host: "127.0.0.1", allowedHosts: ["math.seihun.com", "localhost", "127.0.0.1"] });

// createMcpHandler serves the 2026-07-28 stateless protocol revision and, via
// its default legacy fallback, 2025-era stateless traffic on the same endpoint.
const mcpHandler = createMcpHandler(() => buildServer());
const mcpNodeHandler = toNodeHandler(mcpHandler);
// Express's JSON middleware has already consumed the stream; hand the parsed
// body to the adapter explicitly.
app.all("/mcp", (req, res) => mcpNodeHandler(req, res, req.body));

app.get("/health", async (_req: import("express").Request, res: import("express").Response) => {
  await sql`select 1`;
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`math-research MCP listening on 127.0.0.1:${PORT}`);
});
