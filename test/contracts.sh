#!/usr/bin/env bash
# Contract tests against an ephemeral Postgres and a real server process.
# Covers the invariants that matter: submission shape, the verification
# pipeline's tier neutrality, the axiom policy, the operator gate, trails,
# the three ways a caller can be someone (session, key, OAuth), and that a
# bulk import reconciles in both directions.
# Runs in well under a minute; needs bun on PATH. Postgres comes from nixpkgs
# when it is absent, and must carry pgvector because the schema stores
# semantic embeddings.
set -euo pipefail
[[ -n "${TRACE:-}" ]] && set -x
cd "$(dirname "$0")/.."
source test/under-a-minute.sh

command -v initdb > /dev/null || exec nix shell --impure --expr \
  'let pkgs = import (builtins.getFlake "nixpkgs") { system = builtins.currentSystem; };
   in [ (pkgs.postgresql_17.withPackages (p: [ p.pgvector ])) ]' -c "$0" "$@"

# Prose first: it needs no database, it is the cheapest thing here to check,
# and a version literal that grew back is a deploy that teaches the wrong
# toolchain.
./test/doc-ssot.sh

WORK=$(mktemp -d)
# A fifo nobody writes to, so `read -t` is a sub-second sleep that costs no
# process. Every wait in here is a few milliseconds long and there are hundreds
# of them.
mkfifo "$WORK/nap"
exec 9<> "$WORK/nap"
nap() { read -t 0.005 -u 9 || true; }
export PGHOST="$WORK" PGDATABASE=math PGUSER="$(whoami)"
# A free port, not a fixed one: two agents on one machine run this suite at
# the same time, and a hardcoded port means each silently tests the other's
# server against its own database.
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export SERVER_KEY_PATH="$WORK/server.key" SPOOL_DIR="$WORK/spool" PORT
# Response shapes are validated here rather than on every production call:
# walking a 70 KB payload through a strict zod schema is real CPU, and this
# suite exercises every tool, so drift fails here instead of costing every
# caller. Shared read results are disabled so each assertion sees its own
# write, not a page cached microseconds earlier.
export MCP_VALIDATE=1 READ_CACHE_TTL_MS=0 SNAPSHOT_TTL_MS=0
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
# Production applies schema.sql over an existing deployment. A fresh database
# cannot catch view-column-order and other CREATE OR REPLACE upgrade failures,
# so the contract applies the exact migration a second time before startup.
psql -q -v ON_ERROR_STOP=1 -h "$WORK" -d math -f schema.sql

# A patch is a change to the Lean library, so the pipeline needs a library to
# change. This stands in for /srv/mathlibplus: three modules, one importing
# another, which is enough to exercise applying, rebuild ordering, dangling
# imports, and the commit a promotion produces.
export PATCH_REPO_DIR="$WORK/mathlibplus" PATCH_STATE_DIR="$WORK/patch-work"
export PATCH_BUILD_LIB="$WORK/mathlibplus/.lake/build/lib/lean"
mkdir -p "$PATCH_REPO_DIR/MathlibPlus" "$PATCH_BUILD_LIB"
printf 'theorem alpha : 1 + 1 = 2 := rfl\n' > "$PATCH_REPO_DIR/MathlibPlus/Alpha.lean"
printf 'import MathlibPlus.Alpha\ntheorem beta : 2 + 2 = 4 := rfl\n' > "$PATCH_REPO_DIR/MathlibPlus/Beta.lean"
printf 'theorem gamma : 3 = 3 := rfl\n' > "$PATCH_REPO_DIR/MathlibPlus/Gamma.lean"
printf 'theorem broken : 4 = 5 := rfl\n\n' > "$PATCH_REPO_DIR/MathlibPlus/Broken.lean"
printf '.lake/\n' > "$PATCH_REPO_DIR/.gitignore"   # as in the real repository: build output is not source
# The build tree says what currently builds. Part of the real library does not
# (the umbrella module cannot, and ~1-2% has bit-rotted), and a module with no
# olean is exactly that: Broken has none.
mkdir -p "$PATCH_BUILD_LIB/MathlibPlus"
touch "$PATCH_BUILD_LIB/MathlibPlus/Alpha.olean" "$PATCH_BUILD_LIB/MathlibPlus/Beta.olean" "$PATCH_BUILD_LIB/MathlibPlus/Gamma.olean"
git -C "$PATCH_REPO_DIR" init -q -b main
git -C "$PATCH_REPO_DIR" add -A
git -C "$PATCH_REPO_DIR" -c user.name=contracts -c user.email=c@example.invalid commit -qm "library"

(cd server && bun src/index.ts) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
(cd server && bun verifier/verifier.ts) > "$WORK/verifier.log" 2>&1 &
VERIFIER_PID=$!
SERVER_DEADLINE=$((SECONDS + 30))
until curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; do
  (( SECONDS < SERVER_DEADLINE )) || { echo "server never became healthy" >&2; tail -20 "$WORK/server.log" >&2; exit 1; }
  nap
done

call() { # [AUTH=token] [SESSION=id] call <tool> <json-args> -> result text payload
  curl -sf --max-time 10 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    ${AUTH:+-H "Authorization: Bearer $AUTH"} ${SESSION:+-H "Mcp-Session-Id: $SESSION"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | sed -n 's/^data: //p' | jq -er '.result.content[0].text'
}
new_session() { # -> the Mcp-Session-Id this server hands out at initialize
  curl -sfi --max-time 10 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"contracts","version":"1"}}}' \
    | tr -d '\r' | sed -n 's/^[Mm]cp-[Ss]ession-[Ii]d: //p'
}
browser_call() { # browser_call <origin> <tool> <json-args> -> result text payload
  curl -sf --max-time 10 -X POST "$MCP" \
    -H "Origin: $1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" \
    | sed -n 's/^data: //p' | jq -er '.result.content[0].text'
}
rpc() { # rpc <method> <params-json> -> the whole JSON-RPC result
  curl -sf --max-time 10 -X POST "$MCP" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" \
    | sed -n 's/^data: //p' | jq -er '.result'
}
identity_of() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
field() { jq -cer "$1"; }
fail() {
  echo "FAIL: $1" >&2
  for log in server verifier; do
    [[ -s "$WORK/$log.log" ]] && { echo "--- $log ---" >&2; tail -20 "$WORK/$log.log" >&2; }
  done
  exit 1
}

# Contract: the public site is a real MCP client. Browser POSTs carry Origin,
# unlike curl/CLI traffic; the production hostname and local test origin are
# allowed, while an unrelated website is still refused.
browser_call "$PUBLIC_URL" hello '{}' | field '.welcome' | grep -q lemma.ing || fail "same-origin browser MCP call was rejected"
FOREIGN_STATUS=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$MCP" \
  -H 'Origin: https://unrelated.example' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{}}}')
[[ "$FOREIGN_STATUS" == 403 ]] || fail "foreign browser origin was not rejected: HTTP $FOREIGN_STATUS"

# Contract: an MCP session is an identity. A connection that presents no
# credential at all gets exactly one identity minted for it, handed back once,
# and every contribution over that connection shares it.
SESS=$(new_session)
[[ -n $SESS ]] || fail "server issued no Mcp-Session-Id at initialize"
HI=$(SESSION=$SESS call hello '{"display_name":"contract tester"}')
KEY=$(echo "$HI" | field '.you.contributor_key')
[[ $KEY == mrk_* ]] || fail "session did not mint a contributor key"
SID=$(echo "$HI" | field '.you.identity')
[[ $SID == "$(identity_of "$KEY")" ]] || fail "minted key does not hash to the session identity"
S2=$(SESSION=$SESS call submit '{"kind":"result","title":"session attribution","summary":"s","content":"c."}')
[[ $(echo "$S2" | field '.attributed_to') == "$SID" ]] || fail "second call in the session got a different identity"
echo "$S2" | python3 -c 'import sys,json; assert "your_contributor_key" not in json.load(sys.stdin)' || fail "session minted a second key"

# Contract: contributing needs no identity at all. Unattributed work lands.
ANON=$(call submit '{"kind":"result","title":"anonymous contribution","summary":"s","content":"anon."}')
[[ $(echo "$ANON" | field '.attributed_to') == anonymous ]] || fail "keyless submission was not recorded as anonymous"
AID=$(echo "$ANON" | field '.id')
[[ $(psql -h "$WORK" -d math -tAc "select identity_id is null from contribution where id = '$AID'") == t ]] || fail "anonymous submission invented an identity"
call my_submissions '{}' | field '.error' | grep -qi identity || fail "an identity-scoped tool did not explain itself to an anonymous caller"

# Contract: a credential the server does not recognise fails loudly instead of
# silently attributing someone's work to nobody.
AUTH=mrt_not_a_real_token call submit '{"kind":"result","title":"bad token","summary":"s","content":"c."}' \
  | field '.error' | grep -qi "token" || fail "an unknown access token was silently downgraded to anonymous"

# Contract: a submission is recorded at T0 with a receipt, an event, and a
# queued kernel check when it contains Lean.
SUB=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"test theorem\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem t : 1 + 1 = 2 := rfl\n\`\`\`\"}")
CID=$(echo "$SUB" | field '.id')
[[ $(echo "$SUB" | field '.tier') == 0 ]] || fail "submission did not land at T0"
[[ $(echo "$SUB" | field '.lean_queued') == true ]] || fail "lean content not queued"
echo "$SUB" | field '.receipt.server_signature' > /dev/null || fail "no signed receipt"
EV=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$EV" | field '.events[0].kind') == submitted ]] || fail "no submitted event"

# The runner is a separate sandboxed process; these tests stand in for it.
# Checks are spooled under the hash of their source, which is the whole point:
# it is the same queue entry however the check was asked for.
lean_hash() { sha256sum | cut -d' ' -f1; }
await_spool() { # <hash> -> waits for the runner's input to appear
  await_file "$SPOOL_DIR/in/$1.lean" || fail "verifier never spooled check $1"
}
runner_says() { # <hash> <json> -> answers as the sandboxed runner would
  rm "$SPOOL_DIR/in/$1.lean"
  echo "$2" > "$SPOOL_DIR/out/$1.json"
}
# Waiting is done at the finest granularity the thing being waited on has, and
# in one process. A tenth of a second per poll is invisible to a person and was
# 56 of this suite's 80 seconds: nothing here takes a tenth of a second.
await_file() { # <path> -> true once it exists
  local deadline=$((SECONDS + 20))
  until [[ -e $1 ]]; do
    (( SECONDS < deadline )) || return 1
    nap
  done
}

await_query() { # <scalar select> -> its first non-null, non-empty answer
  # Waited on inside Postgres: one connection, one round trip, and the answer
  # arrives when the writer commits rather than at the next poll.
  # -q: psql prints the DO block's command tag otherwise, and the answer is
  # the last line, not the only one.
  psql -q -h "$WORK" -d math -tAc "
    do \$wait\$ begin
      for _ in 1..4000 loop
        exit when nullif(($1), '') is not null;
        perform pg_sleep(0.005);
      end loop;
    end \$wait\$;
    select ($1)"
}

await_verification() { # <verification id> -> its settled outcome
  await_query "select nullif(outcome, 'pending') from verification where id = $1"
}

# Contract: a passing kernel check flips lean_verified but never the tier.
HASH=$(printf 'import Mathlib\ntheorem t : 1 + 1 = 2 := rfl\n' | lean_hash)
VID=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID'")
await_spool "$HASH"
runner_says "$HASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"t","type":"1 + 1 = 2","axioms":[]}]}'
[[ $(await_verification "$VID") == passed ]] || fail "a clean check did not pass"
GOT=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$GOT" | field '.lean_verified') == true ]] || fail "pass did not set lean_verified"
[[ $(echo "$GOT" | field '.tier') == 0 ]] || fail "verification changed the tier, and it must not"

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
[[ $(echo "$CHECKED" | field '.status') == passed ]] || fail "check_lean did not report the pass: $CHECKED"
[[ $(echo "$CHECKED" | field '.proved[0].statement') == "2 + 2 = 4" ]] || fail "check_lean did not report the statement proven"
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from contribution") == "$BEFORE" ]] || fail "check_lean created a contribution"

