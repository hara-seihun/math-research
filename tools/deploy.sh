#!/usr/bin/env bash
# Deploy to the mathvm guest: push, pull, apply the schema, roll the MCP
# instances one at a time (health-gated), restart the background workers,
# rebuild the onboarding site against the freshly restarted server.
#
#   tools/deploy.sh          everything
#   tools/deploy.sh --site   site only, touching no service, so it is safe
#                            to run while Lean checks are in flight
#
# schema.sql is applied on every deploy. It is written to be re-appliable:
# every object is created if-not-exists and every backfill is guarded, so
# applying it when nothing changed is a no-op that costs a second.
set -euo pipefail
cd "$(dirname "$0")/.."

# Agents deploy concurrently. Without one host-wide lease, two otherwise-safe
# rolling deploys can restart opposite instances at the same time and make the
# final public health probe fail. Hold this descriptor through push, guest
# mutation, and validation; flock releases it on every exit path.
exec 9>/tmp/math-research-deploy.lock
flock 9

# Content edited at https://lemma.ing/admin is committed on the guest
# (which holds no GitHub credential), so the guest is upstream of the host for
# those commits. Collect them before pushing, or the guest's pull diverges.
git remote get-url guest > /dev/null 2>&1 || git remote add guest mathvm:/srv/math-research
git fetch -q guest
if ! git merge-base --is-ancestor guest/main HEAD; then
  echo "picking up commits made at /admin on the guest"
  git merge --no-edit -q guest/main
fi

pull='
  cd /srv/math-research
  if ! sudo -u math git diff --quiet -- site/content guides; then
    echo "unpublished /admin draft in site/content or guides, so publish or revert it at https://lemma.ing/admin" >&2
    exit 1
  fi
  sudo -u math git pull -q
'

# The schema, then the normal forms the schema makes room for: a bumped
# normalizer version leaves every stored row stale, and stale rows are matches
# `lean_similar` silently cannot make. Idempotent, and a no-op when nothing
# moved.
schema='
  cd /srv/math-research && sudo -u math psql -q -v ON_ERROR_STOP=1 -d math -f schema.sql
  cd /srv/math-research/server && sudo -u math bun install --silent
  cd /srv/math-research && sudo -u math bun run tools/normalize-lean.ts
'

# The instance list is read from systemd rather than written down here, so
# adding one in configuration.nix is the whole of adding one. Each is taken
# out and put back on its own, and the next is not touched until the last is
# answering, which is what makes a deploy invisible from outside.
roll='
  cd /srv/math-research/server && sudo -u math bun install --silent
  units=$(systemctl list-units --plain --no-legend "math-mcp-*.service" | awk "{print \$1}" | sort)
  [ -n "$units" ] || { echo "no math-mcp-* instances found" >&2; exit 1; }
  for unit in $units; do
    port=$(systemctl show -p Environment --value "$unit" | tr " " "\n" | sed -n "s/^PORT=//p")
    [ -n "$port" ] || { echo "$unit declares no PORT" >&2; exit 1; }
    sudo systemctl restart "$unit"
    for _ in $(seq 40); do
      curl -sf --max-time 2 "http://127.0.0.1:$port/health" > /dev/null && continue 2
      sleep 0.25
    done
    echo "$unit did not come back healthy" >&2
    exit 1
  done
  sudo systemctl restart math-verifier lean-runner math-embedder-worker math-admin
'

site='
  cd /srv/math-research/site && sudo -u math bun install --silent
  sudo -u math env MATH_MCP_URL=http://127.0.0.1:8787/mcp bun run build.ts
'

# Joined with newlines rather than `;`, because $roll and $site are multi-line and a
# semicolon landing at the start of a line is a syntax error on the far side.
case "${1-}" in
  --site) steps=$(printf '%s\n' "$pull" "$site") ;;
  "")     steps=$(printf '%s\n' "$pull" "$schema" "$roll" "$site") ;;
  *)      echo "usage: $0 [--site]" >&2; exit 2 ;;
esac

# What ships is a commit, so an edit still sitting in the working tree would
# deploy silently as its predecessor and be measured as if it were the change.
if ! git diff --quiet -- server schema.sql tools lean; then
  echo "these will deploy as their committed version, not as they are here:" >&2
  git diff --name-only -- server schema.sql tools lean | sed 's/^/  /' >&2
  # Another agent editing the same checkout is normal, and their half-written
  # file is not a reason nobody can deploy. Yours is: set this when the dirty
  # files are not the change you are deploying.
  [[ -n "${DEPLOY_DIRTY_OK:-}" ]] || { echo "commit them, or set DEPLOY_DIRTY_OK=1 if they are someone else's" >&2; exit 1; }
fi

# A worktree branch is the normal way agents avoid sharing unfinished edits.
# Deploy the reviewed commit as main regardless of that local branch's name.
git push origin HEAD:main
ssh mathvm "set -e; $steps"
curl -sf --max-time 10 https://lemma.ing/health > /dev/null
curl -sf --max-time 10 https://lemma.ing/ > /dev/null
echo "deployed and healthy"
