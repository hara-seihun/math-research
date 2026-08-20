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
# A free port, not a fixed one: two agents on one machine run this suite at
# the same time, and a hardcoded port means each silently tests the other's
# server against its own database.
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export SERVER_KEY_PATH="$WORK/server.key" SPOOL_DIR="$WORK/spool" PORT
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
fail() {
  echo "FAIL: $1" >&2
  for log in server verifier; do
    [[ -s "$WORK/$log.log" ]] && { echo "--- $log ---" >&2; tail -20 "$WORK/$log.log" >&2; }
  done
  exit 1
}

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
EV=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$EV" | field '["events"][0]["kind"]') == submitted ]] || fail "no submitted event"

# The runner is a separate sandboxed process; these tests stand in for it.
# Checks are spooled under the hash of their source, which is the whole point:
# it is the same queue entry however the check was asked for.
lean_hash() { python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }
await_spool() { # <hash> -> waits for the runner's input to appear
  for _ in $(seq 100); do [[ -f "$SPOOL_DIR/in/$1.lean" ]] && return 0; sleep 0.1; done
  fail "verifier never spooled check $1"
}
runner_says() { # <hash> <json> -> answers as the sandboxed runner would
  rm "$SPOOL_DIR/in/$1.lean"
  echo "$2" > "$SPOOL_DIR/out/$1.json"
}
await_verification() { # <verification id> -> its settled outcome
  for _ in $(seq 100); do
    OUT=$(psql -h "$WORK" -d math -tAc "select outcome from verification where id = $1")
    [[ $OUT != pending ]] && { echo "$OUT"; return 0; }
    sleep 0.1
  done
  fail "verification $1 never settled"
}

# Contract: a passing kernel check flips lean_verified but never the tier.
HASH=$(printf 'import Mathlib\ntheorem t : 1 + 1 = 2 := rfl\n' | lean_hash)
VID=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID'")
await_spool "$HASH"
runner_says "$HASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"t","type":"1 + 1 = 2","axioms":[]}]}'
[[ $(await_verification "$VID") == passed ]] || fail "a clean check did not pass"
GOT=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$GOT" | field '["lean_verified"]') == True ]] || fail "pass did not set lean_verified"
[[ $(echo "$GOT" | field '["tier"]') == 0 ]] || fail "verification changed the tier, and it must not"

# Contract: check_lean is a throwaway check. It runs the same kernel, reports
# the exact statements proven, and creates no contribution.
BEFORE=$(psql -h "$WORK" -d math -tAc "select count(*) from contribution")
CHECK_SRC='theorem check_me : 2 + 2 = 4 := rfl'
CHASH=$(printf 'import Mathlib\n\n%s\n' "$CHECK_SRC" | lean_hash)
call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$CHECK_SRC\"}" > "$WORK/check.out" &
CHECK_JOB=$!
await_spool "$CHASH"
runner_says "$CHASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"check_me","type":"2 + 2 = 4","axioms":[]}]}'
wait $CHECK_JOB
CHECKED=$(cat "$WORK/check.out")
[[ $(echo "$CHECKED" | field '["status"]') == passed ]] || fail "check_lean did not report the pass: $CHECKED"
[[ $(echo "$CHECKED" | field '["proved"][0]["statement"]') == "2 + 2 = 4" ]] || fail "check_lean did not report the statement proven"
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from contribution") == "$BEFORE" ]] || fail "check_lean created a contribution"

# Contract: a check is a pure function of its source, so the second caller
# pays nothing, including when the second caller is a submission.
CACHED=$(call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$CHECK_SRC\"}")
[[ $(echo "$CACHED" | field '["cached"]') == True ]] || fail "an identical check was not served from cache"
SUB3=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"already checked\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\n$CHECK_SRC\n\`\`\`\"}")
VID3=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$(echo "$SUB3" | field '["id"]')'")
[[ $(await_verification "$VID3") == passed ]] || fail "a submission of already-checked source did not reuse the result"
[[ ! -f "$SPOOL_DIR/in/$CHASH.lean" ]] || fail "already-checked source was sent to the kernel twice"