# Contract: a check is a pure function of its source, so the second caller
# pays nothing, including when the second caller is a submission.
CACHED=$(call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$CHECK_SRC\"}")
[[ $(echo "$CACHED" | field '.cached') == true ]] || fail "an identical check was not served from cache"
SUB3=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"already checked\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\n$CHECK_SRC\n\`\`\`\"}")
VID3=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$(echo "$SUB3" | field '.id')'")
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
[[ $(echo "$LOOK" | field '.status') == inconclusive ]] || fail "a declaration-free check was not inconclusive: $LOOK"
[[ $(echo "$LOOK" | field '.output') == *"succ_le_succ"* ]] || fail "a declaration-free check did not return Lean's output: $LOOK"
[[ $(echo "$LOOK" | field '.errors') == null ]] || fail "a declaration-free check reported errors it did not have: $LOOK"

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
[[ $(echo "$SORRY" | field '.sorry') == true ]] || fail "check_lean did not report the sorry: $SORRY"
# A proof the kernel accepts because it rests on sorryAx is a hole, and must
# not read as done to someone skimming the status.
HOLE_SRC='theorem still_open : 1 = 1 := by sorry_placeholder'
HHASH=$(printf 'import Mathlib\n\n%s\n' "$HOLE_SRC" | lean_hash)
call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$HOLE_SRC\"}" > "$WORK/hole.out" &
HOLE_JOB=$!
await_spool "$HHASH"
runner_says "$HHASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"still_open","type":"1 = 1","axioms":["sorryAx"]}]}'
wait $HOLE_JOB
[[ $(field '.status' < "$WORK/hole.out") == incomplete ]] || fail "a sorryAx proof was reported as passed: $(cat "$WORK/hole.out")"
SUB4=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"with sorry\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem s : 1 = 1 := by sorry\n\`\`\`\"}")
VID4=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$(echo "$SUB4" | field '.id')'")
[[ $(await_verification "$VID4") == failed ]] || fail "a submission containing sorry was not refused"

# Contract: declarations resting on axioms outside the allowed three fail.
SUB2=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"bad axioms\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\ntheorem u : True := trivial\n\`\`\`\"}")
CID2=$(echo "$SUB2" | field '.id')
HASH2=$(printf 'import Mathlib\ntheorem u : True := trivial\n' | lean_hash)
VID2=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID2'")
await_spool "$HASH2"
runner_says "$HASH2" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"u","type":"True","axioms":["sneakyAxiom"]}]}'
[[ $(await_verification "$VID2") == failed ]] || fail "disallowed axiom was not rejected"

# Contract: a statement is not a proof. `def Q : Prop := …` elaborates cleanly
# and proves nothing, so it is a welcome formalization of an open problem and
# it must not earn lean_verified. check_lean says the same thing by putting it
# under `stated` rather than `proved`.
STATE_SRC='def Q0001 : Prop := ∀ n : ℕ, n + 0 = n'
STHASH=$(printf 'import Mathlib\n\n%s\n' "$STATE_SRC" | lean_hash)
call check_lean "{\"contributor_key\":\"$KEY\",\"source\":\"$STATE_SRC\"}" > "$WORK/stated.out" &
STATE_JOB=$!
await_spool "$STHASH"
runner_says "$STHASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"Q0001","type":"Prop","proof":false,"axioms":[]}]}'
wait $STATE_JOB
STATED=$(cat "$WORK/stated.out")
[[ $(echo "$STATED" | field '.stated[0].name') == Q0001 ]] || fail "a statement was not reported as stated: $STATED"
[[ $(echo "$STATED" | field '.proved') == "[]" ]] || fail "a statement was reported as proved: $STATED"
SUB5=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"formalization\",\"title\":\"statement only\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\n$STATE_SRC\n\`\`\`\"}")
CID5=$(echo "$SUB5" | field '.id')
VID5=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID5'")
[[ $(await_verification "$VID5") == inconclusive ]] || fail "a statement-only submission was judged as a proof"
GOT5=$(call get "{\"ref\":\"$CID5\"}")
[[ $(echo "$GOT5" | field '.lean_verified') == false ]] || fail "a statement-only submission earned lean_verified: $GOT5"
echo "$GOT5" | field '.verifications[0].detail.reason' | grep -q "proves nothing" || fail "the reason did not say what was missing: $GOT5"

# ... while the same file with one thing proved about the statement does earn
# it, and the badge then names only what was actually proven.
BOTH_SRC='def Q0002 : Prop := ∀ n : ℕ, n + 0 = n\ntheorem q0002_holds : Q0002 := fun n => rfl'
SUB6=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"formalization\",\"title\":\"statement and proof\",\"summary\":\"contract test\",\"content\":\"\`\`\`lean\nimport Mathlib\n$BOTH_SRC\n\`\`\`\"}")
CID6=$(echo "$SUB6" | field '.id')
BHASH=$(printf 'import Mathlib\ndef Q0002 : Prop := ∀ n : ℕ, n + 0 = n\ntheorem q0002_holds : Q0002 := fun n => rfl\n' | lean_hash)
VID6=$(psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$CID6'")
await_spool "$BHASH"
runner_says "$BHASH" '{"ok":true,"exit_code":0,"audit_ok":true,"decls":[{"name":"Q0002","type":"Prop","proof":false,"axioms":[]},{"name":"q0002_holds","type":"Q0002","proof":true,"axioms":[]}]}'
[[ $(await_verification "$VID6") == passed ]] || fail "a statement with a proof about it did not pass"
[[ $(call get "{\"ref\":\"$CID6\"}" | field '.lean_verified') == true ]] || fail "a proved statement did not earn lean_verified"

# Contract: the stored lean_verified flag agrees with the verifications it
# summarises, for every row. It is a cache of another table, maintained by
# trigger, and a cache that can silently disagree with its source is worse
# than the subquery it replaced. The first production backfill left five rows
# disagreeing because the verifier kept writing during the pass, so schema.sql
# reconciles on every apply -- this is what proves it.
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from contribution c where c.lean_verified <> exists (select 1 from verification v where v.contribution_id = c.id and v.method = 'lean-kernel' and v.outcome = 'passed')") == 0 ]] \
  || fail "lean_verified disagrees with the verification table"

# Contract: tier changes are trusted-only and land in the event ledger.
DENIED=$(call set_tier "{\"contributor_key\":\"$KEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"x\"}")
echo "$DENIED" | field '.error' | grep -qi trusted || fail "non-trusted was allowed to set tier"
OPKEY="mrk_test_operator"
OPID=$(python3 -c "import hashlib; print(hashlib.sha256(b'$OPKEY').hexdigest())")
psql -q -h "$WORK" -d math -c "insert into identity (id, role) values ('$OPID', 'operator')"
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"reviewed\"}" | field '.ok' > /dev/null
GOT=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$GOT" | field '.tier') == 2 ]] || fail "operator set_tier did not apply"

# Contract: the review queue is a worklist, not a scoreboard. Your own work is
# out (you may not promote it), and so is anything you have already read. What
# somebody *else* read and left undecided stays in, marked, because a reading
# without a verdict is not a decision and entries that collected one used to
# sit at T0 unreachable forever. backlog counts the whole queue rather than the
# page a scheduler happens to have asked for.
RQX=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"conjecture\",\"title\":\"queue subject\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
RQO=$(call submit "{\"contributor_key\":\"$OPKEY\",\"kind\":\"conjecture\",\"title\":\"the reviewer's own conjecture\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
queue() { call review_queue "{\"contributor_key\":\"$OPKEY\",\"kind\":\"conjecture\",\"claim\":false${1:-}}"; }
queued() { python3 -c "import sys,json; d=json.load(sys.stdin); ids=[e['id'] for e in d['unreviewed']]; assert d['backlog']['unreviewed'] == len(ids), d['backlog']; sys.exit(0 if ('\$1' in ids) == ('\$2' == 'in') else 1)"; }
queue "" | queued "$RQX" in || fail "an unreviewed entry was missing from the review queue"
queue "" | queued "$RQO" out || fail "the review queue offered the reviewer their own submission"
queue ',"include_own":true' | queued "$RQO" in || fail "include_own did not bring the reviewer's own work back"
RQR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"review\",\"title\":\"a reading of the queue subject\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$RQR\",\"dst\":\"$RQX\",\"rel\":\"reviews\"}" | field '.edge_id' > /dev/null
queue "" | queued "$RQX" in || fail "someone else's undecided reading hid an entry from the queue"
queue "" | python3 -c "import sys,json; d=json.load(sys.stdin)
row = next(e for e in d['unreviewed'] if e['id'] == '$RQX')
assert row['reviews'] == 1, row
assert d['backlog']['awaiting_decision'] >= 1, d['backlog']" || fail "the queue did not mark an entry as read-but-undecided"
# The reviewer's own reading is what takes it off their list.
RQR2=$(call submit "{\"contributor_key\":\"$OPKEY\",\"kind\":\"review\",\"title\":\"the reviewer's own reading\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
call link "{\"contributor_key\":\"$OPKEY\",\"src\":\"$RQR2\",\"dst\":\"$RQX\",\"rel\":\"reviews\"}" | field '.edge_id' > /dev/null
queue "" | queued "$RQX" out || fail "an entry the reviewer had already read stayed on their list"
queue ',"include_reviewed":true' | queued "$RQX" in || fail "include_reviewed did not bring back what the reviewer had read"
queue ",\"include_reviewed\":true,\"exclude_authors\":[\"$(identity_of "$KEY")\"]" | queued "$RQX" out || fail "exclude_authors did not drop that identity's work"

# ——— Reviewers do not collide ————————————————————————————————————————————
# Contract: the queue hands its rows out under a lease. Two reviewers asking
# at once must get disjoint work, because two readings of one entry produce
# one decision and waste a session — which is exactly what was happening on
# the live ledger. The lease covers adjudication only: nothing here gates
# submit, link, or any research door, since problems are meant to be attacked
# in parallel.
TKEY="mrk_test_second_reviewer"
TID=$(python3 -c "import hashlib; print(hashlib.sha256(b'$TKEY').hexdigest())")
psql -q -h "$WORK" -d math -c "insert into identity (id, role) values ('$TID', 'trusted')"
for i in 1 2 3 4; do
  call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"lease-subject\",\"title\":\"lease subject $i\",\"summary\":\"s\",\"content\":\"c.\"}" > /dev/null
done
lease_queue() { call review_queue "{\"contributor_key\":$1,\"kind\":\"lease-subject\"${2:-}}"; }
ids_of() { python3 -c 'import sys,json; print(" ".join(e["id"] for e in json.load(sys.stdin)["unreviewed"]))'; }
MINE=$(lease_queue "\"$OPKEY\"" ',"limit":2' | ids_of)
THEIRS=$(lease_queue "\"$TKEY\"" ',"limit":2' | ids_of)
[[ -n $MINE && -n $THEIRS ]] || fail "the leased queue handed a reviewer nothing to do"
for m in $MINE; do
  for t in $THEIRS; do
    [[ $m == "$t" ]] && fail "two reviewers were handed the same entry ($m)"
  done
done
LEASED=$(echo "$MINE" | cut -d' ' -f1)
# The holder sees their own claims listed, and asking again renews rather than
# loses them.
lease_queue "\"$OPKEY\"" ',"limit":2' | python3 -c "import sys,json; d=json.load(sys.stdin)
assert '$LEASED' in [c['id'] for c in d['your_claims']], d['your_claims']
assert all(e['claimed_until'] for e in d['unreviewed']), d['unreviewed']" || fail "a reviewer lost sight of what they were holding"
# Another reviewer is told who holds it rather than handed it as well.
call review_claim "{\"contributor_key\":\"$TKEY\",\"refs\":[\"$LEASED\"]}" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['results'][0]; assert r['state']=='held-by-another' and r['holder']=='$OPID', r" \
  || fail "a claimed entry was handed to a second reviewer"
# Contract: a decision ends the lease. This is the release that matters —
# nobody should have to wait out a lease on work that is already decided.
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$LEASED\",\"tier\":1,\"note\":\"confirmed\"}" | field '.ok' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from review_claim where contribution_id = '$LEASED'") == 0 ]] \
  || fail "promoting an entry did not release the review claim on it"
# Releasing by hand gives back work read and left undecided.
HOLD=$(echo "$MINE" | cut -d' ' -f2)
call review_claim "{\"contributor_key\":\"$OPKEY\",\"refs\":[\"$HOLD\"],\"action\":\"release\"}" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['results'][0]; assert r['state']=='released', r" \
  || fail "a reviewer could not hand back what they were holding"
call review_claim "{\"contributor_key\":\"$TKEY\",\"refs\":[\"$HOLD\"]}" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['results'][0]; assert r['state']=='claimed', r" \
  || fail "a released entry was not free for the next reviewer"
# Contract: leases are soft. An agent that dies frees its work by doing
# nothing, so an expired lease is invisible and the entry comes back.
psql -q -h "$WORK" -d math -c "update review_claim set expires_at = now() - interval '1 minute' where contribution_id = '$HOLD'"
lease_queue "\"$OPKEY\"" ',"limit":10' | ids_of | grep -q "$HOLD" || fail "an expired lease still held an entry out of the queue"

# ——— Review can say no ————————————————————————————————————————————————————
# Contract: promotion is not the only exit. "The Riemann Hypothesis is true,
# proof: 1+1=2" must not sit at T0 forever quietly holding a question closed.
# Rejecting takes it out of the active corpus, keeps it readable with its
# reason, and reopens whatever it was claiming to settle.
BOGUS_Q=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"conjecture\",\"title\":\"A hard open question\",\"summary\":\"s\",\"content\":\"Is it so?\"}" | field '.id')
BOGUS_P=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"proof\",\"title\":\"Settling the hard open question\",\"summary\":\"s\",\"content\":\"1 + 1 = 2, therefore yes.\"}" | field '.id')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$BOGUS_P\",\"dst\":\"$BOGUS_Q\",\"rel\":\"proves\"}" | field '.edge_id' > /dev/null
[[ $(call get "{\"ref\":\"$BOGUS_Q\"}" | field '.state') == settled ]] || fail "an asserted proof did not settle its question"
call reject "{\"contributor_key\":\"$KEY\",\"ref\":\"$BOGUS_P\",\"reason\":\"unsupported\",\"note\":\"x\"}" \
  | field '.error' | grep -qi trusted || fail "an untrusted key was allowed to reject"
call reject "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$BOGUS_P\",\"reason\":\"unsupported\",\"note\":\"1+1=2 does not bear on the question.\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok'] and [q['id'] for q in d['reopened']] == ['$BOGUS_Q'], d" \
  || fail "rejecting the proof did not report the question it reopened"
[[ $(call get "{\"ref\":\"$BOGUS_Q\"}" | field '.state') == open ]] || fail "rejecting a bogus proof left its question settled"
[[ $(call get "{\"ref\":\"$BOGUS_P\"}" | field '.status') == rejected ]] || fail "a rejected entry is not readable with its verdict"
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from event where contribution_id = '$BOGUS_P' and kind = 'rejected' and payload->>'reason' = 'unsupported'") == 1 ]] \
  || fail "the rejection did not land in the public event ledger with its reason"
call search "{\"query\":\"Settling the hard open question\"}" | grep -q "$BOGUS_P" \
  && fail "a rejected entry is still offered by search"
# Contract: a review decision is reversed by review. Promoting something that
# was rejected puts it back, so a harsh verdict is not permanent damage.
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$BOGUS_P\",\"tier\":1,\"note\":\"on second reading the argument is real\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok'] and d.get('restored') is True, d" \
  || fail "promoting a rejected entry did not restore it"
[[ $(call get "{\"ref\":\"$BOGUS_P\"}" | field '.status') == active ]] || fail "a restored entry did not come back active"
call reject "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$BOGUS_P\",\"reason\":\"unsupported\",\"note\":\"and back out again\"}" | field '.ok' > /dev/null
# Contract: anyone at all can flag, and it reaches a trusted reviewer. A
# refutation link is the objection; acting on it stays trusted-only.
FLAG_T=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"a result somebody disputes\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
FLAG_O=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"counterexample\",\"title\":\"why that result is wrong\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$FLAG_O\",\"dst\":\"$FLAG_T\",\"rel\":\"refutes\"}" | field '.edge_id' > /dev/null
call review_queue "{\"contributor_key\":\"$OPKEY\",\"claim\":false}" | python3 -c "import sys,json; d=json.load(sys.stdin)
assert any(f['id'] == '$FLAG_T' and f['objection_id'] == '$FLAG_O' for f in d['flagged']), d['flagged']
assert d['backlog']['flagged'] >= 1, d['backlog']" || fail "a public refutation never reached the review queue"

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
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$CID\",\"tier\":2,\"note\":\"scope check\"}" | field '.ok' > /dev/null
# The refresh is finished when the response comes back; what is still moving is
# the statistics view this reads. Wait for it to stop moving rather than for a
# guessed second and a half.
rows_written() { psql -h "$WORK" -d math -tAc "select n_tup_upd from pg_stat_user_tables where relname = 'contribution'"; }
AFTER=$(rows_written)
until [[ $(rows_written) == "$AFTER" ]]; do AFTER=$(rows_written); done
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
  [[ $(field '.ok' < "$f") == true ]] || fail "a concurrent write failed: $(cat "$f")"
done

# A whole-table tuning refresh and a live scoped refresh used to deadlock: the
# former held arbitrary row locks while the latter held its target rows. Full
# refreshes take an exclusive advisory lock; scoped refreshes take its shared
# form before touching rows. Holding the exclusive lock must therefore pause a
# link write rather than letting the two enter the row-lock phase together.
psql -q -h "$WORK" -d math -c "begin; select pg_advisory_xact_lock(hashtext('refresh_notability')); select pg_sleep(0.6); commit" > /dev/null &
LOCK_JOB=$!
# Wait for the lock to actually be held, rather than for long enough that it
# probably is.
until [[ $(psql -h "$WORK" -d math -tAc "select count(*) from pg_locks where locktype = 'advisory'") != 0 ]]; do nap; done
START_MS=$(date +%s%3N)
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$CID\",\"dst\":\"$CID2\",\"rel\":\"repairs\",\"note\":\"full refresh exclusion\"}" | field '.ok' > /dev/null
END_MS=$(date +%s%3N)
wait "$LOCK_JOB"
(( END_MS - START_MS >= 350 )) || fail "a scoped refresh ignored the full-refresh exclusion lock"

echo "$GOT" | python3 -c 'import sys,json; evs=[e["kind"] for e in json.loads(sys.stdin.read())["events"]]; assert "tier-changed" in evs' || fail "no tier-changed event"

# Contract: trails are visible where the work happens and never block anyone.
T=$(call trail "{\"contributor_key\":\"$KEY\",\"title\":\"exploring the test theorem\",\"note\":\"starting out\",\"relates_to\":[\"$CID\"]}")
TID=$(echo "$T" | field '.trail_id')
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$TID\",\"note\":\"found a reduction\"}" | field '.ok' > /dev/null
GOT=$(call get "{\"ref\":\"$CID\"}")
[[ $(echo "$GOT" | field '.exploring_now[0].latest_note') == "found a reduction" ]] || fail "trail not surfaced on get"
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$TID\",\"note\":\"wrapping up without an established claim\",\"close\":true,\"outcome\":\"no-result\"}" | field '.status' | grep -q closed || fail "close failed"
GOT=$(call get "{\"ref\":\"$CID\"}")
echo "$GOT" | python3 -c 'import sys,json; assert not json.loads(sys.stdin.read()).get("exploring_now")' || fail "closed trail still shown as active"
FULL=$(call trails "{\"trail_id\":\"$TID\"}")
[[ $(echo "$FULL" | field '.activity') == closed ]] || fail "trail history wrong"

# Contract: an established obstruction is a durable route contribution, not
# only trail prose. The route must name its attacked question, state, and exact
# first unsupported step; frontier then exposes that step directly.
OBQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"obstruction contract question\",\"summary\":\"a question for the route contract\",\"content\":\"Does the route close?\"}" | field '.id')
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"route\",\"title\":\"underspecified blocked route\",\"summary\":\"missing the exact blocker\",\"content\":\"The argument stops.\",\"state\":\"blocked\",\"relates_to\":[{\"id\":\"$OBQ\",\"rel\":\"attacks\"}]}" \
  | field '.error' | grep -q first_unsupported || fail "a blocked route hid its obstruction in prose"
