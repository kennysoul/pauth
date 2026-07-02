#!/usr/bin/env bash
# pauth · Cloudflare 一键部署（单文件）
#
# 执行顺序：
#   预检 1/4  本机工具（node / git …）
#   预检 2/4  Cloudflare 登录与 API 权限
#   预检 3/4  Git 验证 GitHub 仓库 → clone/pull 源码 → 使用仓库内 scripts/lib
#   预检 4/4  DNS / Worker 冲突 / 域名绑定 API 权限
#
# 单文件下载即可运行；私有仓库在预检 3 会引导 GitHub 登录（gh auth login）。
#
#   curl -fsSL https://raw.githubusercontent.com/your-org/pauth/main/scripts/full-deploy-cloudflare.sh -o full-deploy.sh
#   chmod +x full-deploy.sh
#   export PAUTH_REPO_URL=https://github.com/your-org/pauth.git   # 或 --repo
#   ./full-deploy.sh --yes auth.example.com
#   ./full-deploy.sh --yes --auth-host auth.example.com

set -euo pipefail

# ── 默认配置 ──────────────────────────────────────────────────────────────────

DEFAULT_REPO="${PAUTH_REPO_URL:-https://github.com/your-org/pauth.git}"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="${HOME}/pauth"
DEFAULT_RP_NAME="Passkey Auth"
DEFAULT_DB_LOCATION="apac"

REPO_URL="$DEFAULT_REPO"
GIT_BRANCH="$DEFAULT_BRANCH"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
ZONE_NAME=""
AUTH_HOST=""
RP_NAME="$DEFAULT_RP_NAME"
WORKER_NAME=""
D1_NAME=""
KV_TITLE=""
DB_LOCATION="$DEFAULT_DB_LOCATION"
SESSION_SECRET=""
DEPLOY_MODE=""
CONFIG_POLICY=""
SKIP_CLONE=0
ASSUME_YES=0
NON_INTERACTIVE=0
ROTATE_SECRET=0
GIT_FIRST_DEPLOY=0
SKIP_DOMAIN_BIND=0
WORKER_NAME_EXPLICIT=0
D1_NAME_EXPLICIT=0
KV_TITLE_EXPLICIT=0
ALLOW_WORKER_OVERWRITE=0
INSTALL_DIR_EXPLICIT=0
PAUTH_DEPLOY_MODE=""
PAUTH_NO_WORKERS_ROUTES=0

CONFIG_PY=""
BIND_DOMAIN_PY=""
WRANGLER_WHOAMI=""
GIT_SOURCE_READY=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 输出 ──────────────────────────────────────────────────────────────────────

info()  { printf '%b\n' "${GREEN}→${NC} $*" >&2; }
warn()  { printf '%b\n' "${YELLOW}!${NC} $*" >&2; }
die()   { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }
ok()    { printf '%b\n' "${GREEN}✓${NC} $*" >&2; }
phase() { printf '\n%b\n' "${CYAN}── $* ──${NC}" >&2; }

# npx --yes 避免首次运行时的 “Ok to proceed?” 交互卡住
wrangler_cmd() {
  npx --yes wrangler "$@"
}

warn_manual_domain_for_no_routes() {
  echo ""
  warn "当前登录缺少 Workers Routes 写权限，脚本无法自动强制绑定/覆盖域名"
  warn "若 ${AUTH_HOST:-认证域名} 已被其他 Worker 或 DNS 记录占用，请先到 Cloudflare 手动处理："
  echo "  · Dashboard → Workers & Pages → 目标 Worker → Settings → Domains"
  echo "  · 或 DNS → 删除/修改冲突的 A/CNAME 记录"
  echo "  · 完成后重新运行本脚本"
  echo ""
}

whoami_looks_logged_in() {
  local text="$1"
  [[ -n "$text" ]] || return 1
  if printf '%s' "$text" | grep -qiE 'not authenticated|not logged in|please run .wrangler login'; then
    return 1
  fi
  if printf '%s' "$text" | grep -qiE 'logged in|You are logged in|API Token'; then
    return 0
  fi
  return 1
}

run_wrangler_whoami() {
  local log rc
  log="$(mktemp "${TMPDIR:-/tmp}/pauth-whoami.XXXXXX")"
  info "Wrangler whoami"
  wrangler_cmd whoami 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  WRANGLER_WHOAMI="$(cat "$log")"
  rm -f "$log"
  if [[ "$rc" -ne 0 ]]; then
    return 1
  fi
  whoami_looks_logged_in "$WRANGLER_WHOAMI"
}

ensure_wrangler_oauth_login() {
  echo ""
  warn "未检测到 Cloudflare 登录"
  echo ""
  echo "一般用户推荐 OAuth 浏览器登录："
  echo "  1) 运行 wrangler login，在浏览器完成 Cloudflare 授权"
  echo "  2) 返回终端后脚本将继续部署"
  echo ""

  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    die "已设置 CLOUDFLARE_API_TOKEN 但 whoami 失败。
请检查 Token 是否有效、是否过期，或执行 unset CLOUDFLARE_API_TOKEN 后改用 OAuth：
  npx wrangler login"
  fi

  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    die "非交互模式请先登录：
  npx wrangler login
或设置有效的 CLOUDFLARE_API_TOKEN"
  fi

  read -r -p "是否现在运行 wrangler login（OAuth）？[Y/n]: " ans
  [[ "${ans:-Y}" =~ ^[Yy]$ ]] || die "需要 Cloudflare 登录后才能继续"

  info "启动 OAuth 登录…"
  wrangler_cmd login || die "wrangler login 失败"

  if run_wrangler_whoami; then
    ok "OAuth 登录成功"
    return 0
  fi
  die "登录后 whoami 仍失败，请重试 npx wrangler login"
}

check_workers_routes_write_permission() {
  local text="${WRANGLER_WHOAMI:-}"
  [[ -n "$text" ]] || return 1

  if printf '%s' "$text" | grep -qiE 'workers[_ ]routes[^)]*\(write\)|workers_routes:write'; then
    ok "Workers Routes 写权限"
    return 0
  fi

  if printf '%s' "$text" | grep -qiE 'workers[_ ]routes'; then
    PAUTH_NO_WORKERS_ROUTES=1
    warn_manual_domain_for_no_routes
    return 1
  fi

  if printf '%s' "$text" | grep -qi 'OAuth Token'; then
    PAUTH_NO_WORKERS_ROUTES=1
    warn_manual_domain_for_no_routes
    return 1
  fi

  ok "Workers Routes（whoami 未列出，假定可用）"
  return 0
}

