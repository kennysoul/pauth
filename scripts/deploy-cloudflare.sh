#!/usr/bin/env bash
# Bootstrap Cloudflare D1 + KV, clone/pull pauth from GitHub, migrate, and deploy.
#
# Prerequisites:
#   - Node.js 20+
#   - git
#   - wrangler auth: `npx wrangler login` OR export CLOUDFLARE_API_TOKEN
#
# Examples:
#   ./scripts/deploy-cloudflare.sh
#   ./scripts/deploy-cloudflare.sh --zone kass.cc --auth-host auth.kass.cc --yes
#   ./scripts/deploy-cloudflare.sh --dir . --skip-clone --yes   # from existing checkout

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO="https://github.com/kennysoul/pauth.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="${HOME}/pauth"
DEFAULT_WORKER_NAME="passkey-auth"
DEFAULT_D1_NAME="passkey-auth-db"
DEFAULT_KV_TITLE="CHALLENGES"
DEFAULT_RP_NAME="Kass Auth"
DEFAULT_DB_LOCATION="apac"

REPO_URL="$DEFAULT_REPO"
GIT_BRANCH="$DEFAULT_BRANCH"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
ZONE_NAME=""
AUTH_HOST=""
RP_NAME="$DEFAULT_RP_NAME"
WORKER_NAME="$DEFAULT_WORKER_NAME"
D1_NAME="$DEFAULT_D1_NAME"
KV_TITLE="$DEFAULT_KV_TITLE"
DB_LOCATION="$DEFAULT_DB_LOCATION"
SESSION_SECRET=""
SKIP_CLONE=0
ASSUME_YES=0
NON_INTERACTIVE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { printf '%b\n' "${GREEN}→${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*"; }
die() { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy-cloudflare.sh [options]

Interactive bootstrap for pauth on Cloudflare (D1 + KV + deploy).

Options:
  --repo URL           GitHub repo (default: https://github.com/kennysoul/pauth.git)
  --branch NAME        Git branch (default: main)
  --dir PATH           Install directory (default: ~/pauth)
  --zone DOMAIN        Apex zone on Cloudflare, e.g. kass.cc (required with --yes)
  --auth-host HOST     Auth hostname (default: auth.<zone>)
  --rp-name NAME       WebAuthn display name (default: Kass Auth)
  --worker-name NAME   Worker name in wrangler (default: passkey-auth)
  --d1-name NAME       D1 database name (default: passkey-auth-db)
  --kv-title TITLE     KV namespace title (default: CHALLENGES)
  --db-location LOC    D1 location hint: apac|weur|eeur|wnam|enam|oc (default: apac)
  --session-secret STR SESSION_SECRET (auto-generated if omitted)
  --skip-clone         Use --dir as existing checkout; do not git clone/pull
  --yes, -y            Non-interactive; requires --zone (and --auth-host or default)
  -h, --help           Show this help

Private GitHub repos: use SSH URL (git@github.com:org/pauth.git) or HTTPS with a PAT.
Auth: run `npx wrangler login` first, or set CLOUDFLARE_API_TOKEN.
EOF
}

prompt() {
  local var_name="$1"
  local question="$2"
  local default="${3:-}"
  local value=""
  if [[ -n "$default" ]]; then
    read -r -p "$question [$default]: " value
    value="${value:-$default}"
  else
    read -r -p "$question: " value
  fi
  printf -v "$var_name" '%s' "$value"
}

confirm() {
  local question="$1"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  read -r -p "$question [y/N]: " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) GIT_BRANCH="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --zone) ZONE_NAME="$2"; shift 2 ;;
    --auth-host) AUTH_HOST="$2"; shift 2 ;;
    --rp-name) RP_NAME="$2"; shift 2 ;;
    --worker-name) WORKER_NAME="$2"; shift 2 ;;
    --d1-name) D1_NAME="$2"; shift 2 ;;
    --kv-title) KV_TITLE="$2"; shift 2 ;;
    --db-location) DB_LOCATION="$2"; shift 2 ;;
    --session-secret) SESSION_SECRET="$2"; shift 2 ;;
    --skip-clone) SKIP_CLONE=1; shift ;;
    --yes|-y) ASSUME_YES=1; NON_INTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

need_cmd node
need_cmd npm
need_cmd git
need_cmd python3

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js 20+ required (found $(node -v))"

