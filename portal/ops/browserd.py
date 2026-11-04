#!/usr/bin/env python3
"""agy-browserd: starts and destroys the portal's shared Chromium container on this host.

The portal container gets no docker socket; it calls this helper on 127.0.0.1 instead.
Every docker argument is fixed here: nothing from a request ever reaches docker.
Each session gets a fresh container (--rm, no volumes), so nothing survives between users.

  POST /start   remove any old container, apply egress rules, run a new one, wait until it answers
  POST /stop    remove the container
  GET  /status  {"running": bool}

Auth: Authorization: Bearer $BROWSERD_TOKEN (from /opt/agy-pot/browserd.env).
Python 3.11 stdlib only.
"""
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("BROWSERD_PORT", "8330"))
TOKEN = os.environ.get("BROWSERD_TOKEN", "")
IMAGE = os.environ.get("BROWSER_IMAGE", "lscr.io/linuxserver/chromium:latest")
# Must equal <portal BASE_PATH>/browser/ : the portal forwards the full path unchanged.
SUBFOLDER = os.environ.get("BROWSER_SUBFOLDER", "/xgf/browser/")
NAME = "agy-browser"
NET = "agy-browser-net"
SUBNET = "172.31.250.0/24"
UPSTREAM = "http://127.0.0.1:3010/"
BLOCKED = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]

# linuxserver/docker-baseimage-selkies settings (docs.linuxserver.io/selkies/user-guide/configuration + /security).
SELKIES_ENV = {
    "TZ": "Asia/Shanghai",
    "LC_ALL": "zh_CN.UTF-8",
    "PUID": "1000",
    "PGID": "1000",
    "SUBFOLDER": SUBFOLDER,
    "TITLE": "AGY Browser",
    "CHROME_CLI": "--lang=zh-CN https://accounts.google.com/",
    # HARDEN_DESKTOP: DISABLE_OPEN_TOOLS + DISABLE_SUDO + DISABLE_TERMINALS, no file transfers/command/printing,
    # files and apps sidebar sections hidden. HARDEN_OPENBOX: no close button, no right/middle-click WM menus,
    # WM keybinds off, RESTART_APP relaunches Chromium if it is closed.
    "HARDEN_DESKTOP": "true",
    "HARDEN_OPENBOX": "true",
    "NO_DECOR": "true",
    "SELKIES_FILE_TRANSFERS": "none",
    "SELKIES_COMMAND_ENABLED": "false|locked",
    "SELKIES_PRINTING_ENABLED": "false|locked",
    "SELKIES_UI_SIDEBAR_SHOW_FILES": "false|locked",
    "SELKIES_UI_SIDEBAR_SHOW_APPS": "false|locked",
    "SELKIES_ENABLE_SHARING": "false|locked",
    "SELKIES_UI_SIDEBAR_SHOW_SHARING": "false|locked",
    "SELKIES_MICROPHONE_ENABLED": "false|locked",
    "SELKIES_WEBCAM_ENABLED": "false|locked",
    "NO_WEBCAM": "true",
    "NO_GAMEPAD": "true",
    "SELKIES_AUDIO_ENABLED": "false",
    "SELKIES_MODE": "websockets",
    "SELKIES_ENABLE_DUAL_MODE": "false|locked",
    # keep copy/paste and typing working
    "SELKIES_ENABLE_CLIPBOARD": "true",
}

lock = threading.Lock()


def log(*a):
    print("[browserd]", *a, flush=True)


def run(args, check=False):
    r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if check and r.returncode != 0:
        raise RuntimeError(f"{args[0]} {args[1]} failed: {(r.stderr or r.stdout).strip()[:300]}")
    return r


def host_ips():
    out = run(["ip", "-4", "-o", "addr"]).stdout
    ips = set()
    for m in re.finditer(r"\binet (\d+\.\d+\.\d+\.\d+)/", out):
        ip = m.group(1)
        if not ip.startswith("127."):
            ips.add(ip)
    return sorted(ips)


def ensure_rule(rule, chain="DOCKER-USER"):
    if run(["iptables", "-C", chain] + rule).returncode != 0:
        run(["iptables", "-I", chain] + rule, check=True)


def on_top(rule, chain):
    """(Re)insert at position 1 so it stays above the DROPs."""
    if run(["iptables", "-C", chain] + rule).returncode == 0:
        run(["iptables", "-D", chain] + rule)
    run(["iptables", "-I", chain] + rule, check=True)


