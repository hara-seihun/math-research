import type { Express, Request, Response } from "express";
import express from "express";
import { sql } from "./db.ts";
import {
  mintIdentity,
  newAccessToken,
  newClientId,
  newClientSecret,
  sha256hex,
} from "./identity.ts";

/**
 * An OAuth 2.1 authorization server for a place with no accounts.
 *
 * MCP clients know how to authorize; they do not know how to hold a
 * contributor key. So we speak their protocol and mint identities at the end
 * of it. There is nothing to log into and nothing to approve: the
 * authorization page exists only to say what is about to happen and to let
 * someone paste a key they already hold, so their client's stored token
 * points at the identity they already have.
 *
 * Access tokens do not expire, because an identity here is a credential you
 * keep rather than a session someone grants you.
 */

const CODE_TTL_SECONDS = 300;

const form = express.urlencoded({ extended: false });

const pkceMatches = (verifier: string, challenge: string) =>
  Buffer.from(new Bun.CryptoHasher("sha256").update(verifier).digest())
    .toString("base64url") === challenge;

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).json({ error, error_description: description });

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>math-research — authorize</title>
<style>
  :root { color-scheme: light dark }
  body { font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
         max-width: 34rem; margin: 8vh auto; padding: 0 1.5rem }
  h1 { font-size: 1.4rem; margin-bottom: .25rem }
  p.lede { color: #6b7280; margin-top: 0 }
  form { margin-top: 2rem }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .5rem;
           border: 1px solid transparent; background: #2563eb; color: #fff; cursor: pointer }
  button.secondary { background: transparent; border-color: currentColor; color: inherit }
  textarea { font: 14px ui-monospace, monospace; width: 100%; box-sizing: border-box;
             padding: .6rem; border-radius: .5rem; border: 1px solid #9ca3af; background: transparent; color: inherit }
  details { margin-top: 1.5rem } summary { cursor: pointer }
  .row { display: flex; gap: .75rem; align-items: center; margin-top: 1rem }
</style></head><body>${body}</body></html>`;

const consentPage = (client: string, params: Record<string, string>) =>
  page(`
<h1>math-research</h1>
<p class="lede">An open ledger of mathematical work. No accounts, no signup.</p>
<p><strong>${client}</strong> is asking to contribute as you. Continuing mints a contributor
identity for it — a key it holds, whose SHA-256 is the name your work appears under.
Reading never needed this, and contributing without it is fine too; it just lands unattributed.</p>
<form method="post">
  ${Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("\n  ")}
  <div class="row"><button name="decision" value="new" type="submit">Continue as a new contributor</button></div>
  <details>
    <summary>I already have a contributor key</summary>
    <p>Paste it and this client will act as that identity instead.</p>
    <textarea name="contributor_key" rows="2" placeholder="mrk_…"></textarea>
    <div class="row"><button class="secondary" name="decision" value="existing" type="submit">Continue with my key</button></div>
  </details>
</form>`);

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const redirectAllowed = (registered: string[], candidate: string) => registered.includes(candidate);

export function mountOAuth(app: Express, issuer: string) {
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["contribute"],
    service_documentation: `${issuer}/`,
  };

  const protectedResource = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["contribute"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/`,
  };

  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
    app.get(path, (_req, res) => void res.json(metadata));
  }
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, (_req, res) => void res.json(protectedResource));
  }

  app.post("/oauth/register", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown; grant_types?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
    const wantsCode = grants.includes("authorization_code");
    if (wantsCode && redirectUris.length === 0) {
      return oauthError(res, 400, "invalid_redirect_uri", "authorization_code clients must register at least one redirect_uri");
    }

    const id = newClientId();
    const confidential = grants.includes("client_credentials");
    const secret = confidential ? newClientSecret() : null;
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;
    await sql`insert into oauth_client (id, secret_hash, name, redirect_uris)
              values (${id}, ${secret ? sha256hex(secret) : null}, ${name}, ${redirectUris}::text[])`;
    res.status(201).json({
      client_id: id,
      ...(secret ? { client_secret: secret } : {}),
      client_name: name ?? undefined,
      redirect_uris: redirectUris,
      grant_types: grants,
      token_endpoint_auth_method: secret ? "client_secret_post" : "none",
    });
  });

  app.get("/oauth/authorize", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const client = await clientOf(q.client_id);
    if (!client) return void oauthError(res, 400, "invalid_client", "unknown client_id — register first");
    if (q.response_type !== "code") return void oauthError(res, 400, "unsupported_response_type", "only response_type=code is supported");
    if (!q.redirect_uri || !redirectAllowed(client.redirect_uris, q.redirect_uri)) {
      return void oauthError(res, 400, "invalid_redirect_uri", "redirect_uri does not match one registered by this client");
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return void oauthError(res, 400, "invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    res.type("html").send(
      consentPage(client.name ?? "An MCP client", {
        client_id: q.client_id!,
        redirect_uri: q.redirect_uri,
        code_challenge: q.code_challenge,
        state: q.state ?? "",
        scope: q.scope ?? "contribute",
      }),
    );
  });

  app.post("/oauth/authorize", form, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const client = await clientOf(body.client_id);
    if (!client) return void oauthError(res, 400, "invalid_client", "unknown client_id");
    if (!body.redirect_uri || !redirectAllowed(client.redirect_uris, body.redirect_uri)) {
      return void oauthError(res, 400, "invalid_redirect_uri", "redirect_uri does not match one registered by this client");
    }

    const pasted = body.contributor_key?.trim();
    if (body.decision === "existing" && !pasted?.startsWith("mrk_")) {
      return void res.type("html").send(page(`<h1>That doesn't look like a key</h1>
        <p class="lede">Contributor keys start with <code>mrk_</code>. Go back and try again, or continue as a new contributor.</p>`));
    }

    const identityId = pasted ? sha256hex(pasted) : (await mintIdentity()).identityId;
    if (pasted) await sql`insert into identity (id) values (${identityId}) on conflict do nothing`;

    const code = newAccessToken();
    await sql`insert into oauth_code (code_hash, client_id, identity_id, redirect_uri, code_challenge, expires_at)
              values (${sha256hex(code)}, ${client.id}, ${identityId}, ${body.redirect_uri},
                      ${body.code_challenge!}, now() + ${CODE_TTL_SECONDS} * interval '1 second')`;

    const target = new URL(body.redirect_uri);
    target.searchParams.set("code", code);
    if (body.state) target.searchParams.set("state", body.state);
    res.redirect(302, target.toString());
  });

  app.post("/oauth/token", form, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const basic = /^basic\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const [basicId, basicSecret] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
    const clientId = body.client_id ?? basicId;
    const clientSecret = body.client_secret ?? basicSecret;

    const client = await clientOf(clientId);
    if (!client) return void oauthError(res, 401, "invalid_client", "unknown client_id");
    if (client.secret_hash && sha256hex(clientSecret ?? "") !== client.secret_hash) {
      return void oauthError(res, 401, "invalid_client", "client authentication failed");
    }

    if (body.grant_type === "client_credentials") {
      if (!client.secret_hash) return void oauthError(res, 401, "invalid_client", "client_credentials requires a registered client secret");
      const identityId = client.identity_id ?? (await bindClientIdentity(client.id));
      return void res.json(await issueToken(identityId, client.id));
    }

    if (body.grant_type !== "authorization_code") {
      return void oauthError(res, 400, "unsupported_grant_type", "supported grants: authorization_code, client_credentials");
    }
    if (!body.code || !body.code_verifier) {
      return void oauthError(res, 400, "invalid_request", "code and code_verifier are both required");
    }

    const [code] = await sql<{ identity_id: string; redirect_uri: string; code_challenge: string; expired: boolean }[]>`
      delete from oauth_code
      where code_hash = ${sha256hex(body.code)} and client_id = ${client.id}
      returning identity_id, redirect_uri, code_challenge, expires_at < now() as expired`;
    if (!code || code.expired) return void oauthError(res, 400, "invalid_grant", "authorization code is unknown, already used, or expired");
    if (body.redirect_uri && body.redirect_uri !== code.redirect_uri) {
      return void oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!pkceMatches(body.code_verifier, code.code_challenge)) {
      return void oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    }

    res.json(await issueToken(code.identity_id, client.id));
  });
}

type Client = { id: string; secret_hash: string | null; name: string | null; redirect_uris: string[]; identity_id: string | null };

async function clientOf(id: string | undefined): Promise<Client | null> {
  if (!id) return null;
  const [client] = await sql<Client[]>`
    select id, secret_hash, name, redirect_uris, identity_id from oauth_client where id = ${id}`;
  return client ?? null;
}

async function bindClientIdentity(clientId: string): Promise<string> {
  const { identityId } = await mintIdentity();
  const [bound] = await sql<{ identity_id: string }[]>`
    update oauth_client set identity_id = ${identityId}
    where id = ${clientId} and identity_id is null returning identity_id`;
  if (bound) return identityId;
  await sql`delete from identity i where i.id = ${identityId}
            and not exists (select 1 from contribution where identity_id = i.id)`;
  return (await clientOf(clientId))!.identity_id!;
}

async function issueToken(identityId: string, clientId: string) {
  const token = newAccessToken();
  await sql`insert into oauth_token (token_hash, identity_id, client_id)
            values (${sha256hex(token)}, ${identityId}, ${clientId})`;
  return { access_token: token, token_type: "Bearer", scope: "contribute", identity: identityId };
}
