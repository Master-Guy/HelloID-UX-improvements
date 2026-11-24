# Extending HelloID UX tooling to Service Automation

The project can be extended to Service Automation (SA), Directory, Security and Settings with the existing architecture. The userscript, `Export-HelloID.ps1` and `helloid-mcp` all follow the same pattern: a `contents` discriminator, `***` masking, plan-then-apply and a per-environment flag. No SA, Security or Settings endpoint has been observed. The Claude in Chrome tools were unavailable, the `helloid` MCP server returned ECONNREFUSED, and apidocs.helloid.com is a JavaScript app that could not be fetched. Every internal admin path below is therefore unverified. The only endpoint evidence is community code that calls the public `/api/v1` API with an API key and secret. That evidence covers delegated forms, dynamic forms, data sources, automation tasks, variables, groups, self-service categories, products and roles. It says nothing about approval workflows, Systems, the script library, applications, mapping sets, agent pools, IdPs, access rules, sign-on or password policy, 2FA, SMS, RADIUS, the mobile app or any Settings page. The two "last used" columns are the cheapest deliverable and need only two list endpoints plus two grid-fill endpoints. The first blocker for everything else is one architectural question: does the SA admin UI use the provisioning gateway with a Bearer token, a same-origin `/api/v1` or `/server/...` path with cookies, or something else? The capture checklist at the end is ordered to answer that first.

## What the repository gives you and what it cannot do yet

All three components are Provisioning-only today. A search of both userscripts, the PowerShell script and `helloid-mcp/src` finds no reference to `/admin/delegatedforms`, `/admin/selfservice` or Service Automation. The userscript loads on every HelloID host (`@match https://*.helloid.com/*`) but does nothing on SA pages.

Each component assumes **one API origin**. The PowerShell script and the MCP server log in with the local admin form at `/authentication/admlogin`. They take a JWT with audience `helloid.services` from `/server/v2/security/token`, then discover the gateway from `/server/v2/bootstrap/provisioning` by picking the first URL whose host contains "gateway". The userscript has no login of its own. It copies the headers of the first XHR that HelloID sends to a host matching `/gateway/`, and until one is seen every export throws "No request of HelloID seen yet". The MCP `EnvironmentSession` and `HelloIdClient` hold exactly one `gateway` origin. If SA pages call same-origin endpoints with cookies, or a different bootstrap, all three need a second transport before any feature work. Per-area flags do not solve this.

The extension seams are well defined. In the userscript, a new feature is an idempotent `addXxx()` added to the MutationObserver list. A new kind needs an entry in `ITEM_IMPORTS` or `SETTING_IMPORTS`, `IMPORT_ORDER`, `KIND_LABELS` and `everythingParts()`, and a page button needs an entry in `IMPORT_PAGES`. The page routing is hash-only (`location.hash.includes(ROUTE)`), and `/admin/...` paths are path-based, so `importPage()` and route detection need a pathname-aware variant. The MCP server needs a new kind in four places: `ITEM_KINDS`/`KINDS`, `IMPORT_ORDER` and `makePlanners`, `KIND_LABELS`, and `Exporter.everythingParts()`. It also needs endpoint constants, test fixtures and a fake-portal route, plus an equivalence test against the userscript. The test harness slices the userscript by marker strings, so those marker lines must not be refactored.

The PowerShell script already shows the repeatable recipe: a parameter, an `Export-<Type>` function and a dispatch-table entry, with one file per item named `<name> - <ID> - <date>.json`. One item failing never stops the rest. IDs travel with names, as in `systems: [{systemId, displayName}]`. Every SA kind must follow that: forms carry names for their data sources, tasks, categories and groups; products carry names for forms, groups, workflows and pools.

The MCP server's DryRun static check (`changes/dryrun-check.ts`) is specific to target-system scripts that use `$actionContext.DryRun` or `$dryRun`. SA delegated-form tasks, automation tasks and product actions run in a different PowerShell context, so that checker does not cover them. The project rule that scripts guard every write with DryRun and never disable it applies to anything the tooling executes. MCP tools that run an SA task or form are therefore a separate decision, and they behave like `allowDryRun` and `allowEvaluate`, which are not switched off by `safety.readOnly`.

## Last used and Last requested columns