sanitize_kv_id() {
  local raw="$1"
  local compact
  compact="$(printf '%s' "$raw" | tr -d '-')"
  printf '%s' "$compact" | grep -oE '[0-9a-f]{32}' | tail -1 || true
}

sanitize_d1_id() {
  local raw="$1"
  printf '%s' "$raw" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1 || true
}

validate_resource_ids() {
  D1_ID="$(sanitize_d1_id "$D1_ID")"
  KV_ID="$(sanitize_kv_id "$KV_ID")"
  KV_PREVIEW_ID="$(sanitize_kv_id "$KV_PREVIEW_ID")"
  [[ -n "$D1_ID" ]] || die "D1 id 无效（可能因日志混入配置，请重试）"
  [[ -n "$KV_ID" ]] || die "KV id 无效（可能因日志混入配置，请重试）"
  [[ -n "$KV_PREVIEW_ID" ]] || die "KV preview id 无效（可能因日志混入配置，请重试）"
}

usage() {
  cat <<'EOF'
Usage: full-deploy-cloudflare.sh [options] [auth-host]

单文件 Cloudflare 全量部署。预检通过后才执行 D1 / KV / build / deploy。

常规用法（只需认证域名）:
  ./full-deploy.sh --yes auth.example.com

从 auth.example.com 自动推导 zone、Worker/D1/KV、安装目录；已有 Worker 则升级，否则新建。

预检顺序：本机工具 → Cloudflare 基础权限 → Git 拉源码 → 部署目标（DNS/Worker/域名权限）

Options:
  --repo URL              GitHub 仓库（默认 your-org/pauth，或 PAUTH_REPO_URL）
  --branch NAME           分支（默认 main）
  --dir PATH              安装目录（默认 ~/pauth-<auth-host-slug>）
  --zone DOMAIN           根域名（可选；默认从 auth-host 推导）
  --auth-host HOST        认证域名（必填，或作为 positional 参数）
  --rp-name NAME          Passkey 显示名
  --worker-name NAME      Worker 名称（默认 pauth-<auth-host-slug>；升级时自动探测）
  --d1-name NAME          D1 数据库名（默认 pauth-<auth-host-slug>-db）
  --kv-title TITLE        KV namespace 标题（默认 CHALLENGES-pauth-<auth-host-slug>）
  --db-location LOC       D1 区域（默认 apac）
  --session-secret STR    SESSION_SECRET（留空自动生成）
  --deploy-mode MODE      local | git
  --config-policy POLICY  keep | merge-bindings | overwrite
  --allow-worker-overwrite  允许部署到已绑定其他域名的 Worker（危险）
  --rotate-secret         强制更新 .dev.vars 中的 SESSION_SECRET
  --git-first-deploy      Git 模式下额外执行一次本地 deploy
  --skip-domain-bind      跳过自定义域名绑定
  --skip-clone            使用 --dir 已有 checkout
  --yes, -y               非交互
  -h, --help

环境变量：
  CLOUDFLARE_API_TOKEN      推荐：User/Account API Token
  CLOUDFLARE_ACCOUNT_ID     可选；未设时从 wrangler whoami 解析

私有仓库：预检 3 会引导 gh auth login；非交互模式请先完成 GitHub 登录。

示例：
  ./full-deploy.sh --yes auth.example.com --config-policy keep
EOF
}

git_ls_remote_ok() {
  git ls-remote --exit-code "$REPO_URL" "refs/heads/$GIT_BRANCH" >/dev/null 2>&1
}

git_auth_failure_hint() {
  local err="$1"
  [[ "$err" =~ [Aa]uthentication\ failed ]] && return 0
  [[ "$err" =~ [Pp]ermission\ (denied|to) ]] && return 0
  [[ "$err" =~ [Uu]sername ]] && return 0
  [[ "$err" =~ [Rr]epository\ not\ found ]] && return 0
  [[ "$err" =~ [Ii]nvalid\ username\ or\ password ]] && return 0
  [[ "$err" =~ [Tt]erminal\ is\ dumb ]] && return 0
  [[ "$err" =~ [Ss]upport\ for\ password\ authentication\ was\ removed ]] && return 0
  return 1
}

prompt_github_auth() {
  local err="${1:-}"
  echo ""
  warn "无法访问 Git 仓库: $REPO_URL ($GIT_BRANCH)"
  if [[ -n "$err" ]]; then
    echo "$err" | sed 's/^/    /'
  fi
  echo ""
  echo "私有仓库需先完成 GitHub 授权，可选："
  echo "  1) gh auth login（推荐，GitHub CLI）"
  echo "  2) 改用 SSH 地址: git@github.com:owner/repo.git（--repo）"
  echo "  3) 配置 HTTPS token（git credential / GITHUB_TOKEN）"
  echo ""

  if command -v gh >/dev/null 2>&1; then
    read -r -p "是否现在运行 gh auth login？[Y/n]: " run_gh
    if [[ "${run_gh:-Y}" =~ ^[Yy]$ ]]; then
      gh auth login || die "gh auth login 失败"
      gh auth setup-git 2>/dev/null || true
      return 0
    fi
  else
    warn "未检测到 gh（GitHub CLI）。macOS: brew install gh"
  fi

  read -r -p "完成授权后按回车重试…"
}

ensure_github_git_access() {
  local err="" attempt=0
  while [[ "$attempt" -lt 3 ]]; do
    if git_ls_remote_ok; then
      ok "git ls-remote · $REPO_URL ($GIT_BRANCH)"
      return 0
    fi
    err="$(git ls-remote "$REPO_URL" "refs/heads/$GIT_BRANCH" 2>&1)" || true
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
      if git_auth_failure_hint "$err"; then
        die "无法访问私有仓库。请先执行: gh auth login（或配置 SSH/token），然后重试。"
      fi
      die "无法访问 GitHub 仓库/分支: $REPO_URL ($GIT_BRANCH)\n${err}"
    fi
    prompt_github_auth "$err"
    attempt=$((attempt + 1))
  done
  die "多次重试仍无法访问: $REPO_URL ($GIT_BRANCH)"
}

