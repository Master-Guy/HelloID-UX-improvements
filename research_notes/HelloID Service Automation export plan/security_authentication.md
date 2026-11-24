# HelloID Security and Authentication configuration: export/import research

Scope: Portal/Application access rules, sign-on policies, IdPs, SMS/RADIUS, password policies/self-service, mobile app, roles, API keys, 2FA and OATH.
Method: docs.helloid.com pages, one Tools4ever blog, PSHelloID module source, and the repo script Export-HelloID.ps1. Claude in Chrome tools were NOT available in this session (ToolSearch found none; a "helloid" MCP server failed with ECONNREFUSED), so no live network observation was possible. apidocs.helloid.com (Stoplight, JS-rendered) returned no usable content. All exact admin-UI endpoint paths below are therefore UNVERIFIED unless marked as sourced.

## 1. Which endpoints and auth do the admin UI and the public API use?

### Takeaway
The public API for roles is documented only indirectly (PSHelloID: `/api/v1/roles`, API key/secret). The admin UI for everything else almost certainly uses the gateway pattern `/service/<svc>/api/...` with a Bearer token from an admin session, as Export-HelloID.ps1 does for other areas. No endpoint paths for the security objects were verified.

### Cited Findings
- Public API roles endpoints (API key + secret, company-name host): GET `https://{tenant}.helloid.com/api/v1/roles`, GET `/roles/{guid}` or `/roles/{name}`, POST `/roles` (body: name, Description, IsEnabled, IsDefault, UserNames, UserGuids, Rights), PUT `/roles/{name|guid}` (name, Description, IsEnabled, IsDefault, Rights), POST `/roles/{name|guid}/users` (UserNames, UserGuids) — [PSHelloID Roles.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.7/Content/Roles.psm1)
- PSHelloID `Connect-HelloId` takes company name, API key and API secret; its public scripts cover Automation, Forms, Roles, Groups, Users, DataSources, and none for API keys, policies or sign-on — [PSHelloID Gallery](https://www.powershellgallery.com/packages/PSHelloID/)
- The existing repo script calls the admin UI gateway with `Authorization: Bearer <token>` and `Origin: <base url>` against paths such as `/service/rules/api/...`, `/service/notifications/api/...`, `/service/provisioning-api/api/...`, `/connector/<type>/api/configuration/<id>` (token refreshed on first 401) — d:\Public\HelloID-UX-improvements\Export-HelloID.ps1 lines 113-119, 249-287
- Docs: API keys are generated under Security > API, "Add API Key"; key and secret auto-generated, key can be created disabled, optional IP restriction — [Generate an API key](https://docs.helloid.com/en/api/generate-an-api-key.html); [Create and Manage API Keys](https://docs.helloid.com/hc/en-us/articles/360002741753-How-to-Create-and-Manage-API-Keys)
- Admin UI menu locations: Security > Policies > Sign On Policies ([Sign-on policies](https://docs.helloid.com/en/identity---authentication/security/sign-on-policies.html)); Security > Password > Policies ([Password policies](https://docs.helloid.com/en/identity---authentication/security/password-policies.html)); Security > 2FA > Management ([2FA](https://docs.helloid.com/en/identity---authentication/security/2fa.html), [OATH](https://docs.helloid.com/en/identity---authentication/security/2fa/oath.html)); Security > Portal access rules ([Security](https://docs.helloid.com/en/identity---authentication/security.html))
- Provisioning has no API-key auth per project memory (admin session only); whether the Security `/service/...` routes accept API key/secret is unknown.

### Inferences
- GUESS: security objects live in a gateway service such as `/service/security/api/...`, `/service/access/api/...` or `/service/identity/api/...`; names unverified. Use the same Bearer-token function as Export-HelloID.ps1.
- Only roles (and API-key-free data such as users/groups) are plausibly reachable via the documented public API; the rest need the admin session.

### Gaps
- No endpoint path for portal/application access rules, sign-on policies, IdPs, SMS, RADIUS, password policy, mobile app, API keys, 2FA management or OATH tokens was found.
- apidocs.helloid.com could not be read (404 / empty Stoplight shell). Manual capture needed (see section 6).

## 2. Which fields are secrets and how do they come back?

### Takeaway
Confirmed secret/crypto fields: Azure AD OIDC IdP Client Secret, SAML certificates (possibly with private keys for request/decryption), API key secret. SMS provider, RADIUS and OATH seed handling were not found in docs. How they come back (masked or absent) is unknown.

### Cited Findings
- IdP settings: only listed secret field is Client Secret (Azure AD OIDC); SAML has Request, Response and Response Decryption Certificates; no password fields; page does not mention RADIUS or SMS — [IdP settings reference](https://docs.helloid.com/en/identity---authentication/identity-providers--idps-/idp-settings-reference.html)
- API key secret is shown at creation via a "Show Secret" toggle; the guide says to store key and secret safely — [Generate an API key](https://docs.helloid.com/en/api/generate-an-api-key.html)
- OATH page does not cover seeds or secret storage; tokens can be added individually or imported — [OATH](https://docs.helloid.com/en/identity---authentication/security/2fa/oath.html)
- Repo precedent: notification-system secrets are masked in exports (commit 35ae7c8 "Mask notification secrets in target system exports").

### Inferences
- GUESS: GET of an IdP returns client secret masked or empty; import must preserve (omit or send sentinel) or have user re-enter. Verify by capture.
- Policy: export API key code/identifier only; never request the secret (it exists only at creation time in the UI). OATH seeds: never export; export token metadata (serial, assignment) at most.
- Imports must never write a masked placeholder back as the value.

### Gaps
- SMS (2FA SMS provider, linked page returned 404 on guessed URL), RADIUS configuration docs not found; field list and secret handling unknown.
- Whether API-key list endpoint returns the secret (assume it does not; verify).

## 3. Per-object details (shape, import mode, matching)

### Takeaway
JSON shapes are not captured. Doc-derived field lists below tell what to expect. Matching by name is likely safest for rules/roles/IdPs; GUIDs differ across tenants.

### Cited Findings
- Portal access rules: allow/block by IdP, groups, IP geolocation, IP range, date/time, browser/OS; also enforce 2FA; priority ascending (lower number is higher priority); Deny always beats Permit; with no rules all users can log in — [Portal access rules](https://docs.helloid.com/en/identity---authentication/security/portal-access-rules.html)
- Application access rules: per application or system; conditions include IdP, group, country, IP range, time of day, device type, browser, MFA enforcement with allowed methods; fixed vs dynamic 2FA — [Tools4ever blog](https://www.tools4ever.com/blog/access-management-context-based-access); [2FA](https://docs.helloid.com/en/identity---authentication/security/2fa.html)
- Sign-on policies: single global policy (not a list): lockout (enabled, count, auto-unlock, minutes), forced password change (enabled, days), session timeout minutes and fixed/sliding, always show login selector, remember-me (enabled, days), deprecated QR login (enabled, allowed IPs, show on selector), deprecated email MFA enrollment — [Sign-on policies](https://docs.helloid.com/en/identity---authentication/security/sign-on-policies.html)
- Password policies apply to Local users only: show strength requirements, min/max length (1-20 / 8-50), min/max per character class, regex plus invert, excluded characters, excluded words — [Password policies](https://docs.helloid.com/en/identity---authentication/security/password-policies.html)
- IdP types: Local (cannot be disabled), Active Directory (Agent), Azure AD OIDC, SAML, Shortcut; common fields Name, Enabled, Display On Login Page, JIT, Login/Logout URL, client/IP/source restrictions; AD agent has Directory Configuration, SSRPM (Use SSRPM + URL) — [IdP settings reference](https://docs.helloid.com/en/identity---authentication/identity-providers--idps-/idp-settings-reference.html). With no IdP configured users can only sign in through Local IdP — [IdPs](https://docs.helloid.com/en/identity---authentication/identity-providers--idps-.html)
- 2FA management: factor types WebAuthn, Push to verify (HelloID Authenticator), hardware token (OATH TOTP), Email, SMS; toggles apply to dynamic 2FA only; Remember MFA option — [2FA](https://docs.helloid.com/en/identity---authentication/security/2fa.html)
- Roles: assigned to users/groups, contain rights; "All Rights" role for admin — [Roles & rights](https://docs.helloid.com/en/identity---authentication/roles---rights.html). Role API supports create (POST), update (PUT by name or guid), fields above — PSHelloID source.
- Self-service password reset: docs only mention SSRPM on the AD agent IdP and showing strength requirements; no separate SSPR config page found.

### Inferences (labelled as guesses)
- Suggested import modes: Sign-on policies and password policy and 2FA management = singleton, update-only (full replace of that document). Access rules, roles, IdPs = upsert by name (create if absent, update if present), never delete. API keys = report-only, no import (secrets cannot be reproduced; create manually). OATH tokens = no import of seeds; metadata only or skip. Mobile app, SMS, RADIUS = update-only singletons if the data is readable, secrets re-entered.
- Built-in roles/rights and the Local IdP should be treated read-only (skip or warn).
- GUID references inside rules (IdP, group, application IDs) must be remapped by name on import.

### Gaps
- Mobile app configuration: no docs page found.
- Real JSON shapes, GUID vs name keys, and whether rules/IdPs expose stable IDs: not observed.
- Whether role Rights are array of names or GUIDs: PSHelloID passes `Rights` through, format not shown.

## 4. Lockout and safety risks, recommended safeguards

### Takeaway
Misconfigured access rules or IdPs can lock out administrators; Tools4ever's only recovery stated is support. Import must be plan-then-apply with backups and no deletes.

### Cited Findings
- Once permit or deny rules exist, users who match a deny or fail to meet a permit are denied by default; misconfiguration can lock out admins; recovery is contacting Tools4ever support — [Tools4ever blog](https://www.tools4ever.com/blog/access-management-context-based-access)
- Deny rules are evaluated first regardless of priority; permit rules evaluated in priority order and not stacked — same blog; [Portal access rules](https://docs.helloid.com/en/identity---authentication/security/portal-access-rules.html)
- Sign-on policy lockout and session timeout settings apply to all users — [Sign-on policies](https://docs.helloid.com/en/identity---authentication/security/sign-on-policies.html)
- Local IdP cannot be disabled (acts as fallback) — [IdPs](https://docs.helloid.com/en/identity---authentication/identity-providers--idps-/idp-settings-reference.html)

### Inferences
- Recommended safeguards:
  1. Backup-before-import: full export of every touched object to timestamped files, automatically.
  2. Plan-then-apply: dry-run diff (create/update/skip), explicit confirmation; honour the DryRun guard rule.
  3. Never auto-delete rules, roles, IdPs or keys; report extra objects on the tenant as "not in file".
  4. Ordering: IdPs first, then groups/applications (outside this scope), then roles, then portal and application access rules (reference IdPs/groups), then sign-on policy, password policy, 2FA management/SMS/RADIUS last.
  5. Lockout guards: refuse to apply if result would leave no enabled IdP the current admin can use; refuse a portal rule set whose deny rules would match the running admin (IdP, IP, group) or that leave no permit rule matching the admin; keep Local IdP enabled; do not apply access rules and IdP changes in one run; apply new access rules disabled/lowest priority first (GUESS that rules have an enabled flag).
  6. Warn before changing lockout count, session timeout or remember-me; do not import deprecated QR/email-MFA unless present.
  7. Secrets: omit from export, never import placeholders, list "secret needs re-entry" per object in the plan.
  8. Target tenant differs from source: cross-tenant imports must remap GUIDs by name and flag unresolved references; block rules referencing missing groups/IdPs.

### Gaps
- No documented admin recovery path other than support; no known "break-glass" behaviour.
- Does an access rule have an enabled/disabled flag? Not confirmed.

## 5. Relevant documentation
- [docs.helloid.com Identity & authentication](https://docs.helloid.com/en/identity---authentication.html); [Security](https://docs.helloid.com/en/identity---authentication/security.html); [Portal access rules](https://docs.helloid.com/en/identity---authentication/security/portal-access-rules.html); [Sign-on policies](https://docs.helloid.com/en/identity---authentication/security/sign-on-policies.html); [Password policies](https://docs.helloid.com/en/identity---authentication/security/password-policies.html); [2FA](https://docs.helloid.com/en/identity---authentication/security/2fa.html); [OATH](https://docs.helloid.com/en/identity---authentication/security/2fa/oath.html); [Roles & rights](https://docs.helloid.com/en/identity---authentication/roles---rights.html); [IdP settings reference](https://docs.helloid.com/en/identity---authentication/identity-providers--idps-/idp-settings-reference.html); [Generate an API key](https://docs.helloid.com/en/api/generate-an-api-key.html)
- Not found (404 on guessed URLs): SMS page, RADIUS, mobile app, SSPR, Rights reference. Find via docs search.

## 6. What the user must capture (browser not reachable; GET only, redact tokens/cookies)
Open DevTools Network (Fetch/XHR), visit each page, copy the request URL, method, and response JSON (secrets blanked). Per gap:
- Portal access rules: list page and open one rule (Add form untouched); give list URL, get URL, JSON of a rule with IdP/group/IP/time conditions and 2FA tab; the priority/reorder call (do not trigger it).
- Application access rules: same, from an application's Access rules tab.
- Sign-on policies: GET URL and JSON; confirm if it is a single document.
- Identity providers: list, one Azure AD OIDC and one SAML IdP get; note exactly what Client Secret and certificates return (empty, masked, or value).
- SMS and RADIUS: wherever configured (Security > 2FA or Security > Authentication?), GET URL and JSON, and which fields are secret; confirm the location in the UI.
- Password policies and any self-service password reset settings: GET URLs and JSON.
- Mobile app configuration: menu location, GET URL, JSON.
- Roles: confirm whether the admin UI uses `/api/v1/roles` or a `/service/...` route; JSON of one role including rights format; whether built-in roles carry a flag.
- API (Security > API): list GET URL and JSON; confirm no secret is returned in list or get; note create flow is POST-once-shows-secret (do not create).
- 2FA management: GET URL and JSON for enabled factor types; OATH token list GET URL and JSON (confirm no seed is returned).
- Also confirm which auth the Security gateway accepts (Bearer admin token as in Export-HelloID.ps1; test whether API key/secret Basic works on `/api/v1/...` for roles only).
