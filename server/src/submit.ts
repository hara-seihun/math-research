import { sql } from "./db.ts";
import { sha256hex, verifyAuthorship } from "./identity.ts";
import { issueReceipt } from "./receipts.ts";
import { createEdge, refreshAround } from "./graph.ts";
import { isPatchSubmission, MAX_DIFF_BYTES, extractDiff, PATCH_REPO } from "./patch.ts";
import { LADDER_ESCAPE, ladderRefusal, priorRungs } from "./ladder.ts";
import { EXPOSITION_KIND } from "./exposition.ts";
import { renderArtifact } from "./render.ts";
import { detectLean, hasUnfencedDecl } from "./lean.ts";

const MAX_CONTENT_BYTES = 1 << 20; // 1 MiB

export type SubmitInput = {
  kind: string;
  title: string;
  summary: string;
  content: string;
  media_type?: string;
  state?: string;
  metadata?: Record<string, unknown>;
  external_source?: string;
  names?: string[];
  relates_to?: { id: string; rel: string; note?: string }[];
  supersedes?: string[];
  signature?: string;
  /** The vocabulary a theory introduces. Each becomes its own kind='definition'
   *  entry, named and linkable, with an `introduces` edge from the theory: a
   *  concept nobody can point at is a concept nobody can reuse, and asking an
   *  author to make five more calls to mint five definitions is asking them
   *  not to. */
  definitions?: { term: string; statement: string; names: string[] }[];
};

export type SubmitResult =
  | {
      ok: true;
      id: string;
      /** Null for a review: it is the judgement, so there is no ladder under
       *  it and nothing to promote. Every other kind is recorded at T0. */
      tier: number | null;
      duplicate_of?: string;
      lean_queued: boolean;
      receipt: unknown;
      notes: string[];
      introduced?: { id: string; term: string }[];
    }
  | { ok: false; error: string };

