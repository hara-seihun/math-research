import { sql } from "./db.ts";
import { sha256hex } from "./identity.ts";
import { issueReceipt } from "./receipts.ts";

const MAX_CONTENT_BYTES = 1 << 20; // 1 MiB

export type SubmitInput = {
  kind: string;
  title: string;
  summary: string;
  content: string;
  media_type?: string;
  metadata?: Record<string, unknown>;
  relates_to?: { id: string; rel: string; note?: string }[];
  supersedes?: string[];
  signature?: string;
};

const LEAN_HINT = /^\s*import\s+Mathlib|```lean|\btheorem\b[\s\S]*\bby\b/m;

export type SubmitResult =
  | { ok: true; id: string; tier: number; duplicate_of?: string; lean_queued: boolean; receipt: unknown; notes: string[] }
  | { ok: false; error: string };

export async function submit(identityId: string, input: SubmitInput): Promise<SubmitResult> {
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

    const [contribution] = await tx<
      { id: string; created_at: Date; artifact_hash: string; identity_id: string }[]
    >`
      insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id)
      values (${input.kind}, ${input.title}, ${input.summary}, ${hash},
              ${sql.json((input.metadata ?? {}) as never)}, ${identityId})
      returning id, created_at, artifact_hash, identity_id`;

    await tx`insert into event (kind, contribution_id, identity_id, payload)
             values ('submitted', ${contribution!.id}, ${identityId},
                     ${sql.json({ kind: input.kind, title: input.title, artifact_hash: hash, signature: input.signature ?? null } as never)})`;

    for (const link of input.relates_to ?? []) {
      await tx`insert into edge (src, dst, rel, note)
               values (${contribution!.id}, ${link.id}, ${link.rel}, ${link.note ?? null})
               on conflict do nothing`;
    }
    for (const target of input.supersedes ?? []) {
      await tx`insert into edge (src, dst, rel, note)
               values (${contribution!.id}, ${target}, 'supersedes', 'proposed')
               on conflict do nothing`;
    }
    return contribution!;
  });

  if (existing) {
    notes.push(`heads up: identical content already exists as ${existing.id} — linked it for you.`);
    await sql`insert into edge (src, dst, rel, note)
              values (${result.id}, ${existing.id}, 'duplicates', 'identical artifact')
              on conflict do nothing`;
  }

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
