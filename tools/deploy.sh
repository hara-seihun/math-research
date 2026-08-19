#!/usr/bin/env bash
# Deploy to the mathvm guest: push, pull, restart, health-check.
# Schema changes are not automatic — apply migrations with psql first.
set -euo pipefail
cd "$(dirname "$0")/.."

git push
ssh mathvm '
  set -e
  cd /srv/math-research
  sudo -u math git pull -q
  cd server && sudo -u math bun install --silent
  sudo systemctl restart math-mcp math-verifier lean-runner
'
for _ in $(seq 20); do
  curl -sf --max-time 5 https://math.seihun.com/health > /dev/null && { echo "deployed and healthy"; exit 0; }
  sleep 0.5
done
echo "deploy went out but the health check never came back" >&2
exit 1