activate_repo_helpers() {
  local lib_dir="$INSTALL_DIR/scripts/lib"
  CONFIG_PY="$lib_dir/wrangler-config.py"
  BIND_DOMAIN_PY="$lib_dir/bind-custom-domain.py"
  [[ -f "$CONFIG_PY" && -f "$BIND_DOMAIN_PY" ]] \
    || die "仓库缺少 helper: $lib_dir/{wrangler-config.py,bind-custom-domain.py}"
  chmod +x "$CONFIG_PY" "$BIND_DOMAIN_PY" 2>/dev/null || true
  python3 "$CONFIG_PY" --help >/dev/null 2>&1 || die "wrangler-config.py 无法运行"
  python3 "$BIND_DOMAIN_PY" --help >/dev/null 2>&1 || die "bind-custom-domain.py 无法运行"
  ok "helper · $lib_dir"
}

sync_source_repo() {
  if [[ "$SKIP_CLONE" -eq 1 ]]; then
    INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
    [[ -f "$INSTALL_DIR/package.json" ]] || die "无效目录（缺少 package.json）: $INSTALL_DIR"
    info "使用已有 checkout: $INSTALL_DIR"
    if [[ -d "$INSTALL_DIR/.git" ]]; then
      ensure_github_git_access
      git -C "$INSTALL_DIR" fetch origin "$GIT_BRANCH"
      git -C "$INSTALL_DIR" checkout "$GIT_BRANCH"
      git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_BRANCH"
      ok "git pull · $GIT_BRANCH"
    fi
  else
    ensure_github_git_access
    if [[ -d "$INSTALL_DIR/.git" ]]; then
      info "更新已有仓库: $INSTALL_DIR"
      git -C "$INSTALL_DIR" fetch origin "$GIT_BRANCH"
      git -C "$INSTALL_DIR" checkout "$GIT_BRANCH"
      git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_BRANCH"
    else
      info "克隆仓库 → $INSTALL_DIR"
      mkdir -p "$(dirname "$INSTALL_DIR")"
      git clone --branch "$GIT_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
    fi
    INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
    ok "源码 · $INSTALL_DIR"
  fi
  activate_repo_helpers
  GIT_SOURCE_READY=1
}

# ── 参数 ──────────────────────────────────────────────────────────────────────

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO_URL="$2"; shift 2 ;;
      --branch) GIT_BRANCH="$2"; shift 2 ;;
      --dir) INSTALL_DIR="$2"; INSTALL_DIR_EXPLICIT=1; shift 2 ;;
      --zone) ZONE_NAME="$2"; shift 2 ;;
      --auth-host) AUTH_HOST="$2"; shift 2 ;;
      --rp-name) RP_NAME="$2"; shift 2 ;;
      --worker-name) WORKER_NAME="$2"; WORKER_NAME_EXPLICIT=1; shift 2 ;;
      --d1-name) D1_NAME="$2"; D1_NAME_EXPLICIT=1; shift 2 ;;
      --kv-title) KV_TITLE="$2"; KV_TITLE_EXPLICIT=1; shift 2 ;;
      --db-location) DB_LOCATION="$2"; shift 2 ;;
      --session-secret) SESSION_SECRET="$2"; shift 2 ;;
      --deploy-mode) DEPLOY_MODE="$2"; shift 2 ;;
      --config-policy) CONFIG_POLICY="$2"; shift 2 ;;
      --rotate-secret) ROTATE_SECRET=1; shift ;;
      --git-first-deploy) GIT_FIRST_DEPLOY=1; shift ;;
      --skip-domain-bind) SKIP_DOMAIN_BIND=1; shift ;;
      --skip-clone) SKIP_CLONE=1; shift ;;
      --allow-worker-overwrite) ALLOW_WORKER_OVERWRITE=1; shift ;;
      --yes|-y) ASSUME_YES=1; NON_INTERACTIVE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *)
        if [[ "$1" != -* && -z "$AUTH_HOST" ]]; then
          AUTH_HOST="$1"
          shift
          continue
        fi
        die "未知参数: $1（用 --help 查看）" ;;
    esac
  done
}

github_repo_label() {
  if [[ "$REPO_URL" =~ github\.com[:/]+([^/]+)/([^/.]+) ]]; then
    printf '%s/%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$REPO_URL"
  fi
}

# ── 预检 1/4：本机工具 ───────────────────────────────────────────────────