# Contract: source that declares nothing (an import and a #check, which is how
# you read a library's statements) compiled cleanly. It verifies nothing, so it
# is inconclusive, but Lean's answer comes back as output, not as errors.
LOOK_SRC='#check @Nat.succ_le_succ'
LHASH=$(printf 'import Mathlib\n\n%s\n' "$LOOK_SRC" | lean_hash)
call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$LOOK_SRC\"}" > "$WORK/look.out" &
LOOK_JOB=$!
await_spool "$LHASH"
runner_says "$LHASH" '{"ok":true,"exit_code":0,"audit_ok":false,"declares_nothing":true,"decls":[],"output":"Nat.succ_le_succ : n \u2264 m \u2192 n.succ \u2264 m.succ"}'
wait $LOOK_JOB
LOOK=$(cat "$WORK/look.out")
[[ $(echo "$LOOK" | field '["status"]') == inconclusive ]] || fail "a declaration-free check was not inconclusive: $LOOK"
[[ $(echo "$LOOK" | field '["output"]') == *"succ_le_succ"* ]] || fail "a declaration-free check did not return Lean's output: $LOOK"
[[ $(echo "$LOOK" | field '.get("errors")') == None ]] || fail "a declaration-free check reported errors it did not have: $LOOK"

# Contract: sorry is reported by check_lean and refused by submit, so the check
# is a working tool, the badge is a claim about a finished proof.
SORRY_SRC='theorem hole : 1 = 1 := by sorry'
SHASH=$(printf 'import Mathlib\n\n%s\n' "$SORRY_SRC" | lean_hash)
call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$SORRY_SRC\"}" > "$WORK/sorry.out" &
SORRY_JOB=$!
await_spool "$SHASH"
runner_says "$SHASH" '{"ok":false,"exit_code":0,"output":"warning: declaration uses '"'"'sorry'"'"'"}'
wait $SORRY_JOB
SORRY=$(cat "$WORK/sorry.out")
[[ $(echo "$SORRY" | field '["sorry"]') == True ]] || fail "check_lean did not report the sorry: $SORRY"
# A proof the kernel accepts because it rests on sorryAx is a hole, and must
# not read as done to someone skimming the status.
HOLE_SRC='theorem still_open : 1 = 1 := by sorry_placeholder'
HHASH=$(printf 'import Mathlib\n\n%s\n' "$HOLE_SRC" | lean_hash)
call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$HOLE_SRC\"}" > "$WORK/hole.out" &
HOLE_JOB=$!
await_spool "$HHASH"
runner_says "$HHASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"still_open","type":"1 = 1","axioms":["sorryAx"]}]}'
wait $HOLE_JOB
[[ $(field '["status"]' < "$WORK/hole.out") == incomplete ]] || fail "a sorryAx proof was reported as passed: $(cat "$WORK/hole.out")"
SUB4=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"with sorry\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem s : 1 = 1 := by sorry\n\`\`\`\"}")
VID4=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$(echo "$SUB4" | field '["id"]')'")
[[ $(await_verification "$VID4") == failed ]] || fail "a submission containing sorry was not refused"

# Contract: declarations resting on axioms outside the allowed three fail.
SUB2=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"bad axioms\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem u : True := trivial\n\`\`\`\"}")
CID2=$(echo "$SUB2" | field '["id"]')
HASH2=$(printf 'import Mathlib\ntheorem u : True := trivial\n' | lean_hash)
VID2=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID2'")
await_spool "$HASH2"
runner_says "$HASH2" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"u","type":"True","axioms":["sneakyAxiom"]}]}'
[[ $(await_verification "$VID2") == failed ]] || fail "disallowed axiom was not rejected"

# Contract: tier changes are trusted-only and land in the event ledger.
DENIED=$(call set_tier "{\"contributor_key\":\"$KEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"x\"}")
echo "$DENIED" | field '["error"]' | grep -qi trusted || fail "non-trusted was allowed to set tier"
OPKEY="mrk_test_operator"
OPID=$(python3 -c "import hashlib; print(hashlib.sha256(b'$OPKEY').hexdigest())")
psql -q -h "$WORK" -d math -c "insert into identity (id, role) values ('$OPID', 'operator')"
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"reviewed\"}" | field '["ok"]' > /dev/null
GOT=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$GOT" | field '["tier"]') == 2 ]] || fail "operator set_tier did not apply"

