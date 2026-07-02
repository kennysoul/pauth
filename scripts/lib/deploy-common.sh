# Shared Cloudflare bootstrap helpers for pauth.
# Sourced by provision-cloudflare.sh and deploy-cloudflare.sh — do not execute directly.
[[ "${BASH_SOURCE[0]}" == "${0}" ]] && { echo "Source this file, do not run directly." >&2; exit 1; }

: "${SCRIPT_DIR:?SCRIPT_DIR must be set before sourcing deploy-common.sh}"

# Defaults
: "${DEFAULT_REPO:=https://github.com/kennysoul/pauth.git}"
: "${DEFAULT_BRANCH:=main}"
: "${DEFAULT_INSTALL_DIR:=$HOME/pauth}"
: "${DEFAULT_WORKER_NAME:=passkey-auth}"
: "${DEFAULT_D1_NAME:=passkey-auth-db}"
: "${DEFAULT_KV_TITLE:=CHALLENGES}"
: "${DEFAULT_RP_NAME:=Kass Auth}"
: "${DEFAULT_DB_LOCATION:=apac}"

REPO_URL="${REPO_URL:-$DEFAULT_REPO}"
GIT_BRANCH="${GIT_BRANCH:-$DEFAULT_BRANCH}"
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
ZONE_NAME="${ZONE_NAME:-}"
AUTH_HOST="${AUTH_HOST:-}"
RP_NAME="${RP_NAME:-$DEFAULT_RP_NAME}"
WORKER_NAME="${WORKER_NAME:-$DEFAULT_WORKER_NAME}"
D1_NAME="${D1_NAME:-$DEFAULT_D1_NAME}"
KV_TITLE="${KV_TITLE:-$DEFAULT_KV_TITLE}"
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

