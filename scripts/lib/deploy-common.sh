# Shared Cloudflare bootstrap helpers for pauth.
# Sourced by provision-cloudflare.sh and deploy-cloudflare.sh — do not execute directly.
[[ "${BASH_SOURCE[0]}" == "${0}" ]] && { echo "Source this file, do not run directly." >&2; exit 1; }

: "${SCRIPT_DIR:?SCRIPT_DIR must be set before sourcing deploy-common.sh}"

# Defaults
: "${DEFAULT_REPO:=https://github.com/kennysoul/pauth.git}"
: "${DEFAULT_BRANCH:=main}"
: "${DEFAULT_INSTALL_DIR:=$HOME/pauth}"
: "${DEFAULT_RP_NAME:=Kass Auth}"
: "${DEFAULT_DB_LOCATION:=apac}"

REPO_URL="${REPO_URL:-$DEFAULT_REPO}"
GIT_BRANCH="${GIT_BRANCH:-$DEFAULT_BRANCH}"
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
ZONE_NAME="${ZONE_NAME:-}"
AUTH_HOST="${AUTH_HOST:-}"
RP_NAME="${RP_NAME:-$DEFAULT_RP_NAME}"
WORKER_NAME="${WORKER_NAME:-}"
D1_NAME="${D1_NAME:-}"
KV_TITLE="${KV_TITLE:-}"
DB_LOCATION="${DB_LOCATION:-$DEFAULT_DB_LOCATION}"
SESSION_SECRET="${SESSION_SECRET:-}"
DEPLOY_MODE="${DEPLOY_MODE:-}"
CONFIG_POLICY="${CONFIG_POLICY:-}"
SKIP_CLONE="${SKIP_CLONE:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
ROTATE_SECRET="${ROTATE_SECRET:-0}"
GIT_FIRST_DEPLOY="${GIT_FIRST_DEPLOY:-0}"
SKIP_DOMAIN_BIND="${SKIP_DOMAIN_BIND:-0}"
PROVISION_ONLY="${PROVISION_ONLY:-0}"
PAUTH_SHOW_HELP="${PAUTH_SHOW_HELP:-0}"
WORKER_NAME_EXPLICIT="${WORKER_NAME_EXPLICIT:-0}"
D1_NAME_EXPLICIT="${D1_NAME_EXPLICIT:-0}"
KV_TITLE_EXPLICIT="${KV_TITLE_EXPLICIT:-0}"
ALLOW_WORKER_OVERWRITE="${ALLOW_WORKER_OVERWRITE:-0}"
INSTALL_DIR_EXPLICIT="${INSTALL_DIR_EXPLICIT:-0}"
PAUTH_DEPLOY_MODE="${PAUTH_DEPLOY_MODE:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { printf '%b\n' "${GREEN}→${NC} $*" >&2; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*" >&2; }
die() { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy-cloudflare.sh [options] [auth-host]

Bootstrap pauth on Cloudflare: D1 + KV + wrangler config + deploy.

常规用法（只需认证域名）:
  ./deploy-cloudflare.sh --yes auth.kass.cc
  ./deploy-cloudflare.sh --yes --auth-host auth.kass.cc

脚本会从 auth.kass.cc 推导 zone、Worker/D1/KV 名称与安装目录；
若该域名已有 Worker 或本地配置则升级，否则新建。

Options:
  --repo URL              GitHub repo
  --branch NAME           Git branch (default: main)
  --dir PATH              Install directory (default: ~/pauth-<auth-host-slug>)
  --zone DOMAIN           根域名（可选；默认从 auth-host 推导，如 auth.kass.cc → kass.cc）
  --auth-host HOST        认证域名（必填，或作为唯一 positional 参数）
  --rp-name NAME          RP_NAME（默认从 zone 生成）
  --worker-name NAME      Worker 名称（默认 pauth-<auth-host-slug>；升级时自动探测）
  --d1-name NAME          D1 名称（默认 pauth-<auth-host-slug>-db）
  --kv-title TITLE        KV 标题（默认 CHALLENGES-pauth-<auth-host-slug>）
  --db-location LOC       D1 location hint (default: apac)
  --session-secret STR    SESSION_SECRET (auto-generated if empty)
  --deploy-mode MODE      local | git  (local = wrangler deploy now)
  --config-policy POLICY  keep | merge-bindings | overwrite
                          (when wrangler config already exists)
  --allow-worker-overwrite  Allow deploying to a Worker bound to another hostname
  --rotate-secret         Update SESSION_SECRET even if .dev.vars exists
  --git-first-deploy      Git mode: also run one local wrangler deploy now
  --skip-domain-bind      Do not attach AUTH_HOST to Worker automatically
  --skip-clone            Use existing checkout in --dir
  --yes, -y               Non-interactive
  -h, --help

Config files (written in install dir):
  wrangler.local.jsonc      Local deploy / wrangler dev (gitignored)
  wrangler.production.jsonc Cloudflare Git Builds (commit to private repo)

If wrangler.local.jsonc already exists, interactive mode asks:
  1 keep  2 merge-bindings (sync D1/KV IDs only)  3 overwrite

Custom domain: verifies AUTH_HOST is under your Cloudflare zone, then binds it
to the Worker (overrides existing Worker/DNS on that hostname). --skip-domain-bind
EOF
}