export async function submit(identityId: string | null, input: SubmitInput): Promise<SubmitResult> {
  const notes: string[] = [];
  const content = input.content ?? "";
  if (!input.title?.trim() || !input.summary?.trim() || !content.trim()) {
    return { ok: false, error: "title, summary, and content are all needed. Everything else is optional." };
  }
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error: "content is over 1 MiB. Split it into parts and link them with relates_to, or trim it down.",
    };
  }

  // A third title that differs from two of your own only in its constants is
  // a ladder, and the guide is binding about not climbing one. Checked before
  // anything is written, and answered with the two ways out rather than a
  // verdict on the mathematics.
  const climbed = String(input.metadata?.[LADDER_ESCAPE] ?? "").trim();
  if (!climbed) {
    const { rungs } = await priorRungs(identityId, input.kind, input.title);
    if (rungs.length >= 2) return { ok: false, error: ladderRefusal(rungs) };
  } else {
    notes.push(
      `recorded as a deliberate next case, unlocking: ${climbed}. Review reads that claim, so the general statement it unlocks is what is expected from you next.`,
    );
  }

  const hash = sha256hex(content);
  const mediaType =
    input.media_type ??
    (input.kind === "patch" ? "text/x-diff" : input.kind === EXPOSITION_KIND ? "text/x-latex" : "text/markdown");
  // Priority, declared by the author and correctable by review (set_origin).
  const externalSource = input.external_source?.trim() || undefined;

  if (isPatchSubmission(input.kind, mediaType, content) && Buffer.byteLength(extractDiff(content)) > MAX_DIFF_BYTES) {
    return {
      ok: false,
      error: `that patch is over ${MAX_DIFF_BYTES >> 10} KiB of diff. Split it into patches that each stand on their own.`,
    };
  }

  // An authorship signature is checked before anything is written, and a bad
  // one fails the whole submission: recording a signature nobody verified
  // would publish a proof that isn't one.
  if (input.signature !== undefined) {
    const authorship = await verifyAuthorship(identityId, hash, input.signature);
    if (!authorship.ok) return { ok: false, error: authorship.error };
    notes.push("your signature checks out against your registered public key, and is recorded as an authorship verification anyone can re-check.");
  }

  const minted: { id: string; term: string }[] = [];
  let existing: { id: string } | undefined;
  const result = await sql.begin(async (tx) => {
    await tx`insert into artifact (hash, media_type, content, size_bytes)
             values (${hash}, ${mediaType}, ${content}, ${Buffer.byteLength(content)})
             on conflict do nothing`;

    const classifyText = `${input.title}\n${input.summary}\n${content}`.slice(0, 4000);
    const names = (input.names ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 12);
    const [contribution] = await tx<
      { id: string; created_at: Date; artifact_hash: string; identity_id: string | null }[]
    >`
      insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id, tags, names, state,
                                origin, origin_source)
      values (${input.kind}, ${input.title}, ${input.summary}, ${hash},
              ${sql.json((input.metadata ?? {}) as never)}, ${identityId}, classify_topics(${classifyText}), ${names}::text[],
              ${input.state ?? null},
              ${externalSource ? "external" : "ledger"}, ${externalSource ?? null})
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
    for (const d of input.definitions ?? []) {
      const body = `${d.statement}\n`;
      const defHash = sha256hex(`definition:${d.term}\n${body}`);
      await tx`insert into artifact (hash, media_type, content, size_bytes)
               values (${defHash}, 'text/markdown', ${body}, ${Buffer.byteLength(body)})
               on conflict do nothing`;
      const [def] = await tx<{ id: string }[]>`
        insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id, tags, names,
                                  origin, origin_source)
        values ('definition', ${d.term}, ${d.statement.slice(0, 2000)}, ${defHash},
                ${tx.json({ introduced_by: contribution!.id } as never)}, ${identityId},
                classify_topics(${`${d.term}\n${d.statement}`}), ${d.names}::text[],
                ${externalSource ? "external" : "ledger"}, ${externalSource ?? null})
        returning id`;
      await tx`insert into event (kind, contribution_id, identity_id, payload)
               values ('submitted', ${def!.id}, ${identityId},
                       ${tx.json({ kind: "definition", title: d.term, introduced_by: contribution!.id } as never)})`;
      await createEdge(tx, {
        identityId, src: contribution!.id, dst: def!.id, rel: "introduces",
        note: `vocabulary introduced by this theory`,
      });
      minted.push({ id: def!.id, term: d.term });
    }
    // Resubmitted work points at the original. Sameness is the artifact *and*
    // what the entry proposes to do, because a proposal's body is the author's
    // prose and its payload -- which entry, retitled to what; which entry,
    // scored how -- is structured metadata. On artifact_hash alone, a batch of
    // template amendments retitling hundreds of different entries called
    // itself one duplicated entry: 752 false `duplicates` edges that a
    // reviewer rejected by hand, twice, in one day.
    [existing] = await tx<{ id: string }[]>`
      select c.id from contribution c, contribution n
      where n.id = ${contribution!.id}
        and c.artifact_hash = ${hash} and c.status = 'active' and c.id <> n.id
        and c.metadata -> 'amendment' is not distinct from n.metadata -> 'amendment'
        and c.metadata -> 'impact' is not distinct from n.metadata -> 'impact'
      order by c.created_at limit 1`;
    if (existing) {
      await createEdge(tx, { identityId, src: contribution!.id, dst: existing.id, rel: "duplicates", note: "identical artifact" });
    }
    return contribution!;
  });

  if (existing) {
    notes.push(`identical content already exists as ${existing.id}, so I linked it for you.`);
  }
  if (externalSource) {
    notes.push(
      `recorded as external in origin, established by ${externalSource}. It counts as evidence and can settle a question here, but it stays off the all-time board of what this ledger established first.`,
    );
  }
  const touched = [result.id, ...(input.relates_to ?? []).map((l) => l.id), ...(input.supersedes ?? []), ...minted.map((m) => m.id)];
  await refreshAround(touched);
  if (minted.length) {
    notes.push(
      `minted ${minted.length} definition ${minted.length === 1 ? "entry" : "entries"} for the vocabulary this theory introduces (${minted
        .map((m) => m.term)
        .join(", ")}). Each is its own entry, resolvable by name from any tool that takes a ref.`,
    );
  }

  if ((input.supersedes ?? []).length > 0) {
    notes.push(
      "supersedes recorded as a proposal. The targets stay active until the refactor is reviewed and applied.",
    );
  }
  if (input.kind === "route" && input.metadata?.first_unsupported) {
    notes.push(
      "recorded as a durable route obstruction. It now participates in review and appears under where_routes_stall on the attacked problem's frontier.",
    );
  }

  if (input.signature !== undefined) {
    await sql`insert into verification (contribution_id, method, outcome, detail)
              values (${result.id}, 'authorship-signature', 'passed',
                      ${sql.json({ signature: input.signature, signed: "sha256(content)" } as never)})`;
  }

  // A patch is a change to the library, not a file of Lean to elaborate: it is
  // verified by applying it and rebuilding what it touches, so it goes to the
  // patch queue and never to the kernel queue, whose answer for a diff would
  // be a syntax error.
  let leanQueued = false;
  if (isPatchSubmission(input.kind, mediaType, content)) {
    await sql`insert into verification (contribution_id, method) values (${result.id}, 'patch-build')`;
    const base = (input.metadata?.base_commit as string | undefined)?.trim();
    notes.push(
      `recorded as a patch against ${PATCH_REPO}${base ? ` at ${base.slice(0, 8)}` : " at its current head"}. It is being applied and every module it touches rebuilt, along with everything that imports them; watch my_submissions. Nothing reaches the library until review promotes this to T2.`,
    );
  } else if (mediaType === "text/x-latex" || mediaType === "text/x-tex") {
    // A paper is rendered on the way in, not on the way out, because the
    // author is the only person who can fix it and the only moment they are
    // still here is now. What pandoc could not make sense of comes back as
    // notes; it is never a rejection, since a paper with one unknown macro is
    // still a paper.
    try {
      const rendered = await renderArtifact(hash);
      if (rendered?.warnings.length) {
        notes.push(
          `your LaTeX renders, with ${rendered.warnings.length} thing${rendered.warnings.length === 1 ? "" : "s"} the renderer could not use: ${rendered.warnings.join("; ")}. Everything else is on the page. Submit a corrected version that supersedes this one if that matters.`,
        );
      } else if (rendered) {
        notes.push("your LaTeX renders cleanly, mathematics and all. It is readable on the site as soon as it is linked.");
      }
    } catch (e) {
      notes.push(
        `recorded, but the renderer could not turn this LaTeX into a page: ${e instanceof Error ? e.message : String(e)}. The source is stored exactly as you sent it.`,
      );
    }
  } else if (detectLean(content, mediaType)) {
    await sql`insert into verification (contribution_id, method) values (${result.id}, 'lean-kernel')`;
    leanQueued = true;
    notes.push("there is Lean in this, so it is queued for a kernel check. Watch my_submissions for the result.");
  } else if (hasUnfencedDecl(content)) {
    notes.push(
      "there is what looks like a Lean declaration in here, but it is loose in the prose, so nothing was sent to the kernel. Put it in a ```lean block and submit that version to have it checked.",
    );
  }

  const receipt = await issueReceipt(result);
  return {
    ok: true,
    id: result.id,
    tier: input.kind === "review" ? null : 0,
    duplicate_of: existing?.id,
    lean_queued: leanQueued,
    receipt,
    notes,
    ...(minted.length ? { introduced: minted } : {}),
  };
}
