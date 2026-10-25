#!/usr/bin/env python3
"""End-to-end test: portal (127.0.0.1:8320, DEV_LOGIN=1) -> CPA v8.0.40 + agy-scheduler -> mock upstream.

Run on the server after setup_fake.sh:
    set -a; . /opt/cliproxyapi/secrets.env; set +a; python3 -I /opt/agy-test/e2e.py

Evidence per request: the mock's hit log (bearer token = account actually called) and the
response body ("hello from tok-x"). Every check asserts that no upstream hit ever falls
outside the allowed set for that key.
"""
import concurrent.futures as cf
import http.client
import json
import os
import socket
import sys
import time

PORTAL = ("127.0.0.1", 8320)
CPA = ("127.0.0.1", 8317)
MOCK = ("127.0.0.1", 18090)
MGMT = os.environ["MANAGEMENT_KEY"]
RESULTS = []


def aid(x):
    return f"agy-fake-{x}.json"


def call(addr, method, path, body=None, headers=None, raw=None, timeout=60):
    c = http.client.HTTPConnection(*addr, timeout=timeout)
    h = dict(headers or {})
    data = None
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    c.request(method, path, body=data, headers=h)
    r = c.getresponse()
    txt = r.read().decode(errors="replace")
    try:
        d = json.loads(txt)
    except Exception:
        d = txt
    return r.status, d, txt, r


def mock(path, body=None):
    return call(MOCK, "POST" if body is not None else "GET", path, body)[1]


def gen_hits():
    return [h for h in mock("/_log") if "enerateContent" in h["path"]]


class User:
    def __init__(self, did, name, admin=False):
        self.cookie = ""
        st, d, _, r = call(PORTAL, "POST", "/api/dev-login", {"discordId": did, "name": name, "admin": admin}, {"X-Portal-CSRF": "1"})
        assert st == 200, d
        for k, v in r.getheaders():
            if k.lower() == "set-cookie" and v.startswith("agy_sid="):
                self.cookie = v.split(";")[0]

    def req(self, method, path, body=None):
        st, d, _, _ = call(PORTAL, method, path, body, {"Cookie": self.cookie, "X-Portal-CSRF": "1"})
        return st, d


def gen(key, model="gemini-3-flash", stream=False, path="/v1/chat/completions", body=None, extra=None):
    if body is None:
        body = {"model": model, "stream": stream, "messages": [{"role": "user", "content": "hi"}]}
    h = {"Authorization": "Bearer " + key}
    h.update(extra or {})
    st, _, txt, r = call(PORTAL, "POST", path, body, h)
    used = None
    for t in "abcde":
        if f"tok-{t}" in txt:
            used = t
    return {"status": st, "used": used, "text": txt, "trace": r.getheader("X-CPA-TRACE-ID")}


def record(case, ok, detail):
    RESULTS.append((case, ok, detail))
    print(("PASS " if ok else "FAIL ") + case + " :: " + detail, flush=True)


def check(case, allowed, thunks, expect_ok=True, note=""):
    mock("/_reset", {})
    outs = [t() for t in thunks]
    hits = sorted({h["token"].replace("tok-", "") for h in gen_hits()})
    outside = [h for h in hits if h not in allowed]
    if expect_ok:
        ok = not outside and all(o["status"] == 200 and o["used"] in allowed for o in outs)
    else:
        ok = not outside and all(o["status"] != 200 for o in outs)
    leak = any(o["trace"] for o in outs)
    ok = ok and not leak
    record(case, ok, f"status={sorted({o['status'] for o in outs})} served={[o['used'] for o in outs]} upstream_hits={hits} {note}")
    return outs


def raw_dup_header_request(key, allow_value):
    payload = json.dumps({"model": "gemini-3-flash", "messages": [{"role": "user", "content": "hi"}]})
    s = socket.create_connection(PORTAL)
    s.sendall((f"POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\nContent-Type: application/json\r\n"
               f"x-agy-allow: {allow_value}\r\nX-AGY-ALLOW: {allow_value}\r\nX-Agy-Allow: {allow_value}\r\nConnection: close\r\n"
               f"Content-Length: {len(payload)}\r\n\r\n{payload}").encode())
    buf = b""
    while True:
        b = s.recv(65536)
        if not b:
            break
        buf += b
    s.close()
    txt = buf.decode(errors="replace")
    used = None
    for t in "abcde":
        if f"tok-{t}" in txt:
            used = t
    return {"status": int(txt.split(" ")[1]), "used": used, "text": txt, "trace": None}


