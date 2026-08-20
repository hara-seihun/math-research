#!/usr/bin/env bash
# Zero-downtime deploy to the mathvm guest: push, pull, roll the two MCP
# instances one at a time (health-gated), restart the background workers, and
# rebuild the onboarding site against the freshly restarted server.
# Schema changes are not automatic — apply migrations with psql first.
set -euo pipefail
cd "$(dirname "$0")/.."

git push
ssh mathvm '
  set -e
  cd /srv/math-research
  sudo -u math git pull -q
  cd server && sudo -u math bun install --silent
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

  cd /srv/math-research/site
  sudo -u math bun install --silent
  sudo -u math env MATH_MCP_URL=http://127.0.0.1:8787/mcp bun run build.ts
'
curl -sf --max-time 10 https://math.seihun.com/health > /dev/null && echo "deployed and healthy"