preflight_check_tools() {
  phase "预检 1/4 · 本机工具"
  local missing=()
  for cmd in node npm npx git python3; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ok "$cmd"
    else
      missing+=("$cmd")
    fi
  done
  [[ ${#missing[@]} -eq 0 ]] || die "缺少命令: ${missing[*]}"

  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]")"
  [[ "$node_major" -ge 20 ]] || die "需要 Node.js 20+（当前 $(node -v)）"
  ok "Node.js $(node -v)"

  if [[ -n "${NODE_EXTRA_CA_CERTS:-}" && ! -f "${NODE_EXTRA_CA_CERTS}" ]]; then
    warn "NODE_EXTRA_CA_CERTS 指向不存在的文件，Wrangler 可能报警（可 unset NODE_EXTRA_CA_CERTS）"
  fi
}

# ── 交互配置（预检 2 之前需已知 zone）────────────────────────────────────────

prompt() {
  local var_name="$1" question="$2" default="${3:-}" value=""
  if [[ -n "$default" ]]; then
    read -r -p "$question [$default]: " value
    value="${value:-$default}"
  else
    read -r -p "$question: " value
  fi
  printf -v "$var_name" '%s' "$value"
}

confirm() {
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  read -r -p "$1 [y/N]: " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

collect_config() {
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    [[ -n "$AUTH_HOST" ]] || die "--yes 需要认证域名，例如: --auth-host auth.example.com 或 positional auth.example.com"
    DEPLOY_MODE="${DEPLOY_MODE:-local}"
    CONFIG_POLICY="${CONFIG_POLICY:-merge-bindings}"
    return 0
  fi

  echo ""
  echo "=== pauth · Cloudflare 部署 ==="
  echo ""
  if [[ -z "$AUTH_HOST" ]]; then
    prompt AUTH_HOST "认证域名（如 auth.example.com）" ""
    [[ -n "$AUTH_HOST" ]] || die "认证域名不能为空"
  fi
  normalize_auth_host
  apply_install_dir_default
  prompt REPO_URL "GitHub 仓库 URL" "$DEFAULT_REPO"
  prompt GIT_BRANCH "分支" "$DEFAULT_BRANCH"
  prompt INSTALL_DIR "安装目录" "$INSTALL_DIR"
  if [[ -n "$ZONE_NAME" ]]; then
    prompt ZONE_NAME "根域名（留空则自动推导）" "$ZONE_NAME"
  else
    info "根域名将从 ${AUTH_HOST} 自动推导"
  fi
  prompt RP_NAME "Passkey 显示名称" "${RP_NAME:-$(default_rp_name "${ZONE_NAME:-$AUTH_HOST}")}"
  prompt DB_LOCATION "D1 区域" "$DB_LOCATION"
  if [[ -z "$DEPLOY_MODE" ]]; then
    echo ""
    echo "部署方式:"
    echo "  1) 本地上传（wrangler deploy，立即部署）"
    echo "  2) GitHub 挂钩（生成 wrangler.production.jsonc，Cloudflare Builds 部署）"
    read -r -p "选择 [1]: " dm
    case "${dm:-1}" in
      2) DEPLOY_MODE="git" ;;
      *) DEPLOY_MODE="local" ;;
    esac
  fi
  if [[ -z "$SESSION_SECRET" ]]; then
    read -r -p "SESSION_SECRET（留空则自动生成）: " SESSION_SECRET
  fi
}

apply_config_defaults() {
  [[ -n "$AUTH_HOST" ]] || die "需要认证域名"
  normalize_auth_host
  apply_install_dir_default
  DEPLOY_MODE="${DEPLOY_MODE:-local}"
  [[ "$DEPLOY_MODE" == "local" || "$DEPLOY_MODE" == "git" ]] || die "--deploy-mode 须为 local 或 git"

  if [[ -z "$SESSION_SECRET" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      SESSION_SECRET="$(openssl rand -base64 32)"
    else
      SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    fi
    info "已自动生成 SESSION_SECRET"
  fi
  [[ ${#SESSION_SECRET} -ge 32 ]] || die "SESSION_SECRET 至少 32 字符"
}

normalize_auth_host() {
  AUTH_HOST="$(printf '%s' "$AUTH_HOST" | tr '[:upper:]' '[:lower:]' | sed 's/\.$//')"
}

default_rp_name() {
  python3 -c "import sys; z=sys.argv[1]; print((z.split('.')[0].capitalize() + ' Auth') if z else 'Passkey Auth')" "$1"
}

default_install_dir() {
  printf '%s/pauth-%s' "$HOME" "$(slugify "$AUTH_HOST")"
}

apply_install_dir_default() {
  [[ "$INSTALL_DIR_EXPLICIT" -eq 0 ]] && INSTALL_DIR="$(default_install_dir)"
}

apply_resolve_json() {
  local json="$1"
  [[ -n "$json" ]] || return 0
  ZONE_NAME="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['zone_name'])")"
  if [[ "$WORKER_NAME_EXPLICIT" -eq 0 ]]; then
    WORKER_NAME="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['worker_name'])")"
  fi
  if [[ "$D1_NAME_EXPLICIT" -eq 0 ]]; then
    D1_NAME="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['d1_name'])")"
  fi
  if [[ "$KV_TITLE_EXPLICIT" -eq 0 ]]; then
    KV_TITLE="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['kv_title'])")"
  fi
  PAUTH_DEPLOY_MODE="$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['mode'])")"
  D1_ID="$(sanitize_d1_id "$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('d1_id',''))")")"
  KV_ID="$(sanitize_kv_id "$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('kv_id',''))")")"
  KV_PREVIEW_ID="$(sanitize_kv_id "$(printf '%s' "$json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('kv_preview_id',''))")")"
  CONFIG_POLICY="${CONFIG_POLICY:-merge-bindings}"
  if [[ "$PAUTH_DEPLOY_MODE" == "upgrade" ]]; then
    info "升级已有部署 · Worker=${WORKER_NAME}"
  else
    info "新建部署 · Worker=${WORKER_NAME}"
  fi
  RP_ID="${RP_ID:-$ZONE_NAME}"
  ORIGIN="${ORIGIN:-https://${AUTH_HOST}}"
  COOKIE_DOMAIN="${COOKIE_DOMAIN:-.${ZONE_NAME}}"
  if [[ "$RP_NAME" == "$DEFAULT_RP_NAME" ]]; then
    RP_NAME="$(default_rp_name "$ZONE_NAME")"
  fi
}

resolve_auth_host() {
  local config_path="${1:-}"
  [[ -n "$AUTH_HOST" ]] || return 0
  [[ -f "$BIND_DOMAIN_PY" ]] || return 0
  local resolve_args=(--hostname "$AUTH_HOST" --resolve)
  [[ -n "$ZONE_NAME" ]] && resolve_args+=(--zone-name "$ZONE_NAME")
  [[ -n "$config_path" && -f "$config_path" ]] && resolve_args+=(--config-path "$config_path")
  local json
  json="$(python3 "$BIND_DOMAIN_PY" "${resolve_args[@]}")" || die "无法解析认证域名: ${AUTH_HOST}"
  apply_resolve_json "$json"
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'
}

cloudflare_api_token_available() {
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && return 0
  python3 -c "
import re
from pathlib import Path
paths = [
    Path.home() / '.wrangler/config/default.toml',
    Path.home() / '.config/.wrangler/config/default.toml',
    Path.home() / '.config/wrangler/config/default.toml',
    Path.home() / 'Library/Application Support/.wrangler/config/default.toml',
]
for path in paths:
    if not path.exists():
        continue
    text = path.read_text(encoding='utf-8')
    for key in ('oauth_token', 'api_token'):
        if re.search(rf'^{key}\s*=\s*\"[^\"]+\"', text, re.M):
            raise SystemExit(0)
raise SystemExit(1)
" 2>/dev/null
}

derive_resource_names() {
  local host_slug
  host_slug="$(slugify "$AUTH_HOST")"

  if [[ "$WORKER_NAME_EXPLICIT" -eq 0 ]]; then
    WORKER_NAME="pauth-${host_slug}"
  fi
  if [[ "$D1_NAME_EXPLICIT" -eq 0 ]]; then
    D1_NAME="pauth-${host_slug}-db"
  fi
  if [[ "$KV_TITLE_EXPLICIT" -eq 0 ]]; then
    KV_TITLE="CHALLENGES-pauth-${host_slug}"
  fi

  info "资源命名: Worker=${WORKER_NAME}  D1=${D1_NAME}  KV=${KV_TITLE}"
}

resolve_account_id() {
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && return 0
  CLOUDFLARE_ACCOUNT_ID="$(python3 -c "
import re, sys
for line in sys.stdin.read().splitlines():
    for part in line.split('│'):
        part = part.strip()
        if re.fullmatch(r'[0-9a-f]{32}', part):
            print(part)
            raise SystemExit(0)
" <<<"${WRANGLER_WHOAMI}")"
  [[ -n "$CLOUDFLARE_ACCOUNT_ID" ]] || die "无法解析 Account ID；请 export CLOUDFLARE_ACCOUNT_ID=<32位 hex>"
  export CLOUDFLARE_ACCOUNT_ID
}

