#!/bin/sh
# Remove fake accounts and the mock upstream; plugin stays installed.
set -e
cd /opt/cliproxyapi
docker rm -f agy-mock >/dev/null 2>&1 || true
rm -f auths/agy-fake-*.json auths/agy-fake-*.cds
docker compose restart >/dev/null 2>&1