# Contract: a write refreshes what it touched, not the corpus. Promotion and
# linking used to recompute state and notability over every row, which on a
# real corpus is both slow and a deadlock (two whole-table updates take row
# locks in opposite orders, observed live as "deadlock detected" on the fifth
# of five promotions). Fill the table first, so a whole-table refresh is
# unmistakable in the tuple-update count.
psql -q -h "$WORK" -d math -c "insert into contribution (kind, title, summary, artifact_hash, tier)
  select 'result', 'filler ' || g, 'filler', (select artifact_hash from contribution limit 1), 1
  from generate_series(1, 400) g"
BEFORE=$(psql -h "$WORK" -d math -tAc "select n_tup_upd from pg_stat_user_tables where relname = 'contribution'")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"scope check\"}" | field '["ok"]' > /dev/null
sleep 1.5
AFTER=$(psql -h "$WORK" -d math -tAc "select n_tup_upd from pg_stat_user_tables where relname = 'contribution'")
(( AFTER - BEFORE < 100 )) || fail "set_tier rewrote $((AFTER - BEFORE)) rows, and it should refresh only what it touched"

# And under real contention the writes must all come back answers, not errors.
WRITE_JOBS=()
for i in 1 2 3 4 5 6; do
  call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"concurrent $i\"}" > "$WORK/tier.$i.out" &
  WRITE_JOBS+=($!)
  call link "{\"contributor_key\":\"$KEY\",\"src\":\"$CID\",\"dst\":\"$CID2\",\"rel\":\"about\",\"note\":\"concurrent $i\"}" > "$WORK/link.$i.out" &
  WRITE_JOBS+=($!)
done
# Only these jobs: the server and the verifier are background jobs too, and a
# bare `wait` would wait for the suite's own infrastructure to exit.
wait "${WRITE_JOBS[@]}"
for f in "$WORK"/tier.*.out "$WORK"/link.*.out; do
  [[ $(field '["ok"]' < "$f") == True ]] || fail "a concurrent write failed: $(cat "$f")"
done

echo "$GOT" | python3 -c 'import sys,json; evs=[e["kind"] for e in json.loads(sys.stdin.read())["events"]]; assert "tier-changed" in evs' || fail "no tier-changed event"

# Contract: trails are visible where the work happens and never block anyone.
T=$(call trail "{\"contributor_key\":\"$KEY\",\"title\":\"exploring the test theorem\",\"note\":\"starting out\",\"relates_to\":[\"$CID\"]}")
TID=$(echo "$T" | field '["trail_id"]')
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$TID\",\"note\":\"found a reduction\"}" | field '["ok"]' > /dev/null
GOT=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$GOT" | field '["exploring_now"][0]["latest_note"]') == "found a reduction" ]] || fail "trail not surfaced on get"
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$TID\",\"note\":\"wrapping up\",\"close\":true}" | field '["status"]' | grep -q closed || fail "close failed"
GOT=$(call get "{\"ref\":\"$CID\"}")
echo "$GOT" | python3 -c 'import sys,json; assert not json.loads(sys.stdin.read()).get("exploring_now")' || fail "closed trail still shown as active"
FULL=$(call trails "{\"trail_id\":\"$TID\"}")
[[ $(echo "$FULL" | field '["activity"]') == closed ]] || fail "trail history wrong"

# Contract: an open trail idle past the freshness window is abandoned, hidden
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
call get "{\"ref\":\"$A\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(x for xs in d["links"]["in"].values() for x in xs)' || fail "link not in neighbourhood"
NA=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$A'")
python3 -c "assert float('$NA')>0" || fail "notability not derived for a contribution built upon"

# Contract: trusted promotion of a link (edges climb the same ladder).
EID=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where dst='$A' limit 1")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$EID\",\"tier\":2,\"note\":\"confirmed link\"}" | field '["ok"]' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select tier from contribution where id='$EID'") == 2 ]] || fail "edge did not promote"

