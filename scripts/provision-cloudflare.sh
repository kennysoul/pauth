#!/usr/bin/env bash
# Provision Cloudflare D1 + KV and write wrangler configs (upper half of deploy-cloudflare.sh).
# Use after [Deploy to Cloudflare] badge: Workers Builds handles build + deploy.
#
# Examples:
#   ./scripts/provision-cloudflare.sh --yes auth.kass.cc
#   ./scripts/provision-cloudflare.sh --dir . --skip-clone --yes auth.kass.cc
#
# Self-contained: if scripts/lib/deploy-common.sh is missing, fetches it from GitHub.

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
  curl -fsSL "https://raw.githubusercontent.com/kennysoul/pauth/main/scripts/lib/deploy-common.sh" \
    -o "$PAUTH_COMMON"
  PAUTH_FETCHED_COMMON=1
  trap '[[ "$PAUTH_FETCHED_COMMON" -eq 1 ]] && rm -f "$PAUTH_COMMON"' EXIT
  # shellcheck source=/tmp/pauth-deploy-common.sh
  source "$PAUTH_COMMON"
}

provision_usage() {
  cat <<'EOF'
Usage: provision-cloudflare.sh [options] [auth-host]

Provision D1 + KV and write wrangler configs for pauth (no build/deploy).
Pair with Deploy to Cloudflare badge + Workers Builds (npm run deploy:workers).

常规用法:
  ./provision-cloudflare.sh --yes auth.kass.cc

Options:
  --auth-host HOST        认证域名（必填，或作为 positional 参数）
  --zone DOMAIN           根域名（可选；默认从 auth-host 推导）
  --dir PATH              项目目录（默认 ~/pauth-<auth-host-slug>）
  --worker-name NAME      Worker 名称（默认 pauth-<auth-host-slug>）
  --d1-name NAME          D1 名称（默认 pauth-<auth-host-slug>-db）
  --kv-title TITLE        KV 标题（默认 CHALLENGES-pauth-<auth-host-slug>）
  --skip-clone            Use existing checkout in --dir
  --deploy-mode MODE      git (default) | local
  --config-policy POLICY  keep | merge-bindings | overwrite
  --yes, -y               Non-interactive
  -h, --help

Writes: wrangler.local.jsonc, wrangler.production.jsonc, wrangler.jsonc, .dev.vars
EOF
}

pauth_load_common

PROVISION_ONLY=1
pauth_parse_args "$@"

if [[ "${PAUTH_SHOW_HELP:-0}" -eq 1 ]]; then
  provision_usage
  exit 0
fi

pauth_need_tools
pauth_run_provision
pauth_print_finish
