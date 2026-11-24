# HelloID Service Automation objects: export/import research (Self-Service, Delegation, Automation)

Scope note: the official API docs (apidocs.helloid.com) were NOT reachable (the /docs/helloid/ URL returned 404 via WebFetch, and search did not index it). Claude in Chrome tools were not available in this session (ToolSearch found none), and the project's own `helloid` MCP server failed to connect (ECONNREFUSED). So nothing below was observed on the live training tenant. Endpoint facts come from Tools4ever's own open-source code (a generated createform.ps1 and a PowerShell module), which call the public API with API key/secret. Every statement is labelled Verified (seen in cited source code/docs) or Guess.

## Which endpoints exist, and which auth do they need (admin session vs API key/secret)

### Takeaway
The public Service Automation API lives at `https://<tenant>.helloid.com/api/v1/...` and authenticates with HTTP Basic of `apiKey:apiSecret`. That covers delegated forms, delegated form categories, dynamic forms, data sources, automation tasks, global variables, groups, self-service categories and products. No endpoint was found for approval workflows, Systems, or PowerShell script library in public code; those are gaps (admin UI endpoints under `/admin/...` or `/server/...` not verified).

### Cited Findings
- Auth for the generated export/import scripts: `apiKey:apiSecret` joined with a colon, ASCII, Base64, sent as `authorization: Basic <...>`; base URL is the portal URL with every endpoint appended — [Tools4everBV delegated-forms export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- The PSHelloID module builds a PSCredential from key and secret and passes `Invoke-RestMethod -Credential` (HTTP scheme not named in the source; Basic is consistent with the script above) — [PSHelloID Forms.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.2/Content/Forms.psm1)
- Delegated forms: `GET /api/v1/delegatedforms` (list, supports `?search=&skip=&take=`), `GET /api/v1/delegatedforms/{guid-or-name}`, `POST /api/v1/delegatedforms` (create; same POST used by the module's Set-HidDelegatedForm) — [Forms.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.2/Content/Forms.psm1), [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Delegated form categories: `GET /api/v1/delegatedformcategories` (list), `GET /api/v1/delegatedformcategories/{guid-or-name}`, `POST /api/v1/delegatedformcategories` (body `name = { "en": "<name>" }` in the script), `DELETE /api/v1/delegatedformcategories/{guid}`; link to a form with `POST /api/v1/delegatedforms/{formGuid}/categories` with an array of category GUIDs — [Categories.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.95.1/Content/Categories.psm1), [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Dynamic forms: `GET /api/v1/forms` (paged `skip`/`take`), `GET /api/v1/forms/{guid-or-name}`, `POST /api/v1/forms` (body `Name`, `FormSchema`), `DELETE /api/v1/forms/{guid}` — [Forms.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.2/Content/Forms.psm1), [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Data sources: `GET /api/v1/datasource/{guid}`, `GET /api/v1/datasource/named/{name}`, `POST /api/v1/datasource` (body `name`, `type`, `model`, `automationTaskGUID`, `value`, `script`, `input`, `runInCloud`) — [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Automation tasks: `GET /api/v1/automationtasks` (list, `?search=&container=`), `GET /api/v1/automationtasks/{guid}`, `POST /api/v1/automationtasks/powershell` (body `name`, `useTemplate`, `powerShellScript`, `automationContainer`, `objectGuid`, `variables`) — [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Task library ("automation store"): read-only GETs under `/api/v1/automationstore/tasks[...]` and `/api/v1/automationstore/categories/context/...` — [PSHelloID Tasks.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.2/Content/Tasks.psm1)
- Global variables (variable library): `GET /api/v1/automation/variables` (list), `GET /api/v1/automation/variables/named/{name}`, `POST /api/v1/automation/variable` (body `name`, `value`, `secret`, `ItemType = 0`) — [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1); the module's connect test calls `automation/variables` with key/secret — [PSHelloID Connection.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.7/Content/Connection.psm1)
- Groups: `GET /api/v1/groups` (paged), `GET /api/v1/groups/{name}`, `POST /api/v1/groups` (body `Name`, `IsEnabled`, `Source = "Local"`), `DELETE /api/v1/groups/{id}` — [Entra-to-products sync script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Sync-AzureActiveDirectory-Groups-To-SelfService-Products/main/Sync-EntraID-Groups-To-HelloID-Selfservice-Products.ps1), [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Self-service categories: `GET`/`POST /api/v1/selfservice/categories`, create body `{name, isEnabled, useFaIcon, faIcon, icon}` — [sync script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Sync-AzureActiveDirectory-Groups-To-SelfService-Products/main/Sync-EntraID-Groups-To-HelloID-Selfservice-Products.ps1)
- Products: `GET /api/v1/products` (paged), `POST /api/v1/products` (create), `DELETE /api/v1/products/{productId}`, access groups via `POST /api/v1/selfserviceproducts/{productId}/groups` body `{groupGuid}`; "disable" is also a `POST /api/v1/products` with `Visibility = "Disabled"` (the script posts to the same URL; this suggests POST is upsert by body identity, Guess) — [sync script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Sync-AzureActiveDirectory-Groups-To-SelfService-Products/main/Sync-EntraID-Groups-To-HelloID-Selfservice-Products.ps1)
- Agent pools: `GET /api/v1/agentpools` (default pool is the one with `options -eq "1"`) — same sync script
- Product ownership and request exist at `/api/v1/productownership/` and `/api/v1/selfservice/products/request`; no separate approval API (user-reported on Canny) — [HelloID Canny](https://helloid.canny.io/service-automation/p/choice-to-run-tasks-when-settingremoving-product-ownership-via-api)
- Existing project export uses a different route for Provisioning: admin login form at `/authentication/admlogin`, then Bearer token from `/server/v2/security/token`, then the provisioning gateway host found via `/server/v2/bootstrap/provisioning` — local file `d:\Public\HelloID-UX-improvements\Export-HelloID.ps1` (lines ~178-240). This is the admin-session route; no equivalent was verified for Service Automation.

### Inferences
- Service Automation (unlike Provisioning, per the project's memory note) is reachable with API key/secret on `/api/v1`, so an export/import tool can use that without an admin cookie. Whether the admin UI itself calls the same `/api/v1` paths (probably via `/server/v2/...` or `/api/v1` with the Bearer token) is unverified.
- Products POST body shape suggests a full-object write; whether `POST /api/v1/products` with an existing `productId` updates is unverified (see Gaps).

### Gaps
- Official apidocs page unreachable; no authoritative request/response schemas, PUT/PATCH update endpoints, or Swagger. User should open https://apidocs.helloid.com in a browser and capture (or export OpenAPI JSON if offered).
- No source found for: approval workflows list/create endpoints, Systems (Automation), PowerShell script library, notification/run-as settings.

## Dependency graph and safe import order, GUID handling

### Takeaway
Safe order: variables, agent pools (must exist), automation tasks and data sources (task-backed sources need their task first), dynamic forms (schema embeds data source GUIDs), groups, categories, then delegated forms/products (+ category and group links), then form-attached tasks/product actions. GUIDs are server-generated on POST and must be remapped; Tools4ever's approach is placeholder substitution inside the form schema.

### Cited Findings
- Generated createform.ps1 order: 1 global variables (checked by name first), 2 data sources (for type 3 the backing task is created before its data source), 3 dynamic form, 4 access groups and categories (lookup, create if missing), 5 delegated form then its categories POST, 6 legacy delegated-form automation task (only when the form was newly created) — [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- Remapping: every `dataSourceGuid` property in the form schema is replaced with a `$dataSourceGuid_N` placeholder and the GUID returned by the data source POST is substituted when the script runs; task GUIDs returned from POST are passed on; the new delegated form GUID becomes `objectGuid` of the form's task; group and category names are resolved to GUIDs at runtime — same source
- The form-to-task link is `objectGuid` of the task = delegated form GUID; legacy tasks are created with `ForceCreateTask` and only for newly created forms — same source
- Product references from the sync script: `categories`, `resourceOwnerGroup`, `approvalWorkflow` (`{id}`), `dynamicForm` (form id), `agentPool`, plus action scripts `onRequest/onApprove/onDeny/onReturn/onWithdrawn` as objects `{id, name, script, agentPoolId, runInCloud}` — [sync script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Sync-AzureActiveDirectory-Groups-To-SelfService-Products/main/Sync-EntraID-Groups-To-HelloID-Selfservice-Products.ps1)
- Product config property list (README): Code, Name, Description, SourceIdentifier, Visibility, AccessGroups, RequestCommentOption, AllowMultipleRequests, ApprovalWorkflowId, UseFaIcon/FaIcon/Icon, Category, FormId, ReturnOnUserDisable, HasTimeLimit, ManagerCanOverrideDuration, LimitType, OwnershipMaxDuration, AgentPool, ShowPrice/Price, HasRiskFactor/RiskFactor, MaxCount — [sync repo](https://github.com/Tools4everBV/HelloID-Conn-SA-Sync-AzureActiveDirectory-Groups-To-SelfService-Products)
- Approval workflows exist independently of products and are assigned per product; default is "Approval By Resource Owner"; responders can be users, groups or managers — [HelloID docs](https://docs.helloid.com/en/service-automation/products/approval-workflows.html)
- Products and delegated forms both use Dynamic forms; products' forms let end users provide extra info for product actions — [HelloID docs](https://docs.helloid.com/en/service-automation/products.html), [delegated forms](https://docs.helloid.com/en/service-automation/delegated-forms.html)
- Data source types seen: built-in (e.g. HelloID Groups), static, task (type 3), PowerShell — [delegated forms export README](https://github.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms)

### Inferences
- Proposed order for our tool: (1) variables, (2) groups (names/GUIDs; local groups can be created with source Local, external-source groups cannot), (3) agent pools (verify only), (4) automation tasks/scripts, (5) data sources (task-backed after tasks), (6) dynamic forms (remap data source GUIDs inside FormSchema), (7) selfservice categories and delegated form categories, (8) approval workflows (must precede products), (9) products (+ groups link POST, actions), (10) delegated forms (+ categories POST, tasks with objectGuid = new form GUID).
- Cross-tenant remap keys: name for variables/groups/categories/data sources/forms (all have `named/`-style lookups), `code` for products, agent pool by name. GUIDs cannot be preserved via POST in any seen script (always server-generated); GUID-preserving import is Guess/not shown.

### Gaps
- Whether the dynamic form schema also references task GUIDs, other forms, or product IDs beyond `dataSourceGuid`.
- Whether POST accepts a client-supplied GUID. Not seen anywhere.
- Delegated form fields beyond `name, dynamicFormGUID, isEnabled, useFaIcon, faIcon, task, accessGroups`: notifications, run-as, system settings, drafts/versioning not found in any source.

## Dynamic forms: JSON shape, versioning, drafts, enabled

### Takeaway
A dynamic form is stored as `{Name, FormSchema}`; FormSchema is the form definition JSON with fields whose data sources are referenced by `dataSourceGuid`. Versioning and drafts in the API were not found.

### Cited Findings
- Create body is `Name` + `FormSchema`; list/get by GUID or name — [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)
- The export tool saves `dynamicform.json` plus per-data-source `.model.json` and `.inputs.json` files — [repo README](https://github.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms)
- Delegated form carries `isEnabled` (set "True" on create); products carry `visibility` (e.g. "Disabled") — [export script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1), [sync script](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1)

### Inferences
- The same dynamic form is shared by products and delegated forms through `dynamicFormGUID` (delegated) / `dynamicForm` (product); a form could be used by several objects, so export must dedupe by form.

### Gaps
- /admin/dynamicforms/ UI endpoints, form models, field rules, draft/versioning behaviour: no source. User capture needed (below).

## Secrets handling and masking

### Takeaway
Tools4ever's generated import script exports secret global variables with an empty value; the project's own export masks as `***` for provisioning. API responses for Service Automation secrets (variable values, task variables, notification credentials) were not observed.

### Cited Findings
- Only variables referenced in the task scripts are exported; secret variables are exported with an empty value; only string-type variables and script variable mappings are supported — [export script analysis](https://raw.githubusercontent.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms/main/generate-all-in-one.ps1), [README](https://github.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms)
- Variable create body carries `secret` boolean — same script
- The existing "masked values" feature in the project is for Provisioning: `$ExportMask = '***'`, `-IncludeSecrets` switch / userscript setting "Target system export: include secrets" — `d:\Public\HelloID-UX-improvements\Export-HelloID.ps1` and `d:\Public\HelloID-UX-improvements\CHANGELOG.md` (line 9). The repo has no Service Automation variable library export or flag yet.
- docs.helloid.com variables page does not say how secrets display — [docs](https://docs.helloid.com/en/access-management/access-management-variables.html)

### Gaps
- What `GET /api/v1/automation/variables` returns for `secret:true` (empty, null, or masked string) is unverified; that determines whether we can detect "masked" on import and skip overwriting.
- Task data source secrets, task/product action variables, notification credentials: unknown.

## Built-in export/import features and limits

### Takeaway
No built-in JSON export/import of forms, products, tasks or variables was found in the docs. HelloID's only import is of prebuilt delegated forms from Tools4ever's GitHub; the community export tool is the closest thing and has explicit limits.

### Cited Findings
- docs.helloid.com service-automation pages do not mention export/import/backup — [service automation](https://docs.helloid.com/en/service-automation.html), [products](https://docs.helloid.com/en/service-automation/products.html)
- HelloID can import standard delegated forms from Tools4ever's GitHub repository; afterwards variables are set and access granted per form to users or groups — [Tools4ever blog](https://www.tools4ever.com/blog/service-automation-importing-delegated-forms)
- Export tool limits: only string global variables; PowerShell script templates unsupported (inline only); access groups are hardcoded and must exist/updated manually; categories are created automatically; assumes target resources do not already exist — [README](https://github.com/Tools4everBV/HelloID-Conn-SA-Source-HelloID-DelegatedForms), [AD create README](https://github.com/Tools4everBV/HelloID-Conn-SA-Full-AD-AccountCreate)
- Duplicate mode appends `_tmp` to all resource names — export script

### Gaps
- Whether the admin UI has hidden export buttons (not stated in docs fetched; subpages "Add, edit, or remove a delegated form" etc. were not read).

## Name-collision and overwrite behaviour

### Takeaway
The community scripts check by name (or product code) first and skip/create; none overwrite. Overwrite semantics of POST vs PUT are unverified.

### Cited Findings
- Variables, data sources, tasks, forms, delegated forms: GET by name first, create only if absent — export script
- Categories: lookup by name, POST if lookup fails — same
- Products matched by `code` (hyphens stripped), not name or sourceIdentifier; groups matched by `source/name`; duplicates raise an error — sync script
- Update exists in the sync script (`$updateBody` from cached full product) but the request was not in the read excerpt — sync script

### Gaps
- Exact update verbs/paths for each object (PUT vs POST upsert).
- Behaviour when a name already exists on POST (409 vs duplicate created).

## What the user must capture (browser DevTools, GET only, secrets removed)

For each: URL, method, response sample (remove secret values, tokens, cookies) — redact only values.
- Dynamic forms page `/admin/dynamicforms/`: the list request, one form GET (full FormSchema), any "versions"/"draft" requests when opening the editor; note the status field for enabled/draft.
- Self-service: one product GET (with approvalWorkflow, actions, categories, access groups), product list, approval workflows list + one workflow GET, self-service categories list, product request-form link field.
- Delegation: one delegated form GET (look for notifications, run-as/system, access groups, task link), its tasks request, delegated form categories list.
- Automation: variable library list (one secret and one non-secret variable: show how the secret appears), PowerShell script library list + one GET, task list, Systems list + one GET (note any credentials fields), agent pools list.
- For each of the above: whether the request path is `/api/v1/...` with Basic, or `/server/...` with Bearer cookie session; and the write calls (PUT/POST) captured from a Network tab by the user performing an edit themselves (do not ask the agent to write).
- Apidocs: save the OpenAPI/Swagger JSON from https://apidocs.helloid.com if the "Download" option exists.
