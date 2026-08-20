// Bootstrap a handful of research fronts from the major inherited programmes so
// the fronts view is useful on day one. Each front is a kind='front'
// contribution (owned by the operator, canon), and its members are the
// top-notability entries matching the programme, linked with in-front edges via
// the canonical createEdge path. Agents grow this organically from here.
// Idempotent: skips a front whose title already exists.
//
//   bun run tools/seed-fronts.ts
import { sql } from "../server/src/db.ts";
import { sha256hex } from "../server/src/identity.ts";
import { createEdge, refreshNotability } from "../server/src/graph.ts";

const FRONTS: { title: string; summary: string; pattern: string; limit: number }[] = [
  { title: "de Bruijn–Newman constant: bounding Λ", summary: "Certified upper and lower bounds on the de Bruijn–Newman constant Λ and the machinery (Polymath-style heat-family zero exclusion) behind them.", pattern: "bruijn|newman", limit: 30 },
  { title: "Finite Cayley graph CI-property classification", summary: "The classification of finite groups and graphs with the CI/DCI property, actual-image alignment, and the vertex-transitive isomorphism machinery around it.", pattern: "cayley|\\yci-|dci|circulant|vertex-transitive", limit: 40 },
  { title: "Sharp oracle-area", summary: "The sharp oracle-area programme: constants, constructive policies, and the exact active-mass audits.", pattern: "oracle.?area", limit: 30 },
  { title: "Frankl union-closed sets conjecture", summary: "Progress on the union-closed sets (Frankl) conjecture and its extremal-combinatorial surroundings.", pattern: "union.?closed|frankl", limit: 25 },
  { title: "Unique-centroid tree canonicalization", summary: "Canonical parent equality, centroid identities, and reroot-invariant structure for unique-centroid trees.", pattern: "centroid|canonical parent|reroot", limit: 30 },
  { title: "Matrix multiplication exponent ω", summary: "Bounds and structural results on the exponent of matrix multiplication and the tensor-rank methods behind them.", pattern: "matrix multiplication|omega exponent|tensor rank", limit: 20 },
];

const [operator] = await sql<{ id: string }[]>`select id from identity where role = 'operator' order by created_at limit 1`;
if (!operator) throw new Error("no operator identity to own the seeded fronts");

for (const f of FRONTS) {
  const [existing] = await sql<{ id: string }[]>`select id from contribution where kind = 'front' and title = ${f.title}`;
  if (existing) {
    console.log(`front exists, skipping: ${f.title}`);
    continue;
  }
  const content = f.summary;
  const hash = sha256hex(`front:${f.title}:${content}`);
  const frontId = await sql.begin(async (tx) => {
    await tx`insert into artifact (hash, media_type, content, size_bytes)
             values (${hash}, 'text/markdown', ${content}, ${Buffer.byteLength(content)}) on conflict do nothing`;
    const [c] = await tx<{ id: string }[]>`
      insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id, tier)
      values ('front', ${f.title}, ${f.summary}, ${hash}, ${tx.json({ seeded: true } as never)}, ${operator.id}, 2)
      returning id`;
    await tx`insert into event (kind, contribution_id, identity_id, payload)
             values ('submitted', ${c!.id}, ${operator.id}, ${tx.json({ kind: "front", title: f.title } as never)})`;
    return c!.id;
  });

  const members = await sql<{ id: string }[]>`
    select c.id from contribution c
    where c.status = 'active' and c.kind not in ('edge', 'front')
      and lower(c.title || ' ' || c.summary) ~ ${f.pattern}
    order by c.notability desc limit ${f.limit}`;
  await sql.begin(async (tx) => {
    for (const m of members) {
      await createEdge(tx, { identityId: operator.id, src: m.id, dst: frontId, rel: "in-front", note: "seeded programme membership" });
    }
  });
  await refreshNotability([frontId, ...members.map((m) => m.id)]);
  console.log(`front "${f.title}": ${members.length} members`);
}

await sql.end();