ensure_helpers() {
  if [[ -f "$SCRIPT_DIR/lib/wrangler-config.py" && -f "$SCRIPT_DIR/lib/bind-custom-domain.py" ]]; then
    CONFIG_PY="$SCRIPT_DIR/lib/wrangler-config.py"
    BIND_DOMAIN_PY="$SCRIPT_DIR/lib/bind-custom-domain.py"
    return
  fi

  HELPER_DIR="${TMPDIR:-/tmp}/pauth-deploy-$$"
  mkdir -p "$HELPER_DIR/lib"
  local branch="${GIT_BRANCH:-main}"
  local base="https://raw.githubusercontent.com/kennysoul/pauth/${branch}/scripts/lib"
  if command -v curl >/dev/null 2>&1 \
     && curl -fsSL "$base/wrangler-config.py" -o "$HELPER_DIR/lib/wrangler-config.py" \
     && curl -fsSL "$base/bind-custom-domain.py" -o "$HELPER_DIR/lib/bind-custom-domain.py"; then
    chmod +x "$HELPER_DIR/lib/"*.py
    CONFIG_PY="$HELPER_DIR/lib/wrangler-config.py"
    BIND_DOMAIN_PY="$HELPER_DIR/lib/bind-custom-domain.py"
    trap 'rm -rf "$HELPER_DIR"' EXIT
    return
  fi
  die "无法加载 helper 脚本（需要 scripts/lib/ 或 curl 访问 GitHub）"
}

refresh_helpers_from_install_dir() {
  if [[ -f "$INSTALL_DIR/scripts/lib/wrangler-config.py" && -f "$INSTALL_DIR/scripts/lib/bind-custom-domain.py" ]]; then
    CONFIG_PY="$INSTALL_DIR/scripts/lib/wrangler-config.py"
    BIND_DOMAIN_PY="$INSTALL_DIR/scripts/lib/bind-custom-domain.py"
  fi
}

warn_stale_ca_certs() {
  if [[ -n "${NODE_EXTRA_CA_CERTS:-}" && ! -f "${NODE_EXTRA_CA_CERTS}" ]]; then
    warn "NODE_EXTRA_CA_CERTS 指向不存在的文件，Wrangler 可能报警（可 unset NODE_EXTRA_CA_CERTS）"
  fi
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
" <<<"${WRANGLER_WHOAMI:-}")"
  [[ -n "$CLOUDFLARE_ACCOUNT_ID" ]] || die "无法解析 Account ID；请 export CLOUDFLARE_ACCOUNT_ID=<32位 hex>"
  export CLOUDFLARE_ACCOUNT_ID
}

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
  local target="$1"
  local policy="$2"
  local result
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

normalize_auth_host() {
  AUTH_HOST="$(printf '%s' "$AUTH_HOST" | tr '[:upper:]' '[:lower:]' | sed 's/\.$//')"
}

default_rp_name() {
  python3 -c "import sys; z=sys.argv[1]; print((z.split('.')[0].capitalize() + ' Auth') if z else 'Passkey Auth')" "$1"
}

pauth_default_install_dir() {
  printf '%s/pauth-%s' "$HOME" "$(slugify "$AUTH_HOST")"
}

