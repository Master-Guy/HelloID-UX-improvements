# HelloID MCP server

A local MCP server that lets Claude Code work with HelloID Provisioning in your environments, through your own admin session. It runs on your machine, on `http://127.0.0.1:3917/mcp`, and only Claude Code and the CLI (with the secret token) can use it.

- You log in yourself, in a Chrome window the server opens (Microsoft account, MFA). The server never sees, asks for or stores your password.
- The sessions (cookies, tokens) stay in the server's memory. Nothing is written to disk; after a restart you log in again.
- Every tool call is written to an audit log.

The full design is in [docs/DESIGN.md](docs/DESIGN.md).

**This version** has the session and browser tools, the read tools, the reports, evaluation, the import (plan and apply), the delete tools, the entitlement actions (pending, history, blocked), a health check, retrying failed actions, approving blocked actions and enforcement, each with plan and apply, and partial edits, publishing and cloning business rules, copying between environments, comparing and searching, and the target system scripts: the static DryRun check, the field mapping preview and HelloID's dry runs (see [Tools](#tools)).

## Tools

All tools except `helloid_list_environments` and the browser tools take `environment` (a name from `config.json`). Lists come in pages (`offset`, `limit`, default 100) with a `total`; a get tool gives one item in full. Secrets in configurations are masked as `***`, as the userscript's export masks them.

