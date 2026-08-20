import { generateKeyPairSync, sign, createPublicKey, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "./db.ts";

const KEY_PATH = process.env.SERVER_KEY_PATH ?? "/var/lib/math-research/server-key.pem";

function loadOrCreateKey() {
  if (!existsSync(KEY_PATH)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    writeFileSync(KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(KEY_PATH));
}

const serverKey = loadOrCreateKey();

export function serverPublicKey(): string {
  return createPublicKey(serverKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

/**
 * A receipt is the server's Ed25519 signature over a canonical JSON payload
 * binding (contribution, artifact hash, identity, time). Anyone holding the
 * server public key can verify it; a contributor holding their key can prove
 * the identity is theirs (identity = sha256(contributor_key)).
 */
export async function issueReceipt(contribution: {
  id: string;
  artifact_hash: string;
  identity_id: string | null;
  created_at: Date;
}) {
  const payload = {
    contribution_id: contribution.id,
    artifact_hash: contribution.artifact_hash,
    identity_id: contribution.identity_id,
    created_at: contribution.created_at.toISOString(),
  };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const signature = sign(null, Buffer.from(canonical), serverKey).toString("base64");
  await sql`insert into receipt (contribution_id, payload, server_signature)
            values (${contribution.id}, ${sql.json(payload)}, ${signature})
            on conflict do nothing`;
  return { payload, server_signature: signature };
}