# ── 预检 2/4：Cloudflare 权限 ─────────────────────────────────────────────────

preflight_check_cloudflare() {
  phase "预检 2/4 · Cloudflare 登录与权限"

  if run_wrangler_whoami; then
    ok "Wrangler 已登录"
  else
    ensure_wrangler_oauth_login
  fi

  resolve_account_id
  ok "Account ID: ${CLOUDFLARE_ACCOUNT_ID}"

  check_workers_routes_write_permission || true

  info "D1 读权限"
  if ! wrangler_cmd d1 list --json >/dev/null 2>&1; then
    die "无法列出 D1 数据库 — Token 需 D1 Read（或 Account D1 权限）"
  fi
  ok "D1 list"

  info "KV 读权限"
  if ! wrangler_cmd kv namespace list >/dev/null 2>&1; then
    die "无法列出 KV namespace — Token 需 Workers KV Storage Read"
  fi
  ok "KV list"

  if cloudflare_api_token_available; then
    info "Workers / Zone API 权限"
    ZONE_NAME="$ZONE_NAME" AUTH_HOST="$AUTH_HOST" \
      CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" python3 <<'PY' || die "Cloudflare API 权限不足"
import json, os, re, sys, urllib.parse, urllib.request
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
account_id = os.environ["CLOUDFLARE_ACCOUNT_ID"]
zone_name = os.environ.get("ZONE_NAME", "")
auth_host = os.environ.get("AUTH_HOST", "")

def load_token():
    t = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if t:
        return t
    for path in (
        Path.home() / ".wrangler" / "config" / "default.toml",
        Path.home() / ".config" / "wrangler" / "config" / "default.toml",
    ):
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for key in ("api_token", "oauth_token"):
            m = re.search(rf'^{key}\s*=\s*"([^"]+)"', text, re.MULTILINE)
            if m and m.group(1):
                return m.group(1)
    return ""

def req(method, path, body=None):
    token = load_token()
    if not token:
        print("OAuth 模式：跳过 REST API 细检（D1/KV wrangler 已通过）")
        sys.exit(0)
    data = None if body is None else json.dumps(body).encode("utf-8")
    r = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(r, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("success"):
        errs = payload.get("errors") or [{}]
        raise SystemExit(errs[0].get("message") or json.dumps(payload))
    return payload

req("GET", f"/accounts/{account_id}/workers/scripts")
print("Workers Scripts list OK")

if zone_name:
    z = req("GET", f"/zones?name={urllib.parse.quote(zone_name)}&status=active&per_page=1")
    zones = z.get("result") or []
    if not zones or zones[0].get("name") != zone_name:
        raise SystemExit(f"域名 {zone_name} 不在当前账户或未激活")
    print(f"Zone OK: {zone_name}")
    if auth_host and auth_host != zone_name and not auth_host.endswith("." + zone_name):
        raise SystemExit(f"{auth_host} 不是 {zone_name} 下的主机名")
PY
    ok "Workers / Zone API"
  else
    info "OAuth 模式：跳过 REST API 细检（D1/KV 已通过 whoami 验证）"
  fi

  export CLOUDFLARE_ACCOUNT_ID
  ok "Cloudflare 预检通过"
}

# ── 预检 3/4：Git 验证 + 拉取源码 + helper ───────────────────────────────────

preflight_check_github() {
  phase "预检 3/4 · Git 仓库与源码"

  if [[ ! "$REPO_URL" =~ github\.com ]]; then
    die "仅支持 GitHub 仓库 URL（当前: $REPO_URL）"
  fi

  info "仓库: $(github_repo_label) · 分支: $GIT_BRANCH · 目录: $INSTALL_DIR"
  sync_source_repo
  ok "GitHub 预检通过"
}

preflight_check_deploy_target() {
  phase "预检 4/4 · 部署目标（DNS / Worker / 域名权限）"

  [[ "$GIT_SOURCE_READY" -eq 1 ]] || die "内部错误: 源码未就绪"
  use_repo_helpers
  export PAUTH_INSTALL_DIR="$INSTALL_DIR"

  local preflight_args=(
    --hostname "$AUTH_HOST"
    --zone-name "$ZONE_NAME"
    --worker-name "$WORKER_NAME"
    --preflight
  )
  [[ "$SKIP_DOMAIN_BIND" -eq 1 ]] && preflight_args+=(--skip-domain-bind)
  [[ "$ALLOW_WORKER_OVERWRITE" -eq 1 ]] && preflight_args+=(--allow-overwrite)

  info "Worker=${WORKER_NAME}  域名=${AUTH_HOST}  zone=${ZONE_NAME}"
  if cloudflare_api_token_available; then
    python3 "$BIND_DOMAIN_PY" "${preflight_args[@]}"
  else
    info "OAuth 模式：跳过 REST API 预检"
    if [[ "$PAUTH_NO_WORKERS_ROUTES" -eq 1 ]]; then
      warn "无 Workers Routes 写权限：域名 ${AUTH_HOST} 若已被占用，请到 Cloudflare Dashboard 手动处理后再 deploy"
    else
      warn "域名将由 wrangler routes（custom_domain）在 deploy 时绑定"
    fi
  fi
  ok "部署目标预检通过"
}

validate_wrangler_config_policy() {
  local cfg="$1"
  [[ -f "$cfg" ]] || return 0
  [[ "$CONFIG_POLICY" == "keep" ]] || return 0

  local cfg_worker cfg_auth
  read -r cfg_worker cfg_auth <<<"$(python3 -c "
import json, sys
from pathlib import Path

def strip_jsonc(t):
    out, i, ins, esc = [], 0, False, False
    while i < len(t):
        c = t[i]
        if ins:
            out.append(c)
            if esc: esc = False
            elif c == '\\\\': esc = True
            elif c == '\"': ins = False
            i += 1; continue
        if c == '\"': ins = True; out.append(c); i += 1; continue
        if c == '/' and i+1 < len(t) and t[i+1] == '/':
            while i < len(t) and t[i] not in '\\n': i += 1
            continue
        out.append(c); i += 1
    return ''.join(out)

d = json.loads(strip_jsonc(Path(sys.argv[1]).read_text(encoding='utf-8')))
print(d.get('name', ''), (d.get('vars') or {}).get('AUTH_HOST', ''))
" "$cfg")"

  if [[ -n "$cfg_worker" && "$cfg_worker" != "$WORKER_NAME" ]]; then
    die "wrangler 配置中 Worker 名为「${cfg_worker}」，与目标「${WORKER_NAME}」不一致。
--config-policy keep 会部署到「${cfg_worker}」，可能覆盖其它站点。
请改用 --config-policy merge-bindings 或 overwrite；
或 --worker-name ${cfg_worker} 明确升级原 Worker。"
  fi
  if [[ -n "$cfg_auth" && "$cfg_auth" != "$AUTH_HOST" ]]; then
    warn "配置中 AUTH_HOST=${cfg_auth}，与本次 ${AUTH_HOST} 不同；keep 模式将保留旧值"
  fi
}

use_repo_helpers() {
  [[ "$GIT_SOURCE_READY" -eq 1 ]] || activate_repo_helpers
}

# ── Wrangler 配置 ─────────────────────────────────────────────────────────────

choose_config_policy() {
  local target="$1"
  local -n _out="$2"
  [[ -f "$target" ]] || { _out="overwrite"; return; }
  [[ -n "$_out" ]] && return

  local diff
  diff="$(wrangler_config_py "$target" merge-bindings --diff-only)"
  echo ""
  warn "已存在: $(basename "$target")"
  if [[ "$diff" == "SAME" ]]; then
    info "与当前 Cloudflare 资源参数一致"
    _out="keep"
    return
  fi
  if [[ "$diff" != "NEW" && -n "$diff" ]]; then
    echo "$diff" | sed 's/^/    /'
  fi
  echo ""
  echo "  1) 保留现有（不覆盖）"
  echo "  2) 仅同步 D1/KV 资源 ID，保留 vars 等自定义项"
  echo "  3) 用当前参数完全覆盖"
  local choice=""
  read -r -p "选择 [2]: " choice
  case "${choice:-2}" in
    1) _out="keep" ;;
    3) _out="overwrite" ;;
    *) _out="merge-bindings" ;;
  esac
}

