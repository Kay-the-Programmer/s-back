#!/usr/bin/env bash
# Nightly backup for the SalePilot backend (run on the VM via cron):
#   0 2 * * * /home/ubuntu/salepilot/s-back/deploy/backup.sh >> /home/ubuntu/backups/backup.log 2>&1
# Backs up BOTH the Postgres database and the uploads/ directory (product
# images live on local disk when Cloudinary is not configured — losing them
# is losing every product photo). Keeps 14 days locally. Optionally uploads
# to Google Cloud Storage if the `gsutil` CLI is configured and BUCKET is set.
# Set up offsite copies — local-only backups do not survive losing the VM.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
UPLOADS_DIR="${UPLOADS_DIR:-$HOME/salepilot/s-back/uploads}"
BUCKET="${BUCKET:-}"   # e.g. salepilot-backups (leave empty to skip upload)
STAMP="$(date +%F-%H%M)"
FILE="$BACKUP_DIR/salepilot-$STAMP.sql.gz"
UPLOADS_FILE="$BACKUP_DIR/uploads-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
docker exec salepilot-db pg_dump -U postgres salepilot | gzip > "$FILE"
echo "$(date -Is) wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Uploaded images (best effort — don't fail the DB backup if the dir is empty)
if [ -d "$UPLOADS_DIR" ]; then
    tar -czf "$UPLOADS_FILE" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" || echo "$(date -Is) WARN: uploads tar failed"
    [ -f "$UPLOADS_FILE" ] && echo "$(date -Is) wrote $UPLOADS_FILE ($(du -h "$UPLOADS_FILE" | cut -f1))"
fi

# Prune local backups older than 14 days
find "$BACKUP_DIR" -name 'salepilot-*.sql.gz' -mtime +14 -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +14 -delete

# Optional offsite copy (Google Cloud Storage, 5 GB Always Free in a US region)
if [ -n "$BUCKET" ] && command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$FILE" "gs://$BUCKET/$(basename "$FILE")"
    [ -f "$UPLOADS_FILE" ] && gsutil cp "$UPLOADS_FILE" "gs://$BUCKET/$(basename "$UPLOADS_FILE")"
    echo "$(date -Is) uploaded to bucket $BUCKET"
fi
