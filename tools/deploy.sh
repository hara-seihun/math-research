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

pull='cd /srv/math-research && sudo -u math git pull -q'

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
  sudo systemctl restart math-verifier lean-runner math-embedder-worker
'

site='
  cd /srv/math-research/site && sudo -u math bun install --silent
  sudo -u math env MATH_MCP_URL=http://127.0.0.1:8787/mcp bun run build.ts
'

case "${1-}" in
  --site) steps="$pull; $site" ;;
  "")     steps="$pull; $roll; $site" ;;
  *)      echo "usage: $0 [--site]" >&2; exit 2 ;;
esac

git push
ssh mathvm "set -e; $steps"
curl -sf --max-time 10 https://math.seihun.com/health > /dev/null
curl -sf --max-time 10 https://math.seihun.com/ > /dev/null
echo "deployed and healthy"
