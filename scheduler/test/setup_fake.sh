#!/bin/sh
# Create 5 fake antigravity accounts (agy-fake-a..e) pointing at the local mock,
# restart CPA, then (re)start the mock inside CPA's network namespace (127.0.0.1:18090).
# Fake accounts carry pre-baked capability hints so CPA does not need to probe at boot.
set -e
cd /opt/cliproxyapi
for n in a b c d e; do
  if [ "$n" = e ]; then models='"gemini-3-flash"'; else models='"claude-sonnet-4-6","gemini-3-flash","gemini-3.1-flash-lite"'; fi
  cat > auths/agy-fake-$n.json <<EOF
{"type":"antigravity","access_token":"tok-$n","expires_in":3600,"timestamp":1761300000000,"expired":"2099-01-01T00:00:00Z","email":"fake-$n@example.invalid","project_id":"fake-project-$n","base_url":"http://127.0.0.1:18090","antigravity_capability_hints":{"endpoint":"http://127.0.0.1:18090","model_ids":[$models],"project_id":"fake-project-$n"}}
EOF
done
docker compose restart >/dev/null 2>&1
docker rm -f agy-mock >/dev/null 2>&1 || true
docker run -d --name agy-mock --network container:cli-proxy-api -v /opt/agy-test:/t:ro python:3.12-slim python /t/mock_upstream.py 18090 >/dev/null
sleep 8