# Contract: submissions are auto-tagged with subject topics (submit wiring to
# the shared classifier) and topic is a search facet.
DBN=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"Riemann zeta zero de Bruijn Newman\",\"summary\":\"analytic bound\",\"content\":\"On the critical line.\"}" | field '["id"]')
[[ $(psql -h "$WORK" -d math -tAc "select 'analytic-number-theory' = any(tags) from contribution where id='$DBN'") == t ]] || fail "submission was not topic-tagged"
call search '{"topic":"analytic-number-theory"}' | python3 -c 'import sys,json;assert len(json.load(sys.stdin)["results"])>=1' || fail "topic search facet empty"

# Contract: a front groups work and its members surface (fronts read tool).
FR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"front\",\"title\":\"test front\",\"summary\":\"s\",\"content\":\"grouping.\"}" | field '["id"]')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$A\",\"dst\":\"$FR\",\"rel\":\"in-front\"}" | field '["ok"]' > /dev/null
call fronts "{\"ref\":\"$FR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(m["id"] for ms in d["members_by_kind"].values() for m in ms)' || fail "front member not surfaced"

# Contract: programmes nest, and both directions are visible. A campaign front
# is part-of the broader front that covers it; a reader landing on either must
# be able to walk to the other.
SUBFR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"front\",\"title\":\"test campaign\",\"summary\":\"s\",\"content\":\"one campaign.\"}" | field '["id"]')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$SUBFR\",\"dst\":\"$FR\",\"rel\":\"part-of\"}" | field '["ok"]' > /dev/null
call fronts "{\"ref\":\"$FR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["sub_programmes"][0]["id"]=="'"$SUBFR"'"' || fail "umbrella front does not list its campaigns"
call fronts "{\"ref\":\"$SUBFR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["part_of"][0]["id"]=="'"$FR"'"' || fail "campaign front does not name its umbrella"


# Contract: a list row does not echo the title back as its summary. Titles cut
# from the opening of a write-up make the two identical, which is pure noise in
# a page of results.
ECHO=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"echoing title zqx\",\"summary\":\"echoing title zqx\",\"content\":\"echoing title zqx\"}" | field '["id"]')
call search '{"kind":"problem"}' | python3 -c 'import sys,json;rs=json.load(sys.stdin)["results"];r=[x for x in rs if x["id"]=="'"$ECHO"'"][0];assert "summary" not in r, r' || fail "list row echoed the title as its summary"
call get "{\"ref\":\"$ECHO\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert "summary" not in d and d["content"]' || fail "get echoed the title as its summary"

# Contract: an alias resolves anywhere a ref is taken, even when the title differs.
RN=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"obscure internal title zzq\",\"summary\":\"s\",\"content\":\"c.\",\"names\":[\"Kolmogorov width marker\"]}" | field '["id"]')
call get '{"ref":"Kolmogorov width marker"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["matched_by"]=="name" and d["id"]=="'"$RN"'"' || fail "alias ref did not find the entry"

# Contract: frontier distills a question's attack state from the graph.
Q=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"frontier test question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
SQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"sub-question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"partial attempt\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$Q\",\"rel\":\"refines\"}]}" > /dev/null
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$Q\",\"dst\":\"$SQ\",\"rel\":\"reduces-to\"}" > /dev/null
call frontier "{\"ref\":\"$Q\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["progress_toward_it"])>=1 and any(x["id"]=="'"$SQ"'" for x in d["open_subproblems"])' || fail "frontier did not distill attack state"

# Contract: a door's own preference breaks a near-tie. "frontier test" names
# both the question and the write-up attacking it; frontier wants the question.
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"frontier test question attack\",\"summary\":\"s\",\"content\":\"c.\"}" > /dev/null
FRT=$(call frontier '{"ref":"frontier test question"}')
echo "$FRT" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("kind")=="problem"' || fail "frontier did not prefer the question over the write-up: $FRT"

