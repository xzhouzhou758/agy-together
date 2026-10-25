#!/usr/bin/env python3
"""Post-pick check against the real CPA: with the portal's plugin-health cache made long
(PLUGIN_CHECK_CACHE_MS=600000) the plugin is disabled behind the portal's back, so CPA's built-in
scheduler ignores X-Agy-Allow. The portal must notice the foreign account in X-CPA-TRACE-ID,
send no upstream bytes to the client, raise an alarm and lock the gateway."""
import json, os, sys, time
sys.path.insert(0, "/opt/agy-test")
from e2e import User, gen, call, CPA, MGMT, cpa_plugin_enabled, aid, mock, gen_hits

alice = User("900001", "alice", admin=True)
key = alice.req("POST", "/api/keys", {"name": "breaker", "pool": "private"})[1]["key"]
alice.req("POST", "/api/admin/breaker/reset")
assert gen(key)["status"] == 200  # warms the plugin-health cache
cpa_plugin_enabled(False)
time.sleep(6)
out = []
mock("/_reset", {})
for i in range(10):
    r = gen(key)
    out.append((r["status"], r["used"]))
    if r["status"] != 200:
        break
cpa_plugin_enabled(True)
time.sleep(6)
hits = [h["token"][4:] for h in gen_hits()]
st, u = alice.req("GET", "/api/admin/usage")
after = gen(key)
leaked = [o for o in out if o[1] not in (None, "a", "b")]
ok = out[-1][0] == 502 and not leaked and u["breaker"]["tripped"] and u["alarms"][0]["kind"] in ("allow_violation", "usage_allow_violation") and after["status"] == 503
print(("PASS" if ok else "FAIL"), "plugin bypassed -> foreign account detected, response blocked, gateway locked ::",
      f"responses={out} upstream_hits={hits} breaker={u['breaker']} alarm={u['alarms'][0]['kind'] if u['alarms'] else None} next_request={after['status']}")
alice.req("POST", "/api/admin/breaker/reset")
r = gen(key)
print("PASS" if r["status"] == 200 else "FAIL", "breaker reset by admin -> traffic resumes ::", r["status"], r["used"])
