#!/usr/bin/env bash
# Contract tests against an ephemeral Postgres and a real server process.
# Covers the invariants that matter: submission shape, the verification
# pipeline's tier neutrality, the axiom policy, the operator gate, trails,
# and the three ways a caller can be someone (session, key, OAuth).
# Runs in well under a minute; needs bun on PATH. Postgres comes from nixpkgs
# when it is absent, and must carry pgvector because the schema stores
# semantic embeddings.
set -euo pipefail
[[ -n "${TRACE:-}" ]] && set -x
cd "$(dirname "$0")/.."

command -v initdb > /dev/null || exec nix shell --impure --expr \
  'let pkgs = import (builtins.getFlake "nixpkgs") { system = builtins.currentSystem; };
   in [ (pkgs.postgresql_17.withPackages (p: [ p.pgvector ])) ]' -c "$0" "$@"

WORK=$(mktemp -d)
export PGHOST="$WORK" PGDATABASE=math PGUSER="$(whoami)"
export SERVER_KEY_PATH="$WORK/server.key" SPOOL_DIR="$WORK/spool" PORT=8931
MCP="http://127.0.0.1:$PORT/mcp"
export PUBLIC_URL="http://127.0.0.1:$PORT"

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2> /dev/null || true
  [[ -n "${VERIFIER_PID:-}" ]] && kill "$VERIFIER_PID" 2> /dev/null || true
  pg_ctl -D "$WORK/data" stop -m immediate -s 2> /dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

initdb -D "$WORK/data" -A trust -U "$PGUSER" > /dev/null
pg_ctl -D "$WORK/data" -o "-k $WORK -c listen_addresses=" -s -w start
createdb -h "$WORK" math
psql -q -v ON_ERROR_STOP=1 -h "$WORK" -d math -f schema.sql

(cd server && bun src/index.ts) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
(cd server && bun verifier/verifier.ts) > "$WORK/verifier.log" 2>&1 &
VERIFIER_PID=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && break; sleep 0.1; done

