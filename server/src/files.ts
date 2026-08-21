import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { sql } from "./db.ts";

// --- Evidence files ------
// A certificate is rarely one Markdown body: it is scripts, receipts, pinned
// binary inputs, and archives whose exact bytes other records reference by
// SHA-256. Those cannot live in `artifact` (text, 1 MiB) and should not be
// paraphrased into it. So the ledger stores them as content-addressed blobs on
// disk, bound to entries by (path, hash) rows, uploaded over HTTP because a
// JSON tool call is the wrong pipe for a hundred megabytes, and served forever
// at /files/<hash> because content under a hash cannot change.

const FILE_ROOT = process.env.FILE_ROOT ?? "/var/lib/math-research/files";
/** One blob's ceiling. Uploads arrive in chunks well under proxy body caps,
 *  so this bounds disk, not requests. */
export const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 8 * 2 ** 30);
/** One chunk's ceiling; express buffers a chunk in memory. Cloudflare caps
 *  request bodies at 100 MB, so anything larger must chunk anyway. */
export const MAX_CHUNK_BYTES = Number(process.env.MAX_CHUNK_BYTES ?? 64 << 20);

export const FILE_HASH = /^[0-9a-f]{64}$/;

export const objectPath = (hash: string) => `${FILE_ROOT}/objects/${hash.slice(0, 2)}/${hash}`;
const stagingPath = (hash: string) => `${FILE_ROOT}/staging/${hash}`;

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

const sha256OfFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hasher.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hasher.digest("hex")));
  });

export type UploadResult =
  | { status: number; body: { error: string; resume_at?: number } }
  | { status: 200; body: { stored: true; hash: string; size_bytes: number; existing?: true } }
  | { status: 200; body: { received: number; of: number } };

/**
 * One chunk of one declared blob. Chunks append sequentially into a staging
 * file named by the declared hash; when the declared total is reached, the
 * staging file is hashed and either becomes the object or is thrown away.
 * The offset check makes an interrupted upload resumable (the 409 names the
 * byte to resume from) rather than restartable. Two uploaders racing the same
 * hash across instances can interleave appends; the final hash check fails
 * closed, deletes the staging file, and both start over, which is the right
 * cost for a case that means the same bytes were being sent twice anyway.
 */
export async function receiveChunk(
  identityId: string,
  hash: string,
  chunk: Buffer,
  offset: number,
  total: number,
  mediaType: string | undefined,
): Promise<UploadResult> {
  if (!FILE_HASH.test(hash)) {
    return { status: 400, body: { error: "a file is addressed by the lowercase hex sha256 of its bytes." } };
  }
  if (!Number.isInteger(total) || total < 0 || total > MAX_FILE_BYTES) {
    return {
      status: 413,
      body: { error: `total must be the file's exact byte count, at most ${MAX_FILE_BYTES}.` },
    };
  }
  if (!Number.isInteger(offset) || offset < 0 || offset + chunk.length > total) {
    return { status: 400, body: { error: "offset and chunk together overrun the declared total." } };
  }

  const [existing] = await sql<{ size_bytes: number }[]>`select size_bytes from file where hash = ${hash}`;
  if (existing) return { status: 200, body: { stored: true, hash, size_bytes: Number(existing.size_bytes), existing: true } };

  const staged = stagingPath(hash);
  await mkdir(`${FILE_ROOT}/staging`, { recursive: true });
  const stagedSize = (await sizeOf(staged)) ?? 0;
  if (stagedSize !== offset) {
    return {
      status: 409,
      body: { error: `staged upload for this hash is at byte ${stagedSize}, not ${offset}. Resume from there.`, resume_at: stagedSize },
    };
  }
  // An empty chunk still touches the staging file, which is what lets a
  // zero-byte file (a legitimate marker in many trees) complete.
  await appendFile(staged, chunk);
  const now = stagedSize + chunk.length;
  if (now < total) return { status: 200, body: { received: now, of: total } };

  const digest = await sha256OfFile(staged);
  if (digest !== hash) {
    await rm(staged, { force: true });
    return {
      status: 422,
      body: { error: `assembled bytes hash to ${digest}, not the declared ${hash}. The staging copy is discarded; check your bytes and start over.` },
    };
  }
  const dest = objectPath(hash);
  await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  await rename(staged, dest);
  await sql`insert into file (hash, media_type, size_bytes, identity_id)
            values (${hash}, ${mediaType?.split(";")[0]?.trim() || "application/octet-stream"}, ${total}, ${identityId})
            on conflict do nothing`;
  return { status: 200, body: { stored: true, hash, size_bytes: total } };
}

export type StoredFile = { hash: string; media_type: string; size_bytes: number };

export async function storedFile(hash: string): Promise<(StoredFile & { path: string }) | null> {
  if (!FILE_HASH.test(hash)) return null;
  const [row] = await sql<{ media_type: string; size_bytes: number }[]>`
    select media_type, size_bytes from file where hash = ${hash}`;
  if (!row) return null;
  const path = objectPath(hash);
  return (await sizeOf(path)) === null ? null : { hash, media_type: row.media_type, size_bytes: Number(row.size_bytes), path };
}

