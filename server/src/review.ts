import { sql } from "./db.ts";
import type { Tx } from "./graph.ts";

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
  claimed_at: Date;
  expires_at: Date;
};

/** The live leases one reviewer holds, so a session that reconnects, or one
 *  that has forgotten what it took, can see its own worklist. */
export async function claimsHeldBy(identityId: string | null, limit = 50) {
  if (!identityId) return [];
  return await sql<{ id: string; title: string; kind: string; tier: number; expires_at: Date }[]>`
    select c.id, c.title, c.kind, c.tier, rc.expires_at
    from review_claim rc join contribution c on c.id = rc.contribution_id
    where rc.identity_id = ${identityId} and rc.expires_at > now()
    order by rc.expires_at asc limit ${limit}`;
}

/** Take (or renew) leases on specific entries.
 *
 *  One statement, because two reviewers asking for the same row at the same
 *  moment is the entire scenario this exists for. The conflicting insert
 *  updates only when the existing lease has expired or is already this
 *  reviewer's, so a row held by someone else simply does not come back and the
 *  loser of the race is told who holds it rather than handed a duplicate. */
export async function claimEntries(
  identityId: string,
  ids: string[],
  minutes: number,
  tx?: Tx,
): Promise<Map<string, Date>> {
  const q = tx ?? sql;
  if (!ids.length) return new Map();
  const rows = await q<{ contribution_id: string; expires_at: Date }[]>`
    insert into review_claim (contribution_id, identity_id, claimed_at, expires_at)
    select id, ${identityId}, now(), now() + make_interval(mins => ${minutes})
    from unnest(${ids}::uuid[]) as id
    on conflict (contribution_id) do update
      set identity_id = excluded.identity_id, claimed_at = now(), expires_at = excluded.expires_at
      where review_claim.expires_at <= now()
         or review_claim.identity_id = excluded.identity_id
    returning contribution_id, expires_at`;
  return new Map(rows.map((r) => [r.contribution_id, r.expires_at]));
}

/** Who holds these entries right now (live leases only). */
export async function holdersOf(ids: string[]): Promise<Map<string, ClaimRow>> {
  if (!ids.length) return new Map();
  const rows = await sql<ClaimRow[]>`
    select contribution_id, identity_id, claimed_at, expires_at from review_claim
    where contribution_id = any (${ids}::uuid[]) and expires_at > now()`;
  return new Map(rows.map((r) => [r.contribution_id, r]));
}

/** Drop leases whose time is up. Nothing depends on this — every read filters
 *  on expires_at — so it is housekeeping, run opportunistically off the queue
 *  call and allowed to fail without taking a request with it. */
export function sweepExpiredClaims(): void {
  void sql`delete from review_claim where expires_at <= now() - interval '1 day'`.catch(() => {});
}