OBR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"route\",\"title\":\"durable blocked route\",\"summary\":\"the exact obstruction\",\"content\":\"The reduction needs an injective map, but the constructed map has a two-point fibre.\",\"state\":\"blocked\",\"first_unsupported\":\"Prove the constructed map is injective; its displayed fibre contains two points.\",\"relates_to\":[{\"id\":\"$OBQ\",\"rel\":\"attacks\"}]}" | field '.id')
OBT=$(call trail "{\"contributor_key\":\"$KEY\",\"title\":\"blocked route diary\",\"note\":\"trying the injectivity route\",\"relates_to\":[\"$OBQ\"]}" | field '.trail_id')
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$OBT\",\"note\":\"blocked\",\"close\":true,\"outcome\":\"blocked\"}" \
  | field '.error' | grep -q "durable kind='route'" || fail "a blocked trail closed without a durable route"
call trail "{\"contributor_key\":\"$KEY\",\"trail_id\":\"$OBT\",\"note\":\"blocked at injectivity; durable route attached\",\"relates_to\":[\"$OBR\"],\"close\":true,\"outcome\":\"blocked\"}" | field '.status' | grep -q closed || fail "a blocked trail did not accept its durable route"
OBF=$(call frontier "{\"ref\":\"$OBQ\"}")
[[ $(echo "$OBF" | field '.routes[0].id') == "$OBR" ]] || fail "durable route missing from frontier"
[[ $(echo "$OBF" | field '.where_routes_stall[0].stalls_at') == "Prove the constructed map is injective; its displayed fibre contains two points." ]] || fail "frontier hid the route's first unsupported step"
[[ $(echo "$OBF" | field '.already_tried[0].outcome') == blocked ]] || fail "closed trail lost its explicit outcome"

# Contract: an open trail idle past the freshness window is abandoned, hidden
# from the default listing so it warns no one off, but visible with include_stale.
ST=$(call trail "{\"contributor_key\":\"$KEY\",\"title\":\"stale exploration\",\"note\":\"start\"}" | field '.trail_id')
psql -q -h "$WORK" -d math -c "update trail set updated_at = now() - interval '3 hours' where id = '$ST'" > /dev/null
call trails '{}' | python3 -c 'import sys,json;ts=json.load(sys.stdin)["trails"];assert all(t["id"]!="'"$ST"'" for t in ts)' || fail "stale trail shown in default listing"
call trails '{"include_stale":true}' | python3 -c 'import sys,json;ts=json.load(sys.stdin)["trails"];assert any(t["id"]=="'"$ST"'" and t["activity"]=="stale" for t in ts)' || fail "include_stale did not surface the abandoned trail"

# Contract: search is dash/accent-insensitive and degrades to fuzzy, so a
# hyphen query finds an en-dash title (the de Bruijn–Newman discovery failure).
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"de Bruijn–Newman upper bound 0.2\",\"summary\":\"a certified bound\",\"content\":\"Lambda le 0.2.\"}" > /dev/null
HITS=$(call search '{"query":"de Bruijn-Newman constant"}' | field '.results' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[[ "$HITS" -ge 1 ]] || fail "dash/fuzzy search found nothing"

# Contract: search can bound a rolling activity window. This is the public
# live page's data door, so both text search and browse mode must agree on it.
OLD=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"old window marker\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
NEW=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"fresh window marker\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
psql -q -h "$WORK" -d math -c "update contribution set created_at = now() - interval '25 hours' where id = '$OLD'"
WINDOW=$(call search '{"kind":"theorem","since":"24h","order_by":"recent","limit":100}')
echo "$WINDOW" | OLD="$OLD" NEW="$NEW" python3 -c '
import os,sys,json
ids={r["id"] for r in json.load(sys.stdin)["results"]}
assert os.environ["NEW"] in ids and os.environ["OLD"] not in ids
' || fail "browse-mode since window included old work or omitted fresh work"
call search '{"query":"window marker","since":"24h"}' | OLD="$OLD" NEW="$NEW" python3 -c '
import os,sys,json
ids={r["id"] for r in json.load(sys.stdin)["results"]}
assert os.environ["NEW"] in ids and os.environ["OLD"] not in ids
' || fail "text-search since window disagreed with browse mode"
call search '{"since":"yesterday-ish"}' | field '.error' | grep -qi "invalid since" || fail "invalid since value was accepted"

# Contract: a typed link is itself a contribution (kind='edge'), appears in the
# target's neighbourhood, and lifts notability toward the thing built upon.
A=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"lemma A\",\"summary\":\"s\",\"content\":\"A.\"}" | field '.id')
B=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"thm B\",\"summary\":\"s\",\"content\":\"B via A.\",\"relates_to\":[{\"id\":\"$A\",\"rel\":\"uses\"}]}" | field '.id')
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from contribution where kind='edge'") -ge 1 ]] || fail "link was not recorded as a contribution"
call get "{\"ref\":\"$A\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(x for xs in d["links"]["in"].values() for x in xs)' || fail "link not in neighbourhood"
NA=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$A'")
python3 -c "assert float('$NA')>0" || fail "notability not derived for a contribution built upon"

# Multiple identities may corroborate one relation, but graph importance reads
# the strongest active assertion rather than letting duplicate links multiply
# a score. A stronger reviewed copy may replace the T0 copy's weight.
DUP=$(call link "{\"contributor_key\":\"$OPKEY\",\"src\":\"$B\",\"dst\":\"$A\",\"rel\":\"uses\",\"note\":\"independent assertion\"}" | field '.edge_id')
NA_DUP=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$A'")
[[ "$NA_DUP" == "$NA" ]] || fail "a duplicate active relation multiplied notability ($NA -> $NA_DUP)"
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$DUP\",\"tier\":2,\"note\":\"reviewed relation\"}" | field '.ok' > /dev/null
NA_STRONG=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$A'")
python3 -c "assert float('$NA_STRONG') > float('$NA_DUP')" || fail "the strongest reviewed relation did not replace the T0 relation's weight"