call() { # [AUTH=token] [SESSION=id] call <tool> <json-args> -> result text payload
  curl -sf --max-time 10 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    ${AUTH:+-H "Authorization: Bearer $AUTH"} ${SESSION:+-H "Mcp-Session-Id: $SESSION"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.loads(sys.stdin.read())["result"]["content"][0]["text"])'
}
new_session() { # -> the Mcp-Session-Id this server hands out at initialize
  curl -sfi --max-time 10 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"contracts","version":"1"}}}' \
    | tr -d '\r' | sed -n 's/^[Mm]cp-[Ss]ession-[Ii]d: //p'
}
identity_of() { python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$1"; }
field() { python3 -c "import sys,json; v=json.loads(sys.stdin.read())$1; print(json.dumps(v) if isinstance(v,(dict,list)) else v)"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Contract: an MCP session is an identity. A connection that presents no
# credential at all gets exactly one identity minted for it, handed back once,
# and every contribution over that connection shares it.
SESS=$(new_session)
[[ -n $SESS ]] || fail "server issued no Mcp-Session-Id at initialize"
HI=$(SESSION=$SESS call hello '{"display_name":"contract tester"}')
KEY=$(echo "$HI" | field '["you"]["contributor_key"]')
[[ $KEY == mrk_* ]] || fail "session did not mint a contributor key"
SID=$(echo "$HI" | field '["you"]["identity"]')
[[ $SID == "$(identity_of "$KEY")" ]] || fail "minted key does not hash to the session identity"
S2=$(SESSION=$SESS call submit '{"kind":"result","title":"session attribution","summary":"s","content":"c."}')
[[ $(echo "$S2" | field '["attributed_to"]') == "$SID" ]] || fail "second call in the session got a different identity"
echo "$S2" | python3 -c 'import sys,json; assert "your_contributor_key" not in json.load(sys.stdin)' || fail "session minted a second key"

# Contract: contributing needs no identity at all. Unattributed work lands.
ANON=$(call submit '{"kind":"result","title":"anonymous contribution","summary":"s","content":"anon."}')
[[ $(echo "$ANON" | field '["attributed_to"]') == anonymous ]] || fail "keyless submission was not recorded as anonymous"
AID=$(echo "$ANON" | field '["id"]')
[[ $(psql -h "$WORK" -d math -tAc "select identity_id is null from contribution where id = '$AID'") == t ]] || fail "anonymous submission invented an identity"
call my_submissions '{}' | field '["error"]' | grep -qi identity || fail "an identity-scoped tool did not explain itself to an anonymous caller"

# Contract: a credential the server does not recognise fails loudly instead of
# silently attributing someone's work to nobody.
AUTH=mrt_not_a_real_token call submit '{"kind":"result","title":"bad token","summary":"s","content":"c."}' \
  | field '["error"]' | grep -qi "token" || fail "an unknown access token was silently downgraded to anonymous"

# Contract: a submission is recorded at T0 with a receipt, an event, and a
# queued kernel check when it contains Lean.
SUB=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"test theorem\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem t : 1 + 1 = 2 := rfl\n\`\`\`\"}")
CID=$(echo "$SUB" | field '["id"]')
[[ $(echo "$SUB" | field '["tier"]') == 0 ]] || fail "submission did not land at T0"
[[ $(echo "$SUB" | field '["lean_queued"]') == True ]] || fail "lean content not queued"
echo "$SUB" | field '["receipt"]["server_signature"]' > /dev/null || fail "no signed receipt"
EV=$(call events "{\"contribution_id\":\"$CID\"}")
[[ $(echo "$EV" | field '["events"][0]["kind"]') == submitted ]] || fail "no submitted event"

# Contract: a passing kernel check flips lean_verified but never the tier.
VID=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID'")
for _ in $(seq 50); do [[ -f "$SPOOL_DIR/in/$VID.lean" ]] && break; sleep 0.1; done
[[ -f "$SPOOL_DIR/in/$VID.lean" ]] || fail "verifier never spooled the check"
rm "$SPOOL_DIR/in/$VID.lean"
echo '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"t","type":"1 + 1 = 2","axioms":[]}]}' > "$SPOOL_DIR/out/$VID.json"
for _ in $(seq 50); do
  [[ $(psql -h "$WORK" -d math -tAc "select outcome from verification where id = $VID") == passed ]] && break
  sleep 0.1
done
GOT=$(call get "{\"id\":\"$CID\"}")
[[ $(echo "$GOT" | field '["lean_verified"]') == True ]] || fail "pass did not set lean_verified"
[[ $(echo "$GOT" | field '["tier"]') == 0 ]] || fail "verification changed the tier — it must not"

# Contract: declarations resting on axioms outside the allowed three fail.
SUB2=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"bad axioms\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem u : True := trivial\n\`\`\`\"}")
CID2=$(echo "$SUB2" | field '["id"]')
VID2=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID2'")
for _ in $(seq 50); do [[ -f "$SPOOL_DIR/in/$VID2.lean" ]] && break; sleep 0.1; done
rm "$SPOOL_DIR/in/$VID2.lean"
echo '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"u","type":"True","axioms":["sneakyAxiom"]}]}' > "$SPOOL_DIR/out/$VID2.json"
for _ in $(seq 50); do
  OUT=$(psql -h "$WORK" -d math -tAc "select outcome from verification where id = $VID2")
  [[ $OUT != pending ]] && break
  sleep 0.1
done
[[ $OUT == failed ]] || fail "disallowed axiom was not rejected (got: $OUT)"

# Contract: tier changes are trusted-only and land in the event ledger.
DENIED=$(call set_tier "{\"contributor_key\":\"$KEY\",\"id\":\"$CID\",\"tier\":2,\"note\":\"x\"}")
echo "$DENIED" | field '["error"]' | grep -qi trusted || fail "non-trusted was allowed to set tier"
OPKEY="mrk_test_operator"
OPID=$(python3 -c "import hashlib; print(hashlib.sha256(b'$OPKEY').hexdigest())")
psql -q -h "$WORK" -d math -c "insert into identity (id, role) values ('$OPID', 'operator')"
call set_tier "{\"contributor_key\":\"$OPKEY\",\"id\":\"$CID\",\"tier\":2,\"note\":\"reviewed\"}" | field '["ok"]' > /dev/null
GOT=$(call get "{\"id\":\"$CID\"}")
[[ $(echo "$GOT" | field '["tier"]') == 2 ]] || fail "operator set_tier did not apply"
echo "$GOT" | python3 -c 'import sys,json; evs=[e["kind"] for e in json.loads(sys.stdin.read())["events"]]; assert "tier-changed" in evs' || fail "no tier-changed event"

