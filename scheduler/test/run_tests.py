#!/usr/bin/env python3
"""agy-scheduler verification suite. Run on the docker host:

    set -a; . /opt/cliproxyapi/secrets.env; set +a; python3 -I /opt/agy-test/run_tests.py

Prerequisites: setup_fake.sh has created agy-fake-a..e and started the mock
(container agy-mock, sharing cli-proxy-api's network namespace, 127.0.0.1:18090).

Evidence for each request comes from three independent sources:
  * the mock upstream's hit log (which bearer token = which account actually got called),
  * the response body ("hello from tok-x"),
  * the X-CPA-TRACE-ID response header (auth_index of the account CPA finally used).
"""
import concurrent.futures as cf
import http.client
import json
import os
import subprocess
import sys
import time

CPA = ("127.0.0.1", 8317)
API_KEY = os.environ["API_KEY"]
MGMT_KEY = os.environ["MANAGEMENT_KEY"]
ALL = ["a", "b", "c", "d", "e"]
RESULTS = []


def aid(x):
    return f"agy-fake-{x}.json"


def ctl(path, body=None):
    code = (
        "import urllib.request,sys;"
        "d=sys.argv[2].encode() if len(sys.argv)>2 else None;"
        "r=urllib.request.Request('http://127.0.0.1:18090'+sys.argv[1],data=d,method='POST' if d is not None else 'GET');"
        "print(urllib.request.urlopen(r).read().decode())"
    )
    args = ["docker", "exec", "agy-mock", "python", "-c", code, path]
    if body is not None:
        args.append(json.dumps(body))
    return json.loads(subprocess.check_output(args))


def gen_hits():
    return [h for h in ctl("/_log") if "enerateContent" in h["path"]]


def index_map():
    conn = http.client.HTTPConnection(*CPA, timeout=10)
    conn.request("GET", "/v8/management/credentials", headers={"Authorization": "Bearer " + MGMT_KEY})
    files = json.loads(conn.getresponse().read())["files"]
    return {f["auth_index"]: f["id"] for f in files}


def request(allow=None, model="gemini-3-flash", stream=False, path="/v1/chat/completions",
            body=None, raw_headers=None):
    """allow: None = no header; str = header value; list = header repeated."""
    headers = [("Authorization", "Bearer " + API_KEY), ("Content-Type", "application/json")]
    if isinstance(allow, list):
        headers += [("X-Agy-Allow", v) for v in allow]
    elif allow is not None:
        headers.append(("X-Agy-Allow", allow))
    headers += raw_headers or []
    if body is None:
        body = {"model": model, "stream": stream, "messages": [{"role": "user", "content": "hi"}]}
    conn = http.client.HTTPConnection(*CPA, timeout=60)
    conn.putrequest("POST", path)
    data = json.dumps(body).encode()
    for k, v in headers:
        conn.putheader(k, v)
    conn.putheader("Content-Length", str(len(data)))
    conn.endheaders()
    conn.send(data)
    r = conn.getresponse()
    text = r.read().decode(errors="replace")
    used = None
    for tok in ALL:
        if f"tok-{tok}" in text:
            used = tok
    return {"status": r.status, "trace": r.getheader("X-CPA-TRACE-ID") or "", "text": text, "used": used}


def mgmt(method, path, body):
    conn = http.client.HTTPConnection(*CPA, timeout=10)
    conn.request(method, path, body=json.dumps(body),
                 headers={"Authorization": "Bearer " + MGMT_KEY, "Content-Type": "application/json"})
    r = conn.getresponse()
    return r.status, r.read().decode()


def mgmt_patch(body):
    st, txt = mgmt("PATCH", "/v8/management/config", body)
    assert st == 200, (st, txt)


def reset_cooldown(auth_id):
    idx = {v: k for k, v in index_map().items()}[auth_id]
    mgmt("POST", "/v8/management/routing/cooldown/reset", {"auth_index": idx})


def trace_account(trace, imap):
    parts = trace.split("-")
    return imap.get(parts[1]) if len(parts) >= 3 else None


def record(case, ok, detail):
    RESULTS.append((case, ok, detail))
    print(("PASS " if ok else "FAIL ") + case + " :: " + detail, flush=True)


