import { sql } from "./db.ts";

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
export async function resolveIdentity(contributorKey?: string): Promise<IdentityResolution> {
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

async function roleOf(contributorKey: string | undefined): Promise<{ identityId: string; role: string } | null> {
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
