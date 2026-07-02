#!/usr/bin/env bash
# Full bootstrap: provision (D1/KV/config) + build + deploy + domain bind.
#
# Self-contained: if scripts/lib/deploy-common.sh is missing, fetches it from GitHub.
#
# Examples:
#   bash deploy-cloudflare.sh --yes auth.example.com
#   bash deploy-cloudflare.sh --yes --auth-host auth.example.com --deploy-mode git
#   ./scripts/deploy-cloudflare.sh --deploy-mode git --config-policy keep --yes
#   ./scripts/deploy-cloudflare.sh --dir . --skip-clone --provision-only --yes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAUTH_COMMON="${TMPDIR:-/tmp}/pauth-deploy-common-$$.sh"
PAUTH_FETCHED_COMMON=0

pauth_load_common() {
  local bundled="$SCRIPT_DIR/lib/deploy-common.sh"
  if [[ -f "$bundled" ]]; then
    # shellcheck source=lib/deploy-common.sh
    source "$bundled"
    return
  fi
  info() { printf '%b\n' "\033[0;32m→\033[0m $*"; }
  info "下载 deploy-common.sh…"
  local fetch_repo="${PAUTH_REPO_URL:-https://github.com/your-org/pauth.git}"
  local fetch_branch="${PAUTH_BRANCH:-main}"
  local raw_base=""
  if [[ "$fetch_repo" =~ github\.com[:/]+([^/]+)/([^/.]+)(\.git)?$ ]]; then
    raw_base="https://raw.githubusercontent.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/${fetch_branch}"
  else
    die "无法从 PAUTH_REPO_URL 推导 GitHub raw URL"
  fi
  curl -fsSL "${raw_base}/scripts/lib/deploy-common.sh" \
    -o "$PAUTH_COMMON"
  PAUTH_FETCHED_COMMON=1
  trap '[[ "$PAUTH_FETCHED_COMMON" -eq 1 ]] && rm -f "$PAUTH_COMMON"' EXIT
  # shellcheck source=/tmp/pauth-deploy-common.sh
  source "$PAUTH_COMMON"
}

deploy_usage() {
  cat <<'EOF'
Usage: deploy-cloudflare.sh [options] [auth-host]

Bootstrap pauth on Cloudflare: D1 + KV + wrangler config + deploy.

常规用法:
  ./deploy-cloudflare.sh --yes auth.example.com

Options:
  --auth-host HOST        认证域名（必填，或作为 positional 参数）
  --repo URL              GitHub repo
  --branch NAME           Git branch (default: main)
  --dir PATH              Install directory (default: ~/pauth-<auth-host-slug>)
  --zone DOMAIN           根域名（可选；默认从 auth-host 推导）
  --rp-name NAME          RP_NAME（默认从 zone 生成）
  --worker-name NAME      Worker name (default: pauth-<auth-host-slug>)
  --d1-name NAME          D1 database name (default: pauth-<auth-host-slug>-db)
  --kv-title TITLE        KV namespace title (default: CHALLENGES-pauth-<auth-host-slug>)
  --db-location LOC       D1 location hint (default: apac)
  --session-secret STR    SESSION_SECRET (auto-generated if empty)
  --deploy-mode MODE      local | git
  --config-policy POLICY  keep | merge-bindings | overwrite
  --allow-worker-overwrite  Allow deploying to a Worker bound to another hostname
  --provision-only        Stop after D1/KV/config (same as provision-cloudflare.sh)
  --rotate-secret         Update SESSION_SECRET even if .dev.vars exists
  --git-first-deploy      Git mode: also run one local wrangler deploy now
  --skip-domain-bind      Do not attach AUTH_HOST to Worker automatically
  --skip-clone            Use existing checkout in --dir
  --yes, -y               Non-interactive
  -h, --help

See also: full-deploy-cloudflare.sh（单文件全量部署，预检后从 GitHub 拉 lib 到临时目录）
EOF
}

pauth_load_common

pauth_parse_args "$@"

if [[ "${PAUTH_SHOW_HELP:-0}" -eq 1 ]]; then
  deploy_usage
  exit 0
fi

pauth_need_tools
pauth_run_provision

if [[ "${PROVISION_ONLY:-0}" -eq 1 ]]; then
  pauth_print_finish
  exit 0
fi

pauth_run_deploy
pauth_print_finish