# Contract: a question's state is derived from the graph, not declared. It is
# open until something in the ledger answers it, and answering flips it without
# anyone editing the question. This is what makes "which cells are still open?"
# answerable, so it is checked end to end through the read doors.
[[ $(call frontier "{\"ref\":\"$Q\"}" | field '["state"]') == open ]] || fail "fresh problem was not open"
call search '{"kind":"problem","state":"open"}' | python3 -c 'import sys,json;assert any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "open problem missing from the open list"
ANS=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"settles the sub-question\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$SQ\",\"rel\":\"answers\"}]}" | field '["id"]')
SQF=$(call frontier "{\"ref\":\"$SQ\"}")
[[ $(echo "$SQF" | field '["state"]') == settled ]] || fail "answered problem did not become settled"
echo "$SQF" | python3 -c 'import sys,json;assert any(a["id"]=="'"$ANS"'" for a in json.load(sys.stdin)["answered_by"])' || fail "frontier did not name what settled the question"
call search '{"kind":"problem","state":"open"}' | python3 -c 'import sys,json;assert not any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "settled problem still listed as open"
call retract "{\"contributor_key\":\"$KEY\",\"ref\":\"$ANS\",\"note\":\"withdrawn\"}" | field '["ok"]' > /dev/null
[[ $(call frontier "{\"ref\":\"$SQ\"}" | field '["state"]') == open ]] || fail "retracting the answer did not reopen the question"

# Contract: news is a cursor, not a clock. A reader hands back the sequence
# number it was given and gets exactly the events it has not seen -- no
# interval to guess, no double-read, no gap -- and the packet carries the
# custody vocabulary a summary must preserve.
CUR=$(call news '{"since":"1h"}' | field '["next"]["after_seq"]')
NQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"news test question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
NA=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"settles the news question\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$NQ\",\"rel\":\"answers\"}]}" | field '["id"]')
# A settlement asserted and then withdrawn inside one window is not news that a
# question closed, so this second pair must never reach `settled`.
WQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"withdrawn-answer question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '["id"]')
WA=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"withdrawn answer\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$WQ\",\"rel\":\"answers\"}]}" | field '["id"]')
call retract "{\"contributor_key\":\"$KEY\",\"ref\":\"$WA\",\"note\":\"withdrawn\"}" > /dev/null
NEWS=$(call news "{\"after_seq\":$CUR,\"questions\":50}")
echo "$NEWS" | NQ="$NQ" NA="$NA" WQ="$WQ" CUR="$CUR" python3 -c '
import os, sys, json
d = json.load(sys.stdin)
nq, na, wq = os.environ["NQ"], os.environ["NA"], os.environ["WQ"]
settled = {s["question"]["id"]: s for s in d["settled"]}
assert nq in settled, "settled question missing from news"
by = settled[nq]["by"]
assert any(b["entry"]["id"] == na and b["rel"] == "answers" for b in by), "news did not name what settled it"
assert all("edge_tier" in b for b in by), "news hid the settling link tier"
assert wq not in settled, "a withdrawn answer was reported as a settlement"
assert wq in {q["id"] for q in d["questions"]}, "reopened question missing from the forecast set"
assert d["window"]["from_seq"] == int(os.environ["CUR"]), "news window did not start at the cursor"
assert "T2 canon" in d["how_to_read"], "news dropped the custody vocabulary"
' || fail "news did not report the window correctly: $(echo "$NEWS" | head -c 400)"

# Contract: the cursor advances exactly once. Reading from the sequence number
# the last packet handed back reports nothing that packet already carried.
CUR2=$(echo "$NEWS" | field '["next"]["after_seq"]')
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$NQ\",\"tier\":2,\"note\":\"canon for the news contract\"}" > /dev/null
NEWS2=$(call news "{\"after_seq\":$CUR2}")
echo "$NEWS2" | NQ="$NQ" python3 -c '
import os, sys, json
d = json.load(sys.stdin)
assert not d["settled"], "news replayed a settlement the previous packet carried"
promoted = {p["entry"]["id"]: p for p in d["promoted"]}
assert os.environ["NQ"] in promoted, "trusted promotion missing from news"
assert promoted[os.environ["NQ"]]["tier"] == 2
assert "news contract" in (promoted[os.environ["NQ"]]["note"] or ""), "news dropped the reviewer verdict"
assert d["promotions"]["total"] >= len(d["promoted"])
' || fail "news cursor did not advance cleanly: $(echo "$NEWS2" | head -c 400)"

