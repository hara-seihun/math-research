#!/usr/bin/env bash
# Deploy to the mathvm guest: push, pull, roll the two MCP instances one at a
# time (health-gated), restart the background workers, rebuild the onboarding
# site against the freshly restarted server.
#
#   tools/deploy.sh          everything
#   tools/deploy.sh --site   site only — no service is touched, so it is safe
#                            to run while Lean checks are in flight
#
# Schema changes are not automatic — apply migrations with psql first.
set -euo pipefail
cd "$(dirname "$0")/.."

# Content edited at https://math.seihun.com/admin is committed on the guest
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
    echo "unpublished /admin draft in site/content or guides — publish or revert it at https://math.seihun.com/admin" >&2
    exit 1
  fi
  sudo -u math git pull -q
'

roll='
  cd /srv/math-research/server && sudo -u math bun install --silent
  for unit in math-mcp-a:8787 math-mcp-b:8788; do
    sudo systemctl restart "${unit%:*}"
    for _ in $(seq 40); do
      curl -sf --max-time 2 "http://127.0.0.1:${unit#*:}/health" > /dev/null && continue 2
      sleep 0.25
    done
    echo "${unit%:*} did not come back healthy" >&2
    exit 1
  done
  sudo systemctl restart math-verifier lean-runner math-embedder-worker math-admin
'

site='
  cd /srv/math-research/site && sudo -u math bun install --silent
  sudo -u math env MATH_MCP_URL=http://127.0.0.1:8787/mcp bun run build.ts
'

# Joined with newlines, not `;` — $roll and $site are multi-line and a
# semicolon landing at the start of a line is a syntax error on the far side.
case "${1-}" in
  --site) steps=$(printf '%s\n' "$pull" "$site") ;;
  "")     steps=$(printf '%s\n' "$pull" "$roll" "$site") ;;
  *)      echo "usage: $0 [--site]" >&2; exit 2 ;;
esac

git push
ssh mathvm "set -e; $steps"
curl -sf --max-time 10 https://math.seihun.com/health > /dev/null
curl -sf --max-time 10 https://math.seihun.com/ > /dev/null
echo "deployed and healthy"