wrangler_config_py() {
  local target="$1" policy="$2"
  shift 2
  python3 "$CONFIG_PY" \
    --target "$target" \
    --policy "$policy" \
    --worker-name "$WORKER_NAME" \
    --zone-name "$ZONE_NAME" \
    --auth-host "$AUTH_HOST" \
    --rp-id "$RP_ID" \
    --rp-name "$RP_NAME" \
    --origin "$ORIGIN" \
    --cookie-domain "$COOKIE_DOMAIN" \
    --d1-name "$D1_NAME" \
    --d1-id "$D1_ID" \
    --kv-id "$KV_ID" \
    --kv-preview-id "$KV_PREVIEW_ID" \
    --account-id "${CLOUDFLARE_ACCOUNT_ID:-}" \
    "$@"
}

write_wrangler_config() {
  local target="$1" policy="$2" result
  result="$(wrangler_config_py "$target" "$policy")"
  case "$result" in
    CREATED) info "已创建 $(basename "$target")" ;;
    KEPT) info "保留 $(basename "$target")（未修改）" ;;
    MERGED) info "已合并 $(basename "$target")（仅同步资源绑定）" ;;
    OVERWRITTEN) info "已覆盖 $(basename "$target")" ;;
    *) die "配置写入失败: $result" ;;
  esac
}

ensure_wrangler_custom_domain_route() {
  local cfg="$1"
  [[ -f "$cfg" && -n "$AUTH_HOST" ]] || return 0
  local result
  result="$(python3 "$CONFIG_PY" \
    --target "$cfg" \
    --auth-host "$AUTH_HOST" \
    --ensure-custom-domain-route \
    --worker-name "$WORKER_NAME" \
    --zone-name "$ZONE_NAME" \
    --rp-id "${RP_ID:-$ZONE_NAME}" \
    --rp-name "$RP_NAME" \
    --origin "$ORIGIN" \
    --cookie-domain "$COOKIE_DOMAIN" \
    --d1-name "$D1_NAME" \
    --d1-id "${D1_ID:-00000000000000000000000000000000}" \
    --kv-id "${KV_ID:-00000000000000000000000000000000}" \
    --kv-preview-id "${KV_PREVIEW_ID:-00000000000000000000000000000000}" \
    2>/dev/null || true)"
  case "$result" in
    ENSURED) info "已写入 custom domain route: ${AUTH_HOST}" ;;
    UNCHANGED) info "custom domain route 已存在: ${AUTH_HOST}" ;;
  esac
}

load_vars_from_wrangler() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local env_file
  env_file="$(mktemp "${TMPDIR:-/tmp}/pauth-wrangler-load.XXXXXX")"
  python3 -c "
import json, shlex, sys
from pathlib import Path

def strip_jsonc_comments(text: str) -> str:
    out, i = [], 0
    in_string = escape = False
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escape: escape = False
            elif ch == '\\\\': escape = True
            elif ch == '\"': in_string = False
            i += 1; continue
        if ch == '\"':
            in_string = True; out.append(ch); i += 1; continue
        if ch == '/' and i + 1 < len(text) and text[i + 1] == '/':
            while i < len(text) and text[i] not in '\\n': i += 1
            continue
        out.append(ch); i += 1
    return ''.join(out)

p = Path(sys.argv[1])
cfg = json.loads(strip_jsonc_comments(p.read_text(encoding='utf-8')))
vars = cfg.get('vars') or {}
routes = cfg.get('routes') or [{}]
route = routes[0] if routes else {}
out = {
    'AUTH_HOST': vars.get('AUTH_HOST', ''),
    'RP_ID': vars.get('RP_ID', ''),
    'RP_NAME': vars.get('RP_NAME', ''),
    'ORIGIN': vars.get('ORIGIN', ''),
    'COOKIE_DOMAIN': vars.get('COOKIE_DOMAIN', ''),
    'ZONE_NAME': route.get('zone_name', ''),
}
for k, v in out.items():
    if v:
        print(f'{k}={shlex.quote(str(v))}')
" "$file" >"$env_file" 2>/dev/null || { rm -f "$env_file"; return 0; }
  # shellcheck disable=SC1091
  source "$env_file"
  rm -f "$env_file"
}

verify_auth_zone() {
  if ! cloudflare_api_token_available; then
    info "OAuth 模式：跳过 zone REST 验证（wrangler deploy 将校验权限）"
    return 0
  fi
  info "再次确认 ${ZONE_NAME} / ${AUTH_HOST}"
  python3 "$BIND_DOMAIN_PY" \
    --hostname "$AUTH_HOST" \
    --zone-name "$ZONE_NAME" \
    --worker-name "$WORKER_NAME" \
    --verify-only
}

