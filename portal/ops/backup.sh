#!/bin/sh
# Daily backup of AGY Together state on this host; keeps the newest $KEEP archives.
# Contains secrets (CPA credentials, management key, portal encryption key): the directory is root-only.
# Restore: stop both stacks, untar over / (paths are absolute-relative), start again.
set -eu
DEST=/root/agy-backups
KEEP=7
umask 077
mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Consistent copy of the live SQLite database (WAL mode) via the online backup API.
python3 -I -c '
import sqlite3, sys
src = sqlite3.connect("file:/opt/agy-pot/data/portal.db?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[1])
src.backup(dst); dst.close(); src.close()
' "$TMP/portal.db"

tar czf "$DEST/agy-$TS.tar.gz" \
  --transform "s|^${TMP#/}/portal.db|opt/agy-pot/data/portal.db|" \
  "$TMP/portal.db" \
  /opt/agy-pot/data/secret.key /opt/agy-pot/portal.env /opt/agy-pot/docker-compose.yml \
  /opt/cliproxyapi/config.yaml /opt/cliproxyapi/secrets.env /opt/cliproxyapi/docker-compose.yml \
  /opt/cliproxyapi/auths /opt/cliproxyapi/plugins/data 2>/dev/null

ls -1t "$DEST"/agy-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(date '+%F %T') ok $DEST/agy-$TS.tar.gz $(du -h "$DEST/agy-$TS.tar.gz" | cut -f1)"
