import { sql } from "./db.ts";
import { sha256hex } from "./identity.ts";
import { issueReceipt } from "./receipts.ts";
import { createEdge, refreshNotability, refreshState } from "./graph.ts";

const MAX_CONTENT_BYTES = 1 << 20; // 1 MiB

export type SubmitInput = {
  kind: string;
  title: string;
  summary: string;
  content: string;
  media_type?: string;
  state?: string;
  metadata?: Record<string, unknown>;
  names?: string[];
  relates_to?: { id: string; rel: string; note?: string }[];
  supersedes?: string[];
  signature?: string;
};

const LEAN_HINT = /^\s*import\s+Mathlib|```lean|\btheorem\b[\s\S]*\bby\b/m;

export type SubmitResult =
  | { ok: true; id: string; tier: number; duplicate_of?: string; lean_queued: boolean; receipt: unknown; notes: string[] }
  | { ok: false; error: string };

export async function submit(identityId: string | null, input: SubmitInput): Promise<SubmitResult> {
  const notes: string[] = [];
  const content = input.content ?? "";
  if (!input.title?.trim() || !input.summary?.trim() || !content.trim()) {
    return { ok: false, error: "title, summary, and content are all needed — everything else is optional." };
  }
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error: "content is over 1 MiB. Split it into parts and link them with relates_to, or trim it down.",
    };
  }

  const hash = sha256hex(content);
  const mediaType = input.media_type ?? "text/markdown";

  // Exact duplicates attach as a new contribution over the same artifact
  // only if titled differently by a different identity; the common case
  // (same content resubmitted) just points at the original.
  const [existing] = await sql<{ id: string }[]>`
    select id from contribution where artifact_hash = ${hash} and status = 'active' limit 1`;

  const result = await sql.begin(async (tx) => {
    await tx`insert into artifact (hash, media_type, content, size_bytes)
             values (${hash}, ${mediaType}, ${content}, ${Buffer.byteLength(content)})
             on conflict do nothing`;

    const classifyText = `${input.title}\n${input.summary}\n${content}`.slice(0, 4000);
    const names = (input.names ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 12);
    const [contribution] = await tx<
      { id: string; created_at: Date; artifact_hash: string; identity_id: string | null }[]
    >`
      insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id, tags, names, state)
      values (${input.kind}, ${input.title}, ${input.summary}, ${hash},
              ${sql.json((input.metadata ?? {}) as never)}, ${identityId}, classify_topics(${classifyText}), ${names}::text[],
              ${input.state ?? null})
      returning id, created_at, artifact_hash, identity_id`;

    await tx`insert into event (kind, contribution_id, identity_id, payload)
             values ('submitted', ${contribution!.id}, ${identityId},
                     ${sql.json({ kind: input.kind, title: input.title, artifact_hash: hash, signature: input.signature ?? null } as never)})`;

    for (const link of input.relates_to ?? []) {
      await createEdge(tx, { identityId, src: contribution!.id, dst: link.id, rel: link.rel, note: link.note });
    }
    for (const target of input.supersedes ?? []) {
      await createEdge(tx, { identityId, src: contribution!.id, dst: target, rel: "supersedes", note: "proposed refactor" });
    }
    if (existing) {
      await createEdge(tx, { identityId, src: contribution!.id, dst: existing.id, rel: "duplicates", note: "identical artifact" });
    }
    return contribution!;
  });

  if (existing) {
    notes.push(`heads up: identical content already exists as ${existing.id} — linked it for you.`);
  }
  const touched = [result.id, ...(input.relates_to ?? []).map((l) => l.id), ...(input.supersedes ?? [])];
  await refreshState(touched);
  await refreshNotability(touched);

  if ((input.supersedes ?? []).length > 0) {
    notes.push(
      "supersedes recorded as a proposal — the targets stay active until the refactor is reviewed and applied.",
    );
  }

  let leanQueued = false;
  if (LEAN_HINT.test(content) || mediaType === "text/x-lean") {
    await sql`insert into verification (contribution_id, method) values (${result.id}, 'lean-kernel')`;
    leanQueued = true;
    notes.push("looks like Lean — queued for a kernel check. Watch my_submissions for the result.");
  }

  const receipt = await issueReceipt(result);
  return { ok: true, id: result.id, tier: 0, duplicate_of: existing?.id, lean_queued: leanQueued, receipt, notes };
}