# Contract: trails are visible where the work happens and never block anyone.
T=$(call trail "{\"contributor_key\":\"$KEY\",\"title\":\"exploring the test theorem\",\"note\":\"starting out\",\"relates_to\":[\"$CID\"]}")
TID=$(echo "$T" | field '["trail_id"]')
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$TID\",\"note\":\"found a reduction\"}" | field '["ok"]' > /dev/null
GOT=$(call get "{\"id\":\"$CID\"}")
[[ $(echo "$GOT" | field '["exploring_now"][0]["latest_note"]') == "found a reduction" ]] || fail "trail not surfaced on get"
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$TID\",\"note\":\"wrapping up\",\"close\":true}" | field '["status"]' | grep -q closed || fail "close failed"
GOT=$(call get "{\"id\":\"$CID\"}")
[[ $(echo "$GOT" | field '["exploring_now"]') == "[]" ]] || fail "closed trail still shown as active"
FULL=$(call trails "{\"trail_id\":\"$TID\"}")
[[ $(echo "$FULL" | field '["activity"]') == closed ]] || fail "trail history wrong"

# Contract: an open trail idle past the freshness window is abandoned — hidden
# from the default listing so it warns no one off, but visible with include_stale.
ST=$(call trail "{\"contributor_key\":\"$KEY\",\"title\":\"stale exploration\",\"note\":\"start\"}" | field '["trail_id"]')
psql -q -h "$WORK" -d math -c "update trail set updated_at = now() - interval '3 hours' where id = '$ST'" > /dev/null
call trails '{}' | python3 -c 'import sys,json;ts=json.load(sys.stdin)["trails"];assert all(t["id"]!="'"$ST"'" for t in ts)' || fail "stale trail shown in default listing"
call trails '{"include_stale":true}' | python3 -c 'import sys,json;ts=json.load(sys.stdin)["trails"];assert any(t["id"]=="'"$ST"'" and t["activity"]=="stale" for t in ts)' || fail "include_stale did not surface the abandoned trail"

# Contract: search is dash/accent-insensitive and degrades to fuzzy, so a
# hyphen query finds an en-dash title (the de Bruijn–Newman discovery failure).
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"de Bruijn–Newman upper bound 0.2\",\"summary\":\"a certified bound\",\"content\":\"Lambda le 0.2.\"}" > /dev/null
HITS=$(call search '{"query":"de Bruijn-Newman constant"}' | field '["results"]' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[[ "$HITS" -ge 1 ]] || fail "dash/fuzzy search found nothing"

# Contract: a typed link is itself a contribution (kind='edge'), appears in the
# target's neighbourhood, and lifts notability toward the thing built upon.
A=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"lemma A\",\"summary\":\"s\",\"content\":\"A.\"}" | field '["id"]')
B=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"thm B\",\"summary\":\"s\",\"content\":\"B via A.\",\"relates_to\":[{\"id\":\"$A\",\"rel\":\"uses\"}]}" | field '["id"]')
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from contribution where kind='edge'") -ge 1 ]] || fail "link was not recorded as a contribution"
call context "{\"id\":\"$A\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(x for xs in d["links"]["in"].values() for x in xs)' || fail "link not in neighbourhood"
NA=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$A'")
python3 -c "assert float('$NA')>0" || fail "notability not derived for a contribution built upon"

# Contract: trusted promotion of a link (edges climb the same ladder).
EID=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where dst='$A' limit 1")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"id\":\"$EID\",\"tier\":2,\"note\":\"confirmed link\"}" | field '["ok"]' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select tier from contribution where id='$EID'") == 2 ]] || fail "edge did not promote"

# Contract: submissions are auto-tagged with subject topics (submit wiring to
# the shared classifier) and topic is a browse facet.
DBN=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"Riemann zeta zero de Bruijn Newman\",\"summary\":\"analytic bound\",\"content\":\"On the critical line.\"}" | field '["id"]')
[[ $(psql -h "$WORK" -d math -tAc "select 'analytic-number-theory' = any(tags) from contribution where id='$DBN'") == t ]] || fail "submission was not topic-tagged"
call browse '{"topic":"analytic-number-theory"}' | python3 -c 'import sys,json;assert len(json.load(sys.stdin)["results"])>=1' || fail "topic browse facet empty"