pauth_apply_install_dir_default() {
  if [[ "$INSTALL_DIR_EXPLICIT" -eq 0 ]]; then
    INSTALL_DIR="$(pauth_default_install_dir)"
  fi
}

pauth_apply_resolve_json() {
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

  if [[ -z "$CONFIG_POLICY" ]]; then
    CONFIG_POLICY="merge-bindings"
  fi

  if [[ "$PAUTH_DEPLOY_MODE" == "upgrade" ]]; then
    info "升级已有部署 · Worker=${WORKER_NAME}"
  else
    info "新建部署 · Worker=${WORKER_NAME}"
  fi
}

pauth_resolve_auth_host() {
  local config_path="${1:-}"
  [[ -n "$AUTH_HOST" ]] || return 0
  [[ -f "$BIND_DOMAIN_PY" ]] || return 0

  normalize_auth_host
  pauth_apply_install_dir_default

  local resolve_args=(--hostname "$AUTH_HOST" --resolve)
  [[ -n "$ZONE_NAME" ]] && resolve_args+=(--zone-name "$ZONE_NAME")
  [[ -n "$config_path" && -f "$config_path" ]] && resolve_args+=(--config-path "$config_path")

  local json
  json="$(python3 "$BIND_DOMAIN_PY" "${resolve_args[@]}")" \
    || die "无法解析认证域名: ${AUTH_HOST}"

  pauth_apply_resolve_json "$json"

  RP_ID="${RP_ID:-$ZONE_NAME}"
  ORIGIN="${ORIGIN:-https://${AUTH_HOST}}"
  COOKIE_DOMAIN="${COOKIE_DOMAIN:-.${ZONE_NAME}}"
  if [[ "$RP_NAME" == "$DEFAULT_RP_NAME" ]]; then
    RP_NAME="$(default_rp_name "$ZONE_NAME")"
  fi
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

preflight_deploy_target() {
  local preflight_args=(
    --hostname "$AUTH_HOST"
    --zone-name "$ZONE_NAME"
    --worker-name "$WORKER_NAME"
    --preflight
  )
  [[ "$SKIP_DOMAIN_BIND" -eq 1 ]] && preflight_args+=(--skip-domain-bind)
  [[ "$ALLOW_WORKER_OVERWRITE" -eq 1 ]] && preflight_args+=(--allow-overwrite)
  info "部署目标预检: Worker=${WORKER_NAME}  域名=${AUTH_HOST}  zone=${ZONE_NAME}"
  if cloudflare_api_token_available; then
    python3 "$BIND_DOMAIN_PY" "${preflight_args[@]}"
  else
    info "OAuth 模式：跳过 REST API 预检（Wrangler 已登录即可继续）"
    npx wrangler whoami >/dev/null 2>&1 || die "wrangler 未登录：请先 npx wrangler login 或设置 CLOUDFLARE_API_TOKEN"
    warn "域名将由 wrangler routes（custom_domain）在 deploy 时绑定"
  fi
}

strip_wrangler_routes() {
  local cfg="$1"
  python3 -c "
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

p = Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
cfg = json.loads(strip_jsonc(text))
if cfg.pop('routes', None) is not None:
    p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\\n', encoding='utf-8')
" "$cfg" 2>/dev/null || true
}

verify_auth_zone() {
  if ! cloudflare_api_token_available; then
    info "OAuth 模式：跳过 zone REST 验证（wrangler deploy 将校验权限）"
    return 0
  fi
  info "验证 ${ZONE_NAME} 在当前 Cloudflare 账户中…"
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
    npx wrangler deploy -c "$WRANGLER_CFG"
    return 0
  fi
  info "绑定 ${AUTH_HOST} → Worker ${WORKER_NAME}（覆盖已有 Worker / DNS 绑定）"
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
  npx wrangler deploy -c "$WRANGLER_CFG" \
    || die "无法绑定 ${AUTH_HOST}，请检查 Cloudflare 权限（Workers + DNS + Zone）"
}

pauth_parse_args() {
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
      --provision-only) PROVISION_ONLY=1; shift ;;
      --yes|-y) ASSUME_YES=1; NON_INTERACTIVE=1; shift ;;
      -h|--help) PAUTH_SHOW_HELP=1; shift ;;
      *)
        if [[ "$1" != -* && -z "$AUTH_HOST" ]]; then
          AUTH_HOST="$1"
          shift
          continue
        fi
        die "Unknown option: $1" ;;
    esac
  done
}