def cpa_plugin_enabled(flag):
    st, d, _, _ = call(CPA, "PATCH", "/v8/management/config", {"plugins": {"configs": {"agy-scheduler": {"enabled": flag}}}},
                       {"Authorization": "Bearer " + MGMT})
    assert st == 200, (st, d)


def main():
    alice = User("900001", "alice", admin=True)
    bob = User("900002", "bob")
    carol = User("900003", "carol")

    # adopt the fake accounts: a,b -> alice, c,d -> bob, e -> nobody
    st, accs = alice.req("GET", "/api/admin/accounts")
    ids = {a["id"] for a in accs}
    assert {aid(x) for x in "abcde"} <= ids, ids
    st, users = alice.req("GET", "/api/admin/users")
    uid = {u["name"]: u["id"] for u in users}
    for x, owner in [("a", "alice"), ("b", "alice"), ("c", "bob"), ("d", "bob")]:
        st, d = alice.req("PATCH", "/api/admin/accounts/" + aid(x), {"ownerId": uid[owner]})
        assert st == 200, d
    st, d = bob.req("PATCH", "/api/accounts/" + aid("a"), {"shared": True})
    record("bob cannot modify alice's account", st == 404, f"status={st}")
    st, d = bob.req("GET", "/api/admin/accounts")
    record("non-admin cannot read admin API", st == 403, f"status={st}")

    alice.req("PATCH", "/api/accounts/" + aid("b"), {"shared": True})
    bob.req("PATCH", "/api/accounts/" + aid("d"), {"shared": True})
    alice.req("PUT", "/api/admin/rules", {"keyConc": 8, "keyRpm": 1000, "accConc": 4, "reserve": 0})

    K = {}
    K["alice"] = alice.req("POST", "/api/keys", {"name": "a", "pool": "private"})[1]["key"]
    K["bob"] = bob.req("POST", "/api/keys", {"name": "b", "pool": "private"})[1]["key"]
    K["carol"] = carol.req("POST", "/api/keys", {"name": "c", "pool": "shared"})[1]["key"]
    K["carol_priv"] = carol.req("POST", "/api/keys", {"name": "cp", "pool": "private"})[1]["key"]

    # 1. pools
    check("alice 小锅饭 x8 (stream/non-stream)", ["a", "b"], [lambda i=i: gen(K["alice"], stream=i % 2 == 1) for i in range(8)])
    check("bob 小锅饭 x6", ["c", "d"], [lambda i=i: gen(K["bob"], stream=i % 2 == 0) for i in range(6)])
    check("carol 大锅饭 x8 -> only shared b,d", ["b", "d"], [lambda i=i: gen(K["carol"], stream=i % 3 == 0) for i in range(8)])
    check("carol 小锅饭 with no accounts -> refused", [], [lambda: gen(K["carol_priv"])], expect_ok=False)
    check("bob /v1/messages (claude)", ["c", "d"], [lambda: gen(K["bob"], path="/v1/messages", body={"model": "claude-sonnet-4-6", "max_tokens": 20, "messages": [{"role": "user", "content": "hi"}]})] * 2)
    check("bob /v1beta native stream", ["c", "d"], [lambda: gen(K["bob"], path="/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse", body={"contents": [{"role": "user", "parts": [{"text": "hi"}]}]})] * 2)
    check("bob /v1/responses", ["c", "d"], [lambda: gen(K["bob"], path="/v1/responses", body={"model": "gemini-3-flash", "input": "hi"})] * 2)

    # 2. concurrency mix: two disjoint private keys + shared key at once
    mock("/_reset", {})
    with cf.ThreadPoolExecutor(12) as ex:
        futs = [(who, ex.submit(gen, K[who], "gemini-3-flash", i % 2 == 0)) for i in range(8) for who in ("alice", "bob", "carol")]
        outs = [(w, f.result()) for w, f in futs]
    allowed = {"alice": "ab", "bob": "cd", "carol": "bd"}
    bad = [(w, o["used"]) for w, o in outs if o["status"] != 200 or o["used"] not in allowed[w]]
    hits = sorted({h["token"][4:] for h in gen_hits()})
    record("24 concurrent requests across 3 keys", not bad and set(hits) <= set("abcd"), f"bad={bad} upstream_hits={hits}")

    # 3. client-injected allow header
    check("client X-Agy-Allow: c (fetch-style)", ["a", "b"], [lambda: gen(K["alice"], extra={"X-Agy-Allow": aid("c"), "x-agy-allow-2": aid("c")})] * 3)
    check("client sends 3 raw copies (any case)", ["a", "b"], [lambda: raw_dup_header_request(K["alice"], aid("c") + "," + aid("e"))] * 3)

    # 4. self-use reserve: b's gemini flash quota at 20% < 30% reserve -> leaves the shared pool for flash
    alice.req("PUT", "/api/admin/rules", {"reserve": 30})
    mock("/_quota", {"tok-b": {"gemini-3-flash": 0.2, "gemini-3.1-flash-lite": 0.9, "claude-sonnet-4-6": 0.8}})
    st, q = alice.req("POST", "/api/accounts/" + aid("b") + "/quota")
    groups = q.get("quota", {}) and q["quota"]["groups"]
    record("quota fetched via CPA api-call", st == 200 and any(g[0] == "gf" and abs(g[1] - 0.2) < 1e-6 for g in groups), f"groups={groups}")
    check("reserve: carol flash -> only d", ["d"], [lambda: gen(K["carol"], model="gemini-3-flash")] * 4)
    check("reserve: carol claude -> b,d still eligible", ["b", "d"], [lambda: gen(K["carol"], model="claude-sonnet-4-6")] * 4)
    outs = check("reserve: owner's 小锅饭 still uses b", ["a", "b"], [lambda: gen(K["alice"], model="gemini-3-flash")] * 4)
    record("owner still served by b", any(o["used"] == "b" for o in outs), str([o["used"] for o in outs]))
    alice.req("PUT", "/api/admin/rules", {"reserve": 0})

    # 5. per-account concurrency cap
    alice.req("PUT", "/api/admin/rules", {"accConc": 1, "keyConc": 8, "keyRpm": 1000})
    mock("/_reset", {})
    mock("/_delay", {"ms": 2500})
    with cf.ThreadPoolExecutor(3) as ex:
        f1 = ex.submit(gen, K["carol"], "gemini-3-flash", True)
        time.sleep(0.8)
        f2 = ex.submit(gen, K["carol"], "gemini-3-flash", True)
        time.sleep(0.8)
        r3 = gen(K["carol"])
        r1, r2 = f1.result(), f2.result()
    mock("/_delay", {"ms": 0})
    record("accConc=1: two streams on different accounts, third refused",
           r1["status"] == 200 and r2["status"] == 200 and r1["used"] != r2["used"] and {r1["used"], r2["used"]} <= {"b", "d"} and r3["status"] == 503,
           f"r1={r1['used']} r2={r2['used']} r3={r3['status']}")

    # 6. shared key concurrency / rate
    alice.req("PUT", "/api/admin/rules", {"accConc": 4, "keyConc": 1, "keyRpm": 1000})
    mock("/_delay", {"ms": 2000})
    with cf.ThreadPoolExecutor(2) as ex:
        f1 = ex.submit(gen, K["carol"], "gemini-3-flash", True)
        time.sleep(0.8)
        r2 = gen(K["carol"])
        r1 = f1.result()
    mock("/_delay", {"ms": 0})
    record("keyConc=1: second concurrent shared request -> 429", r1["status"] == 200 and r2["status"] == 429, f"{r1['status']},{r2['status']}")
    alice.req("PUT", "/api/admin/rules", {"keyConc": 8, "keyRpm": 3})
    k2 = carol.req("POST", "/api/keys", {"name": "rate", "pool": "shared"})[1]["key"]
    sts = [gen(k2)["status"] for _ in range(4)]
    record("keyRpm=3: 4th request in a minute -> 429", sts == [200, 200, 200, 429], str(sts))
    alice.req("PUT", "/api/admin/rules", {"keyConc": 8, "keyRpm": 60, "accConc": 2, "reserve": 30})

    # 7. plugin disabled -> portal fails closed
    cpa_plugin_enabled(False)
    time.sleep(6)
    st, plist, _, _ = call(CPA, "GET", "/v8/management/plugins", headers={"Authorization": "Bearer " + MGMT})
    eff = [p for p in plist["plugins"] if p["id"] == "agy-scheduler"][0]["effective_enabled"]
    mock("/_reset", {})
    r = gen(K["alice"])
    hits = gen_hits()
    record("plugin disabled -> portal refuses, upstream untouched", eff is False and r["status"] == 503 and "scheduler_unavailable" in r["text"] and not hits,
           f"effective_enabled={eff} status={r['status']} hits={len(hits)}")
    cpa_plugin_enabled(True)
    time.sleep(6)
    check("plugin re-enabled -> works again", ["a", "b"], [lambda: gen(K["alice"])] * 2)

    # 8. disable a user -> keys and CPA credentials disabled
    alice.req("PATCH", f"/api/admin/users/{uid['bob']}", {"active": False})
    r = gen(K["bob"])
    st, accs = alice.req("GET", "/api/admin/accounts")
    dis = {a["id"]: a["active"] for a in accs}
    check("bob disabled: carol 大锅饭 only b", ["b"], [lambda: gen(K["carol"], model="claude-sonnet-4-6")] * 3)
    record("bob disabled: key 401, c/d disabled in CPA", r["status"] == 401 and dis[aid("c")] is False and dis[aid("d")] is False, f"key={r['status']} c={dis[aid('c')]} d={dis[aid('d')]}")
    alice.req("PATCH", f"/api/admin/users/{uid['bob']}", {"active": True})
    st, _ = bob.req("GET", "/api/me")
    record("bob's sessions were dropped on disable", st == 401, f"status={st}")
    bob = User("900002", "bob")
    check("bob re-enabled", ["c", "d"], [lambda: gen(K["bob"])] * 2)

    # 9. usage rows with tokens, privacy
    time.sleep(8)
    st, rows = alice.req("GET", "/api/usage/requests?limit=500")
    with_tok = [r for r in rows if r["result"] == "ok" and (r["tokens"] or 0) > 0]
    ok_rows = [r for r in rows if r["result"] == "ok"]
    record("usage rows recorded with tokens", len(ok_rows) > 10 and len(with_tok) == len(ok_rows), f"ok_rows={len(ok_rows)} with_tokens={len(with_tok)} sample={ok_rows[0] if ok_rows else None}")
    st, crow = carol.req("GET", "/api/usage/requests?pool=shared&limit=500")
    blob = json.dumps(crow)
    record("shared caller sees no emails / account ids", "@" not in blob and "agy-fake" not in blob and len(crow) > 5, f"rows={len(crow)} sample={crow[0]['account'] if crow else None}")
    st, contrib = bob.req("GET", "/api/usage/contributions")
    record("contributor book (bob's d served carol)", any(c["id"] == aid("d") and c["count"] > 0 and c["tokens"] > 0 for c in contrib) and "carol" not in json.dumps(contrib),
           json.dumps([{k: c[k] for k in ("id", "count", "tokens")} for c in contrib]))
    st, u = alice.req("GET", "/api/admin/usage")
    record("admin site usage", u["total"] > 0 and u["private"] > 0 and u["shared"] > 0 and u["rejected"] > 0 and not u["breaker"]["tripped"],
           f"total={u['total']} private={u['private']} shared={u['shared']} no_account={u['rejected']} tokens={u['tokens']} breaker={u['breaker']['tripped']}")

    print()
    passed = sum(1 for r in RESULTS if r[1])
    print(f"{passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
