# HelloID export/import: Applications, Directory users/groups, Mapping sets, Agent pools

Scope note: the browser tools (mcp__claude-in-chrome__*) were not available in this session and the apidocs.helloid.com site is a JavaScript (Stoplight) app that WebFetch could not render, so exact endpoint paths and JSON shapes for most objects could not be confirmed. Everything not cited is marked as a gap or an explicit guess. Nothing was called on any tenant.

## Exact endpoints (admin UI and public API) and authentication

### Takeaway
Public API (key/secret Basic auth) is confirmed only for users, groups, products and product assignments under /api/v1/. I found no confirmed public endpoint for applications, mapping sets or agent pools; those must be captured from the admin UI network calls (admin session, Bearer token), as Export-HelloID.ps1 already does for Provisioning.

### Cited Findings
- Public API reference lives at apidocs.helloid.com; docs.helloid.com/en/api.html only says "Use the HelloID REST API" and points to it, with no auth detail on that page — [HelloID docs API](https://docs.helloid.com/en/api.html)
- The apidocs navigation has "Applications" and "Agent" sections per a search-result summary (not verified by me; page content did not render) — [apidocs search result](https://apidocs.helloid.com/docs/helloid/ddbf642b3d115-get-all-products)
- Confirmed public endpoints (HelloID target connector README): GET/POST /api/v1/users; GET/PUT/DELETE /api/v1/users/{UserId}; GET/POST /api/v1/groups; GET /api/v1/groups/{GroupId}; POST /api/v1/users/{UserId}/groups (grant group); DELETE /api/v1/{UserId}/groups/{GroupId} (revoke, as printed in README); GET /api/v1/products; product-assignment endpoints — [Tools4everBV target HelloID](https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-HelloID)
- Other apidocs pages seen by title: "Link a user to a group", "Unlink a group from a group (2)" (implies group-in-group nesting endpoints), "Get metadata" — [Link a user to a group](https://apidocs.helloid.com/docs/helloid/575c5cde6e378-link-a-user-to-a-group), [Unlink a group from a group](https://apidocs.helloid.com/docs/helloid/80b9c7feef4b5-unlink-a-group-from-a-group-2), [Get metadata](https://apidocs.helloid.com/docs/helloid/7852815359f41-get-metadata)
- Public API auth: API key + secret, sent as `Authorization: Basic base64("key:secret")` (shown in connector create.ps1) — [create.ps1](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-Prov-Target-HelloID/main/create.ps1)
- Admin session pattern already used in this repo (Access Management admin portal login, then `GET {base}/server/v2/security/token` returns a JWT with aud `helloid.services`; Provisioning API gateway found via `/server/v2/bootstrap/provisioning`) — local file d:\Public\HelloID-UX-improvements\Export-HelloID.ps1 (lines ~180-240)
- Product responses carry `agentPool.id` / `agentPoolGUID` (GUID of an agent pool), so agent pools are referenced by GUID from products/tasks — [Get all products](https://apidocs.helloid.com/docs/helloid/ddbf642b3d115-get-all-products)

### Inferences
- GUESS: Access Management admin UI (applications, mapping sets, directory, agent pools) is served by the same portal with Bearer token from /server/v2/security/token, likely under /server/v2/... or /api/v1/... paths; unverified.
- GUESS: Applications, mapping sets and agent pools may exist under /api/v1/ (apidocs has Applications/Agent sections) and would then accept key/secret; unverified.

### Gaps
- Exact list/get/create/update paths for applications, categories, mapping sets, agent pools, agents (apidocs not renderable; no search hit).
- Whether those paths accept key/secret or only the admin Bearer token.
- Capture list for the user (DevTools Network, filter Fetch/XHR, GET only): open Applications list, one SAML, one OIDC, one WS-Fed, one Form/Plugin app, Application categories; Directory > Users (filter Source=Local) and one user's detail/groups/MFA tabs; Directory > Groups (local and a synced one); Mapping sets (AD, Entra IdP, Google); Agent > Agent pools and an agent pool's agents. For each record request URL, method, host (portal vs gateway), and a sanitized response body.

## Applications and application categories

### Takeaway
Application types and group-based access are documented, but nothing found on export/import, certificate storage, logos or JSON shape; those must be captured.

### Cited Findings
- Types: SAML (v2.0), OIDC (1.0, PKCE), WS-Federation 1.2, Plugin, Form, Basic Auth; created from catalog or generic templates — [Applications](https://docs.helloid.com/en/access-management/applications.html)
- For SAML and OIDC apps, the application's mapping set controls SSO claims sent at launch — [Applications](https://docs.helloid.com/en/access-management/applications.html)
- OIDC: offline_access in Supported Scopes plus Refresh Token Lifetime (days) on the app Configuration tab — [Applications](https://docs.helloid.com/en/access-management/applications.html)
- Access is group-based: grant groups access, optional access rules (e.g. 2FA); categories organize the dashboard — [Applications](https://docs.helloid.com/en/access-management/applications.html)

### Inferences
- GUESS: app JSON references group GUIDs (visibility/access), a mapping set id, category id; these must be remapped by group name and mapping set name on import.
- GUESS: OIDC client secret and SAML signing certificate private key will be masked or absent in GET responses; must be excluded from export and regenerated or re-entered.
- Application order: categories, mapping sets, groups, then applications (apps depend on all three) — reasoned, not documented.

### Gaps
- Endpoint paths, JSON shape, certificate and logo (binary/base64?) handling, secret masking behaviour, idempotency keys: not found; capture a SAML app GET and OIDC app GET (check clientSecret, certificate, logo fields).

## Directory Users (Local source)

### Takeaway
Local users are created manually or by API; only these can be created. Public API supports create/update/delete and group grant; password and MFA details are not documented in sources found.

### Cited Findings
- Local users: created via "Add a local user" or the API; Source `Local`; API-created users may be forced to another IdP, then Source is that IdP's name. Synced users (AD, Azure, JIT) get Source of originating system and can only sign in via matching IdP — [Users](https://docs.helloid.com/en/identity---authentication/users.html)
- API creates and maintains local users and groups (suited to small organisations) — [Users](https://docs.helloid.com/en/identity---authentication/users.html)
- POST /users body is whatever is mapped (connector sends a full account object incl. `isEnabled`, `managedByUserGUID`, `password` if present); account reference is `userGUID`; correlation on `UserName` — [create.ps1](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-Prov-Target-HelloID/main/create.ps1), [README](https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-HelloID)
- Manager link uses the manager's user GUID (must be remapped; import managers first) — same sources

### Inferences
- Passwords are never readable on export; on import set a random/temporary password or require reset (GUESS on exact field and flags).
- Idempotency: match on UserName (connector correlates on UserName); GUID is tenant-generated.

### Gaps
- Full user JSON schema, MFA settings, custom attributes, password field names, user-group membership read endpoint; capture a local user GET (sanitized).

## Directory Groups

### Takeaway
Local groups creatable via API; group-in-group and user-group links exist as endpoints. Synced group details unconfirmed.

### Cited Findings
- GET/POST /api/v1/groups, GET /api/v1/groups/{GroupId} — [README](https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-HelloID)
- Link user to group and unlink group from group endpoints exist (pages by title) — [Link](https://apidocs.helloid.com/docs/helloid/575c5cde6e378-link-a-user-to-a-group), [Unlink](https://apidocs.helloid.com/docs/helloid/80b9c7feef4b5-unlink-a-group-from-a-group-2)

### Inferences
- Order: groups (without membership) first, then users, then membership and nesting links, then application/product assignments; remote groups are matched by name+source after sync and only their local-side config (members of local type, roles, app assignments) is applied. GUESS.

### Gaps
- Group JSON shape, source field, remote-group edit endpoints; capture one local and one synced group.

## Mapping sets (AD, Azure/Entra, Google)

### Takeaway
Three types exist: Active Directory, IdP, Application mapping sets. AD set is auto-created by AD sync; Azure AD sync does not use HelloID mapping sets. Google Workspace not found.

### Cited Findings
- Types: AD mapping set, IdP mapping sets, Application mapping sets; AD one auto-created at sync setup, maps AD attributes to HelloID user fields — [Mapping sets](https://docs.helloid.com/hc/en-us/articles/360002737553-Edit-a-mapping-set)
- Azure AD sync mappings are customised on the Azure side, not with HelloID mapping sets; Azure as IdP uses an IdP mapping set (e.g. immutableId/userName identifier) — [Azure AD sync](https://docs.helloid.com/en/identity---authentication/directory-sync/azure-ad-sync.html), [Azure OIDC IdP](https://docs.helloid.com/hc/en-us/articles/360013152200-Configure-Azure-AD-as-an-OIDC-IdP)
- The AD mapping set page URL I tried returned 404 (path changed) — [attempted](https://docs.helloid.com/en/access-management/directory-sync/active-directory-sync/active-directory-mapping-set.html)

### Inferences
- A mapping set references attributes by name only (no GUIDs) probably; apps and IdPs reference the set by id, so match by name on import. GUESS.

### Gaps
- Endpoints, JSON; Google Workspace mapping set: no docs found; capture each.

## Agent pools and agents

### Takeaway
One "Default pool" exists per tenant; agents and their registration are environment-specific and not exportable; only pool names/GUID references matter.

### Cited Findings
- Pools group agents for load balancing/separation of duties; features choose a pool; HelloID has a single "Default pool"; extra pools only for separate networks — [Agent pools](https://docs.helloid.com/en/agent/agent-pools.html)
- Products reference pool by GUID (`agentPool.id`) — [Get all products](https://apidocs.helloid.com/docs/helloid/ddbf642b3d115-get-all-products)
- Agent tags exist for the on-premises Provisioning Agent — [Agent tags](https://docs.helloid.com/en/provisioning/provisioning-agent/on-premises-provisioning-agent-service/agent-tags--on-premises-provisioning-agent-.html)

### Inferences
- Export pool names only; on import map by pool name, fall back to Default pool; never export agent keys/machine info (agents register themselves with the on-premises install). GUESS on key handling.

### Gaps
- Pool/agent endpoints and JSON; whether pool create is possible by API.

## Import constraints and dependency order (proposed, partly guessed)
1. Agent pools (name match) 2. Mapping sets 3. Local groups 4. Local users 5. Group membership/nesting 6. Application categories 7. Applications (map groups, mapping set, category) 8. Post-sync step for remote groups. Existing repo pattern: Export-HelloID.ps1 masks secrets via password-typed form fields and name regex; reuse for app client secrets.