pauth_need_tools() {
  need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing: $1"; }
  need_cmd node npm git python3
  ensure_helpers
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  [[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js 20+ required"
}

print_git_instructions() {
  local prod="$INSTALL_DIR/wrangler.production.jsonc"
  cat <<EOF

${CYAN}── GitHub 自动部署（Cloudflare Workers Builds）──${NC}

1. 在 GitHub 安装 Cloudflare Workers & Pages App，授权仓库:
   ${REPO_URL}

2. Cloudflare Dashboard → Workers & Pages → ${WORKER_NAME} → Settings → Builds
   Connect to Git → 选择仓库与分支 ${GIT_BRANCH}

3. 构建配置:
   Build command:  npm run build
   Deploy command: npm run deploy:workers

4. 将生产配置提交到私有仓库（仅含资源 ID，不含 Secret）:
   git add wrangler.production.jsonc
   git commit -m "Add Cloudflare production wrangler config"
   git push

5. Settings → Variables and Secrets 中确认 SESSION_SECRET 已设置
   （本脚本已上传；Git 构建不会读取 .dev.vars）

6. 之后每次 push 到 ${GIT_BRANCH} 将自动构建部署。
   deploy:workers 已包含 remote migration

配置文件: ${prod}
EOF
}


print_badge_instructions() {
  cat <<EOF

${CYAN}── Deploy to Cloudflare 徽章 / Workers Builds ──${NC}

1. 提交资源配置（含真实 D1/KV ID 与域名 vars）:
   git add wrangler.jsonc wrangler.production.jsonc
   git commit -m "Configure Cloudflare resources"
   git push

2. Cloudflare Dashboard → Worker → Settings → Builds:
   Build command:  npm run build
   Deploy command: npm run deploy:workers

3. Settings → Variables and Secrets → 添加 SESSION_SECRET
   （值见 .dev.vars；Builds 不会读取 .dev.vars）

4. 首次 Build 成功后，绑定域名并上传 Secret:
   ./scripts/deploy-cloudflare.sh --dir . --skip-clone --zone ${ZONE_NAME} --auth-host ${AUTH_HOST} --yes --config-policy keep

5. 访问 https://${AUTH_HOST}/setup 注册 root 管理员 Passkey

D1: ${D1_NAME} (${D1_ID})  KV: ${KV_TITLE} (${KV_ID})
EOF
}

pauth_print_finish() {
  echo ""
  echo "============================================"
  printf '%b\n' "${GREEN}完成${NC}"
  echo "  站点:     ${ORIGIN}"
  echo "  域名:     ${AUTH_HOST}"
  echo "  模式:     ${DEPLOY_MODE}"
  echo "  本地配置: ${WRANGLER_LOCAL}"
  [[ -f "$WRANGLER_PROD" ]] && echo "  CI 配置:  ${WRANGLER_PROD}"
  [[ -f "$WRANGLER_ROOT" ]] && echo "  徽章配置: ${WRANGLER_ROOT}"
  echo "  D1:       ${D1_NAME} (${D1_ID})"
  echo "  KV:       ${KV_TITLE} (${KV_ID})"
  echo ""
  if [[ "$PROVISION_ONLY" -eq 1 ]]; then
    print_badge_instructions
    warn "下一步: push 配置后由 Workers Builds 执行 npm run deploy:workers"
  elif [[ "$DEPLOY_MODE" == "git" ]]; then
    print_git_instructions
  else
    warn "SESSION_SECRET 在 .dev.vars，勿提交 git"
  fi
  if [[ "$PROVISION_ONLY" -eq 0 ]]; then
    warn "发版后有新 migration 时请执行: npm run db:migrate:remote"
  fi
  echo "============================================"
}
pauth_run_provision() {
# ── Clone / pull (early, so we can read existing config) ───────────────────

if [[ -n "$AUTH_HOST" ]]; then
  normalize_auth_host
  pauth_apply_install_dir_default
fi

if [[ "$SKIP_CLONE" -eq 1 ]]; then
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
  [[ -f "$INSTALL_DIR/package.json" ]] || die "Invalid pauth dir: $INSTALL_DIR"
else
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" fetch origin "$GIT_BRANCH"
    git -C "$INSTALL_DIR" checkout "$GIT_BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_BRANCH"
  else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --branch "$GIT_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
fi

WRANGLER_LOCAL="$INSTALL_DIR/wrangler.local.jsonc"
WRANGLER_PROD="$INSTALL_DIR/wrangler.production.jsonc"
WRANGLER_ROOT="$INSTALL_DIR/wrangler.jsonc"
EXISTING_CFG=""
if [[ -f "$WRANGLER_LOCAL" ]]; then
  EXISTING_CFG="$WRANGLER_LOCAL"
elif [[ -f "$WRANGLER_PROD" ]]; then
  EXISTING_CFG="$WRANGLER_PROD"
fi
load_vars_from_wrangler "$EXISTING_CFG"

if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  echo ""
  if [[ "$PROVISION_ONLY" -eq 1 ]]; then echo "=== pauth · Cloudflare 资源配置 ==="; else echo "=== pauth · Cloudflare 部署 ==="; fi
  echo ""
  prompt REPO_URL "GitHub 仓库 URL" "$DEFAULT_REPO"
  prompt GIT_BRANCH "分支" "$DEFAULT_BRANCH"
  if [[ -z "$AUTH_HOST" ]]; then
    prompt AUTH_HOST "认证域名（如 auth.example.com）" ""
    [[ -n "$AUTH_HOST" ]] || die "认证域名不能为空"
  fi
  normalize_auth_host
  pauth_apply_install_dir_default
  prompt INSTALL_DIR "安装目录" "$INSTALL_DIR"
  if [[ -z "$ZONE_NAME" ]]; then
    info "根域名将从 ${AUTH_HOST} 自动推导"
  else
    prompt ZONE_NAME "根域名（Cloudflare 托管，留空则自动推导）" "$ZONE_NAME"
  fi
  prompt RP_NAME "Passkey 显示名称" "${RP_NAME:-$(default_rp_name "${ZONE_NAME:-$AUTH_HOST}")}"
  prompt DB_LOCATION "D1 区域" "$DEFAULT_DB_LOCATION"
  if [[ -z "$DEPLOY_MODE" ]]; then
    echo ""
    if [[ "$PROVISION_ONLY" -eq 1 ]]; then
      echo "配置模式: Git / Deploy 徽章（生成 wrangler.jsonc + wrangler.production.jsonc）"
      DEPLOY_MODE="git"
    else
      echo "部署方式:"
      echo "  1) 本地上传（wrangler deploy，立即部署）"
      echo "  2) GitHub 挂钩（生成 wrangler.production.jsonc，由 Cloudflare Builds 自动部署）"
      read -r -p "选择 [1]: " dm
      case "${dm:-1}" in
        2) DEPLOY_MODE="git" ;;
        *) DEPLOY_MODE="local" ;;
      esac
    fi
  fi
  if [[ -z "$SESSION_SECRET" ]]; then
    read -r -p "SESSION_SECRET（留空则自动生成）: " SESSION_SECRET
  fi
  echo ""
  info "目标: https://${AUTH_HOST}  模式: ${DEPLOY_MODE}"
  confirm "继续？" || exit 0
else
  [[ -n "$AUTH_HOST" ]] || die "--yes 需要认证域名，例如: --auth-host auth.kass.cc 或 positional auth.kass.cc"
  if [[ "$PROVISION_ONLY" -eq 1 ]]; then DEPLOY_MODE="${DEPLOY_MODE:-git}"; else DEPLOY_MODE="${DEPLOY_MODE:-local}"; fi
  CONFIG_POLICY="${CONFIG_POLICY:-merge-bindings}"
fi

refresh_helpers_from_install_dir
pauth_resolve_auth_host "$EXISTING_CFG"

DEPLOY_MODE="${DEPLOY_MODE:-local}"
[[ "$DEPLOY_MODE" == "local" || "$DEPLOY_MODE" == "git" ]] || die "--deploy-mode 须为 local 或 git"

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

info "检查 Wrangler 登录…"
warn_stale_ca_certs
WRANGLER_WHOAMI="$(npx wrangler whoami 2>&1)" || die "请先 npx wrangler login 或设置 CLOUDFLARE_API_TOKEN"
printf '%s\n' "$WRANGLER_WHOAMI"
resolve_account_id
info "Account ID: ${CLOUDFLARE_ACCOUNT_ID}"

cd "$INSTALL_DIR"
export PAUTH_INSTALL_DIR="$INSTALL_DIR"
validate_wrangler_config_policy "$WRANGLER_LOCAL"
preflight_deploy_target

# ── D1 / KV ────────────────────────────────────────────────────────────────

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
  local title="$1" preview="${2:-}"
  info "创建 KV: $title${preview:+ (preview)}"
  local out id
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
  [[ -n "$D1_ID" ]] || die "Invalid D1 id (log text may have been captured — retry deploy)"
  [[ -n "$KV_ID" ]] || die "Invalid KV id (log text may have been captured — retry deploy)"
  [[ -n "$KV_PREVIEW_ID" ]] || die "Invalid KV preview id (log text may have been captured — retry deploy)"
}

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