if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  echo ""
  echo "=== pauth · Cloudflare 一键部署 ==="
  echo ""
  prompt REPO_URL "GitHub 仓库 URL" "$DEFAULT_REPO"
  prompt GIT_BRANCH "分支" "$DEFAULT_BRANCH"
  prompt INSTALL_DIR "安装目录" "$DEFAULT_INSTALL_DIR"
  prompt ZONE_NAME "根域名（须在 Cloudflare 托管）" ""
  [[ -n "$ZONE_NAME" ]] || die "根域名不能为空"
  prompt AUTH_HOST "认证站点主机名" "auth.${ZONE_NAME}"
  prompt RP_NAME "Passkey 显示名称 (RP_NAME)" "$DEFAULT_RP_NAME"
  prompt DB_LOCATION "D1 区域" "$DEFAULT_DB_LOCATION"
  if [[ -z "$SESSION_SECRET" ]]; then
    read -r -p "SESSION_SECRET（留空则自动生成）: " SESSION_SECRET
  fi
  echo ""
  info "将部署到: https://${AUTH_HOST}"
  info "Cookie 域: .${ZONE_NAME}"
  confirm "继续？" || exit 0
else
  [[ -n "$ZONE_NAME" ]] || die "--yes 需要同时提供 --zone"
  AUTH_HOST="${AUTH_HOST:-auth.${ZONE_NAME}}"
fi

RP_ID="$ZONE_NAME"
ORIGIN="https://${AUTH_HOST}"
COOKIE_DOMAIN=".${ZONE_NAME}"

