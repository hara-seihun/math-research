import postgres from "postgres";

const common = { max: 8, onnotice: () => {} } as const;

export const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, common)
  : postgres({
      host: process.env.PGHOST ?? "/run/postgresql",
      database: process.env.PGDATABASE ?? "math",
      ...(process.env.PGUSER ? { username: process.env.PGUSER } : {}),
      ...common,
    });

export type Contribution = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  artifact_hash: string;
  metadata: Record<string, unknown>;
  identity_id: string;
  tier: number;
  status: string;
  created_at: Date;
};

export async function logRequest(tool: string, identityId: string | null, args: unknown) {
  const text = JSON.stringify(args ?? {});
  const stored =
    text.length > 8192
      ? { truncated: true, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }
      : (args ?? {});
  await sql`insert into request_log (tool, identity_id, args)
            values (${tool}, ${identityId}, ${sql.json(stored as never)})`;
}