# ── Wrangler config (interactive policy per file) ───────────────────────────

write_config_pair() {
  local policy_local="$1" policy_prod="$2"
  write_wrangler_config "$WRANGLER_LOCAL" "$policy_local"
  if [[ "$DEPLOY_MODE" == "git" ]]; then
    write_wrangler_config "$WRANGLER_PROD" "$policy_prod"
    write_wrangler_config "$WRANGLER_ROOT" "$policy_prod"
  elif [[ -f "$WRANGLER_PROD" ]]; then
    write_wrangler_config "$WRANGLER_PROD" "$policy_prod"
  fi
}

if [[ -n "$CONFIG_POLICY" ]]; then
  local_policy="$CONFIG_POLICY"
  prod_policy="$CONFIG_POLICY"
  write_config_pair "$local_policy" "$prod_policy"
else
  local_policy=""
  choose_config_policy "$WRANGLER_LOCAL" local_policy
  if [[ "$DEPLOY_MODE" == "git" ]]; then
    prod_policy=""
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

verify_auth_zone

# .dev.vars — respect keep unless rotate
DEV_VARS="$INSTALL_DIR/.dev.vars"
if [[ -f "$DEV_VARS" && "$ROTATE_SECRET" -eq 0 ]]; then
  if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    read -r -p "已存在 .dev.vars，是否更新 SESSION_SECRET？[y/N]: " rot
    [[ "$rot" =~ ^[Yy]$ ]] && ROTATE_SECRET=1
  else
    info "保留 .dev.vars（使用 --rotate-secret 可强制更新）"
  fi