# Settlement importance uses the same trust semantics. An unreviewed answer
# earns only the T0 edge factor, promotion strengthens it, and the vague
# 'serves' relation earns no settlement credit at all.
IQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"importance target\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$IQ\",\"tier\":2,\"note\":\"canonical target\"}" > /dev/null
IR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"importance answer\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
IE=$(call link "{\"contributor_key\":\"$KEY\",\"src\":\"$IR\",\"dst\":\"$IQ\",\"rel\":\"answers\"}" | field '.edge_id')
IR_T0=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$IR'")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$IE\",\"tier\":2,\"note\":\"confirmed answer relation\"}" > /dev/null
IR_T2=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$IR'")
python3 -c "assert float('$IR_T2') > float('$IR_T0')" || fail "settlement credit ignored the answer edge tier"
IS=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"importance servant\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
IS_BEFORE=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$IS'")
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$IS\",\"dst\":\"$IQ\",\"rel\":\"serves\"}" > /dev/null
IS_AFTER=$(psql -h "$WORK" -d math -tAc "select notability from contribution where id='$IS'")
[[ "$IS_AFTER" == "$IS_BEFORE" ]] || fail "serves relation received settlement credit ($IS_BEFORE -> $IS_AFTER)"

# Contract: trusted promotion of a link (edges climb the same ladder).
EID=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where dst='$A' limit 1")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$EID\",\"tier\":2,\"note\":\"confirmed link\"}" | field '.ok' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select tier from contribution where id='$EID'") == 2 ]] || fail "edge did not promote"

# Contract: submissions are auto-tagged with subject topics (submit wiring to
# the shared classifier) and topic is a search facet.
DBN=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"Riemann zeta zero de Bruijn Newman\",\"summary\":\"analytic bound\",\"content\":\"On the critical line.\"}" | field '.id')
[[ $(psql -h "$WORK" -d math -tAc "select 'analytic-number-theory' = any(tags) from contribution where id='$DBN'") == t ]] || fail "submission was not topic-tagged"
call search '{"topic":"analytic-number-theory"}' | python3 -c 'import sys,json;assert len(json.load(sys.stdin)["results"])>=1' || fail "topic search facet empty"

# Contract: a front groups work and its members surface (fronts read tool).
FR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"front\",\"title\":\"test front\",\"summary\":\"s\",\"content\":\"grouping.\"}" | field '.id')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$A\",\"dst\":\"$FR\",\"rel\":\"in-front\"}" | field '.ok' > /dev/null
call fronts "{\"ref\":\"$FR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(m["id"] for ms in d["members_by_kind"].values() for m in ms)' || fail "front member not surfaced"

# Contract: programmes nest, and both directions are visible. A campaign front
# is part-of the broader front that covers it; a reader landing on either must
# be able to walk to the other.
SUBFR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"front\",\"title\":\"test campaign\",\"summary\":\"s\",\"content\":\"one campaign.\"}" | field '.id')
call link "{\"contributor_key\":\"$KEY\",\"src\":\"$SUBFR\",\"dst\":\"$FR\",\"rel\":\"part-of\"}" | field '.ok' > /dev/null
call fronts "{\"ref\":\"$FR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["sub_programmes"][0]["id"]=="'"$SUBFR"'"' || fail "umbrella front does not list its campaigns"
call fronts "{\"ref\":\"$SUBFR\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["part_of"][0]["id"]=="'"$FR"'"' || fail "campaign front does not name its umbrella"


# Contract: a list row does not echo the title back as its summary. Titles cut
# from the opening of a write-up make the two identical, which is pure noise in
# a page of results.
ECHO=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"echoing title zqx\",\"summary\":\"echoing title zqx\",\"content\":\"echoing title zqx\"}" | field '.id')
call search '{"kind":"problem"}' | python3 -c 'import sys,json;rs=json.load(sys.stdin)["results"];r=[x for x in rs if x["id"]=="'"$ECHO"'"][0];assert "summary" not in r, r' || fail "list row echoed the title as its summary"
call get "{\"ref\":\"$ECHO\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert "summary" not in d and d["content"]' || fail "get echoed the title as its summary"

# Contract: an alias resolves anywhere a ref is taken, even when the title differs.
RN=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"obscure internal title zzq\",\"summary\":\"s\",\"content\":\"c.\",\"names\":[\"Kolmogorov width marker\"]}" | field '.id')
call get '{"ref":"Kolmogorov width marker"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["matched_by"]=="name" and d["id"]=="'"$RN"'"' || fail "alias ref did not find the entry"

# Contract: frontier distills a question's attack state from the graph.
Q=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"frontier test question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
SQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"sub-question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
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
[[ $(call frontier "{\"ref\":\"$Q\"}" | field '.state') == open ]] || fail "fresh problem was not open"
call search '{"kind":"problem","state":"open"}' | python3 -c 'import sys,json;assert any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "open problem missing from the open list"
ANS=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"settles the sub-question\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$SQ\",\"rel\":\"answers\"}]}" | field '.id')
SQF=$(call frontier "{\"ref\":\"$SQ\"}")
[[ $(echo "$SQF" | field '.state') == settled ]] || fail "answered problem did not become settled"
echo "$SQF" | python3 -c 'import sys,json;assert any(a["id"]=="'"$ANS"'" for a in json.load(sys.stdin)["answered_by"])' || fail "frontier did not name what settled the question"
call search '{"kind":"problem","state":"open"}' | python3 -c 'import sys,json;assert not any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "settled problem still listed as open"
# A live T0 closure changes ordinary state immediately, but a reviewed record
# can require a reviewed settling link. This keeps an unreviewed partial answer
# out of public all-time rankings without hiding it from the frontier.
call search '{"kind":"problem","state":"settled","settled_by_min_tier":2,"limit":100}' | python3 -c 'import sys,json;assert not any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "T0 closure entered a T2 settlement browse"
ANS_EDGE=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where src='$ANS' and dst='$SQ' and rel='answers'")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$ANS_EDGE\",\"tier\":2,\"note\":\"reviewed settling link\"}" > /dev/null
call search '{"kind":"problem","state":"settled","settled_by_min_tier":2,"limit":100}' | python3 -c 'import sys,json;assert any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "T2 closure missing from a T2 settlement browse"
# Contract: a settled question on a browse page names what settled it, so an
# all-time board can show the closure rather than just a closed question.
call search '{"kind":["problem","conjecture"],"state":"settled","order_by":"notability","limit":100}' \
  | python3 -c 'import sys,json;rows=[r for r in json.load(sys.stdin)["results"] if r["id"]=="'"$SQ"'"];assert rows and any(s["id"]=="'"$ANS"'" and s["title"] for s in rows[0]["settled_by"])' \
  || fail "settled browse row did not carry settled_by"
# Contract: settling a question and being first to settle it are different
# facts. An entry whose headline claim was established outside this ledger is
# origin='external' with a source; it still closes the question and still shows
# up everywhere the question does, but it is not what this ledger established
# first, so the all-time board (settled_by_origin='ledger') drops the question.
XQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"question closed by a published paper\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
XA=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"statement\",\"title\":\"the published counterexample, recorded here\",\"summary\":\"s\",\"content\":\"c.\",\"external_source\":\"Freedman-Lee, arXiv:2607.23423, Thm 1.3\",\"relates_to\":[{\"id\":\"$XQ\",\"rel\":\"disproves\"}]}" | field '.id')
call get "{\"ref\":\"$XA\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["origin"]=="external" and "2607.23423" in d["origin_source"]' || fail "external_source did not record an external origin"
call search '{"kind":"statement","origin":"external","limit":100}' | python3 -c 'import sys,json;rows=[r for r in json.load(sys.stdin)["results"] if r["id"]=="'"$XA"'"];assert rows and rows[0]["origin"]=="external" and rows[0]["origin_source"]' || fail "origin filter did not find the external entry"
call search '{"kind":"statement","origin":"ledger","limit":100}' | python3 -c 'import sys,json;assert not any(r["id"]=="'"$XA"'" for r in json.load(sys.stdin)["results"])' || fail "external entry appeared in a ledger-origin browse"
X_EDGE=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where src='$XA' and dst='$XQ' and rel='disproves'")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$X_EDGE\",\"tier\":2,\"note\":\"the citation checks out\"}" > /dev/null
call search '{"kind":"problem","state":"settled","settled_by_min_tier":2,"limit":100}' | python3 -c 'import sys,json;rows=[r for r in json.load(sys.stdin)["results"] if r["id"]=="'"$XQ"'"];assert rows and rows[0]["settled_by"][0]["origin"]=="external"' || fail "a settled question did not show that what settled it came from elsewhere"
call search '{"kind":"problem","state":"settled","settled_by_min_tier":2,"settled_by_origin":"ledger","limit":100}' | python3 -c 'import sys,json;assert not any(r["id"]=="'"$XQ"'" for r in json.load(sys.stdin)["results"])' || fail "externally settled question entered the ledger-origin board"
call search '{"kind":"problem","state":"settled","settled_by_origin":"external","limit":100}' | python3 -c 'import sys,json;assert any(r["id"]=="'"$XQ"'" for r in json.load(sys.stdin)["results"])' || fail "externally settled question missing from an external-settlement browse"
[[ $(call frontier "{\"ref\":\"$XQ\"}" | field '.state') == settled ]] || fail "an external closure did not settle the question"

# Contract: origin is a reviewed judgment, so review can correct it, only a
# trusted key may, an external origin without a source is refused, and the
# decision reports which questions it just took off the all-time board.
call set_origin "{\"contributor_key\":\"$KEY\",\"ref\":\"$ANS\",\"origin\":\"external\",\"source\":\"someone else\",\"note\":\"n\"}" | field '.error' | grep -qi "trusted" || fail "an untrusted key changed an origin"
call set_origin "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$ANS\",\"origin\":\"external\",\"note\":\"n\"}" | field '.error' | grep -qi "source" || fail "an external origin was accepted with no source"
call set_origin "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$ANS\",\"origin\":\"external\",\"source\":\"Some Author, J. Example 12 (1999) 3-4\",\"note\":\"already in the literature\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["ok"] and any(q["id"]=="'"$SQ"'" for q in d["left_the_board"])' || fail "set_origin did not report the question it took off the board"
call search '{"kind":"problem","state":"settled","settled_by_origin":"ledger","limit":100}' | python3 -c 'import sys,json;assert not any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "a reviewed external origin did not leave the ledger-origin board"
call set_origin "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$ANS\",\"origin\":\"ledger\",\"note\":\"misattributed; this argument is ours\"}" | field '.ok' > /dev/null
call search '{"kind":"problem","state":"settled","settled_by_origin":"ledger","limit":100}' | python3 -c 'import sys,json;assert any(r["id"]=="'"$SQ"'" for r in json.load(sys.stdin)["results"])' || fail "restoring ledger origin did not put the question back on the board"

call retract "{\"contributor_key\":\"$KEY\",\"ref\":\"$ANS\",\"note\":\"withdrawn\"}" | field '.ok' > /dev/null
[[ $(call frontier "{\"ref\":\"$SQ\"}" | field '.state') == open ]] || fail "retracting the answer did not reopen the question"

# ——— A theory is an object, not a document ———————————————————————————————
# The family only earns its keep if a framework can be recorded once and used
# by someone who never read it: the vocabulary has to be resolvable by name,
# the dictionary has to be rows rather than prose, and a reviewed equivalent
# reformulation has to actually make two questions one question. All three are
# checked end to end here, including the review gate that stops anyone from
# closing the corpus by asserting equivalences.
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theory\",\"title\":\"a framework with no stated scope\",\"summary\":\"s\",\"content\":\"c.\"}" \
  | field '.error' | grep -qi "applies_to" || fail "a theory was accepted without saying what it applies to"
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"not a theory\",\"summary\":\"s\",\"content\":\"c.\",\"applies_to\":\"everything\"}" \
  | field '.error' | grep -qi "belongs on" || fail "a theory-only field was accepted on another kind"

THEORY=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theory\",\"title\":\"contract theory of widget extensions\",\"summary\":\"s\",\"content\":\"c.\",\"applies_to\":\"finite widget extensions W/V\",\"introduces\":[{\"term\":\"widget group\",\"statement\":\"The automorphisms of W fixing V.\",\"names\":[\"Wid(W/V)\"]},{\"term\":\"widget-solvable\",\"statement\":\"Built from a tower of widget radicals.\"}]}")
echo "$THEORY" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["introduced"])==2 and all(x["id"] for x in d["introduced"])' \
  || fail "a theory did not mint its vocabulary: $(echo "$THEORY" | head -c 300)"
THEORY=$(echo "$THEORY" | field '.id')
# The point of minting them: an agent who never read the write-up can ask for
# the concept by the name it was introduced under.
call get '{"ref":"Wid(W/V)"}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["kind"]=="definition" and d["matched_by"]=="name"' \
  || fail "a minted definition was not resolvable by its alias"

