#!/usr/bin/env bash
# Redeploys demo.dunx.win from this checkout. Bash rather than a bun script
# because the host it runs on has Docker and no Bun: the image brings its own.
#
#   ./examples/full/deploy-demo.sh            pull, rebuild, recreate
#   ./examples/full/deploy-demo.sh --no-pull  rebuild what is checked out
#
# Reads DEMO_AUTH_SECRET from examples/full/.env.demo, which is gitignored and
# never committed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
root=$(pwd)
compose="examples/full/compose.demo.yml"
env_file="examples/full/.env.demo"

if [ ! -f "$env_file" ]; then
  echo "missing $env_file. Create it with:" >&2
  echo "  echo \"DEMO_AUTH_SECRET=\$(openssl rand -hex 32)\" > $env_file" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [ "${1:-}" != "--no-pull" ]; then
  echo "==> pulling"
  git pull --ff-only
fi

# The other app on this host owns app-network. Compose declares it external so
# this file never recreates it, which means it has to already be up.
if ! docker network inspect app-network >/dev/null 2>&1; then
  echo "app-network is absent. Start the app that owns it first, so cloudflared" >&2
  echo "can reach this one by name." >&2
  exit 1
fi

echo "==> building"
docker compose -f "$compose" build

echo "==> recreating"
docker compose -f "$compose" up -d --remove-orphans

echo "==> waiting for readiness"
for _ in $(seq 1 60); do
  if docker exec dunx-demo curl -fsS http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1; then
    echo "ready"
    docker exec dunx-demo curl -fsS http://127.0.0.1:3000/api/health/ready
    echo
    docker compose -f "$compose" ps
    # An image per deploy adds up on a 115 GB card, and only dangling ones go.
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

echo "did not become ready. Recent logs:" >&2
docker compose -f "$compose" logs --tail 40 dunx-demo >&2
exit 1
