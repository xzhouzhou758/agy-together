#!/usr/bin/env bash
# AGY Together one-click installer: CLIProxyAPI v8.0.40 + agy-scheduler plugin + the portal.
#
#   curl -fsSL https://raw.githubusercontent.com/xzhouzhou758/agy-together/main/install.sh | sudo bash -s -- --domain pot.example.com
#
# Piped like this it downloads the repository to /opt/agy-together/src first; run from a clone it uses the clone.
#
# Without options it asks: run on the server IP (password login, no domain needed) or on a domain.
# Options (or the same names as environment variables):
#   --ip [1.2.3.4]           IP mode: the portal listens on 0.0.0.0:PORT over plain http, login with a password admin
#   --admin-user NAME        password admin to create / reset (IP mode asks; domain mode optional)
#   --admin-pass PASS        its password (empty = generate one)
#   --domain example.com     domain mode: public site, e.g. https://example.com (sets PUBLIC_URL and the Discord callback)
#   --base-path /xgf         serve the portal under a sub-path (default: site root)
#   --port 8320              portal port on 127.0.0.1
#   --nginx                  also write an nginx site for the domain (nginx must already be installed)
#   --plugin-so PATH         use a prebuilt agy-scheduler.so instead of compiling it
#
# Everything binds to 127.0.0.1; put your own HTTPS reverse proxy in front of the portal.
# Re-running is safe: existing keys, config, credentials and data are kept; code is updated.
set -euo pipefail
REPO=${REPO:-xzhouzhou758/agy-together}
BRANCH=${BRANCH:-main}

CPA_IMAGE=eceasy/cli-proxy-api:v8.0.40
GO_IMAGE=golang:1.26-bookworm
CPA_DIR=${CPA_DIR:-/opt/cliproxyapi}
POT_DIR=${POT_DIR:-/opt/agy-pot}
DOMAIN=${DOMAIN:-}
BASE_PATH=${BASE_PATH:-}
PORT=${PORT:-8320}
NGINX=${NGINX:-0}
PLUGIN_SO=${PLUGIN_SO:-}
MODE=${MODE:-}
IP=${IP:-}
ADMIN_USER=${ADMIN_USER:-}
ADMIN_PASS=${ADMIN_PASS:-}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) MODE=domain; DOMAIN=$2; shift 2 ;;
    --ip) MODE=ip; if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then IP=$2; shift; fi; shift ;;
    --admin-user) ADMIN_USER=$2; shift 2 ;;
    --admin-pass) ADMIN_PASS=$2; shift 2 ;;
    --base-path) BASE_PATH=$2; shift 2 ;;
    --port) PORT=$2; PORT_SET=1; shift 2 ;;
    --nginx) NGINX=1; shift ;;
    --plugin-so) PLUGIN_SO=$2; shift 2 ;;
    -h|--help) echo "usage: install.sh [--ip [ADDR] | --domain D] [--admin-user U --admin-pass P] [--base-path /p] [--port N] [--nginx] [--plugin-so PATH]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