// A path is how a bundle of blobs reads as a tree. Relative, forward slashes,
// no traversal, so it can be materialized onto any filesystem verbatim.
const GOOD_PATH = /^[^\0]{1,512}$/;
export function badPath(path: string): string | null {
  if (!GOOD_PATH.test(path) || path !== path.trim()) return "a path is 1-512 characters with no stray whitespace";
  if (path.startsWith("/") || path.includes("\\")) return "paths are relative, with forward slashes";
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return "paths cannot contain empty, '.' or '..' segments";
  }
  return null;
}

export type AttachOutcome =
  | { ok: true; attached: number; already: number; total: number; total_bytes: number }
  | { ok: false; error: string };

/**
 * Bind uploaded blobs to an entry as named files. Append-only, like everything
 * here: a path, once bound, keeps its hash forever, so a reader who fetched
 * yesterday's inventory is never silently reading different bytes today. A
 * corrected certificate is attached under a new path or a new entry.
 */
export async function attachFiles(
  identityId: string,
  contributionId: string,
  files: { path: string; sha256: string }[],
): Promise<AttachOutcome> {
  const seen = new Set<string>();
  for (const f of files) {
    const bad = badPath(f.path);
    if (bad) return { ok: false, error: `"${f.path}": ${bad}.` };
    if (!FILE_HASH.test(f.sha256)) return { ok: false, error: `"${f.path}": sha256 must be 64 lowercase hex characters.` };
    if (seen.has(f.path)) return { ok: false, error: `"${f.path}" appears twice in this call.` };
    seen.add(f.path);
  }
  const hashes = [...new Set(files.map((f) => f.sha256))];
  const known = new Set(
    (await sql<{ hash: string }[]>`select hash from file where hash = any(${hashes})`).map((r) => r.hash),
  );
  const missing = files.find((f) => !known.has(f.sha256));
  if (missing) {
    return {
      ok: false,
      error: `no uploaded file has hash ${missing.sha256} (path "${missing.path}"). PUT the bytes to /files/<sha256> first; nothing was attached.`,
    };
  }
  const conflicts = await sql<{ path: string; hash: string }[]>`
    select path, hash from contribution_file
    where contribution_id = ${contributionId} and path = any(${files.map((f) => f.path)})`;
  const byPath = new Map(conflicts.map((c) => [c.path, c.hash]));
  const contested = files.find((f) => byPath.has(f.path) && byPath.get(f.path) !== f.sha256);
  if (contested) {
    return {
      ok: false,
      error: `"${contested.path}" is already attached here with different bytes (${byPath.get(contested.path)}). Paths are immutable; attach the correction under a new path. Nothing was attached.`,
    };
  }
  const fresh = files.filter((f) => !byPath.has(f.path));
  if (fresh.length) {
    await sql.begin(async (tx) => {
      for (const f of fresh) {
        await tx`insert into contribution_file (contribution_id, path, hash, identity_id)
                 values (${contributionId}, ${f.path}, ${f.sha256}, ${identityId})
                 on conflict do nothing`;
      }
      await tx`update contribution set updated_at = now() where id = ${contributionId}`;
      await tx`insert into event (kind, contribution_id, identity_id, payload)
               values ('files-attached', ${contributionId}, ${identityId},
                       ${tx.json({ files: fresh.length, paths: fresh.slice(0, 5).map((f) => f.path) } as never)})`;
    });
  }
  const [{ n, bytes }] = await sql<{ n: number; bytes: string }[]>`
    select count(*)::int as n, coalesce(sum(f.size_bytes), 0)::bigint as bytes
    from contribution_file cf join file f on f.hash = cf.hash
    where cf.contribution_id = ${contributionId}`;
  return { ok: true, attached: fresh.length, already: files.length - fresh.length, total: n!, total_bytes: Number(bytes) };
}

export type FileListing = {
  files: { path: string; hash: string; media_type: string; size_bytes: number }[];
  files_total: number;
  files_bytes: number;
} | null;

const LISTED = 20;

/** The inventory `get` shows: the first files by path plus honest totals, so a
 *  thousand-file certificate does not bury the entry it certifies. */
export async function filesOf(contributionId: string): Promise<FileListing> {
  const rows = await sql<{ path: string; hash: string; media_type: string; size_bytes: string }[]>`
    select cf.path, cf.hash, f.media_type, f.size_bytes
    from contribution_file cf join file f on f.hash = cf.hash
    where cf.contribution_id = ${contributionId}
    order by cf.path limit ${LISTED + 1}`;
  if (!rows.length) return null;
  const capped = rows.length > LISTED;
  const shown = rows.slice(0, LISTED).map((r) => ({ ...r, size_bytes: Number(r.size_bytes) }));
  if (!capped) {
    return { files: shown, files_total: shown.length, files_bytes: shown.reduce((s, f) => s + f.size_bytes, 0) };
  }
  const [{ n, bytes }] = await sql<{ n: number; bytes: string }[]>`
    select count(*)::int as n, coalesce(sum(f.size_bytes), 0)::bigint as bytes
    from contribution_file cf join file f on f.hash = cf.hash
    where cf.contribution_id = ${contributionId}`;
  return { files: shown, files_total: n!, files_bytes: Number(bytes) };
}