fi
if [[ ! -f "$DEV_VARS" || "$ROTATE_SECRET" -eq 1 ]]; then
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET" >"$DEV_VARS"
  chmod 600 "$DEV_VARS" 2>/dev/null || true
fi

cat >"$INSTALL_DIR/.deploy-cloudflare.env" <<EOF
# Generated by deploy-cloudflare.sh — do not commit
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


}
pauth_run_deploy() {
# ── Build, secrets, migrate ─────────────────────────────────────────────────

info "npm install && npm run build"
npm install
npm run build

WRANGLER_CFG="$WRANGLER_LOCAL"
[[ -f "$WRANGLER_CFG" ]] || die "缺少 $WRANGLER_CFG"

ensure_wrangler_custom_domain_route "$WRANGLER_CFG"

info "上传 SESSION_SECRET 到 Worker"
printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET -c "$WRANGLER_CFG"

info "应用 D1 迁移（remote）"
npx wrangler d1 migrations apply DB --remote -c "$WRANGLER_CFG"

# ── Deploy ──────────────────────────────────────────────────────────────────

RUN_LOCAL_DEPLOY=0
if [[ "$DEPLOY_MODE" == "local" ]]; then
  RUN_LOCAL_DEPLOY=1
elif [[ "$GIT_FIRST_DEPLOY" -eq 1 ]]; then
  RUN_LOCAL_DEPLOY=1
elif [[ "$NON_INTERACTIVE" -eq 0 ]]; then
  read -r -p "Git 模式：是否现在执行一次本地 wrangler deploy 注册 Worker？[y/N]: " fd
  [[ "$fd" =~ ^[Yy]$ ]] && RUN_LOCAL_DEPLOY=1
fi

if [[ "$RUN_LOCAL_DEPLOY" -eq 1 ]]; then
  info "部署 Worker（本地 wrangler deploy）"
  npm run deploy
fi

bind_auth_domain

}
