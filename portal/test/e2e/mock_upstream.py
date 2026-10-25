#!/usr/bin/env python3
"""Mock Antigravity upstream for agy-scheduler tests.

Runs inside the CPA container's network namespace, bound to 127.0.0.1 only.
Every request is recorded with the bearer token (fake accounts use token
"tok-<name>"), so the test can see exactly which account CPA used.

Control endpoints (same port):
  GET  /_log            -> JSON list of recorded hits
  POST /_reset          -> clear hits and failure rules
  POST /_fail           -> body {"tok-a": [429, 500]}  (statuses consumed in order per token)
                           or {"tok-a": "always:429"}
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
HITS = []
FAIL = {}  # token -> list of statuses or "always:NNN"
QUOTA = {}  # token -> {model: remainingFraction}
DELAY = {"ms": 0}  # pause between stream chunks

MODELS = {
    "models": {
        "gemini-3-flash": {"displayName": "Gemini 3 Flash"},
        "claude-sonnet-4-6": {"displayName": "Claude Sonnet 4.6"},
        "gemini-3.1-flash-lite": {"displayName": "Gemini 3.1 Flash Lite"},
    }
}
# tok-e is a "small" account that only has gemini-3-flash (for model-switch tests).
MODELS_SMALL = {"models": {"gemini-3-flash": {"displayName": "Gemini 3 Flash"}}}


def next_failure(token):
    rule = FAIL.get(token)
    if rule is None:
        return None
    if isinstance(rule, str) and rule.startswith("always:"):
        return int(rule.split(":", 1)[1])
    if isinstance(rule, list) and rule:
        return int(rule.pop(0))
    return None


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj, extra=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/_log":
            with LOCK:
                return self._json(200, HITS)
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.path == "/_reset":
            with LOCK:
                HITS.clear()
                FAIL.clear()
                QUOTA.clear()
                DELAY["ms"] = 0
            return self._json(200, {"ok": True})
        if self.path == "/_quota":
            with LOCK:
                QUOTA.update(json.loads(raw or b"{}"))
            return self._json(200, {"ok": True})
        if self.path == "/_delay":
            with LOCK:
                DELAY.update(json.loads(raw or b"{}"))
            return self._json(200, {"ok": True})
        if self.path == "/_fail":
            with LOCK:
                FAIL.update(json.loads(raw or b"{}"))
            return self._json(200, {"ok": True, "fail": FAIL})

        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else auth
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            payload = {}
        model = payload.get("model", "")
        leaked = {k: v for k, v in self.headers.items() if "agy" in k.lower()}
        with LOCK:
            status = None
            if "generateContent" in self.path or "streamGenerateContent" in self.path:
                status = next_failure(token)
            HITS.append({
                "t": time.time(), "path": self.path.split("?")[0], "token": token,
                "model": model, "status": status or 200, "leaked_headers": leaked,
            })

        if "fetchAvailableModels" in self.path:
            base = MODELS_SMALL if token == "tok-e" else MODELS
            q = QUOTA.get(token, {})
            reset = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
            out = {"models": {m: {**v, "quotaInfo": {"remainingFraction": q.get(m, 1.0), "resetTime": reset}} for m, v in base["models"].items()}}
            return self._json(200, out)
        if "loadCodeAssist" in self.path:
            return self._json(200, {"cloudaicompanionProject": "fake-project", "currentTier": {"id": "free-tier"}})
        if "retrieveUserQuota" in self.path or "Quota" in self.path:
            return self._json(200, {"buckets": []})

        if status:
            err = {"error": {"code": status, "message": f"mock forced {status} for {token}",
                             "status": "RESOURCE_EXHAUSTED" if status == 429 else "INTERNAL"}}
            return self._json(status, err)

        text = f"hello from {token}"
        resp = {
            "response": {
                "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7},
                "modelVersion": model or "mock",
                "responseId": "mock-resp",
            },
            "traceId": "mock",
        }
        if "streamGenerateContent" in self.path:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            first = {"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "hello "}]}}],
                                  "modelVersion": model or "mock", "responseId": "mock-resp"}}
            for obj in (first, {"response": {**resp["response"], "candidates": [{"content": {"role": "model", "parts": [{"text": f"from {token}"}]}, "finishReason": "STOP"}]}}):
                chunk = ("data: " + json.dumps(obj) + "\n\n").encode()
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
                time.sleep(0.05 + DELAY["ms"] / 1000.0)
            self.wfile.write(b"0\r\n\r\n")
            return
        return self._json(200, resp)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18090
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
