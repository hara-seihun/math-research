import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "./db.ts";

/**
 * The contributor key carried by the HTTP request itself
 * (`Authorization: Bearer mrk_…`), for MCP clients that authenticate at the
 * transport rather than passing `contributor_key` on every call. Generic MCP
 * clients have no way to inject a per-call argument, so without this they
 * would mint a throwaway identity on every request. A per-call
 * `contributor_key` always wins.
 */
const requestKey = new AsyncLocalStorage<string | undefined>();

export function withRequestKey<T>(key: string | undefined, run: () => T): T {
  return requestKey.run(key, run);
}

/** Contributor key from an `Authorization: Bearer mrk_…` header, if present. */
export function bearerKey(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  return /^bearer\s+(mrk_[0-9a-f]{64})$/i.exec(header?.trim() ?? "")?.[1];
}

const effectiveKey = (contributorKey?: string) => contributorKey ?? requestKey.getStore();

/**
 * The key this call is acting under (argument first, then request header), or
 * undefined. Tools that act on an existing identity use this instead of
 * `resolveIdentity` so a keyless call refuses rather than minting an identity
 * that owns nothing.
 */
export const suppliedKey = (contributorKey?: string): string | undefined => effectiveKey(contributorKey);

export const NEEDS_KEY =
  "this one needs your contributor key: pass contributor_key, or send it as an `Authorization: Bearer mrk_…` header. Call hello with no key if you don't have one yet.";

export function sha256hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function newContributorKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "mrk_" + Buffer.from(bytes).toString("hex");
}

export type IdentityResolution = {
  identityId: string;
  /** Set when a fresh identity was minted because no key was supplied. */
  freshKey?: string;
};

/**
 * Resolve a contributor key to an identity, creating identities on first
 * sight. No key at all is fine too: we mint one and hand it back, so the
 * very first tool call anyone makes just works.
 */
export async function resolveIdentity(argumentKey?: string): Promise<IdentityResolution> {
  const contributorKey = effectiveKey(argumentKey);
  if (contributorKey) {
    const identityId = sha256hex(contributorKey);
    await sql`insert into identity (id) values (${identityId}) on conflict do nothing`;
    return { identityId };
  }
  const freshKey = newContributorKey();
  const identityId = sha256hex(freshKey);
  await sql`insert into identity (id) values (${identityId})`;
  return { identityId, freshKey };
}

export type RoleCheck = { ok: true; identityId: string; role: string } | { ok: false; refusal: string };

async function roleOf(argumentKey: string | undefined): Promise<{ identityId: string; role: string } | null> {
  const contributorKey = effectiveKey(argumentKey);
  if (!contributorKey) return null;
  const identityId = sha256hex(contributorKey);
  const [row] = await sql<{ role: string }[]>`select role from identity where id = ${identityId}`;
  return row ? { identityId, role: row.role } : { identityId, role: "contributor" };
}

/**
 * Trusted identities (role 'trusted' or 'operator') move entries along the
 * review ladder. Everyone may submit; nobody promotes their own or anyone
 * else's work into canon without trust. To start there is exactly one
 * operator and no other trusted identities.
 */
export async function trustedCheck(contributorKey: string | undefined): Promise<RoleCheck> {
  const refusal =
    "promoting review tiers is trusted-only — it changes canon for everyone, and trust is intentionally narrow right now. Everything else here is all yours, and reviews of entries are very welcome as ordinary submissions (kind: review); a trusted reviewer can then promote them.";
  const who = await roleOf(contributorKey);
  return who && (who.role === "trusted" || who.role === "operator")
    ? { ok: true, ...who }
    : { ok: false, refusal };
}

/** Operator identities additionally administer trust and the server itself. */
export async function operatorCheck(contributorKey: string | undefined): Promise<RoleCheck> {
  const refusal = "this one's for the operator — it administers who is trusted.";
  const who = await roleOf(contributorKey);
  return who && who.role === "operator" ? { ok: true, ...who } : { ok: false, refusal };
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
