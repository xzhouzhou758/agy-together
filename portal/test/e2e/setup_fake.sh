#!/bin/sh
# 117 variant (CPA uses host networking): create 5 fake antigravity accounts pointing at a
# local mock upstream on 127.0.0.1:18090, then restart CPA. No real Google accounts.
set -e
cd /opt/cliproxyapi
for n in a b c d e; do
  if [ "$n" = e ]; then models='"gemini-3-flash"'; else models='"claude-sonnet-4-6","gemini-3-flash","gemini-3.1-flash-lite"'; fi
  cat > auths/agy-fake-$n.json <<JSON
{"type":"antigravity","access_token":"tok-$n","expires_in":3600,"timestamp":1761300000000,"expired":"2099-01-01T00:00:00Z","email":"fake-$n@example.invalid","project_id":"fake-project-$n","base_url":"http://127.0.0.1:18090","antigravity_capability_hints":{"endpoint":"http://127.0.0.1:18090","model_ids":[$models],"project_id":"fake-project-$n"}}
JSON
done
if [ -f /opt/agy-test/mock.pid ]; then kill "$(cat /opt/agy-test/mock.pid)" 2>/dev/null || true; fi
nohup python3 -I /opt/agy-test/mock_upstream.py 18090 >/opt/agy-test/mock.log 2>&1 &
echo $! > /opt/agy-test/mock.pid
docker compose restart >/dev/null 2>&1
sleep 8
