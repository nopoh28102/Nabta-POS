#!/usr/bin/env python3
"""Safely check and renew one DNSHE domain via the official V2 API.

No third-party dependencies. Only the configured exact domain is eligible.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = "https://api005.dnshe.com/index.php?m=domain_hub"
RENEW_WITHIN_DAYS = 170  # 10-day buffer inside DNSHE's documented 180-day free window.
MAX_PAGES = 30
PER_PAGE = 100


class DnsheError(RuntimeError):
    pass


def api_call(key: str, secret: str, action: str, *, method: str = "GET", params: dict | None = None) -> dict:
    args = {"endpoint": "subdomains", "action": action}
    if method == "GET":
        args.update(params or {})
        url = BASE_URL + "&" + urlencode(args)
        body = None
    else:
        url = BASE_URL + "&" + urlencode(args)
        body = json.dumps(params or {}).encode("utf-8")
    request = Request(url, method=method, data=body, headers={
        "X-API-Key": key,
        "X-API-Secret": secret,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "NabtaPOS-DNSHE-Renew/1.0",
    })
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read(1024 * 1024)
    except HTTPError as exc:
        # Do not dump raw response bodies (which may contain request-related data).
        raise DnsheError(f"DNSHE API returned HTTP {exc.code} for {action}") from None
    except (URLError, TimeoutError) as exc:
        raise DnsheError(f"Could not contact DNSHE API for {action}: {type(exc).__name__}") from None
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise DnsheError(f"DNSHE returned invalid JSON for {action}") from exc
    if not isinstance(result, dict) or result.get("success") is not True:
        code = result.get("error_code", "unknown_error") if isinstance(result, dict) else "invalid_response"
        raise DnsheError(f"DNSHE {action} failed: {code}")
    return result


def canonical_name(domain: dict) -> str:
    full = str(domain.get("full_domain") or "").strip().lower().rstrip(".")
    if full:
        return full
    left = str(domain.get("subdomain") or "").strip().lower().rstrip(".")
    suffix = str(domain.get("rootdomain") or "").strip().lower().lstrip(".")
    if left.endswith("." + suffix) and suffix:
        return left
    return f"{left}.{suffix}"


def find_exact_domain(key: str, secret: str, target: str) -> dict:
    # Use the official pagination protocol; never infer an ID or renew a fuzzy match.
    cursor = 0
    seen_cursors = set()
    for _ in range(MAX_PAGES):
        if cursor in seen_cursors:
            raise DnsheError("Domain list pagination did not advance")
        seen_cursors.add(cursor)
        data = api_call(key, secret, "list", params={
            "cursor_id": cursor,
            "per_page": PER_PAGE,
            "fields": "id,subdomain,rootdomain,full_domain,status,expires_at,never_expires",
            "search": target.split(".")[0],
        })
        batch = data.get("subdomains")
        if not isinstance(batch, list):
            raise DnsheError("DNSHE domain listing has an unexpected shape")
        matches = [row for row in batch if isinstance(row, dict) and canonical_name(row) == target]
        if len(matches) > 1:
            raise DnsheError("Multiple exact domain matches returned; refusing to renew")
        if matches:
            return matches[0]
        pg = data.get("pagination")
        if isinstance(pg, dict):
            if pg.get("has_more") is not True:
                break
            nxt = pg.get("next_cursor_id")
            if not isinstance(nxt, int) or nxt <= cursor:
                raise DnsheError("Invalid DNSHE pagination cursor")
            cursor = nxt
        elif len(batch) < PER_PAGE:
            break
        else:
            raise DnsheError("DNSHE omitted pagination for a full page; refusing partial scan")
    raise DnsheError(f"Domain {target} not found in the configured DNSHE account")


def permanent(value: object) -> bool:
    if value in (True, 1):
        return True
    return str(value).strip().lower() in {"true", "yes", "1"}


def parse_expiry(value: object) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise DnsheError("DNSHE did not return expires_at; renewal disabled for safety")
    try:
        dt = datetime.fromisoformat(value.strip().replace(" ", "T").replace("Z", "+00:00"))
    except ValueError as exc:
        raise DnsheError("DNSHE returned an unknown expires_at format") from exc
    # API's documented timestamp is timezone-naive; treat it as UTC conservatively.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def eligibility(domain: dict, now: datetime) -> tuple[bool, str]:
    if permanent(domain.get("never_expires", False)):
        return False, "permanent domain (no renewal needed)"
    status = str(domain.get("status") or "").lower()
    if status not in {"active", "registered"}:
        raise DnsheError(f"Domain status {status!r} is not eligible for automatic renewal")
    expires = parse_expiry(domain.get("expires_at"))
    days_left = (expires - now).total_seconds() / 86400
    if days_left <= 0:
        raise DnsheError("Domain is expired; manual review required to avoid redemption fees")
    if days_left > RENEW_WITHIN_DAYS:
        return False, f"{days_left:.1f} days remaining; outside safe renewal window ({RENEW_WITHIN_DAYS} days)"
    return True, f"{days_left:.1f} days remaining; eligible for normal free renewal"


def run(mode: str, target: str, key: str, secret: str) -> None:
    if not key or not secret:
        raise DnsheError("Missing DNSHE_API_KEY or DNSHE_API_SECRET GitHub Actions secrets")
    if mode not in {"check", "renew"}:
        raise DnsheError("DNSHE_MODE must be check or renew")
    if target != "nabta.de5.net":
        raise DnsheError("Target must be nabta.de5.net; this integration only protects that domain")
    found = find_exact_domain(key, secret, target)
    domain_id = found.get("id")
    if isinstance(domain_id, bool) or not str(domain_id).isdigit() or int(domain_id) <= 0:
        raise DnsheError("Invalid DNSHE subdomain ID")
    # Refresh details to ensure the status and expiry are current before any write.
    data = api_call(key, secret, "get", params={"subdomain_id": int(domain_id)})
    domain = data.get("subdomain")
    if not isinstance(domain, dict) or canonical_name(domain) != target:
        raise DnsheError("DNSHE detail response did not match the exact target domain")
    # Some deployments omit expiry in detail; use the list expiry only for that one field.
    if "expires_at" not in domain and "expires_at" in found:
        domain["expires_at"] = found["expires_at"]
    if "never_expires" not in domain and "never_expires" in found:
        domain["never_expires"] = found["never_expires"]
    eligible, why = eligibility(domain, datetime.now(timezone.utc))
    print(f"Target: {target}\nCurrent expiry: {domain.get('expires_at', 'permanent')}\nStatus: {why}")
    if mode == "check" or not eligible:
        print("No changes made." if mode == "check" else "Renewal not needed.")
        return
    response = api_call(key, secret, "renew", method="POST", params={"subdomain_id": int(domain_id)})
    if str(response.get("subdomain_id")) != str(int(domain_id)):
        raise DnsheError("Renewal response did not confirm the requested domain ID")
    charged = response.get("charged_amount")
    if charged is None or str(charged).strip() not in {"0", "0.0", "0.00"}:
        raise DnsheError("Renewal completed but could not verify zero charge; inspect DNSHE billing immediately")
    old_expiry = parse_expiry(domain.get("expires_at"))
    new_expiry = parse_expiry(response.get("new_expires_at"))
    if new_expiry <= old_expiry:
        raise DnsheError("Renewal response did not extend the expiry date; manual verification required")
    print(f"Renewal successful: {target}\nNew expiry: {new_expiry.isoformat()}\nAmount charged: 0")


if __name__ == "__main__":
    try:
        run(os.getenv("DNSHE_MODE", "check"), os.getenv("DNSHE_TARGET_DOMAIN", "nabta.de5.net").strip().lower(),
            os.getenv("DNSHE_API_KEY", "").strip(), os.getenv("DNSHE_API_SECRET", "").strip())
    except DnsheError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
