import { createPublicKey, verify as verifyEd25519, type KeyObject } from "node:crypto";
import { sql } from "./db.ts";
import { remember, requestContext } from "./request-context.ts";

export function sha256hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

export const newContributorKey = () => "mrk_" + randomHex(32);
export const newAccessToken = () => "mrt_" + randomHex(32);
export const newClientId = () => "mrc_" + randomHex(16);
export const newClientSecret = () => "mrs_" + randomHex(32);

export const KEY_HELP =
  "Three ways to be someone here, none of them required: contribute over an MCP session and this server mints you a key and hands it back once; authorize over OAuth if your client speaks it (there is nothing to log into); or present a key you already hold as the contributor_key argument or an `Authorization: Bearer mrk_…` header.";

export const bearerOf = (authorization: string | string[] | undefined): string | undefined =>
  /^bearer\s+(\S+)$/i.exec((Array.isArray(authorization) ? authorization[0] : authorization)?.trim() ?? "")?.[1];

export type Resolution =
  | { kind: "identity"; identityId: string; via: "key" | "oauth" | "session" }
  | { kind: "session"; sessionId: string }
  | { kind: "anonymous" }
  | { kind: "invalid"; error: string };

/** Who is calling, from the strongest signal available, creating nothing. */
export async function caller(argumentKey?: string): Promise<Resolution> {
  const { bearer, sessionId } = requestContext();
  const key = argumentKey ?? (bearer?.startsWith("mrk_") ? bearer : undefined);
  if (key) return { kind: "identity", identityId: remember(sha256hex(key))!, via: "key" };

  if (bearer) {
    const [token] = await sql<{ identity_id: string }[]>`
      update oauth_token set last_used_at = now()
      where token_hash = ${sha256hex(bearer)} returning identity_id`;
    return token
      ? { kind: "identity", identityId: remember(token.identity_id)!, via: "oauth" }
      : {
          kind: "invalid",
          error:
            "that access token isn't one of ours, or it was revoked. Authorize again, send a contributor key instead (`Authorization: Bearer mrk_…`), or drop the header entirely and contribute unattributed.",
        };
  }

  if (sessionId) {
    const [session] = await sql<{ identity_id: string | null }[]>`
      insert into mcp_session (id) values (${sessionId})
      on conflict (id) do update set last_seen_at = now()
      returning identity_id`;
    return session!.identity_id
      ? { kind: "identity", identityId: remember(session!.identity_id)!, via: "session" }
      : { kind: "session", sessionId };
  }

  return { kind: "anonymous" };
}

const ensureIdentity = async (identityId: string): Promise<string> => {
  await sql`insert into identity (id) values (${identityId}) on conflict do nothing`;
  return identityId;
};

/** Mint a brand-new identity. The key is returned once and never stored. */
export async function mintIdentity(): Promise<{ identityId: string; freshKey: string }> {
  const freshKey = newContributorKey();
  return { identityId: await ensureIdentity(sha256hex(freshKey)), freshKey };
}

export type Writer = { identityId: string | null; freshKey?: string } | { error: string };

/**
 * Who owns work about to be recorded. A session that has not contributed yet
 * gets an identity minted and bound here, so everything that connection does
 * stays together; a caller with no identity at all contributes anonymously
 * rather than being turned away.
 */
export async function writer(argumentKey?: string): Promise<Writer> {
  const who = await caller(argumentKey);
  if (who.kind === "invalid") return { error: who.error };
  if (who.kind === "identity") return { identityId: await ensureIdentity(who.identityId) };
  if (who.kind === "anonymous") return { identityId: null };

  const { identityId, freshKey } = await mintIdentity();
  remember(identityId);
  const [bound] = await sql<{ identity_id: string }[]>`
    update mcp_session set identity_id = ${identityId}
    where id = ${who.sessionId} and identity_id is null
    returning identity_id`;
  if (bound) {
    requestContext().minted = identityId;
    return { identityId, freshKey };
  }

  await sql`delete from identity i where i.id = ${identityId}
            and not exists (select 1 from contribution where identity_id = i.id)`;
  const [session] = await sql<{ identity_id: string }[]>`
    select identity_id from mcp_session where id = ${who.sessionId}`;
  return { identityId: session!.identity_id };
}

/**
 * Undo an identity minted during a call that then failed. The fresh key is
 * only ever handed back in a success payload, so without this a failed first
 * contribution would bind the session to an identity whose key nobody was ever
 * told, and the caller could never be that identity again. Nothing is lost:
 * only an identity that owns no work is removed, and the next attempt mints.
 */
export async function rollbackMint(): Promise<void> {
  const store = requestContext();
  const identityId = store.minted;
  if (!identityId) return;
  store.minted = undefined;
  if (store.sessionId) {
    await sql`update mcp_session set identity_id = null
              where id = ${store.sessionId} and identity_id = ${identityId}`;
  }
  await sql`delete from identity i where i.id = ${identityId}
            and not exists (select 1 from contribution where identity_id = i.id)
            and not exists (select 1 from trail where identity_id = i.id)`;
}

export type Identified = { identityId: string; freshKey?: string } | { error: string };