The columns need a join between a list of forms or products and an activity or request-history list. HelloID documents the pages (Delegation > Activities and Self Service > Request History) but not their columns, filters or retention ([HelloID docs: delegated form activities](https://docs.helloid.com/en/service-automation/delegated-forms/delegated-form-activities/view-powershell-data-source-logs-for-a-delegated-form-submission.html), [HelloID docs: product action run history](https://docs.helloid.com/en/service-automation/products/product-actions/view-product-action-run-history.html)). An activity entry shows start time, submitting user, form name, whether it was actually submitted, and task status ([Tools4ever blog](https://www.tools4ever.com/blog/2024/service-automation-testing-and-logging/)). Viewing needs the Request History overview right, so the code must degrade silently (hide the column) on 401 or 403. The public `/api/v1` has no endpoint for submissions or request history, so the admin UI's own XHR is the only route. That also fits the project rule that browser-side code never carries an API key and secret.

The design the notes recommend is one aggregated fetch per page visit, reduced client-side to `Map(key -> max timestamp)`. This reuses the userscript's `INTERCEPTS` and `WATCHES` pattern, `take=999999` and the 5-minute cache cleared on navigation. Per-item calls are worse unless a filter plus `take=1` descending exists. Key decisions:

- **Join key.** Prefer the form or product GUID. If rows only carry names, rename and duplicate-name effects create false misses. Which one applies depends on the captured rows.
- **Definition of "last used".** Count submitted activities only, because the activity list also contains forms that were opened and not submitted. For products, decide whether cancelled or denied requests count. Both are questions for the user.
- **Retention.** No retention is documented for either list. Audit logs are kept one year ([Audit logs](https://docs.helloid.com/en/incidents---logs/audit-logs.html)). Render an em dash with a tooltip "No activity in the retained history" and show the oldest timestamp seen as coverage. Never claim "never used".
- **Timestamps.** Compare epoch values, parse offset-less strings as UTC, and display in the browser locale.
- **Column injection.** The userscript has no helper that adds a column to an existing table. Its patterns are header and cell buttons, pinned buttons and an own list table. If the SA grid is AG Grid, use `findGridApi` plus `setColumnDefs` with a WeakSet guard, as `applyResizable` does, so sorting works with empty values last. If it is a plain table, append `th` and `td` with `tm-` classes on every mutation. Row identity must be read at click time because Angular reuses rows. The DOM of both pages is unknown, so the injection point cannot be named yet.
- **Cheap extras.** From the same Map: a "Uses (90 days)" count, a stale filter and a failed-last-run dot (each S, a few hours).

## Export, backup and import by object family

Two facts constrain the whole inventory. First, nothing in the HelloID docs describes a built-in export or import for forms, products, tasks or variables. The only import is of Tools4ever's prebuilt delegated forms from GitHub ([Tools4ever blog](https://www.tools4ever.com/blog/service-automation-importing-delegated-forms)). Second, the closest prior art, Tools4ever's generated `createform.ps1`, has stated limits. It exports only string variables, exports secret variables with an empty value, supports inline scripts only, hardcodes access groups and assumes the targets do not already exist ([README](https://github.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms)).

The table lists what is **verified** (seen in cited code or docs), and everything else is a **guess** until captured.

| Family | Verified | Not known |
|---|---|---|
| Delegated forms and categories | `GET/POST /api/v1/delegatedforms`, `GET/POST/DELETE .../delegatedformcategories`, link via `POST /delegatedforms/{guid}/categories` ([PSHelloID Forms.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.2/Content/Forms.psm1), [Categories.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.95.1/Content/Categories.psm1)); form carries `name, dynamicFormGUID, isEnabled, useFaIcon, faIcon, task, accessGroups` | notifications, run-as, drafts, update verb |
| Dynamic forms | `GET/POST/DELETE /api/v1/forms`, body `Name` + `FormSchema`; schema embeds `dataSourceGuid` | versioning, draft state, other embedded GUIDs |
| Data sources | `GET /api/v1/datasource/{guid}`, `.../named/{name}`, `POST` with `name, type, model, automationTaskGUID, value, script, input, runInCloud`; types static, task (3), PowerShell, built-in | secrets inside task data sources |
| Automation tasks, variables | `GET /api/v1/automationtasks`, `POST .../powershell`; `GET /api/v1/automation/variables`, `POST /automation/variable` with `secret` flag | Systems, script library, scheduling, secret display on GET |
| Self-service categories, products | `GET/POST /api/v1/selfservice/categories`, `GET/POST/DELETE /api/v1/products`, groups via `POST /selfserviceproducts/{id}/groups`; product fields include `categories, resourceOwnerGroup, approvalWorkflow, dynamicForm, agentPool` and actions `onRequest/onApprove/onDeny/onReturn/onWithdrawn` ([sync script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Sync-AzureActiveDirectory-Groups-To-SelfService-Products/main/Sync-EntraID-Groups-To-HelloID-Selfservice-Products.ps1)) | approval workflow endpoints (none found), update-by-POST semantics |
| Groups, users | `GET/POST /api/v1/groups`, `GET/POST /api/v1/users`, `GET/PUT/DELETE /users/{id}`, group grant ([HelloID target connector](https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-HelloID)) | full user JSON, MFA, password fields, membership read |
| Roles | `GET/POST/PUT /api/v1/roles`, `POST /roles/{x}/users` ([Roles.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.7/Content/Roles.psm1)) | whether the admin UI uses this path; rights format |
| Agent pools | products reference `agentPool.id`; `GET /api/v1/agentpools` in the sync script | everything else; one "Default pool" exists ([Agent pools](https://docs.helloid.com/en/agent/agent-pools.html)) |
| Applications, mapping sets | types (SAML, OIDC, WS-Fed, Plugin, Form, Basic Auth) and three mapping-set types ([Applications](https://docs.helloid.com/en/access-management/applications.html), [Mapping sets](https://docs.helloid.com/hc/en-us/articles/360002737553-Edit-a-mapping-set)) | all endpoints and JSON |
| Security (access rules, sign-on, password, 2FA, OATH, SMS, RADIUS, IdPs, API keys, mobile app) | field lists from docs only, for example sign-on is a single global policy ([Sign-on policies](https://docs.helloid.com/en/identity---authentication/security/sign-on-policies.html)) | all endpoints and JSON; SMS, RADIUS and mobile app docs not found |
| Settings (Appearance, Certificates, Logging, Language, Company) | UI flows and limits only ([Appearance](https://docs.helloid.com/en/portal-settings/appearance-settings.html), [Certificates](https://docs.helloid.com/en/portal-settings/certificates/export-a-certificate.html)) | all endpoints; Logging is deprecated per the rights reference |

Two auth routes therefore exist for SA objects: the public `/api/v1` with Basic key and secret (verified for some families), and the admin session (the project's established route, unverified for SA). The notes disagree on whether to prefer the first. The recommendation here is to **capture the admin UI's own calls and build on those**. The userscript cannot hold an API secret, the project has so far used only the admin session, and one transport for all families (including the many with no public endpoint) is simpler. Adding a key-and-secret transport to the PowerShell script or MCP server would be a new auth path and needs an explicit DESIGN.md change. If the capture shows the UI itself calls `/api/v1` with the Bearer token, the question disappears.

Several design rules follow from the notes:

- **Dynamic forms are shared.** Delegated forms and products both reference them, so export dedupes by form, and a data-source GUID inside `FormSchema` must be remapped on import.
- **GUIDs are always server-generated.** No script seen lets a POST carry a client GUID. Match by name (variables, groups, categories, data sources, forms, pools) or by `code` (products), and remap every reference. Unresolvable references are flagged in the plan, not guessed.
- **Update versus create is unknown.** Community scripts only check by name and create. Whether POST with an existing ID updates, and the PUT or PATCH verbs, must come from a captured edit. The user must perform that edit in the UI, not an agent.
- **Binary and certificate data.** Appearance images are best stored as separate files with a sha256 in the manifest. Certificates export as public metadata and PEM only. The UI's PFX export includes the private key and is never called by tooling.
- **Tenant-bound settings.** Custom domains, mail domain, default AD domain, redirect URLs, service desk and incident emails or webhooks, and certificates are skipped by default. Custom CSS, images, tile behaviour, currency, time zone and language are portable.

## Phased roadmap, import order and the three real risks

The phases are ordered by value and by what unblocks them. Each phase ships as one userscript version with the CHANGELOG entry and README section, and as a PowerShell parameter where the userscript has an export.

1. **Phase 0, transport and design.** Resolve the single-gateway assumption using the captures in checklist tier A. Add a second origin or cookie transport to the userscript, `Export-HelloID.ps1` and the MCP `HelloIdClient`. Update DESIGN.md first, because it states "Do not add features, flags or behaviour that are not described here".
2. **Phase 1, the two columns.** Read-only, no flags, lowest risk. Needs capture tier B.
3. **Phase 2, SA read and export.** Delegated forms and categories, dynamic forms, data sources, self-service products, categories and approval workflows, then Automation variables, tasks and scripts. Export-only (envelope plus backup parts) and MCP read tools. Secret variables are exported as `***` with `hasValue`.
4. **Phase 3, SA import.** Plan-then-apply with an automatic backup of anything overwritten. Needs the write captures.
5. **Phase 4, Directory and Applications.** Local groups, local users (Local source only), mapping sets, agent pools (verify only), application categories, applications.
6. **Phase 5, Security.** Roles, IdPs, portal and application access rules, then sign-on, password, 2FA, SMS, RADIUS, OATH and mobile app. Export first. Import ships last and only with the lockout guards.
7. **Phase 6, Settings.** Appearance, Language, Company, Certificates (metadata only, read-only), Logging if it still exists.

**Import order** is derived from dependencies. It is reasoned from the notes and not documented by HelloID: variables, agent pools (verify), groups, mapping sets, local users (managers first), group membership and nesting, automation tasks and scripts, data sources (task-backed after their task), dynamic forms (remap data source GUIDs), self-service and delegated form categories, approval workflows, application categories, applications, products (then access-group link and actions), delegated forms (then categories and the task with `objectGuid` set to the new form GUID), roles, then IdPs, access rules and policies. Certificates referenced by applications must exist first, so they are a pre-check, not an import step. Referenced items come before referrers, as the userscript's `IMPORT_ORDER` already does for systems before rules.

**Lockout risk.** Misconfigured portal access rules or IdPs can lock administrators out, and the documented recovery is a call to Tools4ever support ([Tools4ever blog](https://www.tools4ever.com/blog/access-management-context-based-access)). Deny always beats permit and the Local IdP cannot be disabled ([Portal access rules](https://docs.helloid.com/en/identity---authentication/security/portal-access-rules.html)). Safeguards, all untested because the endpoints are unseen:

- Never delete rules, roles, IdPs or keys. List extras as "not in file".
- Refuse an apply that would leave no enabled IdP the current admin can use, or whose deny rules match the running admin by IdP, IP or group.
- Never change IdPs and access rules in the same run.
- Apply new rules disabled or lowest priority first, if a rule enabled flag exists (unconfirmed).
- Warn before changing lockout count, session timeout or remember-me.
- Treat built-in roles and the Local IdP as read-only.
- Custom CSS and custom domain changes are the Settings equivalents: CSS can make the admin portal unusable, and a custom domain changes API, SSO and agent endpoints ([Custom domain risk warning](https://docs.helloid.com/en/portal-settings/company-settings/custom-domain-risk-warning.html)).

**Secret risk.** The `SECRET_NAME` regex and `***` mask carry over unchanged, and a `***` value on import means "keep what the item has". New secret surfaces are variables (the `secret` flag), task and data-source variables, product action scripts, IdP client secrets and certificates, API key secrets (shown once at creation, never exported), OATH seeds (never exported), SMS and RADIUS credentials, and incident webhooks. How HelloID returns each on GET (empty, null, masked or clear) is unknown and decides whether an import can tell "masked" from "blank". Until captured, assume the worst: treat these as masked, never write a placeholder back, and list "secret needs re-entry" per object in the plan. Scripts typed into SA tasks can contain inline secrets that name matching cannot see. The existing menu description already admits this for target systems, so the same warning belongs in every SA export. Exports of local users and requester history contain personal data and need the same warning that excluded-persons exports have.

**GUID remapping risk.** Cross-tenant import needs name-based remapping of data sources in form schemas, groups, categories, pools, mapping sets, certificates, approval workflow, manager GUIDs and application or product assignments. Whether the form schema also embeds task, form or product GUIDs is unknown. A same-tenant restore after deletion also produces new GUIDs, so history and links to the old GUID are lost. State this in the plan output.

## Separate MCP flags and what must be decided first

The existing mechanism is booleans in `environmentSchema` mapped through `Access` and `ACCESS_FLAGS` in `safety.ts`. A flag requires mode `write` plus its own boolean, as `allowDelete` and `allowEnforce` do. A new flag touches roughly eight places: `config.ts`, `config.example.json`, `safety.ts`, `tools/session.ts`, `cli.ts`, the README tables and permissions block, DESIGN.md, and `test/config.test.ts` and `test/safety.test.ts`.

A sensible set is one flag per area, default false: `allowServiceAutomation`, `allowDelegatedForms`, `allowAutomation`, `allowDirectory`, `allowApplications`, `allowSecurity`, `allowSettings`, plus separate `allowBackup` and `allowRestore`. Two choices go beyond the current pattern and need the user's decision.

- **Gating reads.** Today reads are gated by mode only. The Security and Settings notes propose three levels per area (off, read, write), where off hides the tools. That is new behaviour, justified because Security, Directory and Settings reads can expose users, rights and certificates metadata. A smaller alternative is to keep reads mode-gated and add only write flags.
- **Apply gating.** `helloid_apply_plan` has one `write` access. A mixed import file with provisioning and SA entries needs the area flag checked inside the handler (as `requireRevokingRulePublish` is today) or per-area plan and apply tools. Per-area tools are simpler to audit and fit the "separate configuration flags" request.

Flags that execute things (running a delegated form, a task or a data source) should be separate from the CRUD flags and treated like `allowDryRun`: not switched off by `safety.readOnly`, so an explicit decision is needed. Suggested caps from the notes: certificates stay read-only (metadata), API keys and OATH tokens are report-only, and no area gets deletion beyond the existing `allowDelete` path. `DELETE_KINDS` stays provisioning-only until SA delete pre-checks are captured.

Housekeeping conventions to respect, from the repository:

- **Versions.** Date-based `YYYY-MM-DD.N`, identical in the userscript `@version` and the PowerShell `$ScriptVersion` when both change. The MCP package has its own version string.
- **Docs.** A new top CHANGELOG entry (user-facing wording, setting and menu names verbatim), a README section and a parameter-table row. The README currently frames the project as Provisioning-only, so its first line changes.
- **Envelope.** `{exportedAt, exportedFrom, exportedBy, contents}` plus one type key, with `secretsIncluded` where relevant. Backups are `contents: 'backups'`. New `contents` values proposed: `delegatedForm`, `delegatedFormCategory`, `dynamicForm`, `dataSource`, `product`, `productCategory`, `approvalWorkflow`, `automationVariable`, `automationTask`, `application`, `directoryGroup`, `directoryUser`, `mappingSet`, `agentPool`, `securityPolicy`, `role`, `identityProvider`, `settingsPage`.
- **Plan-then-apply.** Fingerprints, a lock per environment and before/after audit. The userscript dialogs become `answers` in the MCP planner.
- **Line endings.** CRLF.

## Capture checklist for the Training tenant

Use Chrome DevTools, Network tab, filter Fetch/XHR, reload each page, **GET requests only**. Do not click Save, Delete, Download, Reset or create anything. Do not trigger any reorder or priority call. For each request record: full URL (path and query), method, header **names** (not values; remove Cookie and the Authorization value), the host (portal, gateway or other), and the first 2 to 3 response rows or one full object with secret values, tokens, cookies and personal names replaced by `<redacted>`. Where a response contains a secret field, note whether it is absent, empty, `null`, masked or clear text, and say which, without pasting the value.

Tier A, unblocks Phase 0 and every later phase:

- On any SA admin page (for example `/admin/delegatedforms/`): which host and path prefix the grid request uses, the auth style (Bearer on a gateway host, cookies only, or `/api/v1` with Basic), and whether the same Bearer token as `/server/v2/security/token` works. Also the bootstrap call that lists service origins (look for something like `/server/v2/bootstrap/...` for SA) and whether the SA app is hash-routed or path-routed.
- The same host and auth note for one Security page, one Settings page and one Directory page, to see whether they share the SA origin.
- Whether `/api/v1/roles` or `/service/...` is used by the Security > Roles page.
- Save the OpenAPI or Swagger JSON from https://apidocs.helloid.com if a download option exists. This replaces most of the list below if it exists.

Tier B, unblocks Phase 1 (the two columns):

- `/admin/delegatedforms/activity/` and `/admin/selfservice/requesthistory/request/`: the request that fills each grid (URL, method, body if POST, response rows), what sorting by the date column sends, what page 2 sends, and what the Submission, Task state and any date filters send. Include the total row count versus the page's count, the oldest timestamp present, and the timestamp format.
- `/admin/delegatedforms/` and `/admin/selfservice/products/`: the request that fills each grid. Note the GUID field name and any last-run-like field already in the rows.
- One grid row and one header cell as `outerHTML` from each of the two pages, and whether the table is AG Grid or a plain table. A screenshot of the activity filter buttons.

Tier C, unblocks Phase 2 and 3 (Service Automation):

- Dynamic forms: list request, one full form (the whole `FormSchema`), any version or draft requests when the editor opens, and the status field for enabled or draft.
- Data sources: list and one of each type (static, task, PowerShell), including the model and inputs requests.
- Delegated forms: list, one full form (notifications, run-as or system fields, access groups, task link), its tasks request, and the category list.
- Self-service: product list, one full product (approval workflow, actions, categories, access groups, form, agent pool), approval workflow list and one workflow, self-service category list.
- Automation: variable list with one secret and one non-secret variable, task list and one task, PowerShell script library list and one script, Systems list and one system (note credential fields), agent pool list.
- Write shapes, performed by the user on a throwaway object while the Network tab is open and then removed from the log before sharing: one edit of a form, product and variable (method, path, body shape, response), and what happens when a name already exists (409 or a duplicate). Without these, Phase 3 cannot start.

Tier D, unblocks Phase 4 (Directory and Applications):

- Directory > Users with Source=Local, plus one local user detail with its groups and MFA tabs. Directory > Groups, one local and one synced.
- Mapping sets: one each for Active Directory, an IdP and an application.
- Agent pools list and one pool's agents.
- Applications list, application categories, and one SAML, one OIDC, one WS-Fed and one Form or Plugin app. Note the client secret, certificate and logo fields.

Tier E, unblocks Phase 5 (Security):

- Portal access rules: list and one rule with IdP, group, IP, time and 2FA conditions. Application access rules from one application's tab. Note whether a rule has an enabled flag and a priority field.
- Sign-on policy (confirm it is one document) and password policy, plus any self-service password reset settings.
- Identity providers: list, one Azure AD OIDC and one SAML. Note what the client secret and certificates return.
- SMS and RADIUS: where they are configured in the UI (menu location), the GET and which fields are secret.
- 2FA management (enabled factors) and the OATH token list (confirm no seed is returned).
- Mobile app configuration: menu location, GET and JSON.
- One role, with the rights format and any built-in flag. Security > API: list GET, confirming no secret is returned.

Tier F, unblocks Phase 6 (Settings):

- Appearance, each tab (Logos and Icons, Custom CSS, Tile Behavior): the loading GET, and whether images come back as URL, base64 or binary. The Save request shape may be read from a change the user performs and reverts on the Training tenant. Never click Reset custom styling.
- Certificates: list and one detail view. State whether any private key material appears. Do not use Download or PFX.
- Language and Company, each tab (Company Info, Service Desk, Mail Domain, Custom Domains, Self Service, Incidents, Advanced). Note which responses contain webhook URLs or secrets.
- Logging: does the page exist, and is any audit retention or forwarding configuration visible.

Open questions for the user (not captures): the definition of "last used" (submitted only?) and "last requested" (include cancelled or denied?), and whether MCP reads of Security and Settings should be flag-gated or only the writes.

## Conclusion

The unexpected result is that the data model is the easy part and the transport is the hard part. The envelope, masking, plan-then-apply and flag mechanisms transfer directly. The unknown is whether SA sits behind the same gateway as Provisioning, and the notes cannot answer it. Security and Settings are the opposite case: the docs are rich in field lists and risks but contain no endpoint at all. That is why their import comes last, behind export-only, and why lockout guards are design requirements and not polish.

The most efficient next step is to send the Tier A and Tier B captures only. They settle the transport, deliver the two columns, and show whether the remaining tiers can be answered from one OpenAPI file or need to be captured page by page. Everything in this report beyond the community-code endpoints and the doc-derived field lists is inference, and the roadmap should be re-planned once Tier A is in.
