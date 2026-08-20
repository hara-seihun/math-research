import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "./db.ts";

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

/**
 * What the transport knows about this request. Both fields are optional: an
 * unidentified caller is a first-class caller here.
 */
export type RequestContext = { bearer?: string; sessionId?: string };

const context = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, run: () => T): T {
  return context.run(ctx, run);
}

export const bearerOf = (authorization: string | string[] | undefined): string | undefined =>
  /^bearer\s+(\S+)$/i.exec((Array.isArray(authorization) ? authorization[0] : authorization)?.trim() ?? "")?.[1];

export type Resolution =
  | { kind: "identity"; identityId: string; via: "key" | "oauth" | "session" }
  | { kind: "session"; sessionId: string }
  | { kind: "anonymous" }
  | { kind: "invalid"; error: string };

/** Who is calling, from the strongest signal available, creating nothing. */
export async function caller(argumentKey?: string): Promise<Resolution> {
  const { bearer, sessionId } = context.getStore() ?? {};
  const key = argumentKey ?? (bearer?.startsWith("mrk_") ? bearer : undefined);
  if (key) return { kind: "identity", identityId: sha256hex(key), via: "key" };

  if (bearer) {
    const [token] = await sql<{ identity_id: string }[]>`
      update oauth_token set last_used_at = now()
      where token_hash = ${sha256hex(bearer)} returning identity_id`;
    return token
      ? { kind: "identity", identityId: token.identity_id, via: "oauth" }
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
      ? { kind: "identity", identityId: session!.identity_id, via: "session" }
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
  const [bound] = await sql<{ identity_id: string }[]>`
    update mcp_session set identity_id = ${identityId}
    where id = ${who.sessionId} and identity_id is null
    returning identity_id`;
  if (bound) return { identityId, freshKey };

  await sql`delete from identity i where i.id = ${identityId}
            and not exists (select 1 from contribution where identity_id = i.id)`;
  const [session] = await sql<{ identity_id: string }[]>`
    select identity_id from mcp_session where id = ${who.sessionId}`;
  return { identityId: session!.identity_id };
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
