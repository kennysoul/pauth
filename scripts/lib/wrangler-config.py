#!/usr/bin/env python3
"""Merge or write wrangler JSONC configs for deploy-cloudflare.sh."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def strip_jsonc_comments(text: str) -> str:
    """Remove // line comments without breaking https:// inside strings."""
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


def load_jsonc(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    return json.loads(strip_jsonc_comments(text))


def dump_jsonc(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def build_desired(args: argparse.Namespace) -> dict[str, Any]:
    cfg: dict[str, Any] = {
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
    if args.account_id:
        cfg["account_id"] = args.account_id
    return cfg


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

    if existing.get("account_id") != desired.get("account_id") and desired.get("account_id"):
        lines.append(
            f"account_id: {existing.get('account_id') or '(空)'} → {desired.get('account_id')}"
        )

    return lines


def merge_config(existing: dict[str, Any], desired: dict[str, Any]) -> dict[str, Any]:
    merged = json.loads(json.dumps(existing))
    merged["d1_databases"] = desired["d1_databases"]
    merged["kv_namespaces"] = desired["kv_namespaces"]
    for key in ("$schema", "main", "compatibility_date", "compatibility_flags", "assets", "observability"):
        if key in desired:
            merged[key] = desired[key]
    if desired.get("account_id"):
        merged["account_id"] = desired["account_id"]
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
    parser.add_argument("--account-id", default="")
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

    if args.policy == "keep" and not args.diff_only:
        print("KEPT")
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