call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"correspondence\",\"title\":\"dictionary with no rows\",\"summary\":\"s\",\"content\":\"c.\",\"via\":\"$THEORY\",\"applies_to\":\"a\",\"transports_to\":\"b\",\"fidelity\":\"equivalence\"}" \
  | field '.error' | grep -qi "dictionary" || fail "a correspondence was accepted with no dictionary rows"
PILLAR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"the widget correspondence theorem\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
CORR=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"correspondence\",\"title\":\"the fundamental widget dictionary\",\"summary\":\"s\",\"content\":\"c.\",\"via\":\"$THEORY\",\"applies_to\":\"intermediate widgets of W/V\",\"transports_to\":\"subgroups of Wid(W/V)\",\"fidelity\":\"equivalence\",\"dictionary\":[{\"source\":\"intermediate widget U\",\"target\":\"subgroup H\",\"note\":\"inclusion-reversing\",\"proof\":\"the widget correspondence theorem\"},{\"source\":\"degree [U:V]\",\"target\":\"index [G:H]\"}]}" | field '.id')
# A row's proof is stored as the id it resolved to, not the phrase that was
# typed, and it is a link the graph can see.
psql -h "$WORK" -d math -tAc "select count(*) from q_dictionary where correspondence_id = '$CORR'" | grep -q '^2$' \
  || fail "the dictionary did not unfold into rows"
[[ $(psql -h "$WORK" -d math -tAc "select proof from q_dictionary where correspondence_id = '$CORR' and row_no = 1") == "$PILLAR" ]] \
  || fail "a dictionary row's proof was not resolved to an id"
psql -h "$WORK" -d math -tAc "select count(*) from edge where src = '$CORR' and dst = '$PILLAR' and rel = 'rests-on'" | grep -q '^1$' \
  || fail "a proved dictionary row did not record a rests-on link"
call theories "{\"ref\":\"contract theory of widget extensions\"}" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["applies_to"].startswith("finite widget"), d["applies_to"]
assert len(d["vocabulary"]) == 2 and all(v["statement"] for v in d["vocabulary"])
rows = d["dictionaries"][0]["rows"]
assert len(rows) == 2 and rows[0]["source"] and rows[0]["target"], rows
' || fail "theories did not serve the framework's vocabulary and dictionary"

# Contract: a reformulation needs all three of what it restates, what it
# restated it through, and how faithful the restatement is.
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"reformulation\",\"title\":\"a restatement out of nowhere\",\"summary\":\"s\",\"content\":\"c.\"}" \
  | field '.error' | grep -qi "reformulates" || fail "a reformulation was accepted with nothing to reformulate"
WQ1=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"is every widget extension solvable\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"reformulation\",\"title\":\"restated with a made-up fidelity\",\"summary\":\"s\",\"content\":\"c.\",\"reformulates\":\"$WQ1\",\"via\":\"$THEORY\",\"fidelity\":\"probably\"}" \
  | field '.error' | grep -qi "fidelity" || fail "a reformulation was accepted with an undeclared fidelity"

REF=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"reformulation\",\"title\":\"is every widget group solvable\",\"summary\":\"s\",\"content\":\"c.\",\"reformulates\":\"$WQ1\",\"via\":\"$THEORY\",\"fidelity\":\"equivalent\"}" | field '.id')
WANS=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"every widget group is solvable\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$REF\",\"rel\":\"answers\"}]}" | field '.id')
# Asserted, not reviewed: nothing transports. Otherwise anyone could close
# every open question in the corpus by claiming an equivalence.
[[ $(call frontier "{\"ref\":\"$WQ1\"}" | field '.state') == open ]] \
  || fail "an unreviewed equivalence settled a question"
REF_EDGE=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where src='$REF' and dst='$WQ1' and rel='reformulates'")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$REF\",\"tier\":2,\"note\":\"the translation checks out\"}" > /dev/null
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$REF_EDGE\",\"tier\":2,\"note\":\"and so does the link\"}" > /dev/null
WF=$(call frontier "{\"ref\":\"$WQ1\"}")
echo "$WF" | WANS="$WANS" REF="$REF" python3 -c '
import os, sys, json
d = json.load(sys.stdin)
assert d["state"] == "settled", "a reviewed equivalence did not carry the settlement home"
assert not d["answered_by"], "nothing answers this question directly"
through = d["settled_through"]
assert any(t["through"]["id"] == os.environ["REF"] and t["answered_by"]["id"] == os.environ["WANS"] for t in through), through
assert "equivalence" in d["stands"], d["stands"]
assert any(r["id"] == os.environ["REF"] and r["transports_settlement"] for r in d["reformulations"])
' || fail "frontier did not explain a transported settlement: $(echo "$WF" | head -c 400)"
call theories "{\"for\":\"$WQ1\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);t=d["transported"];assert t and t[0]["transports_settlement"] and t[0]["via"]' \
  || fail "theories({for}) did not report the transport"
# And it is as reversible as any other settlement.
call retract "{\"contributor_key\":\"$KEY\",\"ref\":\"$WANS\",\"note\":\"withdrawn\"}" > /dev/null
[[ $(call frontier "{\"ref\":\"$WQ1\"}" | field '.state') == open ]] \
  || fail "withdrawing the answer left the transported settlement standing"

# Contract: a one-directional restatement is progress, never a closure, at any
# tier. This is the difference the fidelity field exists to record.
WQ2=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"is every widget extension tame\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
REF2=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"reformulation\",\"title\":\"a sufficient widget-group condition for tameness\",\"summary\":\"s\",\"content\":\"c.\",\"reformulates\":\"$WQ2\",\"via\":\"$THEORY\",\"fidelity\":\"implies\"}" | field '.id')
REF2_EDGE=$(psql -h "$WORK" -d math -tAc "select contribution_id from edge where src='$REF2' and dst='$WQ2' and rel='reformulates'")
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$REF2\",\"tier\":2,\"note\":\"correct, but one way\"}" > /dev/null
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$REF2_EDGE\",\"tier\":2,\"note\":\"n\"}" > /dev/null
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"the sufficient condition holds\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$REF2\",\"rel\":\"answers\"}]}" > /dev/null
[[ $(call frontier "{\"ref\":\"$WQ2\"}" | field '.state') == open ]] \
  || fail "a one-directional reformulation closed the question it only implies"

# Contract: the same transport rule reads a bare equivalence link, so two
# questions already in the corpus can be identified without a write-up.
EQ1=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"the widget parity question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
EQ2=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"the gadget parity question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
EQ_EDGE=$(call link "{\"contributor_key\":\"$KEY\",\"src\":\"$EQ1\",\"dst\":\"$EQ2\",\"rel\":\"equivalent-to\",\"note\":\"same question in two vocabularies\"}" | field '.edge_id')
call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"gadget parity, resolved\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$EQ2\",\"rel\":\"answers\"}]}" > /dev/null
[[ $(call frontier "{\"ref\":\"$EQ1\"}" | field '.state') == open ]] || fail "a T0 equivalence link transported a settlement"
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$EQ_EDGE\",\"tier\":2,\"note\":\"the identification is right\"}" > /dev/null
[[ $(call frontier "{\"ref\":\"$EQ1\"}" | field '.state') == settled ]] \
  || fail "a reviewed equivalence link did not identify the two questions"

# Contract: news is a cursor, not a clock. A reader hands back the sequence
# number it was given and gets exactly the events it has not seen -- no
# interval to guess, no double-read, no gap -- and the packet carries the
# custody vocabulary a summary must preserve.
CUR=$(call news '{"since":"1h"}' | field '.next.after_seq')
NQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"news test question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
NA=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"settles the news question\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$NQ\",\"rel\":\"answers\"}]}" | field '.id')
# A settlement asserted and then withdrawn inside one window is not news that a
# question closed, so this second pair must never reach `settled`.
WQ=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"withdrawn-answer question\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
WA=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"withdrawn answer\",\"summary\":\"s\",\"content\":\"c.\",\"relates_to\":[{\"id\":\"$WQ\",\"rel\":\"answers\"}]}" | field '.id')
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
CUR2=$(echo "$NEWS" | field '.next.after_seq')
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
  [[ $(call "${door%% *}" "${door#* }" | field '.title') == "named cell" ]] || fail "${door%% *} did not accept a name"
done
[[ $(call fronts '{"ref":"test front"}' | field '.title') == "test front" ]] || fail "fronts did not accept a title"

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
[[ $(call get '{"ref":"long summary entry"}' | field '.content' | wc -c) -gt 1000 ]] || fail "get did not return the full content"

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

# Contract: hello carries the census the live page shows -- the review ladder
# over entries, and entries and links counted apart, since a link is a
# contribution on the same ladder but not a thing anyone means by "entries".
call hello '{}' | python3 -c '
import sys,json
w=json.load(sys.stdin)["what_is_here"]
tiers={r["tier"]: r["n"] for r in w["by_tier"]}
assert sum(tiers.values()) == w["totals"]["entries"], (tiers, w["totals"])
assert w["totals"]["links"] > 0
' || fail "hello census does not add up"

# Contract: a contributor key may arrive as an Authorization: Bearer header
# instead of a per-call argument, a per-call argument wins over it, and the
# header carries role gates too.
HELLO=$(AUTH=$KEY call hello '{}')
[[ $(echo "$HELLO" | field '.you.identity') == "$SID" ]] || fail "header key did not resolve to its identity"
[[ $(echo "$HELLO" | field '.you.via') == key ]] || fail "header key was not reported as the credential in use"
MINE=$(AUTH=$KEY call my_submissions '{}' | field '.submissions' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[[ "$MINE" -ge 1 ]] || fail "header identity did not see its own submissions"
OPID2=$(AUTH=$OPKEY call hello "{\"contributor_key\":\"$KEY\"}" | field '.you.identity')
[[ "$OPID2" == "$SID" ]] || fail "per-call contributor_key did not win over the header"
HDRT=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"header gate target\",\"summary\":\"s\",\"content\":\"c.\"}" | field '.id')
AUTH=$OPKEY call set_tier "{\"ref\":\"$HDRT\",\"tier\":2,\"note\":\"reviewed via header\"}" | field '.ok' > /dev/null
[[ $(psql -h "$WORK" -d math -tAc "select tier from contribution where id='$HDRT'") == 2 ]] || fail "operator header did not pass the trusted gate"

# Contract: OAuth is a complete, accountless path to an identity -- the one
# MCP clients already know how to walk. Register, authorize, exchange with
# PKCE, and the token that comes out is a durable identity with no signup.
DISC=$(curl -sf "$PUBLIC_URL/.well-known/oauth-protected-resource")
[[ $(echo "$DISC" | field '.authorization_servers[0]') == "$PUBLIC_URL" ]] || fail "protected-resource metadata does not point at this server"
curl -sf "$PUBLIC_URL/.well-known/oauth-authorization-server" | field '.token_endpoint' > /dev/null || fail "no authorization-server metadata"

REG=$(curl -sf -X POST "$PUBLIC_URL/oauth/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"contract client","redirect_uris":["http://127.0.0.1:9999/callback"]}')
OACID=$(echo "$REG" | field '.client_id')
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
  | field '.error' | grep -q invalid_grant || fail "PKCE verification is not enforced"
CODE=$(authorize_code)
TOKEN=$(curl -sf -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$CODE" --data-urlencode "client_id=$OACID" --data-urlencode "code_verifier=$VERIFIER" | field '.access_token')
[[ $TOKEN == mrt_* ]] || fail "authorization code did not exchange for a token"
OAID=$(AUTH=$TOKEN call submit '{"kind":"result","title":"oauth attribution","summary":"s","content":"c."}' | field '.attributed_to')
[[ $OAID != anonymous ]] || fail "an OAuth token did not attribute the contribution"
[[ $(AUTH=$TOKEN call hello '{}' | field '.you.identity') == "$OAID" ]] || fail "OAuth identity is not stable across calls"

# Contract: a headless client with no browser can still be someone.
MREG=$(curl -sf -X POST "$PUBLIC_URL/oauth/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"machine","grant_types":["client_credentials"]}')
MID=$(echo "$MREG" | field '.client_id'); MSECRET=$(echo "$MREG" | field '.client_secret')
machine_token() {
  curl -sf -X POST "$PUBLIC_URL/oauth/token" --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$MID" --data-urlencode "client_secret=$MSECRET" | field '.access_token'
}
MID1=$(AUTH=$(machine_token) call hello '{}' | field '.you.identity')
[[ $(AUTH=$(machine_token) call hello '{}' | field '.you.identity') == "$MID1" ]] || fail "client_credentials identity is not stable across tokens"

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
HUB=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"hub target\",\"summary\":\"s\",\"content\":\"hub.\"}" | field '.id')
for i in $(seq 1 10); do
  SPOKE=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"theorem\",\"title\":\"spoke $i\",\"summary\":\"s\",\"content\":\"spoke $i.\"}" | field '.id')
  call link "{\"contributor_key\":\"$KEY\",\"src\":\"$SPOKE\",\"dst\":\"$HUB\",\"rel\":\"uses\",\"note\":\"n\"}" > /dev/null
done
call get "{\"ref\":\"$HUB\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["links"]["in"]["uses"])==8 and d["links"]["more"]["in"]["uses"]==2, json.dumps(d["links"].get("more"))' || fail "neighbourhood cap did not hold"
call get "{\"ref\":\"$HUB\",\"rel\":\"uses\",\"links_offset\":8}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert len(d["links"]["in"]["uses"])==2 and "more" not in d["links"], json.dumps(d["links"])' || fail "rel paging did not reach the hidden rows"

# Contract: filter-only search (no query) lists by importance and reports the
# total beyond the page.
call search '{"kind":"theorem","limit":1}' | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["total"]>=2 and len(d["results"])==1 and d.get("next"), d.get("total")' || fail "browse-mode search total/next wrong"

PROPOSAL=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"refactor\",\"title\":\"proposal\",\"summary\":\"s\",\"content\":\"c.\",\"supersedes\":[\"$SQ\"]}" | field '.id')