| Tools | What | Needs |
|---|---|---|
| `helloid_list_environments`, `helloid_list_identity_providers`, `helloid_login`, `helloid_logout`, `helloid_browser_show`, `helloid_browser_hide`, `helloid_browser_close` | Session and browser; `helloid_list_identity_providers` lists the identity providers on an environment's sign-in page (no login needed) and whether `login.provider` is among them | any mode |
| `helloid_list_target_systems`, `helloid_get_target_system` | Target systems, with their entitlement types (Account, Account Access, Permission); get = the userscript's export of the system (configuration, scripts, resources, agents, dependencies, used by, notifications, rules) plus the systems depending on it | mode `read` |
| `helloid_list_source_systems`, `helloid_get_source_system` | Source systems (get = the userscript's export) | mode `read` |
| `helloid_list_business_rules`, `helloid_get_business_rule` | Rules overview; one rule with conditions, entitlements and condition summary | mode `read` |
| `helloid_list_entitlements` | All entitlements rules can have | mode `read` |
| `helloid_list_toxic_combinations`, `helloid_get_toxic_combination` | Toxic policies | mode `read` |
| `helloid_list_notifications`, `helloid_get_notification`, `helloid_list_notification_systems`, `helloid_get_notification_system`, `helloid_list_custom_events`, `helloid_get_custom_event` | Notifications, notification systems, custom events | mode `read` |
| `helloid_list_schedules`, `helloid_get_reconciliation_configuration`, `helloid_get_aggregation_configuration`, `helloid_get_person_lifecycle`, `helloid_get_calculated_layers`, `helloid_list_custom_fields`, `helloid_list_excluded_persons` | The settings the userscript exports | mode `read` |
| `helloid_list_persons`, `helloid_get_person` | Persons (HelloID's search and paging); one person in full | mode `read` |
| `helloid_list_granted_entitlements` | Granted entitlements of one person, one system, or all | mode `read` |
| `helloid_list_evaluation_runs`, `helloid_get_evaluation_report`, `helloid_get_evaluation_logging` | Evaluation runs, a run's report, its logging | mode `read` |
| `helloid_export_everything` | The userscript's "Export everything" backup file | mode `read` |
| `helloid_report_rules_without_entitlements`, `helloid_report_rules_without_persons`, `helloid_report_rules_for_entitlement`, `helloid_report_system_access`, `helloid_check_references` | Reports: combined reads | mode `read` |
| `helloid_evaluate_rule_persons` | The persons a stored or unsaved rule would match (HelloID's preview) | `allowEvaluate` |
| `helloid_start_evaluation` | A full evaluation, always without enforcement; optionally waits and summarises the report | `allowEvaluate` |
| `helloid_list_entitlement_actions` | The pending (open) entitlement actions: person, entitlement, operation, why they wait (search, one system) | mode `read` |
| `helloid_list_action_history`, `helloid_get_action_logging` | The history of the entitlement actions with their result (filters: search, results, operations, types, systems); the log messages of one action | mode `read` |
| `helloid_list_blocked`, `helloid_get_blocked_details` | The blocked entitlement actions per group (system, type, operation, threshold, count, processing); the persons and entitlements of one group | mode `read` |
| `helloid_check_health` | One environment, or every logged-in one: blocked actions, orphaned entitlements, reference cleaner, latest snapshots, latest evaluation run, failed actions, and a list of problems | mode `read` |
| `helloid_plan_import` | Compares export files with the environment, as the userscript's "Overwrite all"; writes nothing; gives the overview and a plan ID | mode `plan` |
| `helloid_apply_plan` | Runs a plan: writes to HelloID | mode `write` |
| `helloid_plan_delete` | Reads one item and HelloID's checks before deleting it; deletes nothing; gives a plan ID | mode `write` + `allowDelete` |
| `helloid_apply_delete` | Runs a delete plan: **deletes for real**; needs `confirmName` | mode `write` + `allowDelete` |
| `helloid_plan_retry_action` | Reads one failed (Error) action of the history and its log messages; retries nothing; gives a plan ID | mode `write` + `allowRetryActions` |
| `helloid_apply_retry_action` | Runs a retry plan: **HelloID runs the action again** in the target system | mode `write` + `allowRetryActions` |
| `helloid_plan_approve_blocked` | Reads one blocked group and all its actions; approves nothing; gives the count and a plan ID | mode `write` + `allowApproveBlocked` |
| `helloid_apply_approve_blocked` | Runs an approve plan: **HelloID runs every blocked action of the group**; needs `confirmCount` | mode `write` + `allowApproveBlocked` |
| `helloid_plan_enforcement` | Runs an evaluation without enforcement and shows its report as what an enforcement would do; gives a plan ID | mode `write` + `allowEnforce` (+ `allowEvaluate`) |
| `helloid_apply_enforcement` | Runs an enforcement plan: **starts an enforcement** (grants and revokes for real); needs `confirmEnvironment` | mode `write` + `allowEnforce` |
| `helloid_plan_edit` | A partial change of one item (set, unset, list operations), planned with the import's planner; writes nothing; gives a plan ID for `helloid_apply_plan` | mode `plan` |
| `helloid_plan_copy` | Items of one environment planned as an import into another, inside the server; writes nothing; gives a plan ID for `helloid_apply_plan` in the target | mode `read` (source) + `plan` (target); applying needs `write` |
| `helloid_plan_publish_rule` | Reads a rule's draft and HelloID's summary of publishing it (persons and entitlements added and removed); gives a plan ID | mode `write` (`"revoke"`: + `allowRevokingRulePublish`) |
| `helloid_apply_publish_rule` | Runs a publish plan: **publishes the rule's draft**; needs `confirmName` | mode `write` (`"revoke"`: + `allowRevokingRulePublish`) |
| `helloid_clone_business_rule` | Copies a business rule in the same environment; returns the new ID and name | mode `write` |
| `helloid_compare` | Compares two items, or the same item across environments (groups of identical ones); scripts as diffs | mode `read` |
| `helloid_search_configuration` | Searches the exports (scripts, configuration, mappings, rules, ...) of one or more environments; never secrets | mode `read` |
| `helloid_check_scripts` | The static DryRun check of every PowerShell script of the target systems (account, permission, resource and uniqueness scripts): findings with line numbers, and the check's limitations | mode `read` |
| `helloid_list_dryrun_persons` | The persons to pick for a dry run or a preview (HelloID's search and paging) | mode `read` |
| `helloid_preview_field_mapping` | The values of a PowerShell system's field mapping for one person and action (saved, given, partly changed or planned mapping); no script runs | mode `read` |
| `helloid_dryrun_account_action`, `helloid_dryrun_permission_action`, `helloid_dryrun_permission_import`, `helloid_dryrun_uniqueness` | HelloID's dry run of an account script, a permission script, an import permissions script or the uniqueness script: **the real script runs against the real target system** with DryRun on; refused when the DryRun check finds anything | `allowDryRun` |

Every mode includes `read`; `allowEvaluate` and `allowDryRun` work whatever the mode. Only `helloid_apply_enforcement` enforces (`helloid_start_evaluation` never does); no tool reconciles.

Codes come with their labels: operation `0` Grant, `1` Revoke, `2` Update; entitlement type `1` Account, `2` Account Access (`AccountAccess`), `3` Permission; history result `0` Error, `1` Success, `2` Skipped, `3` Canceled (e.g. `operation: 0, operationLabel: "Grant"`). Inputs take the code or the label. Origins are numbers only (their labels are not known).

### Import: plan, then apply

`helloid_plan_import` takes the userscript's export files: single exports, partial target system files, and the "Export everything" backup (split into its parts). Pass each file as `{ name, content }`, the content as JSON or as its text. It works as the userscript's **Import HelloID export files… > Overwrite all**: what matches (by ID, else by name) is overwritten, the rest is made new (disabled where it can be switched on; business rules as drafts). It reads and compares only, and returns the same overview as the userscript (per item ⏳ `todo`, ⚠️ `note`, ✅ `same`, ❌ `skip`, with the changes, notes and reasons, and what is linked after it is made) and a plan ID.

- The import always works as the userscript's "Overwrite all": what matches (by ID, else by name) is overwritten, the rest is made new, and what is already the same is left alone.
- **answers**: the special cases the userscript asks in its dialog (dependencies found only by name, rule entitlements the file does not have, more schedules than HelloID allows, custom fields only in the environment). When one has no answer, the tool returns the open `choices` (key, options, default) and no plan ID; ask the user, or pass the defaults explicitly in `answers` (`{ "<key>": <option value> }`), and plan again.
- **helloid_apply_plan** takes the plan ID (valid 30 minutes, once, in the MCP session that made it). It reads the items again and refuses when HelloID changed since the plan; then runs the items in the userscript's order. A failure does not stop the others; what needs a failed item is not done. Every changed item is written to the audit log as it was before and after, secrets masked. Unlike the userscript, no backup is downloaded first: make your daily export.
- **Size**: a request to the server can be at most 64 MB (all files of one call together, as JSON). A file given as text takes more room than as JSON (its quotes are escaped). The audit log gets each file's size and SHA-256, never its content.

### Partial edits, copies, new IDs

- **helloid_plan_edit** takes `kind` (`targetSystem`, `sourceSystem`, `notificationSystem`, `notification`, `customEvent`, `businessRule`, `toxicCombination` or `toxicPolicy`, `schedule`, or a settings page: `sourceConfiguration`, `aggregationConfiguration`, `personLifecycle`, `excludedPersons`, `reconciliationConfiguration`), `id` or `name` (not for a settings page), `changes` and `answers` (as `helloid_plan_import`). The server exports the item (as the `helloid_get_*` tools give it, secrets masked), changes only what is listed, and plans the import of that one item with the same planner as `helloid_plan_import`. A masked value keeps the value it has in HelloID.
  - `set: [{ path, value }]`: a path in that export format, keys with dots, list items as `[n]` or `[key=value]`, e.g. `configuration.scripts.accountCreate`, `policy.enabled`, `configuration.mappingConfiguration.fields[name=mail].description`. A path that is not there yet is a new property (flagged in the plan: check its name). Replacing a list (or a value with lists in it) needs `replaceList: true` on that set.
  - `unset: [path]`: not the name, IDs, or list items.
  - `lists: [{ path, op: "add" | "remove" | "change", match, value }]`: `add` refuses when `match` (made from the new item when left out) finds an item already; `remove` and `change` refuse when it finds none or several. `change` sets the keys of `value` on the item (its other keys stay). `match: { "$value": "x" }` for lists of texts (rule categories, toxic entitlement IDs).
  - Applied in the order: list operations, set, unset. IDs (the item's own, and the IDs HelloID gives list items) and the parts of the export the import does not read are refused.
  - The plan shows every change with its old and new value (scripts: line counts and a unified diff), the planner's overview and a plan ID for **helloid_apply_plan**. A business rule is changed as its draft when it has one, and saved as a draft: publish it with `helloid_plan_publish_rule`. A source system's configuration (JSON in a text) is changed by paths into the JSON: `system.scriptConfiguration.url`.
- **helloid_plan_copy** takes `sourceEnvironment`, `targetEnvironment`, `items: [{ kind, id or name }]` and `answers`: it reads the exports in the source and plans their import into the target, inside the server. A target system comes with its notifications. Secrets are not copied: existing items in the target keep theirs, new items get empty secrets. Apply the plan with `helloid_apply_plan` and `environment` = the target.
- **New IDs**: `helloid_apply_plan` gives per entry `createdId` (the ID of the item it made) and `created` (every item it made, e.g. a new system and its new notifications), adds them to the overview lines, and lists them in the summary.

### Business rules: publish, clone

- **helloid_plan_publish_rule** takes `ruleId` and reads HelloID's summary of publishing the rule's draft (a rule without a draft is refused): persons in scope now, added, removed and after; entitlements now, added, removed and after, with the names. When entitlements are removed **or persons leave the scope**, `removedEntitlements` is required, with no default: `"revoke"` (at the next enforcement HelloID takes the rule's entitlements away from those persons, unless another rule grants them; needs `allowRevokingRulePublish: true`) or `"unmanaged"` (they keep them, no longer managed by the rule). When nothing is taken away it must be left out.
- **helloid_apply_publish_rule** takes the plan ID and `confirmName` (the rule's current name, exactly), reads the rule and the summary again and refuses when they changed, publishes, and reports whether there are orphaned entitlements now.
- **helloid_clone_business_rule** takes `ruleId` and returns the new rule's ID and name.

### Compare and search

- **helloid_compare**: `left` and `right` (`{ environment, kind, id or name }`), or `kind` + `name` (+ `environments`, default every logged-in one) for the same item across environments. Left out: the export header, change and run times, what HelloID fills in, null next to missing; IDs are compared as the name of what they point at. The answer has the differences per path (edit paths), scripts as unified diffs, in pages (`offset`, `limit`); across environments, the groups of identical environments and per group the differences from the first (largest) group.
- **helloid_search_configuration**: `query` (plain text, case-insensitive; `regex: true`, `caseSensitive: true`), `environments` (default every logged-in one), `kinds` (default all), `offset`, `limit`. Per match: environment, kind, item, path, line number in a script, the line and the lines around it. Secret values are never searched or returned. It reads every export of every environment asked (four environments at a time), so it takes a while.

### Delete: plan, then apply

Only these kinds can be deleted: target system, source system, business rule, notification, notification system, custom event, toxic combination. Both tools need mode `write` **and** `allowDelete: true` for the environment (and `safety.readOnly` false).

- **helloid_plan_delete** takes `kind` (`targetSystem`, `sourceSystem`, `businessRule`, `notification`, `notificationSystem`, `customEvent`, `toxicCombination`) and `id`. It reads the item and the checks HelloID's own pages make before deleting (systems depending on a target system, rules granting on it, its agent selection summary; blocked persons and the snapshot status of a source system; a rule's entitlements, published or draft, and the persons in it at the last evaluation; the notifications using a notification system; whether a custom event is used), and returns what would be deleted, what still uses it, warnings, the delete request, and a plan ID. It deletes nothing. Built-in notification systems, and a source system whose snapshot is running, are refused.
- **Business rules**: a published rule needs `ruleEntitlements`, with no default: `unmanaged` (HelloID's "mark entitlements as unmanaged", sends `/false`) or `revoke` (revoke the entitlements, sends `/true`; also needs `allowRevokingRuleDelete: true`). A draft-only rule needs no choice and is deleted with `/true`, as HelloID's page does.
- **helloid_apply_delete** takes the plan ID and `confirmName`, which must be exactly the item's current name (as the plan shows it). It reads the item and the checks again and refuses when anything changed since the plan, sends the delete, and reads back that the item is gone. A plan runs once, in the MCP session that made it, within 30 minutes. The item as it was before (secrets masked) is written to the audit log, with `after` null. There is no undo: make your daily export.
- Keep both delete tools on **ask** in Claude Code's permissions (see [Permissions](#permissions)), so you see every delete before it runs.

### Entitlement actions: retry, approve, enforce

Three things HelloID's Entitlements pages can do, each with a plan and an apply tool, like the delete tools. Each needs mode `write` **and** its own flag for the environment (`allowRetryActions`, `allowApproveBlocked`, `allowEnforce`; all `false` by default), and `safety.readOnly` false. A plan runs once, in the MCP session that made it, within 30 minutes; apply reads HelloID again and refuses when it changed since the plan. Every apply is written to the audit log with the before and after.

- **Retry a failed action**: `helloid_plan_retry_action` takes the `actionId` (from `helloid_list_action_history`) and, to find it fast in a long history, `search` (e.g. the person's name). Only actions with result Error can be retried. The plan shows the person, entitlement, system, operation and the newest log messages. `helloid_apply_retry_action` checks that the action is still an Error and sends HelloID's retry.
- **Approve a blocked group**: HelloID blocks actions when there are more than a threshold of one kind (e.g. "Blocking when at least 5" account updates on one system), and approves them per group: target system + entitlement type + operation, all persons at once (not per person). `helloid_plan_approve_blocked` takes `systemId`, `type`, `operation` (from `helloid_list_blocked`) and shows the count, the threshold and every person and entitlement. `helloid_apply_approve_blocked` needs `confirmCount` equal to that count, and refuses when the group changed or HelloID is processing it already.
- **Enforce**: `helloid_plan_enforcement` runs an evaluation **without** enforcement (it needs `allowEvaluate` too) and shows what it found (per system, type and operation) as what the enforcement is expected to do. `helloid_apply_enforcement` needs `confirmEnvironment` equal to the environment's name, refuses while a run is busy or when another run started since the plan, and starts the enforcement. It takes long: by default it answers the run ID at once (follow it with `helloid_list_evaluation_runs` and `helloid_get_evaluation_report`); with `wait: true` it waits up to 4 hours (raise `MCP_TOOL_TIMEOUT` for that).

Keep the three apply tools on **ask** in Claude Code's permissions (see [Permissions](#permissions)).

### Target system scripts: the dry-run rule, the check, the dry runs

The rule (Tools4ever/HelloID best practice): **every writing or deleting action in a target system script must be inside a dry-run check**, e.g. `if (-not($actionContext.DryRun -eq $true)) { ... }`, and a script must never disable or override DryRun itself. A HelloID dry run runs the **real** script against the **real** target system with `$actionContext.DryRun = $true`; only the script's own guard keeps it from changing things.

- **helloid_check_scripts** (every mode) runs the static DryRun check on every PowerShell script of the target systems (`environments` default every logged-in one; `systemId` one system). Findings per script with the line: `empty-script`, `dryrun-override` (the script changes `$actionContext.DryRun`, or a variable that stands for it, such as `$dryRun = $false` used in a guard), `unguarded-write` (`Invoke-RestMethod`/`Invoke-WebRequest` with POST, PUT, PATCH or DELETE, also through a splatted hashtable; cmdlets with a writing verb such as `New-`, `Set-`, `Remove-`, `Add-`, `Grant-`; a few .NET write methods) outside a dry-run check. A write in a function counts as guarded when every call of the function is. Not writes: a cmdlet called with `-WhatIf` (also `-WhatIf:$actionContext.DryRun`), and an OAuth token request (a POST to an `oauth2/token` endpoint, or with `grant_type` / `client_assertion` in its body). Empty script slots are listed as `notSet`, not as findings. It is a static check: it can miss dynamic code and flag writes guarded in an unusual way (its `limitations` say which); when it flags a safe write, restructure the script into the standard guard pattern. PowerShell v1 systems (`powershell-onpremise`) are checked with `$dryRun` as the guard.
- **helloid_plan_edit**, **helloid_plan_import** and **helloid_plan_copy** run the check on the scripts a target system gets (only the ones that change; every script of a new system) and put the findings in the change's (edit) or the entry's (import, copy) `warnings`: a warning only, the plan is never refused for it.
- **helloid_preview_field_mapping** (every mode, no flag) shows the value of every mapping field for one person and account action (`1` Create, `2` Enable, `3` Update, `4` Disable, `5` Delete), as HelloID's mapping editor does: no script runs. The saved mapping, or `fields` (a whole mapping), `planId` (the mapping a pending `helloid_plan_edit` plan would save) and/or `changes` (helloid_plan_edit's format, paths from `configuration.mappingConfiguration.fields`).
- **The dry runs** (`allowDryRun`): `helloid_dryrun_account_action` (`action` Create ... Delete), `helloid_dryrun_permission_action` (`permission` by entitlementId or name, `action` Grant, Revoke or Update), `helloid_dryrun_permission_import` (the permissions an import script finds, in pages) and `helloid_dryrun_uniqueness`. Persons come from `helloid_list_dryrun_persons`. Each runs the saved script, or `script` (unsaved text), or `planId` (+ `scriptPath`) for the script as a pending `helloid_plan_edit` plan would save it. **Before sending, the server runs the DryRun check on the script that will run and refuses it on any finding**, with the line numbers. The person is sent as HelloID's person preview gives it, with its account reference (`accountReference` overrides it; when HelloID has none, the output says so).
- **Secrets and personal data**: a dry run sends the system's real configuration values with the script, as HelloID's own dry run does. The server reads them from HelloID in memory for that request only: they are never returned, never written to the audit log, and secret values are scrubbed from what the script answers (values whose name says they are a secret are masked too). The person data HelloID gives the script is not returned or audited; the audit line has the system, the script, the person's ID and name, the action and a short result. A given `script` is in the audit as its size and SHA-256.

`allowDryRun` is `false` by default. Like `allowEvaluate`, it works whatever the mode, and `safety.readOnly` does not switch it off: set it to `false` to stop dry runs in an environment.

### The backup: a resource link

`helloid_export_everything` makes the same file as the userscript's "Export everything" (`contents: "backups"`, one export file per item, secrets masked). That file is megabytes, too large for an answer that goes into Claude's context. So the server keeps it in memory for 30 minutes and answers with a short summary (counts per kind, what could not be read) and a **resource link** `helloid-export://<id>`. Only the MCP session that made it can read it (MCP `resources/read`; in the MCP Inspector the Resources tab). It is never written to disk by the server and is lost on a restart. The file has the personal data of the excluded persons, as the userscript's backup does.

## Setup

You need Node.js 24 or newer (26 is fine) and Google Chrome.

### 1. Install

```powershell
cd D:\Public\HelloID-UX-improvements\helloid-mcp
npm install
npm run build
```

### 2. config.json

Copy the example and fill it in:

```powershell
Copy-Item config.example.json config.json
```

`config.json` is in `.gitignore`; it is never committed.

Generate the secret token (Claude Code and the CLI send it with every request):

```powershell
$bytes = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
```

Put the result in `auth.bearerToken` (at least 32 characters).

The rest of the file:

| Setting | Meaning |
|---|---|
| `server.host`, `server.port` | Where the server listens. The host must be a loopback address (`127.0.0.1`). Default `127.0.0.1:3917`. |
| `chrome.executablePath` | Your Chrome. Default `C:\Program Files\Google\Chrome\Application\chrome.exe`. |
| `chrome.profileDir` | The Chrome profile the server uses for all environments. Default `%LOCALAPPDATA%\helloid-mcp\chrome-profile`. |
| `chrome.closeAfterLogin` | Close Chrome after a successful login. Default `true`. The session stays in the server; `helloid_browser_show` or a new login opens Chrome again. Chrome stays open while a login to another environment is still waiting. |
| `audit.dir` | The audit log folder. Default `%LOCALAPPDATA%\helloid-mcp\audit`. |
| `safety.readOnly` | `true` makes every environment `read`, whatever its own mode. `allowEvaluate` and `allowDryRun` still work (they need no mode): set them `false` to stop those. |
| `environments.<name>` | One entry per HelloID environment. The name (letters, digits, `-`, `_`) is what you and Claude use in every tool call. |
| `.baseUrl` | The portal, e.g. `https://customer.helloid.com` (host only, no path). |
| `.gatewayUrl` | The provisioning gateway. Leave it `null`: the server finds it after the login. Only set it when that fails (the browser DevTools show it in the requests of the Target systems page). |
| `.mode` | `read` (read tools only), `plan` (read + plan), `write` (read + plan + apply). |
| `.allowEvaluate` | Rule evaluation and the persons preview (they change nothing). Default `true`. |
| `.allowDelete` | The delete tools; only with mode `write`. Default `false`. |
| `.allowRevokingRuleDelete` | Deleting a published business rule with "revoke entitlements". Default `false`. |
| `.allowRevokingRulePublish` | Publishing a business rule with `removedEntitlements: "revoke"` (entitlements taken away from persons that lose them). Default `false`. |
| `.allowRetryActions` | Retrying failed entitlement actions; only with mode `write`. Default `false`. |
| `.allowApproveBlocked` | Approving blocked entitlement actions; only with mode `write`. Default `false`. |
| `.allowEnforce` | Enforcement (the plan also needs `allowEvaluate`); only with mode `write`. Default `false`. |
| `.allowDryRun` | HelloID's dry runs of target system scripts (`helloid_dryrun_*`): the real script runs against the real target system with DryRun on, so only scripts the DryRun check finds nothing in are sent. Any mode. Default `false`. |
| `.login` | Optional: how the login starts. Leave it out to choose the identity provider on HelloID's sign-in page yourself. |
| `.login.provider` | The identity provider to open directly, as named on the sign-in page (e.g. `"Microsoft"`, `"Local"`; case does not matter, the whole name). The server reads the public sign-in page (no cookies) and opens Chrome on that provider's link, so you skip the choice. `npm run cli -- providers <environment>` lists the names. When the name is not on the page, the login fails and names the ones that are. |
| `.login.username` | A username to pass on (`username=<value>` added to the address Chrome opens: the provider's link, or the sign-in page when no provider is set), as HelloID's own sign-in page does with `?username=`. Whether the provider fills it in is up to the provider. |

`config.example.json` has `"login": { "provider": "Microsoft", "username": "someone@example.com" }` as an example: change both to your own, or remove `login`. Unknown keys in `login` are refused.

`%VAR%` in the paths is replaced by the environment variable. The server refuses to start on an invalid config and says which field is wrong.

### 3. The Chrome profile and the login extensions (once)

The server uses its own Chrome profile, separate from your normal one (Chrome does not allow remote control of your default profile). Install the extensions you need for the Microsoft login in that profile once. Start Chrome with the profile:

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --user-data-dir="$env:LOCALAPPDATA\helloid-mcp\chrome-profile"
```

Install the extensions from the Chrome Web Store, then close this Chrome window. Close it before the server needs Chrome: one profile can only be used by one Chrome at a time. (You can also start the server and run `npm run cli -- browser show`; that opens the same profile.)

## Starting the server

```powershell
npm start
```

It logs to the console (stderr) and keeps running. Stop it with Ctrl+C; it closes its Chrome and forgets the sessions.

While you work on the code, `npm run dev` runs it from the sources and restarts on changes in `src/`. A restart closes the server's Chrome and forgets the sessions, so log in again afterwards.

## Registering it in Claude Code

Once, in user scope (so it is not in the repository):

```powershell
claude mcp add --transport http --scope user helloid http://127.0.0.1:3917/mcp --header "Authorization: Bearer <your token>"
```

Use the token from `config.json`, and the port if you changed it. `claude mcp list` shows whether Claude Code reaches it (the server must be running).

### Permissions

In Claude Code, the tools are called `mcp__helloid__<tool>`. Let the read tools run without asking, and keep the asking for tools that change HelloID. In `%USERPROFILE%\.claude\settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__helloid__helloid_list_environments",
      "mcp__helloid__helloid_list_identity_providers",
      "mcp__helloid__helloid_login",
      "mcp__helloid__helloid_logout",
      "mcp__helloid__helloid_browser_show",
      "mcp__helloid__helloid_browser_hide",
      "mcp__helloid__helloid_browser_close",
      "mcp__helloid__helloid_list_target_systems",
      "mcp__helloid__helloid_get_target_system",
      "mcp__helloid__helloid_check_references",
      "mcp__helloid__helloid_check_health",
      "mcp__helloid__helloid_list_entitlement_actions",
      "mcp__helloid__helloid_list_action_history",
      "mcp__helloid__helloid_get_action_logging",
      "mcp__helloid__helloid_list_blocked",
      "mcp__helloid__helloid_get_blocked_details",
      "mcp__helloid__helloid_plan_retry_action",
      "mcp__helloid__helloid_plan_approve_blocked",
      "mcp__helloid__helloid_plan_enforcement",
      "mcp__helloid__helloid_plan_edit",
      "mcp__helloid__helloid_plan_copy",
      "mcp__helloid__helloid_plan_publish_rule",
      "mcp__helloid__helloid_compare",
      "mcp__helloid__helloid_search_configuration",
      "mcp__helloid__helloid_check_scripts",
      "mcp__helloid__helloid_list_dryrun_persons",
      "mcp__helloid__helloid_preview_field_mapping"
    ],
    "ask": [
      "mcp__helloid__helloid_apply_plan",
      "mcp__helloid__helloid_plan_delete",
      "mcp__helloid__helloid_apply_delete",
      "mcp__helloid__helloid_apply_retry_action",
      "mcp__helloid__helloid_apply_approve_blocked",
      "mcp__helloid__helloid_apply_enforcement",
      "mcp__helloid__helloid_apply_publish_rule",
      "mcp__helloid__helloid_clone_business_rule",
      "mcp__helloid__helloid_dryrun_account_action",
      "mcp__helloid__helloid_dryrun_permission_action",
      "mcp__helloid__helloid_dryrun_permission_import",
      "mcp__helloid__helloid_dryrun_uniqueness"
    ]
  }
}
```

Add the other read and report tools (see [Tools](#tools)) to `allow` in the same way; put `helloid_start_evaluation` where you like (it starts a run, never enforced). The plan tools of retry, approve and enforcement change nothing (the enforcement plan runs an evaluation without enforcement), so they can be allowed. Keep every apply tool and both delete tools in `ask`, always: Claude Code's permission prompt is your confirmation of a change. The script check and the field mapping preview change nothing and can be allowed; keep the dry runs in `ask`: they run the real script against the real target system (with DryRun on, and refused when the check finds a problem).

### The login takes a while

`helloid_login` waits until you have logged in (up to 10 minutes) and sends progress while it waits. If Claude Code gives up earlier, raise its MCP tool timeout (environment variable `MCP_TOOL_TIMEOUT`, in milliseconds), or log in with the CLI first.

## Daily use

Ask Claude to log in to an environment ("log in to training"), or use the CLI. The Chrome window comes to the front with a tab for that environment; log in there. With `login.provider` set, the tab opens on that identity provider straight away instead of HelloID's sign-in page. Each environment gets its own tab in the same window; Microsoft's account picker handles the different accounts.

The CLI talks to the running server (it uses the token from `config.json`):

```powershell
npm run cli -- login training     # log in to an environment
npm run cli -- providers training # the identity providers on its sign-in page (* = login.provider)
npm run cli -- status             # environments, mode, logged in, token valid until
npm run cli -- browser hide       # minimize the Chrome window
npm run cli -- browser show       # show it again (starts Chrome when it is closed, still logged in)
npm run cli -- browser close      # close Chrome; the server keeps its sessions
```

You can close Chrome whenever you like: the server keeps working from its in-memory sessions. `browser show` starts Chrome again with the server's cookies and a tab per logged-in environment.

The token is renewed automatically while the HelloID login lasts. When the login has expired, tools say so ("call helloid_login"); log in again.

## MCP Inspector

To try the tools by hand:

```powershell
npx @modelcontextprotocol/inspector
```

In the Inspector, choose transport **Streamable HTTP**, URL `http://127.0.0.1:3917/mcp`, and add the header `Authorization` with value `Bearer <your token>`. Connect, then use the Tools tab.

## Audit log

One file per day (UTC) in `audit.dir` (default `%LOCALAPPDATA%\helloid-mcp\audit`), e.g. `2026-11-19.jsonl`. One line per tool call: time, MCP session, environment, tool, arguments, result (`ok` / `refused` / `error`) and a short summary. Values whose name says they are a secret are masked, large file contents are replaced by their size and SHA-256, and cookies, tokens and passwords are never written. The files are only appended to, never removed.

```powershell
Get-Content "$env:LOCALAPPDATA\helloid-mcp\audit\$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')).jsonl" | ConvertFrom-Json | Format-Table time, environment, tool, result, summary
```

## Development

```powershell
npm test            # all tests (a fake HelloID on 127.0.0.1; no Chrome, no network)
npm run typecheck   # type-check sources and tests
npm run build       # compile to dist\
```