# Contract: every read door takes a name, not just a uuid. A reader who has
# only seen an entry's name in a summary can ask about it directly.
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"named cell\",\"summary\":\"s\",\"content\":\"c.\",\"names\":[\"cell-q4n-residual\"]}" > /dev/null
for door in 'get {"ref":"cell-q4n-residual"}' 'frontier {"ref":"cell-q4n-residual"}'; do
  [[ $(call "${door%% *}" "${door#* }" | field '["title"]') == "named cell" ]] || fail "${door%% *} did not accept a name"
done
[[ $(call fronts '{"ref":"test front"}' | field '["title"]') == "test front" ]] || fail "fronts did not accept a title"

# Contract: search says how each hit matched, and hits carrying every term rank
# above hits carrying one. Otherwise a two-word query is swamped by whatever
# shares its commonest word.
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"quaternionic residual growth\",\"summary\":\"s\",\"content\":\"c.\"}" > /dev/null
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"unrelated residual note\",\"summary\":\"s\",\"content\":\"c.\"}" > /dev/null
SR=$(call search '{"query":"quaternionic residual"}')
echo "$SR" | python3 -c '
import sys, json
d = json.load(sys.stdin)
top = d["results"][0]
assert top["title"] == "quaternionic residual growth", top
assert top["matched"] == "every term", top
assert any(r["matched"] != "every term" for r in d["results"][1:]), "weaker matches were not labelled"
' || fail "search did not rank or label complete matches"

# Contract: list rows are scannable. A summary in a list is shortened; the full
# text is one get away. Twenty 2000-character summaries is not a list.
LONG=$(python3 -c 'print("Sigma " * 300)')
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"long summary entry\",\"summary\":\"$LONG\",\"content\":\"$LONG full body.\"}" > /dev/null
call search '{"query":"long summary entry"}' | python3 -c '
import sys, json
r = json.load(sys.stdin)["results"][0]
assert len(r["summary"]) <= 281, len(r["summary"])
' || fail "search returned an untruncated summary"
[[ $(call get '{"ref":"long summary entry"}' | field '["content"]' | wc -c) -gt 1000 ]] || fail "get did not return the full content"

# Contract: every read door says when. A reader must be able to date anything
# it is shown without a second round trip, including a *link*, whose
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
' "$1" "$3" || fail "$1 returned undated or unparseable entries: $(echo "$2" | head -c 400)"
}
GOTQ=$(call get "{\"ref\":\"$Q\"}")
dated "get" "$GOTQ" '[d]'
dated "get links" "$GOTQ" '(x for xs in list(d["links"]["in"].values()) + list(d["links"]["out"].values()) for x in xs)'
dated "get events" "$GOTQ" 'd["events"]'
FRO=$(call frontier "{\"ref\":\"$Q\"}")
dated "frontier" "$FRO" '[d]'
dated "frontier progress" "$FRO" 'd["progress_toward_it"]'
dated "frontier open_subproblems" "$FRO" 'd["open_subproblems"]'
dated "fronts list" "$(call fronts '{}')" 'd["fronts"]'
FRD=$(call fronts "{\"ref\":\"$FR\"}")
dated "front" "$FRD" '[d]'
dated "front members" "$FRD" '[m for ms in d["members_by_kind"].values() for m in ms]'
dated "browse-mode search" "$(call search '{"limit":3}')" 'd["results"]'
dated "search" "$(call search '{"query":"frontier test question"}')" 'd["results"]'
dated "related" "$(call related "{\"ref\":\"$Q\",\"method\":\"lexical\",\"limit\":3}")" 'd["related"]'
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
AUTH=$OPKEY call set_tier "{\"ref\":\"$HDRT\",\"tier\":2,\"note\":\"reviewed via header\"}" | field '["ok"]' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select tier from contribution where id='$HDRT'") == 2 ]] || fail "operator header did not pass the trusted gate"