bind_auth_domain() {
  [[ "$SKIP_DOMAIN_BIND" -eq 1 ]] && return 0
  ensure_wrangler_custom_domain_route "$WRANGLER_CFG"
  if ! cloudflare_api_token_available; then
    info "OAuth 模式：由 wrangler custom_domain routes 绑定 ${AUTH_HOST}"
    wrangler_cmd deploy -c "$WRANGLER_CFG"
    return 0
  fi
  info "绑定 ${AUTH_HOST} → Worker ${WORKER_NAME}"
  local bind_args=(
    --hostname "$AUTH_HOST"
    --zone-name "$ZONE_NAME"
    --worker-name "$WORKER_NAME"
  )
  [[ "$ALLOW_WORKER_OVERWRITE" -eq 1 ]] && bind_args+=(--allow-overwrite)
  if python3 "$BIND_DOMAIN_PY" "${bind_args[@]}"; then
    return 0
  fi
  warn "REST 域名绑定失败，改用 wrangler custom_domain routes…"
  wrangler_cmd deploy -c "$WRANGLER_CFG" \
    || die "无法绑定 ${AUTH_HOST}，请检查 Cloudflare 权限与 DNS 记录"
}

print_git_instructions() {
  cat <<EOF

${CYAN}── GitHub 自动部署（Cloudflare Workers Builds）──${NC}

1. GitHub 安装 Cloudflare Workers & Pages App，授权: ${REPO_URL}
2. Dashboard → ${WORKER_NAME} → Settings → Builds → Connect Git (${GIT_BRANCH})
3. Build: npm run build   Deploy: npm run deploy:workers
4. git add wrangler.production.jsonc && git commit && git push
5. Dashboard 确认 SESSION_SECRET 已设置

配置文件: ${INSTALL_DIR}/wrangler.production.jsonc
EOF
}

print_finish() {
  echo ""
  echo "============================================"
  printf '%b\n' "${GREEN}完成${NC}"
  echo "  站点:     ${ORIGIN}"
  echo "  域名:     ${AUTH_HOST}"
  echo "  模式:     ${DEPLOY_MODE}"
  echo "  本地配置: ${WRANGLER_LOCAL}"
  [[ -f "$WRANGLER_PROD" ]] && echo "  CI 配置:  ${WRANGLER_PROD}"
  echo "  D1:       ${D1_NAME} (${D1_ID})"
  echo "  KV:       ${KV_TITLE} (${KV_ID})"
  echo ""
  if [[ "$DEPLOY_MODE" == "git" ]]; then
    print_git_instructions
  else
    warn "SESSION_SECRET 在 .dev.vars，勿提交 git"
  fi
  warn "发版后有新 migration: npm run db:migrate:remote"
  echo "============================================"
}

# ── 主流程：clone / 资源 / 部署 ───────────────────────────────────────────────

