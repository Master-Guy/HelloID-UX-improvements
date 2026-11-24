# HelloID Settings export/import (Appearance, Certificates, Logging, Language, Company) and backup/restore design

Method note: Claude in Chrome tools were not available in this session (ToolSearch found no mcp__claude-in-chrome__* tools), and the local `helloid` MCP server failed to connect (ECONNREFUSED). No live network observation was done. apidocs.helloid.com is a Stoplight SPA (fetch returns only the title; /docs/helloid/ returned 404), so API paths could not be read. Everything below is from docs.helloid.com plus the local Export-HelloID.ps1. Guesses are labelled GUESS.

## 1. Endpoint paths and auth for the five Settings areas

### Takeaway
No endpoint for any of the five areas could be confirmed. The docs describe only UI flows and none mention export/import except per-certificate download. The one verified way into the admin back end is the pattern Export-HelloID.ps1 already uses (admin session, `/service/<module>/api/...`).

### Cited Findings
- Settings pages exist at Settings > Appearance, Language, Company, Certificates; rights are "Settings - Appearance", "Settings - Language", "Settings - Company Settings"; "Settings - Logging" and "Logging Retain Duration" are deprecated (BI reports system, no longer used) — [Rights reference](https://docs.helloid.com/en/identity---authentication/roles---rights/rights/rights-reference.html)
- Appearance docs mention no export/import — [Appearance settings](https://docs.helloid.com/en/portal-settings/appearance-settings.html)
- Language docs mention no translation customization and no export/import — [Language settings](https://docs.helloid.com/en/portal-settings/language-settings.html)
- Company docs list tabs only, no export/import — [Company settings](https://docs.helloid.com/en/portal-settings/company-settings.html)
- Local script authenticates via admin login session, gets a token from `/server/v2/security/token`, and calls `/service/<module>/api/...` (e.g. `/service/notifications/api/...`, `/service/provisioning-api/api/...`, `/service/scheduler/api/...`) — d:\Public\HelloID-UX-improvements\Export-HelloID.ps1 (lines ~182-272, 804-1027); it already masks values matching `secret|passw|pwd|token|api[-_]?key|private[-_]?key|certificate|credential` (line 133).
- Memory note from the user: HelloID Provisioning has no API key/secret auth; admin session is the only route (applies to the `/service/...` provisioning-style endpoints; not verified for Service Automation settings).

### Inferences
- The Settings endpoints are probably under `/service/<something>/api/...` or `/api/v1/...` like other admin UI calls. GUESS only; module names unknown.
- Because docs never mention export/import for these areas, assume a read-only GET export is feasible only if the UI loads each tab via GET; write endpoints (PUT/POST) are unobserved.

### Gaps (user must capture; DevTools > Network, filter Fetch/XHR, GET only, copy "path + method + response shape" and redact Authorization/Cookie headers and any secret values)
- Appearance: open Settings > Appearance, each tab (Logos & Icons, Custom CSS, Tile Behavior). Capture the GET that loads the tab; whether images come back as URL, base64 or binary; the request used on Save (method, content-type: JSON vs multipart). Do not click Save/Reset.
- Certificates: open Settings > Certificates list and a certificate Details view; capture list GET and detail GET. Do NOT click Download/PFX. Note whether the list response contains private key material or only thumbprint/expiry.
- Logging: confirm whether a Logging page still exists in the tenant (docs say deprecated). Capture any GET if present; otherwise note "absent". Also check Admin dashboard for audit-log retention or forwarding config (not documented in sources found).
- Language: Settings > Language; capture the GET (default language, available languages).
- Company: each tab (Company Info, Service Desk, Mail Domain, Custom Domains, Self Service, Incidents, Advanced); capture one GET per tab; note which responses include webhook URLs/secrets (Incidents).
- Whether `/api/v1/...` public API (API key/secret via Basic auth) has any of these; read the Stoplight spec in a browser at https://apidocs.helloid.com/ and list any "branding/settings/certificates" operations.

## 2. Binary assets and certificates

### Takeaway
Appearance has four uploaded images; certificates may carry private keys only via PFX download. Never export private keys; export public metadata/PEM only.

### Cited Findings
- Logos & Icons tab: company logo (login, max 400x400), company icon (admin top-left, max 128x128), loading icon (no limit listed), login background (max 1920x1200); uploads take 10-15 minutes to show due to caching; accepted file formats not specified — [Appearance settings](https://docs.helloid.com/en/portal-settings/appearance-settings.html)
- Custom CSS applies to admin dashboard only; a special reset URL with customer ID exists; "Reset custom styling" returns all appearance to defaults and removes custom CSS — [Appearance settings](https://docs.helloid.com/en/portal-settings/appearance-settings.html)
- Certificate import is by name plus pasted/uploaded X.509 text with BEGIN/END CERTIFICATE lines; docs say nothing about passwords/private keys on import — [Import a certificate](https://docs.helloid.com/en/portal-settings/certificates/import-a-certificate.html)
- Certificate export offers DER .CER (public key only), Base64 .CER, and .PFX (certificate plus private key, optionally password-protected) — [Export a certificate](https://docs.helloid.com/en/portal-settings/certificates/export-a-certificate.html)
- Certificates are referenced by name from applications (SAML X509 signing cert, X509 encryption cert, OIDC signing cert) — [Application settings reference](https://docs.helloid.com/en/access-management/applications/application-settings-reference.html)
- Custom domain certificate is not installed until the next Monday 21:00 CET (WE) or 21:00 PST (WUS) — [Custom domain risk warning](https://docs.helloid.com/en/portal-settings/company-settings/custom-domain-risk-warning.html)

### Inferences
- Import of a certificate via UI is public-cert only, so a backup of PEM (public) cannot restore a certificate that HelloID itself generated with a private key; restore would break SAML signing unless the PFX is re-imported manually. GUESS: UI import may not accept PFX at all (docs show text only).
- Recommended handling: back up certificate metadata (name, subject, thumbprint, notBefore/notAfter, PEM public cert) only; mark private-key-bearing certs as "manual re-create"; never call the PFX download from tooling. Apply the existing secret mask to anything else.
- Images: store as separate files in the snapshot folder (`appearance/logo.png`, etc.) with sha256 in the manifest, rather than base64 in JSON, to keep JSON diffable; base64 acceptable if a single-file export is required. Keep within the documented pixel limits; size byte limits unknown (gap).

### Gaps
- Accepted image types, byte limits, and whether images are served by URL (capture needed above).
- Whether the PFX import path exists in the admin UI.

## 3. Tenant-specific settings and safeguards

### Takeaway
Company settings and certificates are largely tenant-bound; Appearance and Language are mostly portable.

### Cited Findings
- Company Info holds default AD domain, redirect URLs, currency, time zone; Service Desk holds an email; Mail Domain and Custom Domains hold verified domains; Incidents holds email/webhook notifications — [Company settings](https://docs.helloid.com/en/portal-settings/company-settings.html)
- Moving to a custom domain changes API endpoints, SSO endpoints, agent connectivity and user URLs — [Custom domain risk warning](https://docs.helloid.com/en/portal-settings/company-settings/custom-domain-risk-warning.html)
- Language default is browser `autodetect`; admin dashboard is always English — [Language settings](https://docs.helloid.com/en/portal-settings/language-settings.html)

### Inferences
- Do not copy across environments: Custom Domains, Mail Domain (verification is DNS-bound), default AD domain, redirect URLs, Service Desk/Incident emails and webhook URLs/secrets, all certificates, any SIEM/log forwarding endpoints (none documented; GUESS that such config may exist).
- Safe to copy: Custom CSS, images, Tile Behavior, currency, time zone, language default.
- Safeguards: classify each field `portable` / `tenant-bound` / `secret` in the export schema; default import skips tenant-bound and secret fields; require an explicit `--include-tenant-bound` plus a tenant-name match check in the snapshot manifest; always dry-run first.

### Gaps
- Logging/audit forwarding settings: the only Logging right is deprecated, no documented SIEM config found.

## 4. Partial vs full update; live side effects

### Takeaway
Unknown from docs; must be observed on the Save request payload.

### Cited Findings
- Reset custom styling wipes all appearance settings and CSS in one action — [Appearance settings](https://docs.helloid.com/en/portal-settings/appearance-settings.html)
- Image changes take 10-15 minutes to propagate (cache) — same source
- Custom CSS can render the admin portal unusable; reset URL exists — same source
- Custom domain changes affect live users, SSO and agents — [Custom domain risk warning](https://docs.helloid.com/en/portal-settings/company-settings/custom-domain-risk-warning.html)

### Inferences
- GUESS: each tab saves as its own PUT with the whole tab object (full replace per tab, not per field). Restore should therefore read-modify-write per tab.
- Side-effect ranking for restore: Custom CSS (can lock out admins) and Company Custom Domain (can break SSO/agents) are high risk; certificates referenced by SAML apps are high risk; images and language low risk.

### Gaps
- Real save semantics (capture Save request method/body shape by observing, without submitting; or user performs one reversible save on a training tenant while Network tab is open).

## 5. Recommended generic backup/restore design (practice-based, not HelloID-sourced)

These are design recommendations from common safe-by-default practice, not cited facts.

- Snapshot format: one folder per snapshot `backups/<tenant>/<UTC yyyyMMddTHHmmssZ>__<area>__<reason>/` containing `manifest.json` (tool version, tenant host, area, object counts, per-file sha256, source = "pre-import"/"manual", flags used), one JSON file per object (stable key ordering, secrets masked as `***MASKED***`, never written), and binary assets as separate files referenced by hash.
- Naming: `<UTC timestamp>__<area>__<pre-import|manual>`; objects keyed by stable id plus name.
- Automatic pre-write snapshot: every write-capable import first exports the affected objects; abort the import if the snapshot fails or is empty.
- Retention: keep last N (e.g. 10) per area plus anything under 30 days; never auto-delete the most recent pre-import snapshot; deletion only by explicit command.
- Restore as plan-then-apply: `plan` diffs snapshot vs live and emits a change list (create/update/delete/skip with reasons, e.g. masked secrets, tenant-bound, private-key certs) and a plan hash; `apply` requires the plan hash plus confirmation, takes a fresh pre-restore snapshot, applies in dependency order (certificates, then apps referencing them), and verifies by re-export diff. Deletions off by default.
- MCP flag scheme: per-area flags with three levels `off` (default, tool not listed) | `read` | `write`; areas such as `serviceAutomation`, `delegatedForms`, `directory`, `security`, `settings` (optionally split `settings.appearance`, `settings.certificates`, `settings.company`, `settings.language`, `settings.logging`). Rules: `write` implies `read`; `settings.certificates` capped at `read` (metadata only) with no write; separate `backup` flag (snapshot read/write to disk) and `restore` flag distinct from area write; DryRun forced true unless the area write flag is set and the call passes an explicit apply token from a prior plan (consistent with the user's DryRun guard rule). Defaults: everything off; read-only config never exposes secrets.

### Gaps
- None of this is vendor documentation; it should be reviewed against what the endpoints actually allow once captured.