# Contract: OAuth is a complete, accountless path to an identity -- the one
# MCP clients already know how to walk. Register, authorize, exchange with
# PKCE, and the token that comes out is a durable identity with no signup.
DISC=$(curl -sf "$PUBLIC_URL/.well-known/oauth-protected-resource")
[[ $(echo "$DISC" | field '["authorization_servers"][0]') == "$PUBLIC_URL" ]] || fail "protected-resource metadata does not point at this server"
curl -sf "$PUBLIC_URL/.well-known/oauth-authorization-server" | field '["token_endpoint"]' > /dev/null || fail "no authorization-server metadata"

REG=$(curl -sf -X POST "$PUBLIC_URL/oauth/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"contract client","redirect_uris":["http://127.0.0.1:9999/callback"]}')
OACID=$(echo "$REG" | field '["client_id"]')
VERIFIER=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
CHALLENGE=$(python3 -c 'import hashlib,base64,sys; print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b"=").decode())' "$VERIFIER")
curl -sf "$PUBLIC_URL/oauth/authorize?response_type=code&client_id=$OACID&redirect_uri=http%3A%2F%2F127.0.0.1%3A9999%2Fcallback&code_challenge=$CHALLENGE&code_challenge_method=S256&state=xyz" \
  | grep -qi "contract client" || fail "authorization page did not name the client"
authorize_code() { # -> a fresh authorization code from a consent round
  local location
  location=$(curl -sf -o /dev/null -w '%{redirect_url}' -X POST "$PUBLIC_URL/oauth/authorize" \
    --data-urlencode "client_id=$OACID" --data-urlencode "redirect_uri=http://127.0.0.1:9999/callback" \
    --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "state=xyz" --data-urlencode "decision=new")
  [[ $location == *"state=xyz"* ]] || fail "consent did not redirect back with state"
  python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["code"][0])' "$location"
}
# A failed PKCE check burns the code, as OAuth 2.1 requires, so the good
# exchange below starts from its own consent round.
curl -s -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$(authorize_code)" --data-urlencode "client_id=$OACID" --data-urlencode "code_verifier=wrong-verifier" \
  | field '["error"]' | grep -q invalid_grant || fail "PKCE verification is not enforced"
CODE=$(authorize_code)
TOKEN=$(curl -sf -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$CODE" --data-urlencode "client_id=$OACID" --data-urlencode "code_verifier=$VERIFIER" | field '["access_token"]')
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

# A refactor proposal to adjudicate, so apply_refactor below is called with
# something it can actually decide.
# Contract: query is read-only SQL over the public views. It answers, refuses
# writes, cannot see base tables (that is what keeps sessions, OAuth state, and
# the request log private), reports its row cap, and takes one statement only.
QR=$(call query '{"sql":"select kind, count(*) as n from q_entries where status = '"'"'active'"'"' group by kind order by n desc"}')
echo "$QR" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["columns"]==["kind","n"] and d["row_count"]>=1, d' || fail "query did not answer"
call query '{"sql":"delete from q_entries"}' | grep -qi "reads only" || fail "query accepted a write"
call query '{"sql":"select count(*) from contribution"}' | grep -qi "permission denied" || fail "query reached a base table"
call query '{"sql":"select * from generate_series(1,1000)"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["row_count"]==500 and d["truncated"], d.get("row_count")' || fail "query row cap did not hold"
call query '{"sql":"select 1; select 2"}' | grep -q "one statement" || fail "query accepted two statements"

# Contract: a hub entry's neighbourhood is capped per relation and the cap
# reports what it hid (this is what stopped 506-row 136 KB get responses).
# rel-paging reaches the hidden rows.
HUB=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"hub target\",\"summary\":\"s\",\"content\":\"hub.\"}" | field '["id"]')
for i in $(seq 1 10); do
  SPOKE=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"spoke $i\",\"summary\":\"s\",\"content\":\"spoke $i.\"}" | field '["id"]')
  call link "{\"contributor_key\":\"$KEY\",\"src\":\"$SPOKE\",\"dst\":\"$HUB\",\"rel\":\"uses\",\"note\":\"n\"}" > /dev/null