def apply_firewall():
    """Container may reach the internet only: no private ranges, no metadata, not this host."""
    run(["iptables", "-N", "DOCKER-USER"])  # exists already once docker runs; ignore the error
    # DROPs are inserted first; the ESTABLISHED rule is inserted last so it sits on top.
    for dst in BLOCKED + [ip + "/32" for ip in host_ips()]:
        ensure_rule(["-s", SUBNET, "-d", dst, "-j", "DROP"])
    on_top(["-s", SUBNET, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"], "DOCKER-USER")
    # Packets to the host's own addresses (bridge gateway, public IPs) take INPUT, not FORWARD/DOCKER-USER:
    # drop anything the container opens towards the host; replies to host-initiated traffic (the proxied UI) pass.
    ensure_rule(["-s", SUBNET, "-j", "DROP"], "INPUT")
    on_top(["-s", SUBNET, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"], "INPUT")


def ensure_network():
    if run(["docker", "network", "inspect", NET]).returncode != 0:
        run(["docker", "network", "create", "--driver", "bridge", "--subnet", SUBNET, NET], check=True)


def remove():
    run(["docker", "rm", "-f", NAME])


def running():
    r = run(["docker", "inspect", "-f", "{{.State.Running}}", NAME])
    return r.returncode == 0 and r.stdout.strip() == "true"


def wait_ready(timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(UPSTREAM.rstrip("/") + SUBFOLDER, timeout=3) as r:
                if r.status < 500:
                    return True
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


# Links the portal may open (Google's verify / appeal pages). Checked again here: the portal is not trusted blindly.
ALLOWED_HOSTS = ("google.com", "googleapis.com")
ALLOWED_EXACT = ("goo.gl", "forms.gle")
START_URL = "https://accounts.google.com/"


def safe_url(u):
    if not isinstance(u, str) or not u or len(u) > 2048 or re.search(r"[\s\"'`\\$<>;|]", u):
        return None
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return None
    h = (p.hostname or "").lower()
    if p.scheme != "https" or p.username or p.password or p.port not in (None, 443):
        return None
    if h in ALLOWED_EXACT or any(h == d or h.endswith("." + d) for d in ALLOWED_HOSTS):
        return u
    return None


def start(url=None):
    remove()
    ensure_network()
    apply_firewall()
    args = ["docker", "run", "-d", "--rm", "--name", NAME,
            "--network", NET, "-p", "127.0.0.1:3010:3000",
            "--shm-size=1g", "--memory=900m", "--memory-swap=1400m", "--cpus=2", "--pids-limit=512"]
    env = dict(SELKIES_ENV, CHROME_CLI="--lang=zh-CN " + (safe_url(url) or START_URL))
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    args.append(IMAGE)
    run(args, check=True)
    if not wait_ready():
        remove()
        raise RuntimeError("browser did not come up in 60s")


def open_url(url):
    """New tab in the running browser: a second chromium hands the URL to the running one and exits."""
    u = safe_url(url)
    if not u:
        raise ValueError("url not allowed")
    if not running():
        raise RuntimeError("browser not running")
    run(["docker", "exec", "-d", "-u", "abc", "-e", "HOME=/config", "-e", "DISPLAY=:1", NAME, "wrapped-chromium", u], check=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "agy-browserd"

    def reply(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def authed(self):
        got = self.headers.get("Authorization", "")
        if TOKEN and hmac.compare_digest(got.encode(), ("Bearer " + TOKEN).encode()):
            return True
        self.reply(401, {"error": "unauthorized"})
        return False

    def do_GET(self):
        if not self.authed():
            return
        if self.path != "/status":
            return self.reply(404, {"error": "not_found"})
        with lock:
            self.reply(200, {"running": running()})

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= 8192:
            return {}
        try:
            b = json.loads(self.rfile.read(n))
            return b if isinstance(b, dict) else {}
        except ValueError:
            return {}

    def do_POST(self):
        if not self.authed():
            return
        if self.path not in ("/start", "/stop", "/open"):
            return self.reply(404, {"error": "not_found"})
        body = self.body()
        with lock:
            try:
                if self.path == "/start":
                    log("start")
                    start(body.get("url"))
                    log("started")
                elif self.path == "/open":
                    log("open")
                    open_url(body.get("url"))
                else:
                    log("stop")
                    remove()
                self.reply(200, {"ok": True})
            except Exception as e:
                log("error:", e)
                if self.path == "/start":
                    remove()
                self.reply(500, {"error": str(e)[:200]})

    def log_message(self, fmt, *args):
        log(self.address_string(), fmt % args)


def main():
    if len(TOKEN) < 16:
        log("BROWSERD_TOKEN missing or shorter than 16 characters")
        sys.exit(1)
    if not re.fullmatch(r"/[A-Za-z0-9_\-/]*/", SUBFOLDER):
        log("BROWSER_SUBFOLDER must look like /xgf/browser/")
        sys.exit(1)
    log(f"listening on 127.0.0.1:{PORT}, image {IMAGE}, subfolder {SUBFOLDER}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