# Contract: presentation changes are contributions, not privileged silent
# edits. A T0 amendment leaves the target untouched, appears in the reviewer
# queue, and only apply_amendment changes it. The event preserves both sides.
EDIT_TARGET=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"problem\",\"title\":\"opaque task title\",\"summary\":\"opaque summary\",\"content\":\"The mathematical body stays immutable.\",\"names\":[\"old alias\"]}" | field '.id')
AMENDMENT=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"amendment\",\"title\":\"Clarify the opaque task\",\"summary\":\"A reader-facing correction.\",\"content\":\"The new title states the question.\",\"amends\":\"$EDIT_TARGET\",\"replacement\":{\"title\":\"Does the presentation amendment preserve content?\",\"summary\":\"Only title, summary, and names change; the mathematical artifact remains content-addressed.\",\"names\":[\"presentation amendment invariant\"]}}" | field '.id')
EDIT_HASH=$(call get "{\"ref\":\"$EDIT_TARGET\"}" | field '.artifact_hash')
[[ $(call get "{\"ref\":\"$EDIT_TARGET\"}" | field '.title') == "opaque task title" ]] || fail "T0 amendment changed its target before review"
call review_queue "{\"contributor_key\":\"$OPKEY\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(a["amendment_id"]=="'"$AMENDMENT"'" and a["proposed"]["title"].startswith("Does the") for a in d["amendment_proposals"]) and d["backlog"]["amendment_proposals"] >= 1' || fail "pending amendment missing from review queue"
call apply_amendment "{\"contributor_key\":\"$OPKEY\",\"amendment_id\":\"$AMENDMENT\",\"decision\":\"approve\",\"note\":\"Clearer and faithful to the unchanged body.\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert set(d["changed"])=={"title","summary","names"}' || fail "amendment approval did not report changed fields"
call get "{\"ref\":\"$EDIT_TARGET\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["title"].startswith("Does the presentation") and d["artifact_hash"]=="'"$EDIT_HASH"'"' || fail "approved amendment did not update presentation or changed its artifact"
[[ $(psql -h "$WORK" -d math -tAc "select (payload->'before'->>'title') || ' -> ' || (payload->'after'->>'title') from event where kind='amendment-applied' and contribution_id='$EDIT_TARGET'") == "opaque task title -> Does the presentation amendment preserve content?" ]] || fail "amendment event did not preserve before and after"
# A second proposal remains pending for the every-door contract below, which
# rejects it and thereby exercises the other terminal decision.
AMEND_REJECT=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"amendment\",\"title\":\"Unhelpful amendment\",\"summary\":\"Reject me.\",\"content\":\"No improvement.\",\"amends\":\"$EDIT_TARGET\",\"replacement\":{\"title\":\"Thing\"}}" | field '.id')

# Contract: world-facing impact is a reviewed, explained signal separate from
# graph density. A T0 assessment has no ranking effect; approval materializes
# one vote per identity and impact ordering exposes its dimensions.
IMPACT=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"impact-assessment\",\"title\":\"Impact of the presentation invariant\",\"summary\":\"Rubric calibration.\",\"content\":\"Reach 5, advance 5, closure 5 for this synthetic contract target.\",\"assesses_impact\":\"$EDIT_TARGET\",\"impact\":{\"reach\":5,\"advance\":5,\"closure\":5}}" | field '.id')
[[ $(psql -h "$WORK" -d math -tAc "select impact_assessments from contribution where id='$EDIT_TARGET'") == 0 ]] || fail "T0 impact assessment affected its target"
call review_queue "{\"contributor_key\":\"$OPKEY\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert any(a["assessment_id"]=="'"$IMPACT"'" and a["proposed"]=={"reach":5,"advance":5,"closure":5} for a in d["impact_assessment_proposals"]) and d["backlog"]["impact_assessment_proposals"] >= 1' || fail "pending impact assessment missing from review queue"
call apply_impact_assessment "{\"contributor_key\":\"$OPKEY\",\"assessment_id\":\"$IMPACT\",\"decision\":\"approve\",\"note\":\"Rubric values checked for the contract fixture.\"}" > /dev/null
call search '{"kind":"problem","order_by":"impact","limit":1}' | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d["results"][0];i=r["ranking"]["reviewed_impact"];assert r["id"]=="'"$EDIT_TARGET"'" and i["total"]==15 and i["assessments"]==1 and i["score"]>30' || fail "reviewed impact did not drive explained impact ordering"
# One pending rejection lets the every-door census exercise that outcome too.
IMPACT_REJECT=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"impact-assessment\",\"title\":\"Bad impact assessment\",\"summary\":\"Reject me.\",\"content\":\"Unsupported scores.\",\"assesses_impact\":\"$EDIT_TARGET\",\"impact\":{\"reach\":0,\"advance\":0,\"closure\":0}}" | field '.id')

# Contract: an authorship signature is a proof or it is nothing. A submission
# carrying one is checked against the identity's registered public key before
# anything is written, because a signature stored unverified reads as evidence
# while being a claim. A bad one takes the whole submission down with it.
SIGKEY="$WORK/authorship.pem"
openssl genpkey -algorithm ed25519 -out "$SIGKEY" 2> /dev/null
PUBKEY=$(openssl pkey -in "$SIGKEY" -pubout -outform DER | base64 -w0)
sign() { # <message> -> base64 Ed25519 signature (pkeyutl needs a real file)
  printf '%s' "$1" > "$WORK/msg"
  openssl pkeyutl -sign -inkey "$SIGKEY" -rawin -in "$WORK/msg" | base64 -w0
}
SIGNED_BODY="signed authorship."
GOODSIG=$(sign "$(printf '%s' "$SIGNED_BODY" | sha256sum | cut -d' ' -f1)")

call register_public_key "{\"contributor_key\":\"$KEY\",\"public_key\":\"bm90IGEga2V5\"}" \
  | field '.error' | grep -qi ed25519 || fail "a public key that is not an Ed25519 key was accepted"
call register_public_key "{\"contributor_key\":\"$KEY\",\"public_key\":\"$PUBKEY\"}" \
  | field '.ok' > /dev/null || fail "a real Ed25519 public key was rejected"

SIGNED=$(call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"signed work\",\"summary\":\"s\",\"content\":\"$SIGNED_BODY\",\"signature\":\"$GOODSIG\"}")
SIGNED_ID=$(echo "$SIGNED" | field '.id') || fail "a correctly signed submission was refused: $(echo "$SIGNED" | head -c 300)"
[[ $(psql -h "$WORK" -d math -tAc "select outcome from verification where contribution_id = '$SIGNED_ID' and method = 'authorship-signature'") == passed ]] \
  || fail "a verified signature was not recorded as an authorship verification"

call submit "{\"contributor_key\":\"$KEY\",\"kind\":\"result\",\"title\":\"forged authorship\",\"summary\":\"s\",\"content\":\"$SIGNED_BODY\",\"signature\":\"$(sign 'not the digest')\"}" \
  | field '.error' | grep -qi signature || fail "a signature that does not check out was accepted"
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from contribution where title = 'forged authorship'") == 0 ]] \
  || fail "a submission whose signature failed was recorded anyway"

# ... including a signature from an identity that registered no key at all,
# which is the case where nobody could ever check it.
UNREG=$(new_session)
SESSION=$UNREG call submit "{\"kind\":\"result\",\"title\":\"unregistered signer\",\"summary\":\"s\",\"content\":\"$SIGNED_BODY\",\"signature\":\"$GOODSIG\"}" \
  | field '.error' | grep -q register_public_key || fail "a signature was accepted from an identity with no public key"

# Contract: a failed first contribution does not consume the session's one
# identity. The minted key rides home in the success payload only, so binding
# it to a call that failed would leave the caller unable to ever be it again.
[[ $(psql -h "$WORK" -d math -tAc "select identity_id is null from mcp_session where id = '$UNREG'") == t ]] \
  || fail "a failed first contribution bound the session to an identity whose key nobody was told"
RETRY=$(SESSION=$UNREG call submit '{"kind":"result","title":"unregistered signer, retried","summary":"s","content":"c."}')
[[ $(echo "$RETRY" | field '.your_contributor_key') == mrk_* ]] \
  || fail "the session never got a contributor key after its first attempt failed"

# Contract: every door answers. A tool that no contract above calls can still
# be broken by a refactor of a shared read path, so each one is called once
# with plausible arguments and must not come back an error. A new tool means a
# new line here.
declare -A DOORS=(
  [hello]='{}'
  [search]='{"query":"frontier test question"}'
  [search_decls]='{"query":"csSup_le"}'
  [lean_similar]='{"source":"theorem contract_door (n : Nat) : n + 0 = n := by simp"}'
  [fronts]='{}'
  [theories]='{}'
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
  [review_claim]="{\"contributor_key\":\"$OPKEY\",\"refs\":[\"$Q\"],\"action\":\"release\"}"
  [reject]="{\"contributor_key\":\"$OPKEY\",\"ref\":\"$RQO\",\"reason\":\"not-mathematics\",\"note\":\"contract test\"}"
  [set_tier]="{\"contributor_key\":\"$OPKEY\",\"ref\":\"$Q\",\"tier\":1,\"note\":\"n\"}"
  [set_origin]="{\"contributor_key\":\"$OPKEY\",\"ref\":\"$Q\",\"origin\":\"ledger\",\"note\":\"n\"}"
  [apply_refactor]="{\"contributor_key\":\"$OPKEY\",\"refactor_id\":\"$PROPOSAL\",\"decision\":\"reject\",\"note\":\"n\"}"
  [apply_amendment]="{\"contributor_key\":\"$OPKEY\",\"amendment_id\":\"$AMEND_REJECT\",\"decision\":\"reject\",\"note\":\"n\"}"
  [apply_impact_assessment]="{\"contributor_key\":\"$OPKEY\",\"assessment_id\":\"$IMPACT_REJECT\",\"decision\":\"reject\",\"note\":\"n\"}"
  [grant_trust]="{\"contributor_key\":\"$OPKEY\",\"identity_id\":\"$OPID\",\"role\":\"operator\",\"note\":\"n\"}"
  [retract]="{\"contributor_key\":\"$OPKEY\",\"ref\":\"$SQ\",\"note\":\"contract test\"}"
  [register_public_key]="{\"contributor_key\":\"$KEY\",\"public_key\":\"$(openssl genpkey -algorithm ed25519 | openssl pkey -pubout -outform DER | base64 -w0)\"}"
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

# ——— A stranger with only the URL can find everything ————————————————————
# The whole consumer story is: someone is handed https://…/mcp and nothing
# else. So the three MCP surfaces are contracts, not decoration — a client that
# reads resources but never calls a tool, and a person picking a prompt out of
# a menu, both have to arrive at the same doctrine the tools serve.
INIT=$(curl -sf --max-time 10 -X POST "$MCP" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"contracts","version":"1"}}}' \
  | sed -n 's/^data: //p' | jq -er '.result')
for capability in tools resources prompts; do
  echo "$INIT" | jq -e ".capabilities.$capability" > /dev/null || fail "$capability is not advertised at initialize"
done