done
call get "{\"ref\":\"$HUB\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["links"]["in"]["uses"])==8 and d["links"]["more"]["in"]["uses"]==2, json.dumps(d["links"].get("more"))' || fail "neighbourhood cap did not hold"
call get "{\"ref\":\"$HUB\",\"rel\":\"uses\",\"links_offset\":8}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["links"]["in"]["uses"])==2 and "more" not in d["links"], json.dumps(d["links"])' || fail "rel paging did not reach the hidden rows"

# Contract: filter-only search (no query) lists by importance and reports the
# total beyond the page.
call search '{"kind":"theorem","limit":1}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["total"]>=2 and len(d["results"])==1 and d.get("next"), d.get("total")' || fail "browse-mode search total/next wrong"

PROPOSAL=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"refactor\",\"title\":\"proposal\",\"summary\":\"s\",\"content\":\"c.\",\"supersedes\":[\"$SQ\"]}" | field '["id"]')

# Contract: every door answers. A tool that no contract above calls can still
# be broken by a refactor of a shared read path, so each one is called once
# with plausible arguments and must not come back an error. A new tool means a
# new line here.
declare -A DOORS=(
  [hello]='{}'
  [search]='{"query":"frontier test question"}'
  [fronts]='{}'
  [query]='{"sql":"select kind, count(*) as n from q_entries group by kind order by n desc"}'
  [frontier]="{\"ref\":\"$Q\"}"
  [related]="{\"ref\":\"$Q\",\"method\":\"lexical\"}"
  [get]="{\"ref\":\"$Q\"}"
  [submit]='{"kind":"result","title":"every door","summary":"s","content":"c."}'
  [check_lean]="{\"contributor_key\":\"$KEY\",\"source\":\"$CHECK_SRC\"}"
  [link]="{\"contributor_key\":\"$KEY\",\"src\":\"$Q\",\"dst\":\"$SQ\",\"rel\":\"uses\"}"
  [my_submissions]="{\"contributor_key\":\"$KEY\"}"
  [trail]="{\"contributor_key\":\"$KEY\",\"title\":\"every door\",\"note\":\"n\"}"
  [trails]='{}'
  [guides]='{}'
  [news]='{}'
  [set_tuning]="{\"contributor_key\":\"$OPKEY\",\"notability_weights\":{},\"note\":\"no-op\"}"
  [review_queue]="{\"contributor_key\":\"$OPKEY\"}"
  [set_tier]="{\"contributor_key\":\"$OPKEY\",\"ref\":\"$Q\",\"tier\":1,\"note\":\"n\"}"
  [apply_refactor]="{\"contributor_key\":\"$OPKEY\",\"refactor_id\":\"$PROPOSAL\",\"decision\":\"reject\",\"note\":\"n\"}"
  [grant_trust]="{\"contributor_key\":\"$OPKEY\",\"identity_id\":\"$OPID\",\"role\":\"operator\",\"note\":\"n\"}"
  [retract]="{\"contributor_key\":\"$OPKEY\",\"ref\":\"$SQ\",\"note\":\"contract test\"}"
  [register_public_key]="{\"contributor_key\":\"$KEY\",\"public_key\":\"$(python3 -c 'import base64,os; print(base64.b64encode(os.urandom(32)).decode())')\"}"
)
REGISTERED=$(curl -sf --max-time 10 -X POST "$MCP" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p' | python3 -c 'import sys,json; print("\n".join(sorted(t["name"] for t in json.loads(sys.stdin.read())["result"]["tools"])))')
for tool in $REGISTERED; do
  [[ -v DOORS[$tool] ]] || fail "$tool is registered but no contract calls it"
  ANSWER=$(call "$tool" "${DOORS[$tool]}") || fail "$tool did not answer"
  echo "$ANSWER" | grep -q '"error"' && fail "$tool answered with an error: $(echo "$ANSWER" | head -c 300)"
done

echo "all contracts hold"


