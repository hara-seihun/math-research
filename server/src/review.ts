import { sql } from "./db.ts";
import type { Tx } from "./graph.ts";
import { sha256hex } from "./identity.ts";
import { requestContext } from "./request-context.ts";

// --- Review claims ------
// A lease over the *adjudication* of one entry, held by one reviewer for a
// short while. It exists because review is queue work: when two reviewers read
// the same T0 entry, the ledger gets one decision and pays for two readings.
//
// It is deliberately not a lock on mathematics. Nothing here is consulted by
// submit, link, trail, frontier, or any research door, and a claim confers no
// authorship, no priority, and no right to the problem an entry is about. Two
// agents attacking one conjecture from different angles is the point of the
// place; trails stay advisory diaries for exactly that reason. What must not
// happen twice is the reading of one submission against the review ladder.
//
// Every lease is soft. It expires by timestamp, so an agent that crashes,
// wanders off, or loses its context frees its rows by doing nothing at all,
// and there is no reaper to run or to forget to run.

export const LEASE_DEFAULT_MINUTES = 30;
export const LEASE_MAX_MINUTES = 240;

/** Who holds a lease. Not the identity: an agent fleet reviews under one
 *  contributor key, and keying exclusion on that key handed all forty of its
 *  concurrent sessions the same page. The MCP session is the reviewer; the
 *  identity is only who that reviewer is. A caller with no session (a raw
 *  JSON-RPC probe) is one reviewer under its key.
 *
 *  Hashed, because a live Mcp-Session-Id authenticates its holder here and
 *  q_review_claims is a public view: contention is answerable without handing
 *  the world a session to speak through. */
export const claimantOf = (identityId: string): string => {
  const { sessionId } = requestContext();
  return sessionId ? sha256hex(`review-claimant:${sessionId}`) : identityId;
};

/** A decision ends the reading the lease protected, so the lease goes with it.
 *  Called from every terminal verdict: promotion, rejection, retraction, and
 *  the applied or rejected proposals. Takes the caller's transaction so the
 *  release commits with the decision or not at all. */
export async function releaseClaims(tx: Tx, ids: string[]): Promise<void> {
  const targets = [...new Set(ids.filter(Boolean))];
  if (!targets.length) return;
  await tx`delete from review_claim where contribution_id = any (${targets}::uuid[])`;
}

export type ClaimRow = {
  contribution_id: string;
  identity_id: string;
  claimant: string;
  claimed_at: Date;
  expires_at: Date;
};

/** The live leases this reviewer holds, so a session that has forgotten what
 *  it took can see its own worklist -- its own, not its whole fleet's: forty
 *  concurrent sessions under one key would each carry the other thirty-nine's
 *  pages in every answer. A reviewer that reconnected and lost sight of what
 *  it was holding finds it in q_review_claims by identity, and takes it back
 *  with review_claim. */
export async function claimsHeldBy(claimant: string | null, limit = 50) {
  if (!claimant) return [];
  return await sql<{ id: string; title: string; kind: string; tier: number; expires_at: Date }[]>`
    select c.id, c.title, c.kind, c.tier, rc.expires_at
    from review_claim rc join contribution c on c.id = rc.contribution_id
    where rc.claimant = ${claimant} and rc.expires_at > now()
    order by rc.expires_at asc limit ${limit}`;
}

/** Take (or renew) leases on specific entries.
 *
 *  One statement, because two reviewers asking for the same row at the same
 *  moment is the entire scenario this exists for. The conflicting insert
 *  updates only when the existing lease has expired or is already this
 *  reviewer's, so a row held by someone else simply does not come back and the
 *  loser of the race is told who holds it rather than handed a duplicate.
 *
 *  "Already this reviewer's" means the session or the identity behind it. The
 *  session is what keeps a fleet's pages disjoint, but a reviewer whose
 *  connection drops comes back as a new session holding nothing, and its own
 *  claimed page then refused to be decided or released for the length of the
 *  lease. Asking for your own identity's row by name is how you take it back;
 *  the worklist still never hands it to a sibling session unasked. */
export async function claimEntries(
  identityId: string,
  ids: string[],
  minutes: number,
  tx?: Tx,
): Promise<Map<string, Date>> {
  const q = tx ?? sql;
  if (!ids.length) return new Map();
  const rows = await q<{ contribution_id: string; expires_at: Date }[]>`
    insert into review_claim (contribution_id, identity_id, claimant, claimed_at, expires_at)
    select id, ${identityId}, ${claimantOf(identityId)}, now(), now() + make_interval(mins => ${minutes})
    from unnest(${ids}::uuid[]) as id
    on conflict (contribution_id) do update
      set identity_id = excluded.identity_id, claimant = excluded.claimant,
          claimed_at = now(), expires_at = excluded.expires_at
      where review_claim.expires_at <= now()
         or review_claim.claimant = excluded.claimant
         or review_claim.identity_id = excluded.identity_id
    returning contribution_id, expires_at`;
  return new Map(rows.map((r) => [r.contribution_id, r.expires_at]));
}

/** Who holds these entries right now (live leases only). */
export async function holdersOf(ids: string[]): Promise<Map<string, ClaimRow>> {
  if (!ids.length) return new Map();
  const rows = await sql<ClaimRow[]>`
    select contribution_id, identity_id, claimant, claimed_at, expires_at from review_claim
    where contribution_id = any (${ids}::uuid[]) and expires_at > now()`;
  return new Map(rows.map((r) => [r.contribution_id, r]));
}

/** The same question a verdict asks: which of these is somebody else reading
 *  right now?
 *
 *  The lease used to bind only the door that handed it out. review_queue
 *  refused to show a row another session held, and then set_tier, reject and
 *  retract decided it anyway for anyone who had found it through search, a
 *  link page, or a flag -- which is most of how reviewers arrive at an entry.
 *  One reviewer watched sixteen of the twenty-five rows they had just leased
 *  get decided by other sessions inside ten seconds, and another promoted
 *  three edges a colleague had rejected sixty seconds earlier. A lease that
 *  half the writers ignore is not a lease.
 *
 *  Somebody else is another *session*, including a sibling of your own fleet:
 *  the sixteen were decided under the same contributor key as the reviewer
 *  reading them. What a reconnecting reviewer does instead of overriding is
 *  claim its own row back by name, which review_claim allows for your own
 *  identity and the refusal below says so. */
export async function heldByOthers(identityId: string, ids: string[]): Promise<Map<string, ClaimRow>> {
  const mine = claimantOf(identityId);
  const held = await holdersOf(ids);
  for (const [id, row] of held) if (row.claimant === mine) held.delete(id);
  return held;
}

/** Drop leases whose time is up. Nothing depends on this, because every read
 *  filters on expires_at, so it is housekeeping, run opportunistically off the queue
 *  call and allowed to fail without taking a request with it. */
export function sweepExpiredClaims(): void {
  void sql`delete from review_claim where expires_at <= now() - interval '1 day'`.catch(() => {});
}
