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
        Path.home() / ".config" / "wrangler" / "config" / "default.toml",
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