# Instructions are paid for on every connection, so they point rather than
# tell: hello and the prompts carry what a session actually needs, and this
# guard is what stops the doctrine from creeping back in here where it would
# go stale.
INSTRUCTIONS=$(echo "$INIT" | field '.instructions')
[[ ${#INSTRUCTIONS} -lt 1200 ]] || fail "server instructions have grown into a document (${#INSTRUCTIONS} chars); the guides are where that belongs"
grep -q "hello" <<< "$INSTRUCTIONS" || fail "server instructions never mention hello"
grep -qi "prompts\|guides" <<< "$INSTRUCTIONS" || fail "server instructions never point at the guides"

# Every resource this server offers answers, and answers with something.
RESOURCES=$(rpc resources/list '{}' | field '.resources')
[[ $(echo "$RESOURCES" | jq -r 'length') -ge 5 ]] || fail "the resource shelf is empty or tiny: $RESOURCES"
for uri in $(echo "$RESOURCES" | jq -r '.[].uri'); do
  BODY=$(rpc resources/read "{\"uri\":\"$uri\"}" | field '.contents[0].text') \
    || fail "resource $uri did not read"
  [[ ${#BODY} -gt 40 ]] || fail "resource $uri read back nearly empty"
done

# A template is a resource with a name in it, so each one is exercised with a
# name this suite actually created — and a new template with no probe here
# fails, exactly as a new tool with no contract call does.
declare -A TEMPLATES=(
  ["ledger://entry/{ref}"]="ledger://entry/$Q"
  ["ledger://frontier/{ref}"]="ledger://frontier/$Q"
  ["ledger://front/{ref}"]="ledger://front/$FR"
  ["ledger://theory/{ref}"]="ledger://theory/$THEORY"
)
while read -r pattern; do
  [[ -v TEMPLATES[$pattern] ]] || fail "resource template $pattern is registered but no contract reads it"
  rpc resources/read "{\"uri\":\"${TEMPLATES[$pattern]}\"}" | field '.contents[0].text' > /dev/null \
    || fail "resource template $pattern did not read ${TEMPLATES[$pattern]}"
done < <(rpc resources/templates/list '{}' | jq -r '.resourceTemplates[].uriTemplate')

# A ref that is not here is a resource that is not here, and the tool's own
# sentence explains it rather than an empty document pretending to exist.
MISSING=$(curl -sf --max-time 10 -X POST "$MCP" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ledger://entry/no-such-entry-anywhere"}}' \
  | sed -n 's/^data: //p')
echo "$MISSING" | jq -e '.error' > /dev/null || fail "reading a nonexistent entry resource did not error"

# Every guide is a prompt, and the prompt is the guide: one file, three doors.
PROMPTS=$(rpc prompts/list '{}' | field '.prompts')
for name in $(call guides '{}' | jq -r '.guides[].name'); do
  echo "$PROMPTS" | jq -e --arg n "$name" 'map(select(.name == $n)) | length == 1' > /dev/null \
    || fail "guide $name is not offered as a prompt"
  # The description is a retrieval trigger, not a summary: it says when to
  # reach for the guide, so it must not be the guide's own title back again.
  DESC=$(echo "$PROMPTS" | jq -er --arg n "$name" '.[] | select(.name == $n) | .description')
  TITLE=$(echo "$PROMPTS" | jq -er --arg n "$name" '.[] | select(.name == $n) | .title')
  [[ -n $DESC && $DESC != "$TITLE" ]] || fail "prompt $name has no trigger description of its own"
  [[ $DESC == *,* ]] || fail "prompt $name's description reads as prose, not as the conditions for loading it"
  TOOL_TEXT=$(call guides "{\"name\":\"$name\"}")
  PROMPT_TEXT=$(rpc prompts/get "{\"name\":\"$name\"}" | field '.messages[0].content.text')
  [[ $PROMPT_TEXT == "$TOOL_TEXT" ]] || fail "prompt $name and the guides tool serve different text"
  grep -q "^when:" <<< "$TOOL_TEXT" && fail "guide $name leaks its front matter into what readers are served"
  RESOURCE_TEXT=$(rpc resources/read "{\"uri\":\"$PUBLIC_URL/guides/$name.md\"}" | field '.contents[0].text')
  [[ $RESOURCE_TEXT == "$TOOL_TEXT" ]] || fail "guide $name reads differently as a resource than as a tool"
done

# ——— The import reconciles in both directions ————————————————————————————
# A bad edge in a bulk import is not fixed by fixing the exporter unless a
# reload can also take the published copy out. Load a question plus a claim
# that falsely resolves it, then reload the same export with that link gone:
# the link must end up retracted with an event to show for it, and the
# question must go back to open.
IMP="$WORK/import"
mkdir -p "$IMP"
export_corpus() { # export_corpus <claim count>
  python3 - "$IMP" "$1" <<'PY'
import json, sys
out, n = sys.argv[1], int(sys.argv[2])
meta = {"imported_from": "projects-research"}
rows = [{"import_key": "node:1", "kind": "problem", "title": "Imported question", "summary": "s",
         "content": "Is it so?", "tier": 2, "created_at": "2026-01-01T00:00:00Z", "metadata": meta}]
rows += [{"import_key": f"claim:{i}", "kind": "statement", "title": f"Imported answer {i}", "summary": "s",
          "content": f"It is so, {i}.", "tier": 2, "created_at": "2026-01-01T00:00:00Z", "metadata": meta}
         for i in range(1, n + 1)]
with open(f"{out}/contributions.jsonl", "w") as f:
    f.write("".join(json.dumps(r) + "\n" for r in rows))
PY
}
export_corpus 300
echo '{"src":"claim:1","dst":"node:1","rel":"resolves","note":null,"tier":2}' > "$IMP/edges.jsonl"
bun run tools/load-import.ts "$IMP" "$WORK/import.key" "import contract" > "$WORK/import.log" 2>&1 \
  || fail "load-import failed: $(tail -3 "$WORK/import.log")"
state_of() { psql -X -tAq -h "$WORK" -d math -c "select state from contribution where metadata->>'import_key' = 'node:1'"; }
[[ $(state_of) == settled ]] || fail "an imported 'resolves' edge did not settle the question it answers"

: > "$IMP/edges.jsonl"
bun run tools/load-import.ts "$IMP" "$WORK/import.key" "import contract" > "$WORK/import2.log" 2>&1 \
  || fail "reload failed: $(tail -3 "$WORK/import2.log")"
WITHDRAWN=$(psql -X -tAq -h "$WORK" -d math -c "select count(*) from contribution c join event e on e.contribution_id = c.id and e.kind = 'retracted' where c.kind = 'edge' and c.status = 'retracted'")
[[ $WITHDRAWN == 1 ]] || fail "an edge the export stopped asserting was not retracted (got $WITHDRAWN)"
[[ $(state_of) == open ]] || fail "withdrawing the only 'resolves' edge left the question settled"

# The same reload must not be able to empty the corpus when the export is
# truncated: withdrawing entries past the ceiling aborts instead.
export_corpus 10
bun run tools/load-import.ts "$IMP" "$WORK/import.key" "import contract" > "$WORK/import3.log" 2>&1 \
  && fail "a truncated export was allowed to withdraw half the imported entries"
grep -q 'refusing to withdraw' "$WORK/import3.log" || fail "the withdrawal ceiling did not explain itself: $(tail -3 "$WORK/import3.log")"
STILL=$(psql -X -tAq -h "$WORK" -d math -c "select count(*) from contribution where metadata->>'import_key' = 'claim:1' and status = 'active'")
[[ $STILL == 1 ]] || fail "the aborted load withdrew entries anyway"

# Contract: the declaration index is what "is there already a lemma for this?"
# reads. Terms are ANDed across name and statement, the filters restrict, and
# ILIKE metacharacters in a Lean name are literal text rather than a pattern
# language the caller did not ask for.
psql -q -h "$WORK" -d math -c "insert into lean_decl (module, name, library, kind, statement, is_proof) values
  ('Mathlib.Order.Bounds.Basic', 'csSup_le', 'Mathlib', 'theorem', 's.Nonempty → (∀ b ∈ s, b ≤ a) → sSup s ≤ a', true),
  ('Mathlib.Order.Bounds.Basic', 'csSup_le_iff', 'Mathlib', 'theorem', 'BddAbove s → s.Nonempty → (sSup s ≤ a ↔ ∀ b ∈ s, b ≤ a)', true),
  ('MathlibPlus.GroupTheory.Claim1', 'plus_widget', 'MathlibPlus', 'def', 'Nat → Nat', false)"
decls() { call search_decls "$1" | field '.results'; }
decls '{"query":"csSup_le"}' | python3 -c 'import sys,json; r=json.load(sys.stdin); assert r[0]["name"]=="csSup_le" and r[0]["module"]=="Mathlib.Order.Bounds.Basic", r' \
  || fail "search_decls did not rank the exact name first"
decls '{"query":"csSup_le sSup"}' | python3 -c 'import sys,json; assert len(json.load(sys.stdin))==2' \
  || fail "search_decls did not AND a name term with a statement term"
decls '{"query":"csSup?le"}' | python3 -c 'import sys,json; assert json.load(sys.stdin)==[]' \
  || fail "search_decls treated a literal term as a pattern"
decls '{"query":"plus","library":"Mathlib"}' | python3 -c 'import sys,json; assert json.load(sys.stdin)==[]' \
  || fail "search_decls ignored the library filter"
decls '{"query":"widget","module":"MathlibPlus.GroupTheory"}' | python3 -c 'import sys,json; assert len(json.load(sys.stdin))==1' \
  || fail "search_decls did not match a module subtree"
decls '{"query":"widget","proofs_only":true}' | python3 -c 'import sys,json; assert json.load(sys.stdin)==[]' \
  || fail "proofs_only returned a definition"
call search_decls '{}' | python3 -c 'import sys,json; d=json.load(sys.stdin); assert {i["library"] for i in d["index"]} == {"Mathlib","MathlibPlus"}, d' \
  || fail "search_decls did not report what is indexed"

# Contract: alpha-normalized similarity compares what a declaration says, not
# what anyone called it. These three differ only in binder names and in the
# name of the declaration itself, so they are one statement; the fourth says
# something else and must not be swept in with them. The generated one is
# Lean's own boilerplate and is classified out of every answer.
psql -q -h "$WORK" -d math -c "insert into lean_decl (module, name, library, kind, statement, is_proof) values
  ('MathlibPlus.Dup.A', 'MathlibPlus.Dup.A.sum_bound', 'MathlibPlus', 'theorem',
   '∀ {α : Type u_1} (s : Finset α) (f : α → ℝ) (n : ℝ), (∀ x ∈ s, f x ≤ n) → ∑ i ∈ s, f i ≤ s.card • n', true),
  ('MathlibPlus.Dup.B', 'MathlibPlus.Dup.B.bounded_sum', 'MathlibPlus', 'theorem',
   '∀ {β : Type u_7} (t : Finset β) (g : β → ℝ) (c : ℝ), (∀ y ∈ t, g y ≤ c) → ∑ j ∈ t, g j ≤ t.card • c', true),
  ('MathlibPlus.Dup.C', 'MathlibPlus.Dup.C.other', 'MathlibPlus', 'theorem',
   '∀ (p q : Prop), p ∧ q → q ∧ p', true),
  ('MathlibPlus.Dup.Defs', 'MathlibPlus.Dup.Defs.first', 'MathlibPlus', 'def', 'Nat → Nat', false),
  ('MathlibPlus.Dup.Defs', 'MathlibPlus.Dup.Defs.second', 'MathlibPlus', 'def', 'Nat → Nat', false),
  ('Mathlib.Finset.Sum', 'Mathlib.Finset.bounded_sum', 'Mathlib', 'theorem',
   '∀ {γ : Type u_3} (u : Finset γ) (h : γ → ℝ) (b : ℝ), (∀ z ∈ u, h z ≤ b) → ∑ k ∈ u, h k ≤ u.card • b', true),
  ('MathlibPlus.Dup.Numerals', 'MathlibPlus.Dup.Numerals.seven_prime', 'MathlibPlus', 'theorem',
   'Fact (Nat.Prime 7)', true),
  ('Mathlib.Data.Nat.Prime', 'Mathlib.fact_prime_three', 'Mathlib', 'theorem',
   'Fact (Nat.Prime 3)', true),
  ('MathlibPlus.Dup.A', 'MathlibPlus.Dup.A.Config.mk.injEq', 'MathlibPlus', 'theorem',
   '∀ {α : Type u_1} (s : Finset α) (f : α → ℝ) (n : ℝ), (∀ x ∈ s, f x ≤ n) → ∑ i ∈ s, f i ≤ s.card • n', true)"
bun run tools/normalize-lean.ts > "$WORK/normalize.log" 2>&1 || fail "normalize-lean failed: $(tail -3 "$WORK/normalize.log")"

call lean_similar '{"name":"MathlibPlus.Dup.A.sum_bound"}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); names={m["name"] for m in d["exact"]}; assert names=={"MathlibPlus.Dup.B.bounded_sum","Mathlib.Finset.bounded_sum"}, d' \
  || fail "lean_similar did not recognize renamed copies as the same statement"

# The same question asked with source nobody has ever indexed, in a third set
# of names: normalization happens on the way in, not only at index time.
call lean_similar '{"source":"theorem entirely_different_name {γ : Type u_3} (u : Finset γ) (h : γ → ℝ) (b : ℝ) : (∀ z ∈ u, h z ≤ b) → ∑ k ∈ u, h k ≤ u.card • b"}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); assert {m["name"] for m in d["exact"]} == {"MathlibPlus.Dup.A.sum_bound","MathlibPlus.Dup.B.bounded_sum","Mathlib.Finset.bounded_sum"}, d' \
  || fail "lean_similar did not match pasted source against the indexed twins"

call lean_similar '{"scan":true,"library":"MathlibPlus"}' \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
groups = [g for g in d["identical"] if len(g["members"]) > 1]
names = [{m["name"] for m in g["members"]} for g in groups]
assert {"MathlibPlus.Dup.A.sum_bound", "MathlibPlus.Dup.B.bounded_sum"} in names, d
assert all("MathlibPlus.Dup.A.Config.mk.injEq" not in group for group in names), d
' || fail "a scan did not group the duplicate pair, or swept in generated or unrelated declarations"

# Exact-only cleanup scans are not the bounded NCD attention window: they walk
# the complete normalized-hash index, can exclude same-typed definitions, and
# can ask which MathlibPlus proofs should simply import Mathlib.
call lean_similar '{"scan":true,"library":"MathlibPlus","proofs_only":true,"exact_only":true,"limit":1}' \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["scanned"] == 4 and d["next_offset"] == 1, d
assert {m["name"] for m in d["identical"][0]["members"]} == {"MathlibPlus.Dup.A.sum_bound", "MathlibPlus.Dup.B.bounded_sum"}, d
assert all(m["is_proof"] for m in d["identical"][0]["members"]), d
' || fail "exact-only scan did not cover the full proof scope or page duplicate groups"
call lean_similar '{"scan":true,"library":"MathlibPlus","against_library":"Mathlib","proofs_only":true,"exact_only":true}' \
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert len(d["identical"]) == 1, d
members = d["identical"][0]["members"]
assert {m["library"] for m in members} == {"MathlibPlus", "Mathlib"}, d
assert {m["name"] for m in members} == {"MathlibPlus.Dup.A.sum_bound", "MathlibPlus.Dup.B.bounded_sum", "Mathlib.Finset.bounded_sum"}, d
assert all("prime" not in m["name"] for m in members), d
' || fail "cross-library scan missed a duplicate or treated different numerals as alpha-equivalent"

# Contract: a patch is a change to the library, verified by applying it and
# building what it touches. A diff that does not apply is a failure with the
# conflict, not a build attempt.
patch_submit() { # <title> <diff-content> -> contribution id
  call submit "$(python3 -c 'import json,sys; print(json.dumps({"contributor_key":sys.argv[1],"kind":"patch","title":sys.argv[2],"summary":"contract patch","content":sys.argv[3]}))' "$KEY" "$1" "$2")" | field '.id'
}
patch_verification() { psql -h "$WORK" -d math -tAc "select id from verification where contribution_id = '$1' and method = 'patch-build'"; }
STALE=$(cat <<'EOF'
diff --git a/MathlibPlus/Alpha.lean b/MathlibPlus/Alpha.lean
--- a/MathlibPlus/Alpha.lean
+++ b/MathlibPlus/Alpha.lean
@@ -1 +1,2 @@
-theorem alpha : 9 = 9 := rfl
+theorem alpha : 9 = 9 := rfl
+theorem added : 5 = 5 := rfl
EOF
)
STALE_ID=$(patch_submit "a patch against a file that has moved on" "$STALE")
STALE_V=$(patch_verification "$STALE_ID")
[[ -n $STALE_V ]] || fail "a diff was not recognised as a patch"
[[ $(await_verification "$STALE_V") == failed ]] || fail "a patch that does not apply was not failed"
psql -h "$WORK" -d math -tAc "select detail->>'reason' from verification where id = $STALE_V" | grep -qi "does not apply" \
  || fail "a conflicting patch did not say so"

# Contract: deleting a module something still imports is a broken library, and
# it is caught before anything is compiled.
ORPHAN=$(printf 'diff --git a/MathlibPlus/Alpha.lean b/MathlibPlus/Alpha.lean\ndeleted file mode 100644\n--- a/MathlibPlus/Alpha.lean\n+++ /dev/null\n@@ -1 +0,0 @@\n-theorem alpha : 1 + 1 = 2 := rfl\n')
ORPHAN_V=$(patch_verification "$(patch_submit "delete a module others import" "$ORPHAN")")
[[ $(await_verification "$ORPHAN_V") == failed ]] || fail "deleting an imported module was not refused"
psql -h "$WORK" -d math -tAc "select detail->>'reason' from verification where id = $ORPHAN_V" | grep -q "still imports" \
  || fail "the dangling import was not explained"

# Contract: a patch that applies is compiled in dependency order, and a module
# that merely imports what changed is rebuilt too.
MERGE=$(cat <<'EOF'
diff --git a/MathlibPlus/Alpha.lean b/MathlibPlus/Alpha.lean
--- a/MathlibPlus/Alpha.lean
+++ b/MathlibPlus/Alpha.lean
@@ -1 +1,2 @@
 theorem alpha : 1 + 1 = 2 := rfl
+theorem gamma : 3 = 3 := rfl
diff --git a/MathlibPlus/Gamma.lean b/MathlibPlus/Gamma.lean
deleted file mode 100644
--- a/MathlibPlus/Gamma.lean
+++ /dev/null
@@ -1 +0,0 @@
-theorem gamma : 3 = 3 := rfl
EOF
)
MERGE_ID=$(patch_submit "fold Gamma into Alpha" "$MERGE")
MERGE_V=$(patch_verification "$MERGE_ID")
CHECK_ID=$(await_query "select detail->>'check_id' from verification where id = $MERGE_V")
await_file "$SPOOL_DIR/in/patch-$CHECK_ID/job.json" || CHECK_ID=""
[[ -n $CHECK_ID ]] || fail "an applying patch was never spooled to the runner"
python3 -c 'import json,sys; j=json.load(open(sys.argv[1]));
mods=[m["module"] for m in j["modules"]];
assert mods == ["MathlibPlus.Alpha", "MathlibPlus.Beta"], mods
assert j["deleted"] == ["MathlibPlus.Gamma"], j["deleted"]
assert [m["changed"] for m in j["modules"]] == [True, False]
assert [m["optional"] for m in j["modules"]] == [False, False], j["modules"]
assert j["modules"][1]["requires"] == ["MathlibPlus.Alpha"], j["modules"]' "$SPOOL_DIR/in/patch-$CHECK_ID/job.json" \
  || fail "the patch job was not the changed modules plus their importers, in build order"
grep -q 'theorem gamma' "$SPOOL_DIR/in/patch-$CHECK_ID/src/MathlibPlus/Alpha.lean" || fail "the runner was handed unpatched sources"

# The runner is sandboxed and stands in here, exactly as for kernel checks. It
# returns the oleans it built, because publication installs those rather than
# compiling the library a second time.
rm -rf "$SPOOL_DIR/in/patch-$CHECK_ID"
mkdir -p "$SPOOL_DIR/out/patch-$CHECK_ID.staging/lib/MathlibPlus"
echo olean > "$SPOOL_DIR/out/patch-$CHECK_ID.staging/lib/MathlibPlus/Alpha.olean"
cat > "$SPOOL_DIR/out/patch-$CHECK_ID.staging/result.json" <<EOF
{"ok":true,"built":["MathlibPlus.Alpha","MathlibPlus.Beta"],"elapsed_ms":1200,
 "decls":{"MathlibPlus.Alpha":[{"name":"alpha","type":"1 + 1 = 2","axioms":[],"proof":true},
                               {"name":"gamma","type":"3 = 3","axioms":[],"proof":true}]}}
EOF
mv "$SPOOL_DIR/out/patch-$CHECK_ID.staging" "$SPOOL_DIR/out/patch-$CHECK_ID"
[[ $(await_verification "$MERGE_V") == passed ]] || fail "a patch that builds did not pass"

# Contract: verification is not publication. The library is untouched until a
# trusted reviewer promotes the patch, and review sees the build result.
git -C "$PATCH_REPO_DIR" diff --quiet HEAD || fail "a merely verified patch changed the library"
call review_queue "{\"contributor_key\":\"$OPKEY\"}" | python3 -c 'import sys,json; d=json.load(sys.stdin);
p=[x for x in d["patches"] if x["id"]=="'"$MERGE_ID"'"]; assert p and p[0]["build"]=="passed" and p[0]["deleted_modules"]==["MathlibPlus.Gamma"], d["patches"]' \
  || fail "the review queue did not show the patch with its build result"

# A stale kernel check of the module the patch changes: publication must drop
# it, because its answer was about a library that no longer exists.
psql -q -h "$WORK" -d math -c "insert into lean_check (source_hash, source, outcome) values ('deadbeef', 'import MathlibPlus.Alpha' || chr(10) || 'example : True := trivial', 'failed')"
call set_tier "{\"contributor_key\":\"$OPKEY\",\"ref\":\"$MERGE_ID\",\"tier\":2,\"note\":\"reviewed patch\"}" | field '.ok' > /dev/null
await_query "select state from patch_publication where contribution_id = '$MERGE_ID' and state = 'published'" > /dev/null
STATE=$(psql -h "$WORK" -d math -tAc "select state from patch_publication where contribution_id = '$MERGE_ID'")
[[ $STATE == published ]] || fail "promoting a patch to T2 did not publish it (state: ${STATE:-none}, $(tail -3 "$WORK/verifier.log"))"
grep -q 'theorem gamma' "$PATCH_REPO_DIR/MathlibPlus/Alpha.lean" || fail "the published patch is not in the library"
[[ ! -f "$PATCH_REPO_DIR/MathlibPlus/Gamma.lean" ]] || fail "the published patch did not delete the module it folded in"
git -C "$PATCH_REPO_DIR" log -1 --format=%s | grep -q "fold Gamma into Alpha" || fail "publication did not commit with the patch's title"
git -C "$PATCH_REPO_DIR" status --porcelain | grep -q . && fail "publication left the library checkout dirty"
[[ -f "$PATCH_BUILD_LIB/MathlibPlus/Alpha.olean" ]] || fail "the verified olean was not installed into the build tree"
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from lean_check where source_hash = 'deadbeef'") == 0 ]] \
  || fail "publication kept a cached check of a module it changed"
[[ $(psql -h "$WORK" -d math -tAc "select count(*) from lean_decl where module = 'MathlibPlus.GroupTheory.Claim1'") == 1 ]] \
  || fail "publication disturbed the index of modules it did not touch"

# Contract: a module that does not build at the base commit is the library's
# state, not the patch's doing. Touching one must not condemn the patch, and a
# patch that could build nothing at all verified nothing.
# Ending on a blank context line is the case that broke the first real patch:
# a hunk's blank context line is a single space, and trimming trailing
# whitespace off the diff leaves the hunk shorter than its header claims.
BROKEN=$(printf 'diff --git a/MathlibPlus/Broken.lean b/MathlibPlus/Broken.lean\n--- a/MathlibPlus/Broken.lean\n+++ b/MathlibPlus/Broken.lean\n@@ -1,2 +1,3 @@\n theorem broken : 4 = 5 := rfl\n+-- a note that changes nothing\n \n')
BROKEN_ID=$(patch_submit "touch a module that does not build" "$BROKEN")
BROKEN_V=$(patch_verification "$BROKEN_ID")
BROKEN_CHECK=$(await_query "select detail->>'check_id' from verification where id = $BROKEN_V")
await_file "$SPOOL_DIR/in/patch-$BROKEN_CHECK/job.json" || BROKEN_CHECK=""
[[ -n $BROKEN_CHECK ]] || fail "a patch to an unbuilt module was never spooled"
python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); assert j["modules"][0]["optional"] is True, j["modules"]' \
  "$SPOOL_DIR/in/patch-$BROKEN_CHECK/job.json" || fail "a module with no olean was not marked already-broken"
rm -rf "$SPOOL_DIR/in/patch-$BROKEN_CHECK"
mkdir -p "$SPOOL_DIR/out/patch-$BROKEN_CHECK.staging"
echo '{"ok":true,"built":[],"still_broken":["MathlibPlus.Broken"],"elapsed_ms":10}' \
  > "$SPOOL_DIR/out/patch-$BROKEN_CHECK.staging/result.json"
mv "$SPOOL_DIR/out/patch-$BROKEN_CHECK.staging" "$SPOOL_DIR/out/patch-$BROKEN_CHECK"
[[ $(await_verification "$BROKEN_V") == inconclusive ]] || fail "a patch that built nothing was not inconclusive"
psql -h "$WORK" -d math -tAc "select detail->>'reason' from verification where id = $BROKEN_V" | grep -q "does not build at this commit" \
  || fail "a patch that built nothing did not explain why"

echo "all contracts hold"


