#!/usr/bin/env bash
# pauth · Cloudflare 一键部署（单文件）
#
# 执行顺序：
#   预检 1/3  本机工具（node / git …）
#   预检 2/3  Cloudflare 登录与 API 权限
#   预检 3/3  Git 验证 GitHub 仓库 → clone/pull 源码 → 使用仓库内 scripts/lib
#   全部通过后继续 D1 / KV / 部署
#
# 单文件下载即可运行；私有仓库在预检 3 会引导 GitHub 登录（gh auth login）。
#
#   curl -fsSL https://raw.githubusercontent.com/kennysoul/pauth/main/scripts/full-deploy-cloudflare.sh -o full-deploy.sh
#   chmod +x full-deploy.sh
#   export CLOUDFLARE_API_TOKEN=...
#   ./full-deploy.sh --zone kass.cc --auth-host auth.kass.cc --yes

set -euo pipefail

# ── 默认配置 ──────────────────────────────────────────────────────────────────

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
DEPLOY_MODE=""
CONFIG_POLICY=""
SKIP_CLONE=0
ASSUME_YES=0
NON_INTERACTIVE=0
ROTATE_SECRET=0
GIT_FIRST_DEPLOY=0
SKIP_DOMAIN_BIND=0

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

info()  { printf '%b\n' "${GREEN}→${NC} $*"; }
warn()  { printf '%b\n' "${YELLOW}!${NC} $*"; }
die()   { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }
ok()    { printf '%b\n' "${GREEN}✓${NC} $*"; }
phase() { printf '\n%b\n' "${CYAN}── $* ──${NC}"; }

usage() {
  cat <<'EOF'
Usage: full-deploy-cloudflare.sh [options]

单文件 Cloudflare 全量部署。预检通过后才执行 D1 / KV / build / deploy。

预检顺序：本机工具 → Cloudflare 权限 → Git 拉取源码（含 scripts/lib）

Options:
  --repo URL              GitHub 仓库（默认 kennysoul/pauth）
  --branch NAME           分支（默认 main）
  --dir PATH              安装目录（默认 ~/pauth）
  --zone DOMAIN           根域名，Cloudflare 托管（--yes 时必填）
  --auth-host HOST        认证域名（默认 auth.<zone>）
  --rp-name NAME          Passkey 显示名
  --worker-name NAME      Worker 名称
  --d1-name NAME          D1 数据库名
  --kv-title TITLE        KV namespace 标题
  --db-location LOC       D1 区域（默认 apac）
  --session-secret STR    SESSION_SECRET（留空自动生成）
  --deploy-mode MODE      local | git
  --config-policy POLICY  keep | merge-bindings | overwrite
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
  ./full-deploy.sh --zone kass.cc --auth-host auth.kass.cc --yes --config-policy keep
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
      --dir) INSTALL_DIR="$2"; shift 2 ;;
      --zone) ZONE_NAME="$2"; shift 2 ;;
      --auth-host) AUTH_HOST="$2"; shift 2 ;;
      --rp-name) RP_NAME="$2"; shift 2 ;;
      --worker-name) WORKER_NAME="$2"; shift 2 ;;
      --d1-name) D1_NAME="$2"; shift 2 ;;
      --kv-title) KV_TITLE="$2"; shift 2 ;;
      --db-location) DB_LOCATION="$2"; shift 2 ;;
      --session-secret) SESSION_SECRET="$2"; shift 2 ;;
      --deploy-mode) DEPLOY_MODE="$2"; shift 2 ;;
      --config-policy) CONFIG_POLICY="$2"; shift 2 ;;
      --rotate-secret) ROTATE_SECRET=1; shift ;;
      --git-first-deploy) GIT_FIRST_DEPLOY=1; shift ;;
      --skip-domain-bind) SKIP_DOMAIN_BIND=1; shift ;;
      --skip-clone) SKIP_CLONE=1; shift ;;
      --yes|-y) ASSUME_YES=1; NON_INTERACTIVE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数: $1（用 --help 查看）" ;;
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

# ── 预检 1/3：本机工具 ───────────────────────────────────────────────────

