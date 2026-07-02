#!/usr/bin/env python3
"""Verify Cloudflare zone, DNS, Worker collisions; bind custom domain to Worker."""
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
DNS_BLOCKING_TYPES = frozenset({"A", "AAAA", "CNAME"})


def try_load_api_token() -> str | None:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if token:
        return token

    home = Path(os.environ.get("WRANGLER_HOME", Path.home() / ".wrangler"))
    config_paths = [
        home / "config" / "default.toml",
        Path.home() / ".config" / "wrangler" / "config" / "default.toml",
        Path.home() / ".config" / ".wrangler" / "config" / "default.toml",
        Path.home() / "Library" / "Application Support" / ".wrangler" / "config" / "default.toml",
    ]
    for path in config_paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for key in ("api_token", "oauth_token"):
            m = re.search(rf'^{key}\s*=\s*"([^"]+)"', text, re.MULTILINE)
            if m and m.group(1):
                return m.group(1)
    return None


def load_api_token() -> str:
    token = try_load_api_token()
    if token:
        return token
    die("需要 CLOUDFLARE_API_TOKEN 或已执行 wrangler login")


def has_api_token() -> bool:
    return try_load_api_token() is not None


def wrangler_logged_in(cwd: str | None = None) -> bool:
    workdir = cwd or os.environ.get("PAUTH_INSTALL_DIR") or os.getcwd()
    try:
        result = subprocess.run(
            ["npx", "wrangler", "whoami"],
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    output = f"{result.stdout}\n{result.stderr}".lower()
    if result.returncode != 0:
        return False
    if "not authenticated" in output or "please run `wrangler login`" in output:
        return False
    return "logged in" in output or "you are logged in" in output


def run_preflight_oauth_fallback(args: argparse.Namespace) -> int:
    hostname = args.hostname.strip().lower()
    zone_name = args.zone_name.strip().lower()
    if not hostname_in_zone(hostname, zone_name):
        die(f"{hostname} 不是 {zone_name} 下的域名")

    cwd = os.environ.get("PAUTH_INSTALL_DIR") or os.getcwd()
    if not wrangler_logged_in(cwd):
        die("需要 CLOUDFLARE_API_TOKEN 或已执行 wrangler login")

    print("WARN preflight_oauth_only: REST API 细检已跳过（OAuth 登录无法供 bind-custom-domain.py 直接读取 token）")
    print("WARN domain_bind: 将保留 wrangler routes，由 wrangler deploy 绑定自定义域名")
    print(f"OK oauth_wrangler hostname={hostname} worker={args.worker_name}")
    if args.skip_domain_bind:
        print("SKIP domain_bind (--skip-domain-bind)")
    return 0


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def api_request(
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    allow_failure: bool = False,
) -> dict[str, Any] | None:
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
        if allow_failure:
            try:
                return json.loads(detail)
            except json.JSONDecodeError:
                return {"success": False, "errors": [{"message": detail}]}
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
        if allow_failure:
            return payload
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
    results = (data or {}).get("result") or []
    if not results:
        die("无法获取 Cloudflare Account ID")
    if len(results) == 1:
        return results[0]["id"]
    die("多个 Cloudflare 账户，请设置 CLOUDFLARE_ACCOUNT_ID")


def find_zone(token: str, zone_name: str) -> dict[str, Any]:
    path = f"/zones?name={urllib.parse.quote(zone_name)}&status=active&per_page=1"
    data = api_request(token, "GET", path)
    zones = (data or {}).get("result") or []
    if not zones:
        die(f"域名 {zone_name} 不在当前 Cloudflare 账户中（或 zone 未激活）")
    zone = zones[0]
    if zone.get("name") != zone_name:
        die(f"Zone 匹配异常: 期望 {zone_name}，得到 {zone.get('name')}")
    return zone


def hostname_in_zone(hostname: str, zone_name: str) -> bool:
    return hostname == zone_name or hostname.endswith("." + zone_name)


def slugify_hostname(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def derive_zone_name(hostname: str) -> str:
    hostname = hostname.strip().lower().rstrip(".")
    parts = hostname.split(".")
    if len(parts) < 2:
        die(f"无效认证域名: {hostname}（至少需要形如 auth.example.com）")
    if len(parts) == 2:
        return hostname
    return ".".join(parts[1:])


def strip_jsonc(text: str) -> str:
    out: list[str] = []
    i = 0
    in_string = False
    escape = False
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            while i < len(text) and text[i] not in "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def read_wrangler_jsonc(path: Path) -> dict[str, Any]:
    return json.loads(strip_jsonc(path.read_text(encoding="utf-8")))


def sanitize_kv_id(raw: str) -> str:
    compact = re.sub(r"[^0-9a-fA-F]", "", raw or "")
    matches = re.findall(r"[0-9a-f]{32}", compact.lower())
    return matches[-1] if matches else ""


def sanitize_d1_id(raw: str) -> str:
    matches = re.findall(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        (raw or "").lower(),
    )
    return matches[-1] if matches else ""


def apply_config_bindings(out: dict[str, Any], cfg: dict[str, Any]) -> None:
    if cfg.get("name"):
        out["worker_name"] = str(cfg["name"])
    d1 = (cfg.get("d1_databases") or [{}])[0]
    if d1.get("database_name"):
        out["d1_name"] = str(d1["database_name"])
    d1_id = sanitize_d1_id(str(d1.get("database_id") or ""))
    if d1_id:
        out["d1_id"] = d1_id
    kv = (cfg.get("kv_namespaces") or [{}])[0]
    if kv.get("title"):
        out["kv_title"] = str(kv["title"])
    kv_id = sanitize_kv_id(str(kv.get("id") or ""))
    if kv_id:
        out["kv_id"] = kv_id
    kv_preview_id = sanitize_kv_id(str(kv.get("preview_id") or ""))
    if kv_preview_id:
        out["kv_preview_id"] = kv_preview_id


def apply_worker_bindings(out: dict[str, Any], token: str, account_id: str, worker_name: str) -> None:
    data = api_request(
        token,
        "GET",
        f"/accounts/{account_id}/workers/scripts/{urllib.parse.quote(worker_name, safe='')}/bindings",
        allow_failure=True,
    )
    if not data or not data.get("success"):
        return
    for row in data.get("result") or []:
        btype = (row.get("type") or "").lower()
        if btype in {"d1", "d1_database", "d1database"}:
            if row.get("database_name"):
                out["d1_name"] = str(row["database_name"])
            if row.get("id"):
                out["d1_id"] = str(row["id"])
        if btype in {"kv_namespace", "kv"}:
            if row.get("namespace_id"):
                out["kv_id"] = str(row["namespace_id"])
            if row.get("title"):
                out["kv_title"] = str(row["title"])


def run_resolve(args: argparse.Namespace) -> int:
    hostname = args.hostname.strip().lower().rstrip(".")
    zone_name = (args.zone_name or derive_zone_name(hostname)).strip().lower()
    if not hostname_in_zone(hostname, zone_name):
        die(f"{hostname} 不是 {zone_name} 下的域名")

    host_slug = slugify_hostname(hostname)
    out: dict[str, Any] = {
        "auth_host": hostname,
        "zone_name": zone_name,
        "host_slug": host_slug,
        "worker_name": f"pauth-{host_slug}",
        "d1_name": f"pauth-{host_slug}-db",
        "kv_title": f"CHALLENGES-pauth-{host_slug}",
        "mode": "create",
    }

    config_path = (args.config_path or "").strip()
    if config_path:
        path = Path(config_path)
        if path.exists():
            cfg = read_wrangler_jsonc(path)
            cfg_auth = str((cfg.get("vars") or {}).get("AUTH_HOST") or "").lower()
            if cfg_auth == hostname:
                out["mode"] = "upgrade"
                apply_config_bindings(out, cfg)

    if has_api_token():
        try:
            token = load_api_token()
            account_id = get_account_id(token)
            workers = find_workers_bound_to_hostname(token, account_id, hostname)
            if workers:
                out["worker_name"] = workers[0]
                out["mode"] = "upgrade"
                apply_worker_bindings(out, token, account_id, workers[0])
        except SystemExit:
            pass

    print(json.dumps(out, ensure_ascii=False))
    return 0


def list_dns_records(token: str, zone_id: str, hostname: str) -> list[dict[str, Any]]:
    q = urllib.parse.urlencode({"name": hostname, "per_page": 100})
    data = api_request(token, "GET", f"/zones/{zone_id}/dns_records?{q}")
    return (data or {}).get("result") or []


def is_worker_managed_dns(record: dict[str, Any]) -> bool:
    comment = (record.get("comment") or "").lower()
    if "worker" in comment:
        return True
    tags = record.get("tags") or []
    if any("worker" in str(t).lower() for t in tags):
        return True
    # Workers custom domain records are typically proxied CNAME to workers.dev
    content = (record.get("content") or "").lower()
    if record.get("type") == "CNAME" and "workers.dev" in content:
        return True
    return False


def check_dns_conflicts(token: str, zone_id: str, hostname: str) -> list[str]:
    issues: list[str] = []
    for rec in list_dns_records(token, zone_id, hostname):
        rtype = rec.get("type", "")
        if rtype not in DNS_BLOCKING_TYPES:
            continue
        if is_worker_managed_dns(rec):
            continue
        content = rec.get("content", "")
        issues.append(f"  - {rtype} {hostname} → {content} (id={rec.get('id', '?')})")
    return issues


def list_worker_script_names(token: str, account_id: str) -> list[str]:
    data = api_request(token, "GET", f"/accounts/{account_id}/workers/scripts")
    result = (data or {}).get("result") or []
    names: list[str] = []
    for row in result:
        if isinstance(row, str):
            names.append(row)
        elif isinstance(row, dict):
            script_id = row.get("id") or row.get("name")
            if script_id:
                names.append(str(script_id))
    return names


def list_worker_custom_domains(token: str, account_id: str, worker_name: str) -> list[str]:
    """Return hostnames bound to a Worker script."""
    data = api_request(
        token,
        "GET",
        f"/accounts/{account_id}/workers/scripts/{worker_name}/domains/records",
        allow_failure=True,
    )
    if not data or not data.get("success"):
        return []
    hostnames: list[str] = []
    for row in data.get("result") or []:
        h = (row.get("hostname") or row.get("name") or "").strip().lower()
        if h:
            hostnames.append(h)
    return hostnames


def find_workers_bound_to_hostname(token: str, account_id: str, hostname: str) -> list[str]:
    hostname = hostname.lower()
    bound: list[str] = []
    for name in list_worker_script_names(token, account_id):
        for h in list_worker_custom_domains(token, account_id, name):
            if h == hostname:
                bound.append(name)
    return bound


def check_domain_bind_permission(token: str, account_id: str, worker_name: str) -> None:
    data = api_request(
        token,
        "GET",
        f"/accounts/{account_id}/workers/scripts/{worker_name}/domains/records",
        allow_failure=True,
    )
    if data and data.get("success"):
        return
    errs = (data or {}).get("errors") or [{}]
    msg = errs[0].get("message", "") if errs else ""
    code = errs[0].get("code", 0) if errs else 0
    if code == 10000 or "authentication" in msg.lower():
        die(
            "Token 缺少 Workers 自定义域名权限。\n"
            "请在 Cloudflare API Token 中添加 Account 权限:\n"
            "  - Workers Scripts → Edit\n"
            "  - Workers Domains / Workers Routes → Edit（如有）\n"
            "  - Zone → DNS → Edit（资源: 目标 zone）"
        )
    # Worker 尚不存在时 GET 可能 404 — 视为有 Scripts 权限即可继续
    if code in (10006, 10007) or "not found" in msg.lower():
        return
    if msg:
        die(f"无法验证域名绑定权限: {msg}")


def check_worker_collision(
    token: str,
    account_id: str,
    worker_name: str,
    hostname: str,
    *,
    allow_overwrite: bool,
) -> None:
    hostnames = list_worker_custom_domains(token, account_id, worker_name)
    if not hostnames:
        if worker_name in list_worker_script_names(token, account_id):
            print(f"WARN worker_exists={worker_name} domains=(none)")
        return

    other = [h for h in hostnames if h != hostname.lower()]
    if other and not allow_overwrite:
        die(
            f"Worker「{worker_name}」已绑定其他域名: {', '.join(other)}。\n"
            f"部署 {hostname} 会覆盖该 Worker 的代码与配置，不会自动保留原站点。\n"
            f"请改用独立 Worker 名称（默认会根据 auth 域名自动生成，勿手动指定 passkey-auth），\n"
            f"或确认要覆盖后加 --allow-worker-overwrite"
        )
    for h in hostnames:
        print(f"OK worker_domain={worker_name} hostname={h}")


def run_preflight(args: argparse.Namespace) -> int:
    if not has_api_token():
        return run_preflight_oauth_fallback(args)

    hostname = args.hostname.strip().lower()
    zone_name = args.zone_name.strip().lower()
    if not hostname_in_zone(hostname, zone_name):
        die(f"{hostname} 不是 {zone_name} 下的域名")

    token = load_api_token()
    account_id = get_account_id(token)
    zone = find_zone(token, zone_name)
    zone_id = zone["id"]
    print(f"OK zone={zone_name} id={zone_id}")

    dns_issues = check_dns_conflicts(token, zone_id, hostname)
    if dns_issues:
        die(
            f"{hostname} 已有非 Worker 管理的 DNS 记录，无法绑定自定义域名 [code:100117]:\n"
            + "\n".join(dns_issues)
            + "\n请先在 Cloudflare DNS 删除上述记录，或换用其他 auth 子域名。"
        )
    print(f"OK dns={hostname} (no blocking A/CNAME/AAAA)")

    existing_workers = find_workers_bound_to_hostname(token, account_id, hostname)
    if existing_workers:
        w = existing_workers[0]
        if w != args.worker_name and not args.allow_overwrite:
            die(
                f"{hostname} 已绑定到 Worker「{w}」，与目标 Worker「{args.worker_name}」不一致。\n"
                f"请使用 --worker-name {w} 升级现有部署，或先解绑再部署。"
            )
        print(f"OK hostname_bound={hostname} worker={existing_workers[0]}")

    check_domain_bind_permission(token, account_id, args.worker_name)
    print(f"OK domain_bind_api worker={args.worker_name}")

    check_worker_collision(
        token,
        account_id,
        args.worker_name,
        hostname,
        allow_overwrite=args.allow_overwrite,
    )

    if args.skip_domain_bind:
        print("SKIP domain_bind (--skip-domain-bind)")
    else:
        print(f"OK preflight hostname={hostname} worker={args.worker_name}")
    return 0


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
    parser.add_argument("--zone-name", help="e.g. kass.cc (optional; derived from --hostname when omitted)")
    parser.add_argument("--worker-name", default="passkey-auth")
    parser.add_argument("--config-path", help="Existing wrangler.local.jsonc for upgrade detection")
    parser.add_argument("--resolve", action="store_true", help="Print JSON deployment plan for auth hostname")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--preflight", action="store_true", help="Full pre-deploy checks")
    parser.add_argument("--skip-domain-bind", action="store_true")
    parser.add_argument(
        "--allow-overwrite",
        action="store_true",
        help="Allow deploying to a Worker already bound to another hostname",
    )
    parser.add_argument(
        "--has-token",
        action="store_true",
        help="Exit 0 when CLOUDFLARE_API_TOKEN or wrangler config token is available",
    )
    args = parser.parse_args()

    if args.resolve:
        return run_resolve(args)

    if not args.zone_name:
        args.zone_name = derive_zone_name(args.hostname)

    if args.has_token:
        if has_api_token():
            print("OK has_token")
            return 0
        die("no token")

    if args.preflight:
        return run_preflight(args)

    hostname = args.hostname.strip().lower()
    zone_name = args.zone_name.strip().lower()
    if not hostname_in_zone(hostname, zone_name):
        die(f"{hostname} 不是 {zone_name} 下的域名")

    if not has_api_token():
        die(
            "OAuth 模式下无法通过 REST API 绑定域名。\n"
            "请保留 wrangler.jsonc 中的 routes（custom_domain: true），由 wrangler deploy 完成绑定；\n"
            "或设置 CLOUDFLARE_API_TOKEN 后重试。"
        )

    token = load_api_token()
    account_id = get_account_id(token)
    zone = find_zone(token, zone_name)
    zone_id = zone["id"]

    if args.verify_only:
        print(f"OK zone={zone_name} id={zone_id}")
        return 0

    if args.skip_domain_bind:
        return 0

    dns_issues = check_dns_conflicts(token, zone_id, hostname)
    if dns_issues:
        die(
            f"{hostname} 已有非 Worker 管理的 DNS 记录:\n"
            + "\n".join(dns_issues)
            + "\n请先在 DNS 删除上述记录后再绑定。"
        )

    check_worker_collision(
        token,
        account_id,
        args.worker_name,
        hostname,
        allow_overwrite=args.allow_overwrite,
    )

    bind_custom_domain(token, account_id, args.worker_name, hostname, zone_id, zone_name)
    print(f"BOUND {hostname} -> {args.worker_name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