info() { printf '%b\n' "${GREEN}→${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*"; }
die() { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy-cloudflare.sh [options]

Bootstrap pauth on Cloudflare: D1 + KV + wrangler config + deploy.

This script is self-contained — you may download only this file and run it;
it will clone the pauth repo and extract embedded helper tools automatically.

Options:
  --repo URL              GitHub repo
  --branch NAME           Git branch (default: main)
  --dir PATH              Install directory (default: ~/pauth)
  --zone DOMAIN           Apex zone on Cloudflare (required with --yes)
  --auth-host HOST        Auth hostname (default: auth.<zone>)
  --rp-name NAME          RP_NAME (default: Kass Auth)
  --worker-name NAME      Worker name (default: passkey-auth)
  --d1-name NAME          D1 database name
  --kv-title TITLE        KV namespace title
  --db-location LOC       D1 location hint (default: apac)
  --session-secret STR    SESSION_SECRET (auto-generated if empty)
  --deploy-mode MODE      local | git  (local = wrangler deploy now)
  --config-policy POLICY  keep | merge-bindings | overwrite
                          (when wrangler config already exists)
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

  cat >"$HELPER_DIR/lib/wrangler-config.py" <<'PY'
#!/usr/bin/env python3
"""Merge or write wrangler JSONC configs for deploy-cloudflare.sh."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def load_jsonc(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    lines = [re.sub(r"//.*$", "", line) for line in text.splitlines()]
    return json.loads("\n".join(lines))


def dump_jsonc(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def build_desired(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "$schema": "node_modules/wrangler/config-schema.json",
        "name": args.worker_name,
        "main": "src/index.ts",
        "compatibility_date": "2025-06-05",
        "compatibility_flags": ["nodejs_compat"],
        "vars": {
            "RP_ID": args.rp_id,
            "RP_NAME": args.rp_name,
            "ORIGIN": args.origin,
            "COOKIE_DOMAIN": args.cookie_domain,
            "AUTH_HOST": args.auth_host,
            "SESSION_TTL_SECONDS": "604800",
            "SETUP_TTL_SECONDS": "600",
        },
        "assets": {
            "directory": "./dist",
            "binding": "ASSETS",
            "not_found_handling": "single-page-application",
            "run_worker_first": True,
        },
        "d1_databases": [
            {
                "binding": "DB",
                "database_name": args.d1_name,
                "database_id": args.d1_id,
                "migrations_dir": "migrations",
            }
        ],
        "kv_namespaces": [
            {
                "binding": "CHALLENGES",
                "id": args.kv_id,
                "preview_id": args.kv_preview_id,
            }
        ],
        "routes": [
            {
                "pattern": args.auth_host,
                "zone_name": args.zone_name,
                "custom_domain": True,
            }
        ],
        "observability": {"enabled": True},
    }


def diff_summary(existing: dict[str, Any], desired: dict[str, Any]) -> list[str]:
    lines: list[str] = []

    def var(key: str) -> str:
        return str((existing.get("vars") or {}).get(key, ""))

    def dvar(key: str) -> str:
        return str((desired.get("vars") or {}).get(key, ""))

    for key in ("RP_ID", "RP_NAME", "ORIGIN", "COOKIE_DOMAIN", "AUTH_HOST"):
        if var(key) != dvar(key):
            lines.append(f"vars.{key}: {var(key) or '(空)'} → {dvar(key)}")

    ex_d1 = ((existing.get("d1_databases") or [{}])[0]).get("database_id", "")
    de_d1 = ((desired.get("d1_databases") or [{}])[0]).get("database_id", "")
    if ex_d1 != de_d1:
        lines.append(f"d1.database_id: {ex_d1 or '(空)'} → {de_d1}")

    ex_kv = ((existing.get("kv_namespaces") or [{}])[0]).get("id", "")
    de_kv = ((desired.get("kv_namespaces") or [{}])[0]).get("id", "")
    if ex_kv != de_kv:
        lines.append(f"kv.id: {ex_kv or '(空)'} → {de_kv}")

    ex_prev = ((existing.get("kv_namespaces") or [{}])[0]).get("preview_id", "")
    de_prev = ((desired.get("kv_namespaces") or [{}])[0]).get("preview_id", "")
    if ex_prev != de_prev:
        lines.append(f"kv.preview_id: {ex_prev or '(空)'} → {de_prev}")

    ex_route = ((existing.get("routes") or [{}])[0]).get("pattern", "")
    de_route = ((desired.get("routes") or [{}])[0]).get("pattern", "")
    if ex_route != de_route:
        lines.append(f"routes.pattern: {ex_route or '(空)'} → {de_route}")

    if existing.get("name") != desired.get("name"):
        lines.append(f"name: {existing.get('name')} → {desired.get('name')}")

    return lines


def merge_config(existing: dict[str, Any], desired: dict[str, Any]) -> dict[str, Any]:
    merged = json.loads(json.dumps(existing))
    merged["d1_databases"] = desired["d1_databases"]
    merged["kv_namespaces"] = desired["kv_namespaces"]
    for key in ("$schema", "main", "compatibility_date", "compatibility_flags", "assets", "observability"):
        if key in desired:
            merged[key] = desired[key]
    return merged


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--policy", choices=("keep", "merge-bindings", "overwrite"), required=True)
    parser.add_argument("--worker-name", required=True)
    parser.add_argument("--zone-name", required=True)
    parser.add_argument("--auth-host", required=True)
    parser.add_argument("--rp-id", required=True)
    parser.add_argument("--rp-name", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--cookie-domain", required=True)
    parser.add_argument("--d1-name", required=True)
    parser.add_argument("--d1-id", required=True)
    parser.add_argument("--kv-id", required=True)
    parser.add_argument("--kv-preview-id", required=True)
    parser.add_argument("--diff-only", action="store_true")
    args = parser.parse_args()

    target = Path(args.target)
    desired = build_desired(args)

    if not target.exists():
        if args.diff_only:
            print("NEW")
            return 0
        target.write_text(dump_jsonc(desired), encoding="utf-8")
        print("CREATED")
        return 0

    existing = load_jsonc(target)
    changes = diff_summary(existing, desired)

    if args.diff_only:
        if not changes:
            print("SAME")
        else:
            print("\n".join(changes))
        return 0

    if args.policy == "keep":
        print("KEPT")
        return 0

    if args.policy == "merge-bindings":
        merged = merge_config(existing, desired)
        target.write_text(dump_jsonc(merged), encoding="utf-8")
        print("MERGED")
        return 0

    target.write_text(dump_jsonc(desired), encoding="utf-8")
    print("OVERWRITTEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY

  cat >"$HELPER_DIR/lib/bind-custom-domain.py" <<'PY'
#!/usr/bin/env python3
"""Verify Cloudflare zone ownership and force-bind a Worker custom domain."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


API_BASE = "https://api.cloudflare.com/client/v4"


def load_api_token() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token

    home = Path(os.environ.get("WRANGLER_HOME", Path.home() / ".wrangler"))
    config_paths = [
        home / "config" / "default.toml",
        Path.home() / ".config" / ".wrangler" / "config" / "default.toml",
    ]
    for path in config_paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for key in ("api_token", "oauth_token"):
            m = re.search(rf'^{key}\s*=\s*"([^"]+)"', text, re.MULTILINE)
            if m and m.group(1):
                return m.group(1)
    die("需要 CLOUDFLARE_API_TOKEN 或已执行 wrangler login")


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def api_request(
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{API_BASE}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            msgs = parsed.get("errors") or []
            if msgs:
                die(msgs[0].get("message") or detail)
        except json.JSONDecodeError:
            pass
        die(f"HTTP {e.code}: {detail[:400]}")
    except urllib.error.URLError as e:
        die(str(e))

    if not payload.get("success"):
        errs = payload.get("errors") or []
        if errs:
            die(errs[0].get("message") or json.dumps(errs))
        die(json.dumps(payload))
    return payload


def get_account_id(token: str) -> str:
    env_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if env_id:
        return env_id

    proc = subprocess.run(
        ["npx", "wrangler", "whoami"],
        capture_output=True,
        text=True,
        check=False,
    )
    out = proc.stdout + proc.stderr
    m = re.search(r"Account ID[:\s]+([0-9a-f]{32})", out, re.I)
    if m:
        return m.group(1)

    data = api_request(token, "GET", "/accounts?per_page=50")
    results = data.get("result") or []
    if not results:
        die("无法获取 Cloudflare Account ID")
    if len(results) == 1:
        return results[0]["id"]
    die("多个 Cloudflare 账户，请设置 CLOUDFLARE_ACCOUNT_ID")


def find_zone(token: str, zone_name: str) -> dict[str, Any]:
    path = f"/zones?name={urllib.parse.quote(zone_name)}&status=active&per_page=1"
    data = api_request(token, "GET", path)
    zones = data.get("result") or []
    if not zones:
        die(f"域名 {zone_name} 不在当前 Cloudflare 账户中（或 zone 未激活）")
    zone = zones[0]
    if zone.get("name") != zone_name:
        die(f"Zone 匹配异常: 期望 {zone_name}，得到 {zone.get('name')}")
    return zone


def hostname_in_zone(hostname: str, zone_name: str) -> bool:
    return hostname == zone_name or hostname.endswith("." + zone_name)


def bind_custom_domain(
    token: str,
    account_id: str,
    worker_name: str,
    hostname: str,
    zone_id: str,
    zone_name: str,
) -> None:
    worker_url = f"/accounts/{account_id}/workers/scripts/{worker_name}"
    origins = [{"hostname": hostname, "zone_id": zone_id, "zone_name": zone_name}]
    body = {
        "override_scope": True,
        "override_existing_origin": True,
        "override_existing_dns_record": True,
        "origins": origins,
    }
    api_request(token, "PUT", f"{worker_url}/domains/records", body)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bind auth hostname to pauth Worker")
    parser.add_argument("--hostname", required=True, help="e.g. auth.kass.cc")
    parser.add_argument("--zone-name", required=True, help="e.g. kass.cc")
    parser.add_argument("--worker-name", default="passkey-auth")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    hostname = args.hostname.strip().lower()
    zone_name = args.zone_name.strip().lower()
    if not hostname_in_zone(hostname, zone_name):
        die(f"{hostname} 不是 {zone_name} 下的域名")

    token = load_api_token()
    account_id = get_account_id(token)
    zone = find_zone(token, zone_name)
    zone_id = zone["id"]

    if args.verify_only:
        print(f"OK zone={zone_name} id={zone_id}")
        return 0

    bind_custom_domain(token, account_id, args.worker_name, hostname, zone_id, zone_name)
    print(f"BOUND {hostname} -> {args.worker_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY

  chmod +x "$HELPER_DIR/lib/wrangler-config.py" "$HELPER_DIR/lib/bind-custom-domain.py"
  CONFIG_PY="$HELPER_DIR/lib/wrangler-config.py"
  BIND_DOMAIN_PY="$HELPER_DIR/lib/bind-custom-domain.py"
  trap 'rm -rf "$HELPER_DIR"' EXIT
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

load_vars_from_wrangler() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  python3 -c "
import json, re, sys
from pathlib import Path
p = Path(sys.argv[1])
text = p.read_text()
text = '\n'.join(re.sub(r'//.*$', '', line) for line in text.splitlines())
cfg = json.loads(text)
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
        print(f'{k}={v}')
" "$file" > /tmp/pauth-wrangler-load.env 2>/dev/null || return 0
  # shellcheck disable=SC1091
  source /tmp/pauth-wrangler-load.env
  rm -f /tmp/pauth-wrangler-load.env
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
   Deploy command: npx wrangler deploy --config wrangler.production.jsonc

4. 将生产配置提交到私有仓库（仅含资源 ID，不含 Secret）:
   git add wrangler.production.jsonc
   git commit -m "Add Cloudflare production wrangler config"
   git push

5. Settings → Variables and Secrets 中确认 SESSION_SECRET 已设置
   （本脚本已上传；Git 构建不会读取 .dev.vars）

6. 之后每次 push 到 ${GIT_BRANCH} 将自动构建部署。
   数据库迁移仍需在发版后手动执行:
   npm run db:migrate:remote

配置文件: ${prod}
EOF
}

verify_auth_zone() {
  info "验证 ${ZONE_NAME} 在当前 Cloudflare 账户中…"
  python3 "$BIND_DOMAIN_PY" \
    --hostname "$AUTH_HOST" \
    --zone-name "$ZONE_NAME" \
    --worker-name "$WORKER_NAME" \
    --verify-only
}

bind_auth_domain() {
  [[ "$SKIP_DOMAIN_BIND" -eq 1 ]] && return 0
  info "绑定 ${AUTH_HOST} → Worker ${WORKER_NAME}（覆盖已有 Worker / DNS 绑定）"
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

pauth_parse_args() {
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
      --provision-only) PROVISION_ONLY=1; shift ;;
      --yes|-y) ASSUME_YES=1; NON_INTERACTIVE=1; shift ;;
      -h|--help) PAUTH_SHOW_HELP=1; shift ;;
      *) die "Unknown option: $1" ;;
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
  prompt INSTALL_DIR "安装目录" "$INSTALL_DIR"
  prompt ZONE_NAME "根域名（Cloudflare 托管）" "${ZONE_NAME:-}"
  [[ -n "$ZONE_NAME" ]] || die "根域名不能为空"
  prompt AUTH_HOST "认证主机名" "${AUTH_HOST:-auth.${ZONE_NAME}}"
  prompt RP_NAME "Passkey 显示名称" "${RP_NAME:-$DEFAULT_RP_NAME}"
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
  [[ -n "$ZONE_NAME" ]] || die "--yes 需要 --zone"
  AUTH_HOST="${AUTH_HOST:-auth.${ZONE_NAME}}"
  if [[ "$PROVISION_ONLY" -eq 1 ]]; then DEPLOY_MODE="${DEPLOY_MODE:-git}"; else DEPLOY_MODE="${DEPLOY_MODE:-local}"; fi
  CONFIG_POLICY="${CONFIG_POLICY:-merge-bindings}"
