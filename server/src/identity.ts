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

export type OperatorCheck = { ok: true; identityId: string } | { ok: false; refusal: string };

/**
 * Operator identities are ordinary identities whose `role` column was set by
 * the maintainers; the key itself is the credential.
 */
export async function operatorCheck(contributorKey: string | undefined): Promise<OperatorCheck> {
  const refusal =
    "this one's for the maintainers — it changes review state for everyone. Everything else here is all yours, and reviews of entries are very welcome as ordinary submissions (kind: review).";
  if (!contributorKey) return { ok: false, refusal };
  const identityId = sha256hex(contributorKey);
  const [row] = await sql<{ role: string }[]>`select role from identity where id = ${identityId}`;
  return row?.role === "operator" ? { ok: true, identityId } : { ok: false, refusal };
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