rand() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
SRC=""
[ -f "${BASH_SOURCE[0]:-}" ] && SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -z "$SRC" ] || [ ! -f "$SRC/portal/src/main.ts" ] || [ ! -f "$SRC/scheduler/main.go" ]; then
  # piped from curl: fetch the repository (latest $BRANCH) and use that
  SRC=/opt/agy-together/src
  say "downloading github.com/$REPO ($BRANCH) → $SRC"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  TMP=$(mktemp -d)
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar xz -C "$TMP" || die "download failed"
  rm -rf "$SRC"; mkdir -p "$(dirname "$SRC")"
  mv "$TMP"/*/ "$SRC"; rm -rf "$TMP"
fi
[ "$(uname -m)" = x86_64 ] || die "only amd64 is supported (the CLIProxyAPI image and plugin are amd64)"
# ---------- IP or domain ----------
ask() { # prompt default -> REPLY (reads the terminal even when the script is piped)
  local a=""
  if [ -r /dev/tty ]; then printf '%s' "$1" > /dev/tty; IFS= read -r a < /dev/tty || true; fi
  REPLY=${a:-$2}
}
detect_ip() { curl -fs -m 5 https://api.ipify.org 2>/dev/null || curl -fs -m 5 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'; }
[ -n "$MODE" ] || [ -n "$DOMAIN" ] && MODE=${MODE:-domain}
if [ -z "$MODE" ]; then
  [ -r /dev/tty ] || die "no terminal to ask on: pass --ip or --domain"
  printf '\n选择运行方式：\n  1) IP 直接访问（http://服务器IP:端口，用账号密码登录，不需要域名）\n  2) 域名（https，可用 Discord 登录）\n' > /dev/tty
  ask "请输入 1 或 2 [1]: " 1
  [ "$REPLY" = 2 ] && MODE=domain || MODE=ip
fi
if [ "$MODE" = ip ]; then
  [ -n "$IP" ] || { d=$(detect_ip); ask "服务器 IP [$d]: " "$d"; IP=$REPLY; }
  [ -n "$IP" ] || die "could not detect the server IP: pass --ip 1.2.3.4"
  [ -r /dev/tty ] && [ -z "${PORT_SET:-}" ] && { ask "门户端口 [$PORT]: " "$PORT"; PORT=$REPLY; }
  [ -n "$ADMIN_USER" ] || { ask "管理员用户名 [admin]: " admin; ADMIN_USER=$REPLY; }
  if [ -z "$ADMIN_PASS" ] && [ -r /dev/tty ]; then
    printf '管理员密码（至少 8 位，直接回车自动生成）: ' > /dev/tty; IFS= read -rs ADMIN_PASS < /dev/tty || true; echo > /dev/tty
  fi
  DOMAIN=""; BASE_PATH=""; NGINX=0
else
  [ -n "$DOMAIN" ] || { ask "域名（如 pot.example.com）: " ""; DOMAIN=$REPLY; }
  [ -n "$DOMAIN" ] || die "domain mode needs a domain"
fi
if [ -n "$ADMIN_USER" ] && [ -z "$ADMIN_PASS" ]; then ADMIN_PASS=$(rand 16); GENPASS=1; fi
[ -z "$ADMIN_PASS" ] || [ ${#ADMIN_PASS} -ge 8 ] || die "admin password must be at least 8 characters"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "bad port: $PORT"
DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}
if [ -n "$BASE_PATH" ]; then BASE_PATH="/${BASE_PATH#/}"; BASE_PATH=${BASE_PATH%/}; fi

# ---------- docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin is missing (install docker-compose-plugin)"
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------- CLIProxyAPI ----------
say "CLIProxyAPI → $CPA_DIR"
mkdir -p "$CPA_DIR"/{auths,logs,plugins}
chmod 700 "$CPA_DIR" "$CPA_DIR/auths"
if [ -f "$CPA_DIR/secrets.env" ]; then
  # shellcheck disable=SC1091
  . "$CPA_DIR/secrets.env"
fi
MANAGEMENT_KEY=${MANAGEMENT_KEY:-$(rand 48)}
API_KEY=${API_KEY:-sk-$(rand 48)}
umask 077
printf 'MANAGEMENT_KEY=%s\nAPI_KEY=%s\n' "$MANAGEMENT_KEY" "$API_KEY" > "$CPA_DIR/secrets.env"
umask 022
if [ ! -f "$CPA_DIR/config.yaml" ]; then
  # CLIProxyAPI hashes a plain management secret-key on first start.
  cat > "$CPA_DIR/config.yaml" <<EOF
server:
    host: "127.0.0.1"
    port: 8317
management:
    allow-remote: false
    secret-key: "$MANAGEMENT_KEY"
access:
    api-keys:
        - "$API_KEY"
plugins:
    enabled: true
    dir: "plugins"
    configs:
        agy-scheduler:
            enabled: true
            priority: 1
            header: "X-Agy-Allow"
            allow_missing_header: false
            log_picks: true
            session_ttl: "1h"
            max_sessions: 20000
observability:
    logs:
        request-log: false
        logging-to-file: true
        logs-max-total-size-mb: 500
        error-logs-max-files: 10
    usage:
        usage-statistics-enabled: true
        redis-usage-queue-retention-seconds: 60
routing:
    retry:
        request-retry: 2
        max-retry-credentials: 3
        max-retry-interval: 45
EOF
  chmod 600 "$CPA_DIR/config.yaml"
else
  grep -q 'agy-scheduler' "$CPA_DIR/config.yaml" || die "$CPA_DIR/config.yaml exists but has no agy-scheduler plugin config; add the block from scheduler/README.md first"
fi
cp "$SRC/portal/deploy/cpa-docker-compose.yml" "$CPA_DIR/docker-compose.yml"

# ---------- agy-scheduler plugin ----------
if [ -n "$PLUGIN_SO" ]; then
  say "using prebuilt plugin $PLUGIN_SO"
  install -m 755 "$PLUGIN_SO" "$CPA_DIR/plugins/agy-scheduler.so"
else
  say "building agy-scheduler.so in $GO_IMAGE (first run downloads ~1 GB)"
  BUILD=$(mktemp -d)
  cp -r "$SRC/scheduler/." "$BUILD/"
  docker run --rm -v "$BUILD":/src -w /src "$GO_IMAGE" \
    sh -c 'CGO_ENABLED=1 go build -mod=vendor -buildmode=c-shared -trimpath -o agy-scheduler.so . && rm -f agy-scheduler.h'
  install -m 755 "$BUILD/agy-scheduler.so" "$CPA_DIR/plugins/agy-scheduler.so"
  rm -rf "$BUILD"
fi

say "starting CLIProxyAPI"
(cd "$CPA_DIR" && docker compose pull -q && docker compose up -d --force-recreate)
for i in $(seq 1 30); do
  curl -fs -o /dev/null -H "Authorization: Bearer $MANAGEMENT_KEY" http://127.0.0.1:8317/v8/management/plugins && break
  sleep 2
  [ "$i" = 30 ] && die "CLIProxyAPI did not come up: docker logs cli-proxy-api"
done
curl -fs -H "Authorization: Bearer $MANAGEMENT_KEY" http://127.0.0.1:8317/v8/management/plugins \
  | grep -q '"id":"agy-scheduler"[^}]*"effective_enabled":true' \
  || die "agy-scheduler plugin is not active: docker logs cli-proxy-api | grep -i plugin"

# ---------- portal ----------
say "portal → $POT_DIR"
mkdir -p "$POT_DIR/app" "$POT_DIR/data"
rm -rf "$POT_DIR/app/src" "$POT_DIR/app/public"
cp -r "$SRC/portal/src" "$SRC/portal/public" "$SRC/portal/package.json" "$SRC/portal/Dockerfile" "$SRC/portal/.dockerignore" "$POT_DIR/app/"
cp "$SRC/portal/deploy/docker-compose.yml" "$POT_DIR/docker-compose.yml"
sed -i "s/PORT: \"8320\"/PORT: \"$PORT\"/" "$POT_DIR/docker-compose.yml"
[ "$MODE" = ip ] && sed -i 's/HOST: 127.0.0.1/HOST: 0.0.0.0/' "$POT_DIR/docker-compose.yml"
chown 1000:1000 "$POT_DIR/data"; chmod 700 "$POT_DIR/data"
PUBLIC_URL=""
[ -n "$DOMAIN" ] && PUBLIC_URL="https://$DOMAIN$BASE_PATH"
[ "$MODE" = ip ] && PUBLIC_URL="http://$IP:$PORT"
touch "$POT_DIR/portal.env"; chmod 600 "$POT_DIR/portal.env"
setenv() { # key value: replace or append in portal.env
  if grep -q "^$1=" "$POT_DIR/portal.env"; then sed -i "s|^$1=.*|$1=$2|" "$POT_DIR/portal.env"; else echo "$1=$2" >> "$POT_DIR/portal.env"; fi
}
setenv CPA_URL http://127.0.0.1:8317
setenv CPA_API_KEY "$API_KEY"
setenv CPA_MANAGEMENT_KEY "$MANAGEMENT_KEY"
setenv COOKIE_SECURE "$([ "$MODE" = ip ] && echo 0 || echo 1)"
setenv BASE_PATH "$BASE_PATH"
setenv PUBLIC_URL "$PUBLIC_URL"

say "building and starting the portal"
(cd "$POT_DIR" && docker compose build -q && docker compose up -d)
for i in $(seq 1 30); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT$BASE_PATH/healthz" && break
  sleep 2
  [ "$i" = 30 ] && die "portal did not come up: docker logs agy-pot"
done

# ---------- password admin ----------
if [ -n "$ADMIN_USER" ]; then
  printf '%s\n%s\n' "$ADMIN_USER" "$ADMIN_PASS" | (cd "$POT_DIR" && docker compose exec -T agy-pot node --disable-warning=ExperimentalWarning src/admin-cli.ts) \
    || die "could not create the admin (username: 3-32 chars of a-z 0-9 _ . -)"
fi

# ---------- daily backup ----------
install -d -m 755 /opt/agy-backup
install -m 755 "$SRC/portal/ops/backup.sh" /opt/agy-backup/backup.sh
if ! command -v python3 >/dev/null 2>&1 || ! command -v crontab >/dev/null 2>&1; then
  say "skipping the daily backup (needs python3 and cron); the script is at /opt/agy-backup/backup.sh"
elif ! crontab -l 2>/dev/null | grep -q /opt/agy-backup/backup.sh; then
  (crontab -l 2>/dev/null; echo "17 4 * * * /opt/agy-backup/backup.sh >> /opt/agy-backup/backup.log 2>&1") | crontab -
  say "daily backup at 04:17 → /root/agy-backups (keeps 7)"
fi

# ---------- optional nginx ----------
if [ "$NGINX" = 1 ]; then
  [ -n "$DOMAIN" ] || die "--nginx needs --domain"
  command -v nginx >/dev/null 2>&1 || die "nginx is not installed"
  CONF=/etc/nginx/conf.d/agy-together.conf
  LOC=${BASE_PATH:-/}
  [ "$LOC" = / ] || LOC="$LOC/"
  cat > "$CONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location $LOC {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 50m;
    }
}
EOF
  nginx -t && (systemctl reload nginx 2>/dev/null || nginx -s reload)
  say "nginx site written to $CONF (HTTP only — add HTTPS, e.g. certbot --nginx -d $DOMAIN)"
fi

# ---------- done ----------
TOKEN=$(cat "$POT_DIR/data/setup-token" 2>/dev/null || true)
echo
say "安装完成"
echo "  CLIProxyAPI : 127.0.0.1:8317（密钥在 $CPA_DIR/secrets.env）"
if [ "$MODE" = ip ]; then
  echo "  门户        : http://$IP:$PORT"
  echo "  API 地址    : http://$IP:$PORT/v1   （登录后在「API 密钥」里创建密钥）"
  echo "  管理员      : $ADMIN_USER"
  [ "${GENPASS:-}" = 1 ] && echo "  密码        : $ADMIN_PASS   （自动生成，请保存好）"
  echo "  记得在防火墙 / 云安全组放行 TCP $PORT。IP 模式是明文 http，有条件还是建议换成域名 + https。"
else
  echo "  门户        : 127.0.0.1:$PORT$BASE_PATH（用 HTTPS 反向代理指向这里）"
  echo "  站点        : $PUBLIC_URL"
  echo "  API 地址    : $PUBLIC_URL/v1"
  echo "  Discord 回调: $PUBLIC_URL/auth/discord/callback"
  [ -n "$ADMIN_USER" ] && echo "  管理员      : $ADMIN_USER${GENPASS:+   密码：$ADMIN_PASS（自动生成）}"
  if [ -n "$TOKEN" ]; then
    echo
    echo "  首次设置：打开 $PUBLIC_URL/setup 填 Discord 应用信息"
    echo "  Setup Token: $TOKEN"
  fi
fi