fi

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
npx wrangler whoami >/dev/null 2>&1 || die "请先 npx wrangler login 或设置 CLOUDFLARE_API_TOKEN"
npx wrangler whoami

verify_auth_zone

cd "$INSTALL_DIR"

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
import re,sys
t=sys.stdin.read()
m=re.search(r'\"id\":\s*\"([a-f0-9]{32})\"',t) or re.search(r\"id\s*=\s*['\\\"]([a-f0-9]{32})['\\\"]\",t)
print(m.group(1) if m else '')
")"
  [[ -n "$id" ]] || die "KV 创建失败: $out"
  printf '%s' "$id"
}

# Reuse IDs from existing local config when user chose keep (set below for migrate only)
KEEP_EXISTING_CONFIG=0

D1_ID="$(find_d1_id || true)"
if [[ -z "$D1_ID" ]]; then create_d1; D1_ID="$(find_d1_id)"; fi
[[ -n "$D1_ID" ]] || die "无法获取 D1 id"
info "D1: $D1_NAME → $D1_ID"

KV_ID="${KV_ID:-$(find_kv_id "$KV_TITLE" || true)}"
[[ -z "$KV_ID" ]] && KV_ID="$(create_kv "$KV_TITLE")"
KV_PREVIEW_ID="${KV_PREVIEW_ID:-$(find_kv_id "$KV_TITLE" 1 || true)}"
[[ -z "$KV_PREVIEW_ID" ]] && KV_PREVIEW_ID="$(create_kv "$KV_TITLE" --preview)"
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

[[ "$local_policy" == "keep" || "$CONFIG_POLICY" == "keep" ]] && KEEP_EXISTING_CONFIG=1

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

  bind_auth_domain
}
