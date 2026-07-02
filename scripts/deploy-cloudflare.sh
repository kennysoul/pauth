#!/usr/bin/env bash
# Full bootstrap: provision (D1/KV/config) + build + deploy + domain bind.
#
# Self-contained: if scripts/lib/deploy-common.sh is missing, fetches it from GitHub.
#
# Examples:
#   curl -fsSL .../deploy-cloudflare.sh | bash
#   bash deploy-cloudflare.sh --zone kass.cc --auth-host auth.kass.cc --yes
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
  curl -fsSL "https://raw.githubusercontent.com/kennysoul/pauth/main/scripts/lib/deploy-common.sh" \
    -o "$PAUTH_COMMON"
  PAUTH_FETCHED_COMMON=1
  trap '[[ "$PAUTH_FETCHED_COMMON" -eq 1 ]] && rm -f "$PAUTH_COMMON"' EXIT
  # shellcheck source=/tmp/pauth-deploy-common.sh
  source "$PAUTH_COMMON"
}

deploy_usage() {
  cat <<'EOF'
Usage: deploy-cloudflare.sh [options]

Bootstrap pauth on Cloudflare: D1 + KV + wrangler config + deploy.

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
  --deploy-mode MODE      local | git
  --config-policy POLICY  keep | merge-bindings | overwrite
  --provision-only        Stop after D1/KV/config (same as provision-cloudflare.sh)
  --rotate-secret         Update SESSION_SECRET even if .dev.vars exists
  --git-first-deploy      Git mode: also run one local wrangler deploy now
  --skip-domain-bind      Do not attach AUTH_HOST to Worker automatically
  --skip-clone            Use existing checkout in --dir
  --yes, -y               Non-interactive
  -h, --help

See also: full-deploy-cloudflare.sh (full local one-shot, uses scripts/lib/*.py)
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