run_provision() {
  phase "Cloudflare 资源配置"

  [[ "$GIT_SOURCE_READY" -eq 1 ]] || die "内部错误: 源码未在预检阶段就绪"
  use_repo_helpers

  WRANGLER_LOCAL="$INSTALL_DIR/wrangler.local.jsonc"
  WRANGLER_PROD="$INSTALL_DIR/wrangler.production.jsonc"
  EXISTING_CFG=""
  if [[ -f "$WRANGLER_LOCAL" ]]; then
    EXISTING_CFG="$WRANGLER_LOCAL"
  elif [[ -f "$WRANGLER_PROD" ]]; then
    EXISTING_CFG="$WRANGLER_PROD"
  fi
  load_vars_from_wrangler "$EXISTING_CFG"
  resolve_auth_host "$EXISTING_CFG"
  validate_wrangler_config_policy "$WRANGLER_LOCAL"

  if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    echo ""
    info "目标: https://${AUTH_HOST}  模式: ${DEPLOY_MODE}"
    confirm "预检已通过，开始创建/更新 Cloudflare 资源？" || exit 0
  fi

  cd "$INSTALL_DIR"

  export PAUTH_INSTALL_DIR="$INSTALL_DIR"

  find_d1_id() {
    wrangler_cmd d1 list --json 2>/dev/null | python3 -c "
import json, sys
name = sys.argv[1]
for row in json.load(sys.stdin):
    if row.get('name') == name:
        print(row.get('uuid') or row.get('database_id') or '')
        break
" "$D1_NAME"
  }

  create_d1() {
    info "创建 D1: $D1_NAME ($DB_LOCATION)"
    wrangler_cmd d1 create "$D1_NAME" --location "$DB_LOCATION" >/dev/null
  }

  find_kv_id() {
    local title="$1" want_preview="${2:-0}"
    wrangler_cmd kv namespace list 2>/dev/null | python3 -c "
import json, sys
title, want = sys.argv[1], sys.argv[2] == '1'
raw = sys.stdin.read().strip()
if not raw: sys.exit(0)
try: data = json.loads(raw)
except json.JSONDecodeError: sys.exit(0)
for row in data if isinstance(data, list) else []:
    t = row.get('title', '')
    prev = 'preview' in t.lower()
    if want and title in t and prev:
        print(row.get('id', '')); break
    if not want and t == title and not prev:
        print(row.get('id', '')); break
" "$title" "$want_preview"
  }

  create_kv() {
    local title="$1" preview="${2:-}" out id
    info "创建 KV: $title${preview:+ (preview)}"
    if [[ -n "$preview" ]]; then
      out="$(wrangler_cmd kv namespace create "$title" --preview 2>&1)"
    else
      out="$(wrangler_cmd kv namespace create "$title" 2>&1)"
    fi
    id="$(printf '%s' "$out" | python3 -c "
import re, sys
t = sys.stdin.read()
m = re.search(r'\"(?:id|preview_id)\":\s*\"([a-f0-9]{32})\"', t)
if not m:
    m = re.search(r\"id\s*=\s*['\\\"]([a-f0-9]{32})['\\\"]\", t)
print(m.group(1) if m else '')
")"
    [[ -n "$id" ]] || die "KV 创建失败: $out"
    printf '%s' "$id"
  }

  phase "Cloudflare 资源 · D1 / KV"

  D1_ID="$(sanitize_d1_id "$D1_ID")"
  if [[ -z "$D1_ID" ]]; then
    D1_ID="$(sanitize_d1_id "$(find_d1_id || true)")"
  fi
  if [[ -z "$D1_ID" ]]; then
    create_d1
    D1_ID="$(sanitize_d1_id "$(find_d1_id)")"
  fi
  [[ -n "$D1_ID" ]] || die "无法获取 D1 id"

  KV_ID="$(sanitize_kv_id "$KV_ID")"
  if [[ -z "$KV_ID" ]]; then
    KV_ID="$(sanitize_kv_id "$(find_kv_id "$KV_TITLE" || true)")"
  fi
  if [[ -z "$KV_ID" ]]; then
    KV_ID="$(sanitize_kv_id "$(create_kv "$KV_TITLE")")"
  fi
  [[ -n "$KV_ID" ]] || die "无法获取 KV id"

  KV_PREVIEW_ID="$(sanitize_kv_id "$KV_PREVIEW_ID")"
  if [[ -z "$KV_PREVIEW_ID" ]]; then
    KV_PREVIEW_ID="$(sanitize_kv_id "$(find_kv_id "$KV_TITLE" 1 || true)")"
  fi
  if [[ -z "$KV_PREVIEW_ID" ]]; then
    KV_PREVIEW_ID="$(sanitize_kv_id "$(create_kv "$KV_TITLE" --preview)")"
  fi
  [[ -n "$KV_PREVIEW_ID" ]] || die "无法获取 KV preview id"

  validate_resource_ids
  info "D1: $D1_NAME → $D1_ID"
  info "KV: $KV_TITLE → $KV_ID"

  phase "Wrangler 配置"

  write_config_pair() {
    local policy_local="$1" policy_prod="$2"
    write_wrangler_config "$WRANGLER_LOCAL" "$policy_local"
    if [[ "$DEPLOY_MODE" == "git" ]]; then
      write_wrangler_config "$WRANGLER_PROD" "$policy_prod"
    elif [[ -f "$WRANGLER_PROD" ]]; then
      write_wrangler_config "$WRANGLER_PROD" "$policy_prod"
    fi
  }

  local local_policy="" prod_policy=""
  if [[ -n "$CONFIG_POLICY" ]]; then
    local_policy="$CONFIG_POLICY"
    prod_policy="$CONFIG_POLICY"
    write_config_pair "$local_policy" "$prod_policy"
  else
    choose_config_policy "$WRANGLER_LOCAL" local_policy
    if [[ "$DEPLOY_MODE" == "git" ]]; then
      if [[ -f "$WRANGLER_PROD" && "$local_policy" != "keep" ]]; then
        choose_config_policy "$WRANGLER_PROD" prod_policy
      else
        prod_policy="$local_policy"
      fi
      write_config_pair "$local_policy" "$prod_policy"
    else
      write_wrangler_config "$WRANGLER_LOCAL" "$local_policy"
    fi
  fi

  DEV_VARS="$INSTALL_DIR/.dev.vars"
  if [[ -f "$DEV_VARS" && "$ROTATE_SECRET" -eq 0 && "$NON_INTERACTIVE" -eq 0 ]]; then
    read -r -p "已存在 .dev.vars，是否更新 SESSION_SECRET？[y/N]: " rot
    [[ "$rot" =~ ^[Yy]$ ]] && ROTATE_SECRET=1
  elif [[ -f "$DEV_VARS" && "$ROTATE_SECRET" -eq 0 ]]; then
    info "保留 .dev.vars（--rotate-secret 可强制更新）"
  fi
  if [[ ! -f "$DEV_VARS" || "$ROTATE_SECRET" -eq 1 ]]; then
    printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET" >"$DEV_VARS"
    chmod 600 "$DEV_VARS" 2>/dev/null || true
  fi

  cat >"$INSTALL_DIR/.deploy-cloudflare.env" <<EOF
# Generated by full-deploy-cloudflare.sh
DEPLOY_MODE=${DEPLOY_MODE}
ZONE_NAME=${ZONE_NAME}
AUTH_HOST=${AUTH_HOST}
ORIGIN=${ORIGIN}
D1_ID=${D1_ID}
KV_ID=${KV_ID}
KV_PREVIEW_ID=${KV_PREVIEW_ID}
CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-}
EOF
  chmod 600 "$INSTALL_DIR/.deploy-cloudflare.env" 2>/dev/null || true

  verify_auth_zone
}

run_deploy() {
  phase "构建与发布"

  info "npm install && npm run build"
  npm install
  npm run build

  WRANGLER_CFG="$WRANGLER_LOCAL"
  [[ -f "$WRANGLER_CFG" ]] || die "缺少 $WRANGLER_CFG"

  ensure_wrangler_custom_domain_route "$WRANGLER_CFG"

  info "上传 SESSION_SECRET"
  printf '%s' "$SESSION_SECRET" | wrangler_cmd secret put SESSION_SECRET -c "$WRANGLER_CFG"

  info "D1 迁移（remote）"
  wrangler_cmd d1 migrations apply DB --remote -c "$WRANGLER_CFG"

  RUN_LOCAL_DEPLOY=0
  if [[ "$DEPLOY_MODE" == "local" ]]; then
    RUN_LOCAL_DEPLOY=1
  elif [[ "$GIT_FIRST_DEPLOY" -eq 1 ]]; then
    RUN_LOCAL_DEPLOY=1
  elif [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    read -r -p "Git 模式：是否现在本地 deploy 注册 Worker？[y/N]: " fd
    [[ "$fd" =~ ^[Yy]$ ]] && RUN_LOCAL_DEPLOY=1
  fi

  if [[ "$RUN_LOCAL_DEPLOY" -eq 1 ]]; then
    info "wrangler deploy"
    npm run deploy
  fi

  bind_auth_domain
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  if [[ -n "$AUTH_HOST" ]]; then
    normalize_auth_host
    apply_install_dir_default
  fi

  preflight_check_tools
  collect_config
  apply_config_defaults

  preflight_check_cloudflare
  preflight_check_github

  use_repo_helpers
  local existing_cfg=""
  if [[ -f "$INSTALL_DIR/wrangler.local.jsonc" ]]; then
    existing_cfg="$INSTALL_DIR/wrangler.local.jsonc"
  elif [[ -f "$INSTALL_DIR/wrangler.production.jsonc" ]]; then
    existing_cfg="$INSTALL_DIR/wrangler.production.jsonc"
  fi
  resolve_auth_host "$existing_cfg"

  preflight_check_deploy_target

  echo ""
  ok "四项预检全部通过"
  info "Worker: ${WORKER_NAME}  目标: https://${AUTH_HOST}"
  echo ""

  run_provision
  run_deploy
  print_finish
}

main "$@"