if [[ -z "$SESSION_SECRET" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    SESSION_SECRET="$(openssl rand -base64 32)"
  else
    SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  fi
  info "已自动生成 SESSION_SECRET"
fi

[[ ${#SESSION_SECRET} -ge 32 ]] || die "SESSION_SECRET 至少 32 个字符"

info "检查 Wrangler 登录状态…"
if ! npx wrangler whoami >/dev/null 2>&1; then
  die "Wrangler 未登录。请先运行: npx wrangler login  （或设置 CLOUDFLARE_API_TOKEN）"
fi
npx wrangler whoami

# ── Clone / pull ─────────────────────────────────────────────────────────────

if [[ "$SKIP_CLONE" -eq 1 ]]; then
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
  [[ -f "$INSTALL_DIR/package.json" ]] || die "--skip-clone 目录不是有效的 pauth 项目: $INSTALL_DIR"
  info "使用现有目录: $INSTALL_DIR"
else
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "目录已存在，执行 git pull: $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin "$GIT_BRANCH"
    git -C "$INSTALL_DIR" checkout "$GIT_BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_BRANCH"
  else
    info "克隆仓库到 $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --branch "$GIT_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
fi

cd "$INSTALL_DIR"

# ── Cloudflare resources ─────────────────────────────────────────────────────

find_d1_id() {
  npx wrangler d1 list --json 2>/dev/null | python3 -c "
import json, sys
name = sys.argv[1]
data = json.load(sys.stdin)
for row in data:
    if row.get('name') == name:
        print(row.get('uuid') or row.get('database_id') or '')
        break
" "$D1_NAME"
}

create_d1() {
  info "创建 D1 数据库: $D1_NAME ($DB_LOCATION)"
  local out
  out="$(npx wrangler d1 create "$D1_NAME" --location "$DB_LOCATION" 2>&1)" || die "D1 创建失败: $out"
  printf '%s\n' "$out"
}

find_kv_id() {
  local title="$1"
  local want_preview="${2:-0}"
  npx wrangler kv namespace list 2>/dev/null | python3 -c "
import json, sys, re
title = sys.argv[1]
want_preview = sys.argv[2] == '1'
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(0)
if not isinstance(data, list):
    sys.exit(0)
for row in data:
    t = row.get('title', '')
    is_preview = 'preview' in t.lower()
    if want_preview:
        if title in t and is_preview:
            print(row.get('id', ''))
            break
    elif t == title and not is_preview:
        print(row.get('id', ''))
        break
" "$title" "$want_preview"
}

create_kv() {
  local title="$1"
  local preview_flag="${2:-}"
  info "创建 KV 命名空间: $title${preview_flag:+ (preview)}"
  local out id
  if [[ -n "$preview_flag" ]]; then
    out="$(npx wrangler kv namespace create "$title" --preview 2>&1)"
  else
    out="$(npx wrangler kv namespace create "$title" 2>&1)"
  fi
  id="$(printf '%s\n' "$out" | python3 -c "
import re, sys
text = sys.stdin.read()
m = re.search(r\"\\\"id\\\":\\s*\\\"([a-f0-9]{32})\\\"\", text)
if not m:
    m = re.search(r\"id\\s*=\\s*['\\\"]([a-f0-9]{32})['\\\"]\", text)
print(m.group(1) if m else '')
")"
  [[ -n "$id" ]] || die "无法解析 KV id: $out"
  printf '%s' "$id"
}

D1_ID="$(find_d1_id || true)"
if [[ -z "$D1_ID" ]]; then
  create_d1 >/dev/null
  D1_ID="$(find_d1_id)"
fi
[[ -n "$D1_ID" ]] || die "无法获取 D1 database_id"
info "D1: $D1_NAME → $D1_ID"

KV_ID="$(find_kv_id "$KV_TITLE" || true)"
if [[ -z "$KV_ID" ]]; then
  KV_ID="$(create_kv "$KV_TITLE")"
fi
[[ -n "$KV_ID" ]] || die "无法获取 KV id"

KV_PREVIEW_ID="$(find_kv_id "$KV_TITLE" 1 || true)"
if [[ -z "$KV_PREVIEW_ID" ]]; then
  KV_PREVIEW_ID="$(create_kv "$KV_TITLE" --preview)"
fi
[[ -n "$KV_PREVIEW_ID" ]] || die "无法获取 KV preview id"
info "KV: $KV_TITLE → $KV_ID (preview: $KV_PREVIEW_ID)"

# ── wrangler.local.jsonc ───────────────────────────────────────────────────────

WRANGLER_LOCAL="$INSTALL_DIR/wrangler.local.jsonc"
info "写入 $WRANGLER_LOCAL"

cat >"$WRANGLER_LOCAL" <<EOF
{
  "\$schema": "node_modules/wrangler/config-schema.json",
  "name": "${WORKER_NAME}",
  "main": "src/index.ts",
  "compatibility_date": "2025-06-05",
  "compatibility_flags": ["nodejs_compat"],

  "vars": {
    "RP_ID": "${RP_ID}",
    "RP_NAME": "${RP_NAME}",
    "ORIGIN": "${ORIGIN}",
    "COOKIE_DOMAIN": "${COOKIE_DOMAIN}",
    "AUTH_HOST": "${AUTH_HOST}",
    "SESSION_TTL_SECONDS": "604800",
    "SETUP_TTL_SECONDS": "600"
  },

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "${D1_NAME}",
      "database_id": "${D1_ID}",
      "migrations_dir": "migrations"
    }
  ],

  "kv_namespaces": [
    {
      "binding": "CHALLENGES",
      "id": "${KV_ID}",
      "preview_id": "${KV_PREVIEW_ID}"
    }
  ],

  "routes": [
    {
      "pattern": "${AUTH_HOST}",
      "zone_name": "${ZONE_NAME}",
      "custom_domain": true
    }
  ],

  "observability": {
    "enabled": true
  }
}
EOF

# Local dev secret file (gitignored)
cat >"$INSTALL_DIR/.dev.vars" <<EOF
SESSION_SECRET=${SESSION_SECRET}
EOF
chmod 600 "$INSTALL_DIR/.dev.vars" 2>/dev/null || true

# Save deploy summary for re-runs
cat >"$INSTALL_DIR/.deploy-cloudflare.env" <<EOF
# Generated by scripts/deploy-cloudflare.sh — do not commit
ZONE_NAME=${ZONE_NAME}
AUTH_HOST=${AUTH_HOST}
ORIGIN=${ORIGIN}
D1_ID=${D1_ID}
KV_ID=${KV_ID}
KV_PREVIEW_ID=${KV_PREVIEW_ID}
EOF
chmod 600 "$INSTALL_DIR/.deploy-cloudflare.env" 2>/dev/null || true

# ── Build & deploy ─────────────────────────────────────────────────────────────

info "npm install"
npm install

info "npm run build"
npm run build

info "上传 SESSION_SECRET"
printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET -c "$WRANGLER_LOCAL"

info "应用 D1 迁移（remote）"
npx wrangler d1 migrations apply "$D1_NAME" --remote -c "$WRANGLER_LOCAL"

info "部署 Worker"
npm run deploy

echo ""
echo "============================================"
printf '%b\n' "${GREEN}部署完成${NC}"
echo "  站点:     ${ORIGIN}"
echo "  初始化:   ${ORIGIN}/setup"
echo "  管理后台: ${ORIGIN}/admin"
echo ""
echo "  D1:       ${D1_NAME} (${D1_ID})"
echo "  KV:       ${KV_TITLE} (${KV_ID})"
echo "  配置:     ${WRANGLER_LOCAL}"
echo ""
warn "请妥善保存 SESSION_SECRET（已写入 .dev.vars，勿提交 git）"
warn "若自定义域名未生效，请在 Cloudflare Dashboard → Worker → Domains 检查 DNS"
echo "============================================"
