# DNSHE Auto Renew — nabta.de5.net

Automated DNSHE renewal is intentionally restricted to **nabta.de5.net**. It uses the official DNSHE V2 API, not browser cookies or a third-party renewal service. No production POS services or Cloudflare settings are modified.

## One-time setup

1. DNSHE → Free Domains → API Management: create an API Key and API Secret. If available, give the key only the permissions required for domain listing, reading, and renewing.
2. GitHub repository `nopoh28102/Nabta-POS` → **Settings → Secrets and variables → Actions → New repository secret**:
   - `DNSHE_API_KEY` — the DNSHE API Key.
   - `DNSHE_API_SECRET` — the DNSHE API Secret.
3. GitHub → **Actions → DNSHE Auto Renew - Nabta domain → Run workflow** → **mode: check**. Confirm the exact domain and its expiry in the run log. No renewal is attempted in check mode.
4. If the domain is within 170 days of expiration, optionally run **mode: renew**. After the first successful check, the weekly schedule handles normal renewals automatically.

## Scheduling and safeguards

- Every **Tuesday 03:17 UTC**, GitHub Actions checks DNSHE and renews **only** `nabta.de5.net` if 170 or fewer days remain. DNSHE documents a 180-day free renewal window; the 10-day buffer reduces edge-case timing errors.
- If expiry is further away, the domain is permanent, or the run is a manual **check**, no modification is made.
- Refuses to renew expired, suspended, unrecognized, or incorrectly identified domains; fails visibly on missing secrets, API failures, or malformed expiry data.
- API renew uses `POST endpoint=subdomains&action=renew`, `subdomain_id` in JSON body. It does **not** change DNS records.
- The script expects the normal free renewal to report `charged_amount=0`. **DNSHE does not expose a charge preview or a no-charge guarantee via this call.** The automation only attempts renewal for active, non-expired domains within the official free window. If a charge appears unexpectedly, the run fails with an alert; verify the DNSHE billing history. Review DNSHE's current renewal policy before turning on unattended renewal.
- Any GitHub Actions failure is visible in **Actions**; enable GitHub notifications for failed workflow runs. GitHub scheduled runs can be delayed or skipped; continue monitoring the actual expiry date periodically. Free renewal is not the same as a permanent upgrade.
- The API key is injected as protected **GitHub Actions Secrets**. Never add it to code, commit history, workflow Variables, issue comments or screenshots. Do not set an IP allowlist that blocks GitHub-hosted runners.

## Official references

- https://github.com/dnshe/DNSHE-FreeDomains/blob/main/docs/api.md
- https://my.dnshe.com/knowledgebase/5/DNSHE-Free-Domain-Renewal-and-API-Command-Renewal-Methods.html
- Adapted concept from: https://github.com/Maritnbk/DNSHE-Auto-Renew