# Contract: a front groups work and its members surface (fronts read tool).
FR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"front\",\"title\":\"test front\",\"summary\":\"s\",\"content\":\"grouping.\"}" | field '["id"]')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$A\",\"dst\":\"$FR\",\"rel\":\"in-front\"}" | field '["ok"]' > /dev/null
call fronts "{\"id\":\"$FR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(m["id"] for m in d["members"])' || fail "front member not surfaced"

# Contract: resolve finds an entry by an alias, even when the title differs.
RN=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"obscure internal title zzq\",\"summary\":\"s\",\"content\":\"c.\",\"names\":[\"Kolmogorov width marker\"]}" | field '["id"]')
call resolve '{"name":"Kolmogorov width marker"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["match"]=="exact" and d["results"][0]["id"]=="'"$RN"'"' || fail "resolve did not find entry by alias"

# Contract: frontier distills a question's attack state from the graph.
Q=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"frontier test question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
SQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"sub-question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"partial attempt\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$Q\",\"rel\":\"refines\"}]}" > /dev/null
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$Q\",\"dst\":\"$SQ\",\"rel\":\"reduces-to\"}" > /dev/null
call frontier "{\"id\":\"$Q\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["progress"])>=1 and any(x["id"]=="'"$SQ"'" for x in d["open_subproblems"])' || fail "frontier did not distill attack state"

# Contract: every read door says when. A reader must be able to date anything
# it is shown without a second round trip — including a *link*, whose
# assertion time exists nowhere else, so "is this connection fresh?" stays
# answerable from the same payload that shows the connection.
dated() { # dated <label> <json> <python-expression yielding objects>
  echo "$2" | python3 -c '
import sys, json, datetime
d = json.load(sys.stdin)
objs = list(eval(sys.argv[2], {"d": d}))
assert objs, f"{sys.argv[1]}: nothing to check"
for o in objs:
    stamps = [k for k in ("created_at", "linked_at", "joined_at", "updated_at", "last_activity") if o.get(k)]
    assert stamps, f"{sys.argv[1]}: undated object {sorted(o)}"
    for k in stamps:
        datetime.datetime.fromisoformat(str(o[k]).replace("Z", "+00:00"))
' "$1" "$3" || fail "$1 returned undated or unparseable entries"
}
GOTQ=$(call get "{\"id\":\"$Q\"}")
dated "get" "$GOTQ" '[d]'
dated "get links" "$GOTQ" '(x for xs in list(d["links"]["in"].values()) + list(d["links"]["out"].values()) for x in xs)'
dated "get events" "$GOTQ" 'd["events"]'
CTX=$(call context "{\"id\":\"$Q\"}")
dated "context" "$CTX" '[d]'
dated "context links" "$CTX" '(x for xs in list(d["links"]["in"].values()) + list(d["links"]["out"].values()) for x in xs)'
FRO=$(call frontier "{\"id\":\"$Q\"}")
dated "frontier" "$FRO" '[d]'
dated "frontier progress" "$FRO" 'd["progress"]'
dated "frontier open_subproblems" "$FRO" 'd["open_subproblems"]'
dated "fronts list" "$(call fronts '{}')" 'd["fronts"]'
FRD=$(call fronts "{\"id\":\"$FR\"}")
dated "front" "$FRD" '[d]'
dated "front members" "$FRD" 'd["members"] + d["open_problems"]'
dated "browse" "$(call browse '{"limit":3}')" 'd["results"]'
dated "search" "$(call search '{"query":"frontier test question"}')" 'd["results"]'
dated "related" "$(call related "{\"id\":\"$Q\",\"method\":\"lexical\",\"limit\":3}")" 'd["related"]'
dated "hello most_notable" "$(call hello '{}')" 'd["most_notable"]'

