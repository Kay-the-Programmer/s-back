#!/usr/bin/env bash
# Git-based production deploy — run ON THE VM:
#   ~/salepilot/s-back/deploy/pull-and-rebuild.sh
# Pulls the latest main, rebuilds the backend image, recreates the container,
# and health-checks. The server's .env and uploads/ are untracked, so a pull
# never touches them.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[1/3] Pulling latest main..."
git pull --ff-only origin main

echo "[2/3] Rebuilding backend (npm install + tsc inside the image)..."
sudo docker compose -f docker-compose.prod.yml up -d --build s-back

echo "[3/3] Health check..."
sleep 8
if curl -sf -m 15 http://127.0.0.1:5000/api/health; then
    echo ""
    echo "DEPLOY_OK — running commit: $(git rev-parse --short HEAD)"
else
    echo ""
    echo "HEALTH CHECK FAILED — inspect with: sudo docker logs --tail 50 salepilot-backend" >&2
    exit 1
fi
