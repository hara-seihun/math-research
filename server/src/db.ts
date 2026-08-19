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

export async function logRequest(tool: string, identityId: string | null, args: unknown) {
  const text = JSON.stringify(args ?? {});
  const stored =
    text.length > 8192
      ? { truncated: true, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }
      : (args ?? {});
  await sql`insert into request_log (tool, identity_id, args)
            values (${tool}, ${identityId}, ${sql.json(stored as never)})`;
}