def check_case(case, allow_ids, reqs, expect_success=True, extra_ok=True, note=""):
    """Run request thunks; verify every upstream hit and every served account is inside allow_ids."""
    ctl("/_reset", {})
    imap = index_map()
    outs = [r() for r in reqs]
    hits = gen_hits()
    hit_accounts = sorted({h["token"].replace("tok-", "") for h in hits})
    outside = [a for a in hit_accounts if a not in allow_ids]
    served = [o["used"] for o in outs]
    trace_ok = True
    for o in outs:
        if o["status"] == 200:
            if trace_account(o["trace"], imap) != aid(o["used"]):
                trace_ok = False
    statuses = sorted({o["status"] for o in outs})
    if expect_success:
        ok = not outside and all(o["status"] == 200 and o["used"] in allow_ids for o in outs) and trace_ok
    else:
        ok = not outside and all(o["status"] != 200 for o in outs)
    ok = ok and extra_ok
    detail = f"status={statuses} served={served} upstream_hits={hit_accounts} trace_matches={trace_ok}"
    if not expect_success and outs:
        detail += " err=" + outs[0]["text"][:120].replace("\n", " ")
    if note:
        detail += " | " + note
    record(case, ok, detail)
    return outs, hits


def main():
    ctl("/_reset", {})

    # 1. plain request
    check_case("plain allow=[a,b] x6", ["a", "b"], [lambda: request(f"{aid('a')},{aid('b')}")] * 6)

    # 2. streaming
    def stream_req(allow):
        return lambda: request(allow, stream=True)
    check_case("stream allow=[c] x3", ["c"], [stream_req(aid("c"))] * 3)
    check_case("stream allow=[a,b,d] x6", ["a", "b", "d"], [stream_req(",".join(map(aid, "abd")))] * 6)

    # 3. size-1 list
    check_case("size-1 allow=[d] x4", ["d"], [lambda: request(aid("d"))] * 4)

    # 4. retries, non-stream: a and b always fail, c succeeds
    def retry_case(name, stream, fails, allow, expect_success):
        def run():
            # warm-up: make the healthy account(s) most-recently-used so the
            # least-recently-used pick lands on a failing account first.
            for x in allow:
                if f"tok-{x}" not in fails:
                    request(aid(x))
            ctl("/_reset", {})
            ctl("/_fail", fails)
            return request(",".join(map(aid, allow)), stream=stream)
        outs, hits = check_case(name, allow, [run], expect_success=expect_success)
        seq = [h["token"].replace("tok-", "") + ":" + str(h["status"]) for h in hits]
        print("      upstream sequence:", seq)
        return seq
    retry_case("retry non-stream a=500,b=429 allow=[a,b,c]", False, {"tok-a": "always:500", "tok-b": "always:429"}, ["a", "b", "c"], True)
    retry_case("retry stream a=500,b=429 allow=[a,b,c]", True, {"tok-a": "always:500", "tok-b": "always:429"}, ["a", "b", "c"], True)
    retry_case("retry exhausts list non-stream allow=[a,b] (both fail)", False, {"tok-a": "always:503", "tok-b": "always:503"}, ["a", "b"], False)
    retry_case("retry exhausts list stream allow=[a,b] (both fail)", True, {"tok-a": "always:503", "tok-b": "always:503"}, ["a", "b"], False)
    retry_case("retry size-1 allow=[a] fails", False, {"tok-a": "always:500"}, ["a"], False)

    # 5. model switching (tok-e only has gemini-3-flash)
    check_case("model claude allow=[e,a]", ["a"], [lambda: request(f"{aid('e')},{aid('a')}", model="claude-sonnet-4-6")] * 3)
    check_case("model claude allow=[e] -> reject", [], [lambda: request(aid("e"), model="claude-sonnet-4-6")], expect_success=False)
    check_case("model gemini allow=[e]", ["e"], [lambda: request(aid("e"), model="gemini-3-flash")] * 2)
    check_case("model alternating allow=[b,c]", ["b", "c"],
               [lambda: request(f"{aid('b')},{aid('c')}", model="gemini-3.1-flash-lite"),
                lambda: request(f"{aid('b')},{aid('c')}", model="claude-sonnet-4-6"),
                lambda: request(f"{aid('b')},{aid('c')}", model="gemini-3-flash")])

    # 6. empty / malformed / nonexistent / missing / duplicated
    check_case("empty list", [], [lambda: request("")], expect_success=False)
    check_case("only commas/spaces", [], [lambda: request(" , ,, ")], expect_success=False)
    check_case("nonexistent ids only", [], [lambda: request("nope.json,agy-fake-z.json")], expect_success=False)
    check_case("nonexistent + d", ["d"], [lambda: request(f"nope.json,{aid('d')}")] * 2)
    check_case("header missing -> reject", [], [lambda: request(None)], expect_success=False)
    check_case("header duplicated -> reject", [], [lambda: request([aid("a"), aid("b")])], expect_success=False)
    check_case("header case-insensitive (x-agy-allow)", ["b"],
               [lambda: request(None, raw_headers=[("x-agy-allow", aid("b"))])])

    # 7. other client protocols hitting the same accounts
    claude_body = {"model": "claude-sonnet-4-6", "max_tokens": 50, "messages": [{"role": "user", "content": "hi"}]}
    gemini_body = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
    resp_body = {"model": "gemini-3-flash", "input": "hi"}
    check_case("claude /v1/messages allow=[c]", ["c"], [lambda: request(aid("c"), path="/v1/messages", body=claude_body)])
    check_case("claude /v1/messages stream allow=[c]", ["c"], [lambda: request(aid("c"), path="/v1/messages", body={**claude_body, "stream": True})])
    check_case("gemini native allow=[d]", ["d"], [lambda: request(aid("d"), path="/v1beta/models/gemini-3-flash:generateContent", body=gemini_body)])
    check_case("gemini native stream allow=[d]", ["d"], [lambda: request(aid("d"), path="/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse", body=gemini_body)])
    check_case("openai /v1/responses allow=[b]", ["b"], [lambda: request(aid("b"), path="/v1/responses", body=resp_body)])
    check_case("claude messages no header -> reject", [], [lambda: request(None, path="/v1/messages", body=claude_body)], expect_success=False)
    check_case("gemini native no header -> reject", [], [lambda: request(None, path="/v1beta/models/gemini-3-flash:generateContent", body=gemini_body)], expect_success=False)

    # count_tokens: does it go through the scheduler too?
    ctl("/_reset", {})
    r = request(None, path="/v1/messages/count_tokens", body=claude_body)
    hits = [h["token"] for h in ctl("/_log")]
    record("count_tokens no header", r["status"] != 200 or not hits,
           f"status={r['status']} upstream_hits={hits} body={r['text'][:120]}")

    # 7b. production-like cooldown (cooling enabled): a 429'd allowed account is
    #     removed from candidates; the plugin must reject rather than fall back.
    mgmt_patch({"routing": {"cooldown": {"disable-cooling": False}}})
    time.sleep(3)
    ctl("/_reset", {})
    ctl("/_fail", {"tok-a": [429]})
    first = request(aid("a"))
    ctl("/_reset", {})
    second = request(aid("a"))
    third = request(f"{aid('a')},{aid('b')}")
    hits = [h["token"] for h in gen_hits()]
    record("cooldown: allow=[a] after a got 429", first["status"] == 429 and second["status"] != 200 and third["used"] == "b" and "tok-a" not in hits and set(hits) <= {"tok-b"},
           f"first={first['status']} second={second['status']} ({second['text'][:90]}) third_used={third['used']} upstream_hits_after={hits}")
    mgmt_patch({"routing": {"cooldown": {"disable-cooling": True}}})
    time.sleep(3)
    reset_cooldown(aid("a"))

    # 8. concurrency: two tenants with disjoint lists fire at once
    ctl("/_reset", {})
    imap = index_map()
    jobs = []
    with cf.ThreadPoolExecutor(max_workers=24) as ex:
        for i in range(12):
            jobs.append(("ab", ex.submit(request, f"{aid('a')},{aid('b')}", stream=(i % 2 == 0))))
            jobs.append(("de", ex.submit(request, f"{aid('d')},{aid('e')}", stream=(i % 2 == 1))))
        outs = [(g, f.result()) for g, f in jobs]
    bad = [(g, o["status"], o["used"]) for g, o in outs if o["status"] != 200 or o["used"] not in g]
    trace_bad = [g for g, o in outs if trace_account(o["trace"], imap) != aid(o["used"] or "x")]
    hit_accounts = sorted({h["token"].replace("tok-", "") for h in gen_hits()})
    from collections import Counter
    dist = Counter(o["used"] for _, o in outs)
    record("concurrency 24 parallel (ab vs de, mixed stream)", not bad and "c" not in hit_accounts,
           f"violations={bad} trace_mismatch={len(trace_bad)} upstream_hits={hit_accounts} distribution={dict(dist)}")

    # summary
    print("\nSUMMARY")
    for case, ok, _ in RESULTS:
        print(("PASS" if ok else "FAIL"), "|", case)
    sys.exit(0 if all(ok for _, ok, _ in RESULTS) else 1)


if __name__ == "__main__":
    main()