/** For tools that act on work you already own; these cannot be anonymous. */
export async function requireIdentity(argumentKey?: string): Promise<Identified> {
  const w = await writer(argumentKey);
  if ("error" in w) return w;
  return w.identityId
    ? { identityId: w.identityId, freshKey: w.freshKey }
    : { error: `this one is about your own work, so it needs an identity. ${KEY_HELP}` };
}

export type RoleCheck = { ok: true; identityId: string; role: string } | { ok: false; refusal: string };

async function roleOf(argumentKey: string | undefined): Promise<{ identityId: string; role: string } | null> {
  const who = await caller(argumentKey);
  if (who.kind !== "identity") return null;
  const [row] = await sql<{ role: string }[]>`select role from identity where id = ${who.identityId}`;
  return { identityId: who.identityId, role: row?.role ?? "contributor" };
}

/**
 * Trusted identities (role 'trusted' or 'operator') move entries along the
 * review ladder. Everyone may submit; nobody promotes their own or anyone
 * else's work into canon without trust. To start there is exactly one
 * operator and no other trusted identities.
 */
export async function trustedCheck(contributorKey: string | undefined): Promise<RoleCheck> {
  const refusal =
    "promoting review tiers is trusted-only, because it changes canon for everyone, and trust is intentionally narrow right now. Everything else here is all yours, and reviews of entries are very welcome as ordinary submissions (kind: review); a trusted reviewer can then promote them.";
  const who = await roleOf(contributorKey);
  return who && (who.role === "trusted" || who.role === "operator") ? { ok: true, ...who } : { ok: false, refusal };
}

/** Operator identities additionally administer trust and the server itself. */
export async function operatorCheck(contributorKey: string | undefined): Promise<RoleCheck> {
  const refusal = "this one's for the operator. It administers who is trusted.";
  const who = await roleOf(contributorKey);
  return who && who.role === "operator" ? { ok: true, ...who } : { ok: false, refusal };
}

const decodeBase64 = (text: string): Buffer | null => {
  const cleaned = text.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, "base64");
};

/** An Ed25519 public key as base64 spki/der, or null if it is not one. */
export function parseEd25519PublicKey(base64: string): KeyObject | null {
  const der = decodeBase64(base64);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export type AuthorshipCheck = { ok: true } | { ok: false; error: string };

/**
 * A submission may carry an Ed25519 signature over the artifact's SHA-256
 * digest, proving authorship to anyone holding the identity's registered
 * public key rather than to this server alone. The canonical message is the
 * 64-character lowercase hex digest; the raw 32 digest bytes are accepted too,
 * since both prove the same thing and clients differ on which they sign.
 *
 * A signature that does not check out is refused rather than recorded: stored
 * unverified, it would read as proof while being none.
 */
export async function verifyAuthorship(
  identityId: string | null,
  contentHash: string,
  signature: string,
): Promise<AuthorshipCheck> {
  if (!identityId) {
    return { ok: false, error: `a signature says who wrote this, so it needs an identity. ${KEY_HELP}` };
  }
  const [row] = await sql<{ public_key: string | null }[]>`
    select public_key from identity where id = ${identityId}`;
  if (!row?.public_key) {
    return {
      ok: false,
      error:
        "this identity has no signing key registered, so nobody could check that signature. Call register_public_key with your Ed25519 public key first, or submit without the signature field, since authorship is already recorded from your contributor key either way.",
    };
  }
  const key = parseEd25519PublicKey(row.public_key);
  if (!key) {
    return {
      ok: false,
      error:
        "the public key registered for this identity isn't a base64 spki/der Ed25519 key, so no signature can ever verify against it. Register a good one with register_public_key.",
    };
  }
  const sig = decodeBase64(signature);
  if (!sig || sig.length !== 64) {
    return {
      ok: false,
      error: "an Ed25519 signature is 64 bytes, base64-encoded. That one isn't.",
    };
  }
  const verified =
    verifyEd25519(null, Buffer.from(contentHash, "utf8"), key, sig) ||
    verifyEd25519(null, Buffer.from(contentHash, "hex"), key, sig);
  return verified
    ? { ok: true }
    : {
        ok: false,
        error:
          "that signature doesn't check out against the public key registered for this identity. Sign sha256(content), the 64-character lowercase hex digest, with your Ed25519 private key and send the signature base64-encoded, or leave the field out.",
      };
}

export async function updateIdentity(
  identityId: string,
  fields: { display_name?: string; public_key?: string },
) {
  if (fields.display_name !== undefined) {
    await sql`update identity set display_name = ${fields.display_name} where id = ${identityId}`;
  }
  if (fields.public_key !== undefined) {
    await sql`update identity set public_key = ${fields.public_key} where id = ${identityId}`;
  }
  await sql`insert into event (kind, identity_id, payload)
            values ('identity-updated', ${identityId}, ${sql.json(fields as never)})`;
}

/** The session row itself is created lazily, on the connection's first tool call. */
export const newSessionId = () => randomHex(16);

export const pruneSessions = () => sql`delete from mcp_session where last_seen_at < now() - interval '30 days'`;
