#!/usr/bin/env bash
# Contract tests against an ephemeral Postgres and a real server process.
# Covers the invariants that matter: submission shape, the verification
# pipeline's tier neutrality, the axiom policy, the operator gate, and trails.
# Runs in well under a minute; needs postgres and bun on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v initdb > /dev/null || exec nix shell nixpkgs#postgresql_17 -c "$0" "$@"

WORK=$(mktemp -d)
export PGHOST="$WORK" PGDATABASE=math PGUSER="$(whoami)"
export SERVER_KEY_PATH="$WORK/server.key" SPOOL_DIR="$WORK/spool" PORT=8931
MCP="http://127.0.0.1:$PORT/mcp"

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
psql -q -h "$WORK" -d math -f schema.sql

(cd server && bun src/index.ts) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
(cd server && bun verifier/verifier.ts) > "$WORK/verifier.log" 2>&1 &
VERIFIER_PID=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && break; sleep 0.1; done

call() { # call <tool> <json-args> -> result text payload
  curl -sf --max-time 10 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | sed -n 's/^data: //p' | python3 -c 'import sys,json; print(json.loads(sys.stdin.read())["result"]["content"][0]["text"])'
}
field() { python3 -c "import sys,json; v=json.loads(sys.stdin.read())$1; print(json.dumps(v) if isinstance(v,(dict,list)) else v)"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

KEY=$(call hello '{}' | field '["your_contributor_key"]')

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

echo "all contracts hold"