# Contract: a contributor key may arrive as an Authorization: Bearer header
# instead of a per-call argument, a per-call argument wins over it, and the
# header carries role gates too.
HELLO=$(AUTH=$KEY call hello '{}')
[[ $(echo "$HELLO" | field '["you"]["identity"]') == "$SID" ]] || fail "header key did not resolve to its identity"
[[ $(echo "$HELLO" | field '["you"]["via"]') == key ]] || fail "header key was not reported as the credential in use"
MINE=$(AUTH=$KEY call my_submissions '{}' | field '["submissions"]' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[[ "$MINE" -ge 1 ]] || fail "header identity did not see its own submissions"
OPID2=$(AUTH=$OPKEY call hello "{\"contributor_key\":\"$KEY\"}" | field '["you"]["identity"]')
[[ "$OPID2" == "$SID" ]] || fail "per-call contributor_key did not win over the header"
HDRT=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"header gate target\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
AUTH=$OPKEY call set_tier "{\"id\":\"$HDRT\",\"tier\":2,\"note\":\"reviewed via header\"}" | field '["ok"]' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select tier from contribution where id='$HDRT'") == 2 ]] || fail "operator header did not pass the trusted gate"

# Contract: OAuth is a complete, accountless path to an identity -- the one
# MCP clients already know how to walk. Register, authorize, exchange with
# PKCE, and the token that comes out is a durable identity with no signup.
DISC=$(curl -sf "$PUBLIC_URL/.well-known/oauth-protected-resource")
[[ $(echo "$DISC" | field '["authorization_servers"][0]') == "$PUBLIC_URL" ]] || fail "protected-resource metadata does not point at this server"
curl -sf "$PUBLIC_URL/.well-known/oauth-authorization-server" | field '["token_endpoint"]' > /dev/null || fail "no authorization-server metadata"

REG=$(curl -sf -X POST "$PUBLIC_URL/oauth/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"contract client","redirect_uris":["http://127.0.0.1:9999/callback"]}')
CID=$(echo "$REG" | field '["client_id"]')
VERIFIER=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
CHALLENGE=$(python3 -c 'import hashlib,base64,sys; print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b"=").decode())' "$VERIFIER")
curl -sf "$PUBLIC_URL/oauth/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2F127.0.0.1%3A9999%2Fcallback&code_challenge=$CHALLENGE&code_challenge_method=S256&state=xyz" \
  | grep -qi "contract client" || fail "authorization page did not name the client"
authorize_code() { # -> a fresh authorization code from a consent round
  local location
  location=$(curl -sf -o /dev/null -w '%{redirect_url}' -X POST "$PUBLIC_URL/oauth/authorize" \
    --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=http://127.0.0.1:9999/callback" \
    --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "state=xyz" --data-urlencode "decision=new")
  [[ $location == *"state=xyz"* ]] || fail "consent did not redirect back with state"
  python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["code"][0])' "$location"
}
# A failed PKCE check burns the code, as OAuth 2.1 requires, so the good
# exchange below starts from its own consent round.
curl -s -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$(authorize_code)" --data-urlencode "client_id=$CID" --data-urlencode "code_verifier=wrong-verifier" \
  | field '["error"]' | grep -q invalid_grant || fail "PKCE verification is not enforced"
CODE=$(authorize_code)
TOKEN=$(curl -sf -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$CODE" --data-urlencode "client_id=$CID" --data-urlencode "code_verifier=$VERIFIER" | field '["access_token"]')
[[ $TOKEN == mrt_* ]] || fail "authorization code did not exchange for a token"
OAID=$(AUTH=$TOKEN call submit '{"kind":"result","title":"oauth attribution","summary":"s","content":"c."}' | field '["attributed_to"]')
[[ $OAID != anonymous ]] || fail "an OAuth token did not attribute the contribution"
[[ $(AUTH=$TOKEN call hello '{}' | field '["you"]["identity"]') == "$OAID" ]] || fail "OAuth identity is not stable across calls"

# Contract: a headless client with no browser can still be someone.
MREG=$(curl -sf -X POST "$PUBLIC_URL/oauth/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"machine","grant_types":["client_credentials"]}')
MID=$(echo "$MREG" | field '["client_id"]'); MSECRET=$(echo "$MREG" | field '["client_secret"]')
machine_token() {
  curl -sf -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$MID" --data-urlencode "client_secret=$MSECRET" | field '["access_token"]'
}
MID1=$(AUTH=$(machine_token) call hello '{}' | field '["you"]["identity"]')
[[ $(AUTH=$(machine_token) call hello '{}' | field '["you"]["identity"]') == "$MID1" ]] || fail "client_credentials identity is not stable across tokens"

echo "all contracts hold"