preflight_check_tools() {
  phase "预检 1/3 · 本机工具"
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
    [[ -n "$ZONE_NAME" ]] || die "--yes 需要 --zone <根域名>"
    AUTH_HOST="${AUTH_HOST:-auth.${ZONE_NAME}}"
    DEPLOY_MODE="${DEPLOY_MODE:-local}"
    CONFIG_POLICY="${CONFIG_POLICY:-merge-bindings}"
    return 0
  fi

  echo ""
  echo "=== pauth · Cloudflare 部署 ==="
  echo ""
  prompt REPO_URL "GitHub 仓库 URL" "$DEFAULT_REPO"
  prompt GIT_BRANCH "分支" "$DEFAULT_BRANCH"
  prompt INSTALL_DIR "安装目录" "$INSTALL_DIR"
  prompt ZONE_NAME "根域名（Cloudflare 托管）" "${ZONE_NAME:-}"
  [[ -n "$ZONE_NAME" ]] || die "根域名不能为空"
  prompt AUTH_HOST "认证主机名" "${AUTH_HOST:-auth.${ZONE_NAME}}"
  prompt RP_NAME "Passkey 显示名称" "$RP_NAME"
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
  DEPLOY_MODE="${DEPLOY_MODE:-local}"
  [[ "$DEPLOY_MODE" == "local" || "$DEPLOY_MODE" == "git" ]] || die "--deploy-mode 须为 local 或 git"
  AUTH_HOST="${AUTH_HOST:-auth.${ZONE_NAME}}"
  RP_ID="${RP_ID:-$ZONE_NAME}"
  ORIGIN="${ORIGIN:-https://${AUTH_HOST}}"
  COOKIE_DOMAIN="${COOKIE_DOMAIN:-.${ZONE_NAME}}"

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

# ── 预检 2/3：Cloudflare 权限 ─────────────────────────────────────────────────

preflight_check_cloudflare() {
  phase "预检 2/3 · Cloudflare 登录与权限"

  info "Wrangler 登录状态"
  WRANGLER_WHOAMI="$(npx wrangler whoami 2>&1)" || die "未登录：请先 npx wrangler login 或设置 CLOUDFLARE_API_TOKEN"
  printf '%s\n' "$WRANGLER_WHOAMI"
  resolve_account_id
  ok "Account ID: ${CLOUDFLARE_ACCOUNT_ID}"

  info "D1 读权限"
  if ! npx wrangler d1 list --json >/dev/null 2>&1; then
    die "无法列出 D1 数据库 — Token 需 D1 Read（或 Account D1 权限）"
  fi
  ok "D1 list"

  info "KV 读权限"
  if ! npx wrangler kv namespace list >/dev/null 2>&1; then
    die "无法列出 KV namespace — Token 需 Workers KV Storage Read"
  fi
  ok "KV list"

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
  export CLOUDFLARE_ACCOUNT_ID
  ok "Cloudflare 预检通过"
}

# ── 预检 3/3：Git 验证 + 拉取源码 + helper ───────────────────────────────────

preflight_check_github() {
  phase "预检 3/3 · Git 仓库与源码"

  if [[ ! "$REPO_URL" =~ github\.com ]]; then
    die "仅支持 GitHub 仓库 URL（当前: $REPO_URL）"
  fi

  info "仓库: $(github_repo_label) · 分支: $GIT_BRANCH · 目录: $INSTALL_DIR"
  sync_source_repo
  ok "GitHub 预检通过"
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

load_vars_from_wrangler() {
  local file="$1"
  [[ -f "$file" ]] || return 0
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
    'WORKER_NAME': cfg.get('name', ''),
}
for k, v in out.items():
    if v:
        print(f'{k}={shlex.quote(str(v))}')
" "$file" > /tmp/pauth-wrangler-load.env 2>/dev/null || return 0
  # shellcheck disable=SC1091
  source /tmp/pauth-wrangler-load.env
  rm -f /tmp/pauth-wrangler-load.env
}

verify_auth_zone() {
  info "再次确认 ${ZONE_NAME} / ${AUTH_HOST}"
  python3 "$BIND_DOMAIN_PY" \
    --hostname "$AUTH_HOST" \
    --zone-name "$ZONE_NAME" \
    --worker-name "$WORKER_NAME" \
    --verify-only
}

bind_auth_domain() {
  [[ "$SKIP_DOMAIN_BIND" -eq 1 ]] && return 0
  info "绑定 ${AUTH_HOST} → Worker ${WORKER_NAME}"
  if python3 "$BIND_DOMAIN_PY" \
    --hostname "$AUTH_HOST" \
    --zone-name "$ZONE_NAME" \
    --worker-name "$WORKER_NAME"; then
    return 0
  fi
  warn "首次绑定失败，先部署 Worker 再重试…"
  npx wrangler deploy -c "$WRANGLER_CFG"
  python3 "$BIND_DOMAIN_PY" \
    --hostname "$AUTH_HOST" \
    --zone-name "$ZONE_NAME" \
    --worker-name "$WORKER_NAME" \
    || die "无法绑定 ${AUTH_HOST}，请检查 Cloudflare 权限（Workers + DNS + Zone）"
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

  if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    echo ""
    info "目标: https://${AUTH_HOST}  模式: ${DEPLOY_MODE}"
    confirm "预检已通过，开始创建/更新 Cloudflare 资源？" || exit 0
  fi

  cd "$INSTALL_DIR"

  find_d1_id() {
    npx wrangler d1 list --json 2>/dev/null | python3 -c "
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
    npx wrangler d1 create "$D1_NAME" --location "$DB_LOCATION" >/dev/null
  }

  find_kv_id() {
    local title="$1" want_preview="${2:-0}"
    npx wrangler kv namespace list 2>/dev/null | python3 -c "
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
      out="$(npx wrangler kv namespace create "$title" --preview 2>&1)"
    else
      out="$(npx wrangler kv namespace create "$title" 2>&1)"
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

  D1_ID="$(find_d1_id || true)"
  if [[ -z "$D1_ID" ]]; then create_d1; D1_ID="$(find_d1_id)"; fi
  [[ -n "$D1_ID" ]] || die "无法获取 D1 id"
  info "D1: $D1_NAME → $D1_ID"

  KV_ID="${KV_ID:-$(find_kv_id "$KV_TITLE" || true)}"
  [[ -z "$KV_ID" ]] && KV_ID="$(create_kv "$KV_TITLE")"
  KV_PREVIEW_ID="${KV_PREVIEW_ID:-$(find_kv_id "$KV_TITLE" 1 || true)}"
  [[ -z "$KV_PREVIEW_ID" ]] && KV_PREVIEW_ID="$(create_kv "$KV_TITLE" --preview)"
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

  info "上传 SESSION_SECRET"
  printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET -c "$WRANGLER_CFG"

  info "D1 迁移（remote）"
  npx wrangler d1 migrations apply DB --remote -c "$WRANGLER_CFG"

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

  preflight_check_tools
  collect_config
  apply_config_defaults

  preflight_check_cloudflare
  preflight_check_github

  echo ""
  ok "三项预检全部通过"
  info "目标: https://${AUTH_HOST}  仓库: ${REPO_URL} (${GIT_BRANCH})"
  echo ""

  run_provision
  run_deploy
  print_finish
}

main "$@"
