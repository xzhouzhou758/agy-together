#!/bin/sh
# Remove fake accounts and the mock upstream; CPA, plugin and portal stay up.
set -e
cd /opt/cliproxyapi
if [ -f /opt/agy-test/mock.pid ]; then kill "$(cat /opt/agy-test/mock.pid)" 2>/dev/null || true; rm -f /opt/agy-test/mock.pid; fi
rm -f auths/agy-fake-*.json auths/agy-fake-*.cds
docker compose restart >/dev/null 2>&1
