#!/usr/bin/env bash
# Nightly Postgres dump for the SalePilot backend (run on the VM via cron):
#   0 2 * * * /home/ubuntu/salepilot/s-back/deploy/backup.sh >> /home/ubuntu/backups/backup.log 2>&1
# Keeps 14 days locally. Optionally uploads to OCI Object Storage if the
# `oci` CLI is configured and BUCKET is set.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
BUCKET="${BUCKET:-}"   # e.g. salepilot-backups (leave empty to skip upload)
STAMP="$(date +%F-%H%M)"
FILE="$BACKUP_DIR/salepilot-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
docker exec salepilot-db pg_dump -U postgres salepilot | gzip > "$FILE"
echo "$(date -Is) wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Prune local dumps older than 14 days
find "$BACKUP_DIR" -name 'salepilot-*.sql.gz' -mtime +14 -delete

# Optional offsite copy (OCI Object Storage, 20 GB Always Free)
if [ -n "$BUCKET" ] && command -v oci >/dev/null 2>&1; then
    oci os object put --bucket-name "$BUCKET" --file "$FILE" --name "$(basename "$FILE")" --force
    echo "$(date -Is) uploaded to bucket $BUCKET"
fi
