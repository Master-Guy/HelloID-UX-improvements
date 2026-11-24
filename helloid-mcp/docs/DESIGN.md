# HelloID MCP server: design

A local MCP server that lets Claude (Claude Code) read and change HelloID Provisioning in any number of environments, through the admin session of the person using it. It runs on the user's own machine, next to their normal work in HelloID.

Everything in this document was agreed with the user. Do not add features, flags or behaviour that are not described here. Where something is unknown, find out (see "Unknowns" at the end) instead of guessing.

## Principles

- **The server is the only holder of HelloID sessions.** No HelloID password, cookie or token is ever written to disk by the server, returned to Claude, written to the audit log, or printed to the console. Sessions live in memory; a restart of the server means logging in again.
- **Passwords are typed by the user** in the browser window. The server never asks for, stores or fills in a password.
- **Logging in is interactive** (Microsoft account with push, TOTP or biometric). It is a daily task of the user.
- **Changes only when explicitly asked for:** write and delete tools are separate from read tools, carry MCP annotations, and go through a plan step and an apply step. Claude Code's permission prompt is the user's confirmation.
- **Follow MCP best practices** (see "MCP practices").
- **Local now, online later:** keep authentication of callers in one module, so OAuth 2.1 (the MCP authorization spec) can replace the static bearer secret in a later version.

## Technology

- Node.js (26 is installed), TypeScript, ES modules, strict mode.
- `@modelcontextprotocol/sdk` (official TypeScript SDK), `McpServer` with `registerTool`, Streamable HTTP transport (`StreamableHTTPServerTransport`).
- `zod` for input and output schemas.
- Chrome control over the Chrome DevTools Protocol with `puppeteer-core` (no bundled browser; the installed Google Chrome is used).
- Tests: `node:test` with a fake HelloID server (plain `http` module) that serves recorded-shape sample data. No test uses the network outside `127.0.0.1`.
- Line endings: CRLF, like the rest of the repository (`core.autocrlf` is true).
- Lives in `helloid-mcp/` in this repository. The userscripts and `Export-HelloID.ps1` are not changed by this project.

## Folder layout

```
helloid-mcp/
  package.json, tsconfig.json, README.md
  config.example.json        committed; config.json is gitignored
  docs/DESIGN.md             this file
  src/
    index.ts                 start: config, HTTP server, MCP server
    cli.ts                   command line: login, providers, browser show/hide/close, status
    config.ts                load + validate config.json (zod)
    auth/caller.ts           bearer secret + Origin check (the swappable layer)
    helloid/browser.ts       Chrome: launch, login, show/hide/close, cookies in and out
    helloid/session.ts       per environment: cookies, token, gateway, refresh
    helloid/client.ts        requests to the portal and the gateway
    helloid/endpoints.ts     every HelloID path in one place
    helloid/signin.ts        the identity providers on the sign-in page (login.provider)
    audit.ts                 audit log
    safety.ts                modes, flags, locks, plan store
    tools/*.ts               MCP tools, grouped by area
    changes/*.ts             partial edits, compare, and the DryRun check of scripts (dryrun-check.ts)
    planners/*.ts            the import/plan logic, ported from the userscript
  test/
    fake-helloid.ts          fake portal + gateway
    fixtures/*.json          synthetic sample data in HelloID's shapes
    *.test.ts
```

## Configuration: one JSON file

`helloid-mcp/config.json` (gitignored; add it to the root `.gitignore` together with `helloid-mcp/node_modules/` and `helloid-mcp/dist/`). `config.example.json` is committed with placeholder values. Validated with zod at start; the server refuses to start on an invalid config and says which field is wrong.

```json
{
  "server": { "host": "127.0.0.1", "port": 3917 },
  "auth": { "bearerToken": "<long random secret, also given to Claude Code>" },
  "chrome": {
    "executablePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "profileDir": "%LOCALAPPDATA%\\helloid-mcp\\chrome-profile"
  },
  "audit": { "dir": "%LOCALAPPDATA%\\helloid-mcp\\audit" },
  "safety": { "readOnly": false },
  "environments": {
    "training": {
      "baseUrl": "https://example.helloid.training",
      "gatewayUrl": null,
      "mode": "write",
      "allowEvaluate": true,
      "allowDelete": false,
      "allowRevokingRuleDelete": false,
      "allowRevokingRulePublish": false,
      "allowRetryActions": false,
      "allowApproveBlocked": false,
      "allowEnforce": false,
      "allowDryRun": false,
      "login": { "provider": "Microsoft", "username": "someone@example.com" }
    }
  }
}
```

- `server.host` must be a loopback address; refuse anything else in this version.
- `auth.bearerToken`: at least 32 characters. Compared with `crypto.timingSafeEqual`.
- `%VAR%` in paths is expanded. Defaults: `chrome.executablePath` as above, `profileDir` and `audit.dir` as above.
- Environments: any number (about 15 to start), keyed by a short name that is used in every tool call. `baseUrl` is the portal (each environment has its own hostname). `gatewayUrl` is optional: when null, it is discovered after login (see Session).
- `mode`: `read` (read tools only), `plan` (read + plan tools), `write` (read + plan + apply).
- `allowEvaluate` (default true): rule evaluation and the rule persons preview are allowed whatever the mode (they change nothing in HelloID).
- `allowDelete` (default false): the delete tools work only when true and mode is `write`.
- `allowRevokingRuleDelete` (default false): deleting a published business rule with "revoke entitlements" is allowed only when true. Without it, a published rule can only be deleted with "mark entitlements as unmanaged".
- `allowRevokingRulePublish` (default false): publishing a business rule with `removedEntitlements: "revoke"` (`helloid_plan_publish_rule`, `helloid_apply_publish_rule`) is allowed only when true. Without it, only "unmanaged".
- `allowRetryActions` (default false): retrying failed entitlement actions (`helloid_plan_retry_action`, `helloid_apply_retry_action`) works only when true and mode is `write`.
- `allowApproveBlocked` (default false): approving blocked entitlement actions (`helloid_plan_approve_blocked`, `helloid_apply_approve_blocked`) works only when true and mode is `write`.
- `allowEnforce` (default false): a full enforcement (`helloid_plan_enforcement`, `helloid_apply_enforcement`) works only when true and mode is `write`; the plan runs an evaluation, so it also needs `allowEvaluate`.
- `allowDryRun` (default false): HelloID's dry runs of target system scripts (`helloid_dryrun_*`, see "Target system scripts") work only when true. Like `allowEvaluate` it needs no mode, and `safety.readOnly` does not switch it off (decided so for consistency: a dry run changes nothing when the script follows the dry-run rule, and the server only sends scripts the DryRun check finds nothing in). To stop dry runs, set it false.
- `login` (optional): `{ "provider"?: string, "username"?: string }`, both optional, non-empty (trimmed); unknown keys are refused. See Chrome and login.
- `safety.readOnly` true overrides every environment to `read` (so every apply, delete, retry, approve and enforcement tool is refused). `allowEvaluate` and `allowDryRun` need no mode, so they still work.

## Callers: who may use the server

- Streamable HTTP on `http://127.0.0.1:<port>/mcp`.
- Every request needs `Authorization: Bearer <auth.bearerToken>`; otherwise 401 with `WWW-Authenticate: Bearer`.
- Validate the `Origin` header: requests that carry an `Origin` that is not `http://127.0.0.1:<port>` or `http://localhost:<port>` are refused with 403 (protection against DNS rebinding). Requests without `Origin` (Claude Code, the CLI) are allowed.
- Session management per the SDK (`Mcp-Session-Id`), several Claude sessions at once.
- All of this lives in `src/auth/caller.ts`, behind one function, so OAuth can replace it later.

Claude Code is registered once by the user, in user scope (outside the repo), for example:
`claude mcp add --transport http --scope user helloid http://127.0.0.1:3917/mcp --header "Authorization: Bearer <token>"`.
The README explains this, and how to set read tools to "allow" and apply/delete tools to "ask" in Claude Code's permissions.

## Chrome and login

- One shared Chrome profile for all environments (`chrome.profileDir`), separate from the user's normal Chrome profile (Chrome 136+ refuses remote debugging of the default profile). The user installs the extensions needed for the Microsoft login in it once; the README says so.
- Launch the installed Chrome with `puppeteer-core`, `headless: false`, the profile dir, `defaultViewport: null`. Keep extensions enabled (`ignoreDefaultArgs: ['--disable-extensions']`). The debugging port listens on 127.0.0.1 only.
- `login(env)`: open (or reuse) the Chrome window, open a tab on `<baseUrl>/`, bring the window to the front, and wait until the user has logged in. Logged in = `GET <baseUrl>/server/v2/security/token` with the tab's cookies answers 200 with a token (poll every 2 seconds, time out after 10 minutes with a clear message). Then copy that host's cookies (CDP `Storage.getCookies` / `Network.getAllCookies`, filtered on the environment's host) into the server's memory, get the token and the gateway (see Session), and report the result. Then Chrome is closed (`chrome.closeAfterLogin`, default `true`), unless a login to another environment is still waiting in it; the sessions stay in memory, and a failure to close is only logged. With `false`, the tab stays open.
- The address the login opens (`src/helloid/signin.ts`, `BrowserService.loginUrl`):
  - Without `login`: `<baseUrl>/` (unchanged; HelloID shows its sign-in page).
  - With `login.provider`: before Chrome is started, the server reads the public sign-in page with its own fetch (`GET <baseUrl>/`, redirects followed to `/Authentication/SignIn?ReturnUrl=%2F`; no cookies, no credentials) and takes the identity providers from it: every `a` element whose class list contains `sign-in-link`; name = the link's text (tags removed, entities decoded, whitespace collapsed), path = its `href` (relative, with its `returnUrl`). The configured name is matched case-insensitively after trimming, the whole name. Chrome opens `<baseUrl><path>`, so the choice page is skipped. No match: the login fails and lists the names on the page; the page cannot be read or has no providers: the login fails with the reason. Chrome is not opened in either case, and there is no fallback to the sign-in page.
  - With `login.username`: `username=<value>` (URL-encoded) is added as a query parameter to that address, keeping its other parameters: the provider's link, or, without a provider, `<baseUrl>/Authentication/SignIn?ReturnUrl=%2F` (HelloID's sign-in page adds `?username=` to its provider links itself).
  - The URL is only passed to `Target.createTarget` (`ChromeDriver.openTab`); the server never attaches DevTools to a page (the Cloudflare check in login extensions such as Dashlane detects it).
- Logging in to several environments: each in its own tab of the same window; Microsoft's account picker handles the different accounts.
- `browser show`: restore and focus the window (CDP `Browser.setWindowBounds` with `windowState: 'normal'`). If Chrome is closed, launch it again, put the server's cookies back for every logged-in environment (`Network.setCookies` / `Storage.setCookies`), and open one tab per logged-in environment, so the user is still logged in.
- `browser hide`: minimize the window (`windowState: 'minimized'`).
- `browser close`: close Chrome. The server keeps working from its in-memory sessions.
- If the user closes Chrome themselves, the server notices (puppeteer `disconnected`) and keeps working.

## Session per environment

- In memory: cookies of the portal host, the current Bearer token and its expiry (the JWT `exp`), the gateway origin.
- Token: `GET <baseUrl>/server/v2/security/token?cachebust=<ms>` with the cookies and `Accept: application/json, text/plain, */*`. The answer contains one or more JWTs: take the one whose `aud` is `helloid.services`, else the first (`/eyJ[\w-]+\.[\w-]+\.[\w-]+/g`). This is what `Export-HelloID.ps1` does (`Update-Token`).
- Gateway: `GET <baseUrl>/server/v2/bootstrap/provisioning` with the cookies; the gateway is the first URL in the answer whose host contains `gateway`; keep its origin. `gatewayUrl` from the config wins when set. (`Find-Gateway` in `Export-HelloID.ps1`.)
- Gateway requests: `Authorization: Bearer <token>`, `Accept: application/json, text/plain, */*`, `Origin: <baseUrl>`. Renew the token when it expires within 2 minutes, and once on a 401 (then retry once). If renewing fails (portal answers not 200), the session is expired: mark it so and tell the caller to log in again (`helloid_login`).
- Cookies set by the portal in responses (`Set-Cookie`) update the in-memory cookies.
- Reads of HelloID's lists use `take` large enough to get everything in one request (`999999`, as HelloID's own pages do), and `cachebust` where HelloID's page sends it.

## Safety

- Mode checks per tool (see Configuration). A refused call returns an MCP tool error (`isError: true`) that says which setting refuses it.
- **Plans:** every plan tool stores its plan in memory with an ID (random UUID), the environment, the caller's MCP session, a fingerprint of the current state of every item the plan touches (a hash of the item as read from HelloID), and an expiry of 30 minutes. The apply tool takes the plan ID; before running, it reads the items again and refuses if any fingerprint changed ("HelloID changed since the plan; plan again"). A plan is applied at most once.
- **One write at a time per environment:** a lock around apply and delete.
- **Deletes** need, in `helloid_apply_delete`: the plan ID, and `confirmName` exactly equal to the item's current name. Plus `allowDelete`, and for a published rule with revoke also `allowRevokingRuleDelete`.
- **Enforcement only through its own plan and apply:** `helloid_start_evaluation` and every other evaluation always use `enforce=false` and have no enforce argument. `enforce=true` is sent only by `helloid_apply_enforcement` (mode `write` + `allowEnforce`, `confirmEnvironment`). No reconciliation actions exist in the server.
- **Retrying failed actions and approving blocked actions** need mode `write` plus their own flag (`allowRetryActions`, `allowApproveBlocked`), and go through plan and apply. Approving a blocked group needs `confirmCount` equal to the planned number of actions.
- Secrets in target system and notification system configurations are masked in every answer to Claude, the same way the userscript's export does (`exportSecrets: false`: password-type fields of the configuration form, names matching the secret pattern, replaced by the mask). On import, a masked value means "keep the value that is in HelloID", as in the userscript.

## Audit log

- One file per day, `<audit.dir>/YYYY-MM-DD.jsonl`, append only, never removed or rotated away.
- One line per tool call: time (ISO, UTC), MCP session ID, environment, tool name, arguments (secrets masked, and large file contents replaced by their size and SHA-256), result (`ok` / `refused` / `error`) and a short summary.
- For apply and delete: per changed item, the item as it was before and as it is after (read back from HelloID after the change), with secrets masked. This replaces backups before writes (the user makes daily exports separately).
- Never contains cookies, tokens or passwords.

## MCP practices

- Tool names `helloid_<verb>_<thing>`, snake_case. Clear descriptions that say what the tool does, what it changes, and which setting allows it.
- zod input schemas with descriptions per field; `outputSchema` + `structuredContent` for tools with structured results, plus a short text summary in `content`.
- Annotations on every tool: `readOnlyHint` (read, plan, evaluate preview), `destructiveHint` (apply, delete), `idempotentHint`, `openWorldHint: true` (HelloID is outside the server).
- Short answers: lists return the fields that matter with paging (`offset`, `limit`, default 100) and a total; details are fetched with a get tool.
- Errors as tool results (`isError: true`) with a message Claude can act on (for example "not logged in to 'training': call helloid_login"), never a crashed request.
- Logging to stderr only. Never log secrets.
- Graceful shutdown on Ctrl+C.
- Testable with the MCP Inspector (README explains how).

## Tools

All tools take `environment` (a name from the config) unless stated otherwise.

### Session and browser
- `helloid_list_environments`: the environments, their mode and flags (`allowEvaluate`, `allowDelete`, `allowRevokingRuleDelete`, `allowRevokingRulePublish`, `allowRetryActions`, `allowApproveBlocked`, `allowEnforce`, `allowDryRun`), and whether each is logged in (and until when the token is valid). No environment argument.
- `helloid_list_identity_providers`: the identity providers on an environment's sign-in page (name and path), `login.provider` from the config and whether the page has it. Read-only; needs no login.
- `helloid_login`: start the interactive login for an environment (see Chrome and login). Returns when logged in or timed out.
- `helloid_logout`: forget the in-memory session of an environment.
- `helloid_browser_show`, `helloid_browser_hide`, `helloid_browser_close`: as described above. No environment argument.

The CLI (`npm run cli -- <command>`) offers the same: `login <env>`, `providers <env>` (the names, the configured one marked `*`), `browser show|hide|close`, `status`. The CLI talks to the running server over the same HTTP endpoint with the bearer token from the config (it is an MCP client), so there is one process holding the sessions.

### Read (every mode)
Per section, list and get, with the data HelloID gives (secrets masked):
- target systems (list; get = the full configuration as the userscript's export collects it: configuration, PowerShell resources, permissions, agent selection, dependencies, systems depending on it). Both also give `entitlementTypes` per system (code, name and label), from `GET /service/rule-enforcement/api/entitlement-import/entitlement-types` (`{ "<systemId>": [codes] }`), read once per call; `null` when it cannot be read.
- source systems
- business rules (overview; get = the rule with conditions and entitlements, condition summary)
- entitlements (all, `/service/rules/api/entitlements`)
- notifications, notification systems, custom events
- toxic combinations
- schedule, reconciliation configuration, aggregation, person lifecycle, calculated layers, custom fields, excluded persons (the settings the userscript exports)
- persons (overview with search and paging; get = one person)
- granted entitlements (of one person, of one system, or all)
- evaluation runs, one evaluation report, the logging of a run
- `helloid_export_everything`: the same structure as the userscript's "Export everything" backup file, returned as a resource link or as structured content (choose what works with large data and say why in the README).

### Reports (every mode)
Combined reads for questions that would otherwise take many calls:
- `helloid_report_rules_without_entitlements`: rules whose configured entitlement count is 0.
- `helloid_report_rules_without_persons`: rules whose `personInRuleLastEvaluationCount` is 0.
- `helloid_report_rules_for_entitlement`: the rules linked to an entitlement (published and draft).
- `helloid_report_system_access`: for one target system, the accounts (granted entitlements of type Account on that system, per person) and **all** rules that grant an account (and, separately, account access and permissions) on that system, from `entitlements-overview`. For each person, list every account-granting rule of that system whose persons (from the last evaluation, `/evaluation/results/rule/{ruleId}/persons`, which gives display names) include that person's display name. Do not try to pick a single rule. Persons that match no account-granting rule are listed apart.
- `helloid_check_references`: references to things that do not exist (rule conditions or entitlements referring to missing source or target systems, notifications referring to missing systems or custom events, and so on, as the userscript's import notes find them). The source system ID `00000000-0000-0000-0000-000000000000` in rule conditions is intentional and is not reported.

### Evaluation (needs `allowEvaluate`)
- `helloid_evaluate_rule_persons`: the persons a rule would match, for a rule as stored or for a rule definition given in the call (unsaved). `POST /service/rule-evaluation/api/evaluation/evaluate/rule/persons?skip=&take=&calculateTotalRowCount=true` with the rule as JSON body; the answer is a server-sent event stream (`event: Data` / `data: {"pagedResult": {...}}`); parse it. Changes nothing. The output has `nextOffset` (null on the last page) for getting the full list. HelloID's `exceededTotalRowCountLimit` is passed on with an explanation: in this preview it is true whenever there are more persons than `take`, even on the last page, so it isn't an error.
- `helloid_start_evaluation`: start a full evaluation, `POST /service/rule-evaluation/api/evaluation/start?enforce=false` (no body; answers the run ID as a JSON string). Never `enforce=true`. Optionally wait for the run to finish (poll `evaluation/runs`) and return the report summary.

### Entitlement actions (every mode)
HelloID's Entitlements pages (Actions, History, Blocked), from a recording of them. Labels (confirmed by the user) are given next to HelloID's codes, e.g. `operation: 0, operationLabel: "Grant"`:

- operation: 0 Grant, 1 Revoke, 2 Update
- entitlement type: 1 Account, 2 Account Access, 3 Permission (codes in `types=` and the entitlement-types map; names `Account`, `AccountAccess`, `Permission` in rows and in `type=` of the blocked details)
- history result: 0 Error, 1 Success, 2 Skipped, 3 Canceled
- origins: no labels known; the numbers only

Inputs take a code or a label (case-insensitive). Tools:

- `helloid_list_entitlement_actions`: the pending (open) actions. `GET /service/rule-enforcement/api/actions/overview?take=&search=`. `systemId` is filtered by the server (HelloID's page has no such filter; then `take=999999`). Rows: action ID, person, entitlement (system with name, type, name, permission definition), operation, origins, created, initiated, waiting reasons.
- `helloid_list_action_history`: `GET /service/rule-enforcement/api/actions/history/overview?take=&search=&results=&operations=&types=&systems=` (arrays repeat the key). Rows as above plus run, rules, matching contracts, finished, result. HelloID counts at most 5000 rows (`exceededTotalRowCountLimit`). When HelloID answers rows that do not match a filter, the output has a warning (see Unknowns).
- `helloid_get_action_logging`: `GET /service/rule-enforcement/api/actions/history/{actionId}/logging?cachebust=` (`{ logMessages: [{ message, messageTimeUtc, level, scopeId, objectId }], moreDataAvailable }`).
- `helloid_list_blocked`: the blocked groups. `GET /service/rule-enforcement/api/enforcedstate/blocked/overview?take=&systems=<every target system>&types=1&types=2&types=3&operations=0&operations=1&operations=2`; the systems are every system of `GET /service/provisioning-api/api/target-systems` (no query, disabled ones too), as HelloID's page sends them. Rows: system, type, operation (with labels), `configuration` (the threshold text, e.g. "Blocking when at least 5"), `count`, `processing`.
- `helloid_get_blocked_details`: the actions of one group. `GET /service/rule-enforcement/api/enforcedstate/blocked/details?take=999999&system=&type=<name>&operation=<code>` (`{ pageData: [{ personDisplayName, entitlementName, permissionDefinitionDisplayName }] }`), paged by the server.

The pending actions and the history are read with `take = offset + limit` and cut (HelloID's pages send no `skip`); the blocked overview and details with `take=999999`.

### Health (every mode)
- `helloid_check_health`: `environment` is optional; without it, every environment in config.json. Environments that are not logged in (or expired) are listed as such, not checked, and are not an error. Per logged-in environment, each check on its own (a failing check is reported as `{ ok: false, error }` and the others still answer):
  - `blockedAny`: `GET /service/rule-enforcement/api/enforcedstate/blocked/any` (true/false)
  - `orphanedEntitlementsAny`: `GET /service/rules/api/entitlements/orphaned/any` (true/false)
  - `referenceCleanerActive`: `GET /service/maintenance/api/reference-cleaner/is-active` (true/false)
  - `snapshots`: `GET /service/provisioning-api/api/target-systems/snapshots/latest` (`{ "<systemId>": { status, succeeded, errorMessage, startedOn, completedOn, ... } }`) with `.../snapshots/latest/successful-times` (`{ "<systemId>": "<time>" }`) and the system names
  - `latestEvaluationRun`: `GET /service/rule-evaluation/api/evaluation/runs?take=1` (time, state, enforce, stageFailed)
  - `failedActions`: `GET .../actions/history/overview?take=1&results=0`, its `totalRowCount`
  - `problems`: a short list: blocked actions, orphaned entitlements, the reference cleaner active, failed snapshots, a failed stage in the latest run, failed actions, and every check that failed.

### Retry, approve, enforce (plan and apply; mode `write` + the flag, for both steps)
Like the delete tools: the plan is stored (PlanStore: same MCP session, 30 minutes, applied once) with fingerprints; the apply runs inside the environment's lock, reads HelloID again and refuses when anything changed ("plan again"); its audit line has the before and after.

- `helloid_plan_retry_action` / `helloid_apply_retry_action` (`allowRetryActions`): the plan takes `actionId` and an optional `search` (HelloID's search of the history, e.g. the person's name). HelloID has no request for one action, so the history is read with `take=999999&results=0` (and `search`) and the action found by ID; when it is not among the Error results, the history is read without a result filter to say why. Only result 0 (Error) can be retried; others are refused with their result. The plan shows the action (person, entitlement, system, operation, result) and its newest log messages (at most 10). Apply re-reads it (still in the history with result Error, same fingerprint), then `POST /service/rule-enforcement/api/actions/history/retry/{systemId}/{actionId}` with body `{}` (HelloID answers an empty 200). The systemId is the entitlement's `systemIdentifier`. Audit: the action before, and as read back from the history after.
- `helloid_plan_approve_blocked` / `helloid_apply_approve_blocked` (`allowApproveBlocked`): approving is per group (system + type + operation): HelloID cannot approve per person. The plan takes `systemId`, `type`, `operation`, reads the group from the overview and all its details, and returns the count, the threshold, the list (paged in the output, with the total), a fingerprint of the details, and the plan ID. A group with `processing` true is refused. Apply needs `confirmCount` equal to the planned count, re-reads the group, refuses when it is gone, `processing`, or its count or details changed, then `POST /service/rule-enforcement/api/enforcedstate/process-blocked/{systemId}/{Type}/{operation}` with body `{}` (Type is the name, e.g. `Permission`; empty 200). Audit: the group and every approved person/entitlement pair before; the group as read back after.
- `helloid_plan_enforcement` / `helloid_apply_enforcement` (`allowEnforce`; the plan also `allowEvaluate`): the plan refuses while a run is in progress (a run among the latest 30 without `endDateUtc`), starts an evaluation with `enforce=false` and waits for it (the start and wait of `helloid_start_evaluation`, up to 30 minutes), and returns its report summary (actions per system, type and operation, with labels) as what the enforcement is expected to do. Its fingerprint is the ID of the newest run (the plan's evaluation). Apply needs `confirmEnvironment` equal to the environment's name, refuses while a run is in progress or when another run started since the plan, then `POST /service/rule-evaluation/api/evaluation/start?enforce=true` (no body). Without `wait` (default) it returns the run ID (follow it with `helloid_list_evaluation_runs`, `helloid_get_evaluation_report`); with `wait` it polls the runs (as the evaluation does) for up to 4 hours, outside the lock, and returns the run and its report summary. Audit: the plan's expected summary before; the run (and its report when waited for) after.

Annotations: the plan tools `readOnlyHint: true`; the apply tools `destructiveHint: true`, `readOnlyHint: false`.

### Plan and apply (plan: mode `plan` or `write`; apply: mode `write`)
- `helloid_plan_import`: takes one or more files in the userscript's export formats (single exports, partial files, the full backup) as JSON, plus `answers` for the choices the userscript asks in dialogs. It works as the userscript's "Overwrite all" (the userscript's other route, "One by one", is its interactive dialog per file and has no separate behaviour to port). Returns the same overview as the userscript's Overwrite all overview (per item: create / overwrite / same / note / refused, with the reasons and what is linked after it is made), the plan ID, and the list of open choices with their options and defaults if `answers` is incomplete (then no plan ID: Claude asks the user or passes the defaults explicitly).
- `helloid_apply_plan`: runs a plan (see Safety), in the order the userscript uses, and returns per item what was done.

The planning and applying logic is ported from the userscript (`HelloID-UX-improvements.user.js`): `PLANNERS`, `singlePlanner`, `itemsPlanner`, `settingPlanner`, `ITEM_IMPORTS`, `SETTING_IMPORTS`, `importData`, `importSourceSystemData`, `importNotificationSystemData`, `importNotificationsData`, `mergeNotificationFiles`, `makeAuto`, pending items, needs/provides, dependency order of target systems, and everything they call. Dialogs become `answers`; nothing is interactive. The behaviour (what is created, overwritten, refused, the notes) must match the userscript. Backups in the userscript's planners are not ported (the user makes daily exports).

### Partial edits and copies (plan: `helloid_plan_edit` mode `plan`; `helloid_plan_copy` mode `read` on the source and `plan` on the target; apply: `helloid_apply_plan`, mode `write`)

Both make an import plan (kind `import`, PlanStore, fingerprints of what the entries touch, 30 minutes, the MCP session, applied once by `helloid_apply_plan` in the environment the plan is for), with the planners of `helloid_plan_import` (`planFilesInto` in `tools/import.ts`). Code: `src/changes/` (paths, edit, diff, kinds, compare) and `src/tools/edit.ts`.

- `helloid_plan_edit`: `kind`, `id` or `name`, `changes`, `answers`. The item is exported with the export code (`ItemReader` in `changes/kinds.ts`: the same files as the `helloid_get_*` tools; for a notification the notification itself, wrapped as a notifications file for the import), the changes are applied to that export, and the result is planned as the import of that one file. Masked secrets are restored by the planners' existing logic. A business rule with a draft is edited as its draft (its condition and entitlements), because the import saves a draft and compares with the draft.
  - Paths: keys with dots, list items `[n]` or `[key=value]` (value as text, or a "JSON string"), `["key.with.dots"]`. Every step must exist; only the last key of a set may be new (a new property: flagged in the plan with a warning). A source system's `system.scriptConfiguration` and `system.scriptConfigurationForm` (JSON in a text) are changed as JSON and written back as text.
  - `set` (`replaceList: true` needed when it replaces a list or a value with lists in it), `unset` (not required fields, identity, list items or values with lists), `lists` (`add`, `remove`, `change`; `match` = every key given has that value, `$value` for lists of texts; `add` makes the match from the new item's match keys when left out and refuses an existing one; `remove`/`change` refuse no match and several). Order: lists, set, unset.
  - Refused: paths outside the parts the import reads (per kind), identity fields (the item's own ID and type), the IDs HelloID gives list items (set, changed, or given in an added item: checked again on the whole result).
  - The plan lists every change with old -> new (previews, secrets masked by key name; texts with line counts and a unified diff, cut at 60 lines), with `warnings` per change (the new-property warning, and the DryRun check of the scripts the change sets or changes, see "Target system scripts"), plus the planner's entries and overview.
  - The plan keeps the changed export (`ImportPlanData.edited`), so the dry-run tools and the field mapping preview can run a planned script or mapping (`planId`) before it is applied.

| Kind | Parts the import reads | Lists and their match keys (ID HelloID gives: never changed) |
|---|---|---|
| targetSystem | configuration, resources, agents, notifications, rules | `configuration.mappingConfiguration.fields` name / identifier (ID identifier); `...fields[].mappingActions` mappingActionId (ID); `...uniquenessConfiguration.selectedUniqueFields` $value; `configuration.permissions` displayName / identification (ID identification); `configuration.dependOnSystems` systemId / displayName; `configuration.scriptConfigurationForm.fields` key; `resources` displayName / resourceDefinitionId (ID); `notifications` identifier (ID) / name; `notifications[].dataReferences` systemId / key; `rules` ruleId / ruleName; `rules[].entitlements` entitlementId; `agents.selected` type + value |
| sourceSystem | system, agents | `system.scriptConfigurationForm` key; `agents.selected` type + value |
| notificationSystem | system, agents | `system.notificationScripts` displayName / scriptId (ID); `system.notificationTemplates` displayName / templateId (ID); `...notificationTemplates[].fields` key; `system.systemConfiguration.fields` key; `agents.selected` type + value |
| notification | every key except the names the export adds | `dataReferences` systemId / key |
| customEvent | customEvent, systemName | (others: see below) |
| businessRule | rule | `rule.entitlements` entitlementId / displayName; `rule.categories` $value; `rule.condition.titleCondition.titles` externalId / name; `...departments` externalId / displayName; `rule.condition.personConditions`, `contractConditions` field + mode + invert + values |
| toxicCombination | policy | `policy.inputObjectIds`, `policy.outputObjectIds` $value |
| schedule | schedule | `schedule.tasks` type + systemId |
| sourceConfiguration | calculatedLayers, customFields | `customFields` name (ID customFieldIdentifier) |
| aggregationConfiguration | configuration | — |
| personLifecycle | configuration | `configuration` eventType |
| excludedPersons | persons | `persons` personId / externalId |
| reconciliationConfiguration | schedule, systemConfiguration | `systemConfiguration` systemId |

Any other list: items are found by the keys given in `match`; an added item's match is made from its name, displayName or key.

- `helloid_plan_copy`: `sourceEnvironment`, `targetEnvironment`, `items: [{kind, id | name}]`, `answers`. The exports are read in the source (secrets masked) and planned into the target, all inside the server. A target system's export has its notifications and rule links, so they come along. Existing items in the target keep their secrets; new items get empty ones (the plan says so). The tool has no `environment` argument; its audit line has the environments in its arguments.
- New IDs (`helloid_apply_plan`): every entry gets `createdId` (the first item it made) and `created` (`[{kind, id, name}]`), on its overview lines and in the summary. The planners report what they make through `PlannerEnv.onCreated` (not in the userscript). Where the ID comes from: target system, source system, notification system: HelloID's answer to the create request (a string); business rule (`PUT rules/add`), toxic policy (`PUT toxic-combinations`), custom event (`POST custom-events`): HelloID's answer (a string, or an object with the ID); notifications (also a new target system's notifications) and schedules: the ID the server makes and sends (as the userscript), which HelloID keeps; settings pages make nothing. No item is read back by name for this.

### Business rules: publish and clone (mode `write`)

From a recording of HelloID's Business rules page (publishing three times):
- `helloid_plan_publish_rule` (`ruleId`, `removedEntitlements?`): `GET /service/rules/api/rules/{id}` (refused without `hasDraft`; needs its `changeId`), then `GET /service/rule-evaluation/api/evaluation/evaluate/rule/{ruleId}/summary/{changeId}` → `{ personCounts: {current, added, removed}, entitlementCounts: {...}, addedEntitlements: [names] | null, removedEntitlements: [names] | null }`. When `entitlementCounts.removed > 0` or `personCounts.removed > 0`, `removedEntitlements` is required (`revoke` needs `allowRevokingRulePublish`); otherwise giving it is refused. Fingerprint: the changeId and the summary.
- `helloid_apply_publish_rule` (`planId`, `confirmName`): re-reads both (refuses on change, or a name that is not exactly the rule's), then `PUT /service/rules/api/rules/publish/{ruleId}` with `{ addedEntitlements, removedEntitlements (as the summary gives them), changeId, previousPersonsInScopeCount: persons.current, personsAddedToScopeCount: added, personsRemovedFromScopeCount: removed, currentPersonsInScopeCount: current + added - removed, previousSelectedEntitlementsCount: entitlements.current, addedEntitlementsCount, removedEntitlementsCount, currentSelectedEntitlementsCount: current + added - removed, unmanageRemovedEntitlements }` (empty 200): `unmanageRemovedEntitlements` is true for "unmanaged", false for "revoke" and when no choice is needed (as recorded). Then `GET /service/rules/api/entitlements/orphaned/any`, reported. Audit: the rule before and after.
- `helloid_clone_business_rule` (`ruleId`): `PUT /service/rules/api/rules/copy/{id}` with `{}` (the userscript's "Clone rule"; answers the new ID as a string or an object with ruleId/id), then reads the new rule for its name. Not destructive; audited (before null).

### Compare and search (every mode; read access to each environment)

- `helloid_compare`: `left`/`right` `{environment, kind, id | name}`, or `kind` + `name` + `environments?` (default every logged-in one). The exports are normalized: the kind's identity fields, the export header, `lastChanged`, `lastChange`, `lastRunTime`, `changeId`, `tenantUrl`, `verifiedDomains` and null values are left out (as the planners' `sameNotification` does), and every GUID (and `_<ID without dashes>`) becomes the name of what it points at (from the export and the environment's systems) or `<id>`. Lists are paired by name, displayName, key, eventType, externalId, ruleName or field when unique, else identical items are paired and the rest is "only left/right". Output: differences per path (edit paths), texts as unified diffs, paged; across environments the groups of identical environments (largest first = reference) with the differences from the reference, `missing` and `unavailable` environments.
- `helloid_search_configuration`: `query`, `regex`, `caseSensitive`, `environments?`, `kinds?`, paging. Every item of every kind asked is exported (the export code, memoized reads per environment; environments four at a time, items six at a time) and every value searched, except the export header, keys whose name says they are a secret, and masked values. Multi-line texts per line with the line number and one line of context.

### Target system scripts (check: every mode; previews: mode `read`; dry runs: `allowDryRun`)

The rule (Tools4ever/HelloID best practice, stated in the descriptions of the dry-run tools and of `helloid_plan_edit`): every writing or deleting action in a target system script must be inside a dry-run check (e.g. `if (-not($actionContext.DryRun -eq $true)) { ... }`), and a script must never disable or override DryRun itself. A HelloID dry run runs the REAL script against the REAL target system with `$actionContext.DryRun = $true`; only the script's own guard keeps it from changing things.

**The DryRun check** (`src/changes/dryrun-check.ts`, pure): `checkDryRun(script, { variant })` → `{ findings: [{ line, kind, text, detail }], limitations }`.
- Tokens: strings (single, double with `$(...)`, `''` / `""` / backtick escapes, smart quotes), here-strings (`@' '@`, `@" "@`), line and block comments, backtick line continuations, variables, members, type literals, splats. Braces in strings, here-strings and comments do not count.
- `empty-script`: null, empty or only whitespace.
- `dryrun-override`: an assignment to `$actionContext.DryRun` (any case, also `['DryRun']`, `.PSObject.Properties['DryRun'].Value`), replacing `$actionContext`, `Set-Variable` / `New-Variable` / `Remove-Variable` / `Clear-Variable` of it or of a dry-run variable, `Add-Member ... DryRun` on `$actionContext`, `[ref]` to it, `set_DryRun(...)`, and an assignment to a variable that stands for it: an alias (`$x = $actionContext.DryRun`, then assigned anything else), `$dryRun` / `$isDryRun`, or a variable whose name has "dryrun" and is used in an if condition (e.g. `$dryRun = $false` later used in the guard). Other names with "dryrun" (`$dryRunMessage`) and hashtable keys are not changes.
- `unguarded-write`: outside a dry-run check, `Invoke-RestMethod` / `Invoke-WebRequest` / `irm` / `iwr` / `Invoke-MgGraphRequest` with `-Method` POST, PUT, PATCH, DELETE or MERGE (`-Method:x`, a variable resolved through its last text assignment; a method that cannot be resolved counts as a possible write), also through splatting (`@splat`: the nearest assignment of the hashtable before the call, and later `$splat.Method =`, `$splat['Method'] =`, `$splat.Add('Method', ...)`); cmdlets with a writing verb (New, Set, Remove, Add, Enable, Disable, Clear, Rename, Move, Grant, Revoke, Update, Reset, Unlock, Send, Copy, Install, Uninstall, Register, Unregister, Publish, Lock) except New-Object, New-TimeSpan, New-Guid, Set-StrictMode, Set/New/Clear/Remove-Variable, Add-Member, Add-Type, Set-Location, the PSSession / CimSession cmdlets, Remove-Module, Clear-Host; the .NET methods ExecuteNonQuery, CommitChanges, SetInfo, DeleteTree, HttpClient Post/Put/Patch/Delete/SendAsync, and the write methods of `[System.IO.File]` / `[System.IO.Directory]`.
- Not writes: a writing-verb cmdlet called with `-WhatIf`, `-WhatIf:$true` or `-WhatIf:$actionContext.DryRun` (v1: `-WhatIf:$dryRun`) (the Exchange Online pattern `else { Set-Mailbox @splat -WhatIf }`); an OAuth token request: a POST whose Uri (literal, or the variable or hashtable entry it comes from, followed through simple assignments such as `$authUri = $baseUri + "$TenantId/oauth2/token"`) matches `/oauth2\/(v2\.0\/)?token|\/token(\?|"|'|$)/i`, or whose Body (inline hashtable or its variable / hashtable entry) has `grant_type` or `client_assertion`. Only these signals; a POST to such a Uri that writes would be missed.
- Guards: a block whose `if` / `elseif` condition is true only when it is not a dry run (`-not(D -eq $true)`, `-not D`, `!D`, `D -eq $false`, `D -ne $true`, either side, `-and` with anything; D = `$actionContext.DryRun` or an alias, v1: `$dryRun`), and the `else` (or a later `elseif`) of a condition that is true whenever it is a dry run (`D`, `D -eq $true`, `D -or x`). Nested blocks inside a guard are guarded.
- Functions defined in the script: a write inside a function (not guarded inside it) is guarded when every call of the function is guarded, or is inside a function whose calls all are (transitively, greatest fixpoint); a function that is never called is not checked. The finding names the unguarded call lines.
- Variant: `v1` for `powershell-onpremise` (guard `$dryRun`), `v2` otherwise.
- `limitations`: a static check; misses dynamic code (Invoke-Expression, `& $cmd`, dot-sourcing, modules), writes inside double-quoted strings, other .NET methods, writing cmdlets without a writing verb (Invoke-Sqlcmd, Start-Process, Out-File, Export-Csv); flags writes guarded otherwise (an early `return`/`exit` when DryRun is true, a switch, a guard variable that is not exactly the value, -WhatIf through splatting), REST calls whose method it cannot resolve (e.g. a helper function called with -Method GET outside the guard), harmless writing-verb cmdlets. The advice: restructure into the standard guard pattern.
- `targetScripts(export)`: the scripts of a target system export: `configuration.scripts.*`, every `configuration.permissions[]` key ending in "script" (with `unused` per `useSeparateScriptForEachAction` / `useScriptToRetrievePermissions`), every `resources[]` key ending in "script", and `configuration.mappingConfiguration.uniquenessConfiguration.script`; paths in helloid_plan_edit's format.

**In plans** (warnings only, never a refusal): `helloid_plan_edit` checks the scripts of a target system that differ from the export after the changes, and puts the findings in the `warnings` of the change whose path holds the script (the most specific one; else in the notes), with the rule and the dry-run tools; `helloid_plan_import` and `helloid_plan_copy` check, per planned PowerShell target system (todo or note), the scripts of the file that differ from the system's in the target (found by ID, else name; every script for a new one) and put them in the entry's `warnings` (a new field of the entries, `[]` otherwise) and a section of the overview.

**Tools** (all gateway paths in `DRYRUN_PATHS`; connector paths start with `/connector/<templateIdentifier>/api`, see Unknowns):
- `helloid_check_scripts` (no `environment`; `environments?` default every logged-in one, `systemId?`): reads `GET .../target-systems?showReferenceSystems=true`, and per PowerShell system its configuration (`/connector/powershell-target/api/configuration/{id}`) and resources, and lists per environment, system and script the findings (only scripts with findings; `unused`), the empty script slots as `notSet` (not a problem and not counted: the empty-script refusal is only for the dry runs), the rule and the limitations. Never returns configuration values.
- `helloid_list_dryrun_persons`: `GET /service/provisioning-integration/api/vault/latest/selection-persons?skip=&take=&search=` → `{ pageData: [{ personId, displayName }], totalRowCount }`.
- `helloid_preview_field_mapping` (mode `read`, no flag: no script runs): the saved mapping from `GET <api>/mapping/{systemId}?cachebust=&usedInNotificationOption=true&storedInAccountDataOption=true&noOption=true` (`{ fields, fieldsNotInFilter }`), or `fields`, or a plan's `configuration.mappingConfiguration.fields`, then `changes` (helloid_plan_edit's format and the target system's list specs); `POST <api>/mapping/{systemId}/preview` with `{ personId, fields, action }`, each field as the editor sends it: `{ type, mappingActions, configuredForActions (the codes of its actions, in order of appearance), identifier, name, description, useInNotificationsForActions, storeInAccountDataForActions (the labels, "Create, Update", in code order) }`; a field or action without an ID gets a random one. Answer `{ <identifier>: { field, value, hasError, error, ... } }` (only the fields configured for the action). Output per field: name, value, hasError, error; `notForAction`. Values are returned, never audited.
- Account actions (entitlementAction, and `action` of the mapping preview; confirmed by the user): 1 Create, 2 Enable, 3 Update, 4 Disable, 5 Delete. powerShellScriptContext: 1 account scripts, 2 permission scripts, 16 import permissions, 128 uniqueness.
- The dry runs (`allowDryRun`; annotations `readOnlyHint: false`, `destructiveHint: false`): each reads the system (`GET .../target-systems`; only `powershell-target` and `powershell-onpremise`) and its configuration (`GET /connector/powershell-target/api/configuration/{id}`: the real values; the export masks them from the same answer), takes the script (saved; `script`; or `planId` + optional `scriptPath`: a pending `helloid_plan_edit` plan of this system, same MCP session, not applied), runs the DryRun check on it and REFUSES (`RefusedError`, the findings with line numbers, the rule, the advice to restructure) before anything else is read or sent. Then `GET /service/rule-enforcement/api/entitlements/{systemId}/{personId}/actions/data/preview?cachebust=` → `{ person, accountReference, manager, managerAccountReference }`, sent as they are (`accountReference` from the call overrides; when it is null the output says so, and whether the person has account data of the system).
  - `helloid_dryrun_account_action`: `POST <api>/preview/entitlement-action` `{ script, scriptConfiguration, executeOnPremises, systemId, operation: 0, entitlementAction: <1-5>, person, accountReference, manager, managerAccountReference, powerShellScriptContext: 1 }`; script `configuration.scripts.account<Action>`.
  - `helloid_dryrun_permission_action`: the permission by entitlementId, else display name (case-insensitive), in the permission sets (`permissionDefinition` narrows to one) from `GET <api>/configuration/{systemId}/permissions/{identification}?skip=0&take=999999` (`{ pageData: [{ displayName, entitlementId, reference }] }`); several matches are refused. Script: the set's grant/revoke/update script for Grant/Revoke/Update, or its `permissionActionScript` when `useSeparateScriptForEachAction` is false. `POST <api>/preview/entitlement-action` `{ script, scriptConfiguration, executeOnPremises, permissionDefinitionIdentifier, permission: { displayName, entitlementId, reference }, systemId, operation: 0, hasSubPermissions, entitlementAction: 0, person, accountReference, manager, managerAccountReference, powerShellScriptContext: 2 }`.
  - `helloid_dryrun_permission_import`: the set's `permissionImportScript` (`permissionDefinition` needed when several sets have one); `POST <api>/preview/permission-import` `{ script, systemId, executeOnPremises }` (no configuration, no person: as recorded); `resultData: [{ displayName, permissionReference }]` in pages, with `resultDataCount` and `dataLimited` (HelloID returns part of a long list).
  - `helloid_dryrun_uniqueness`: the saved script from `GET <api>/mapping/{systemId}/uniqueness` (`{ script, mappingEntitlementActions, selectedUniqueFields }`); `POST <api>/preview/uniqueness-check` `{ script, selectedPerson: { personId, displayName }, person, accountReference, manager, managerAccountReference, entitlementAction: "Create", systemId, powerShellScriptContext: 128 }` (no configuration: as recorded); `resultData: { Success, NonUniqueFields, Iteration }`.
  - Answer of every dry run: `{ resultData, resultDataCount, dataLimited, logMessages: [{ messageTimeUtc, message, level }], scriptExecutionSuccessful, errorMessage }`. Output: success, errorMessage, resultData (keys with a secret name masked), at most 100 log messages of at most 2000 characters, dataLimited, the account reference sent and its source, notes. Every secret value of the configuration (what the export masks) is replaced by `***` in all of it, and in HelloID's error messages.
  - Audit: the arguments (a given `script` as its size and SHA-256) and a summary with the system, the script, the person's ID and name, the action and the result; never the configuration, the person data or what the script returned.
- `GET <api>/metadata/context-metadata?systemId=&powerShellScriptContext=` (descriptions of `$actionContext` etc.) was recorded but is not used.

### Delete (mode `write` + `allowDelete`)
- `helloid_plan_delete`: `kind` + `id`. Reads the item and the checks HelloID itself makes before deleting, and returns what would be deleted, what still uses it, warnings, and a plan ID. For a business rule, `ruleEntitlements` is required when the rule is published: `unmanaged` or `revoke` (no default); a draft-only rule needs none.
- `helloid_apply_delete`: plan ID + `confirmName` (see Safety).

Kinds, requests and checks (from the recording of HelloID's own pages):

| Kind | Delete request | Checks before (show in the plan) |
|---|---|---|
| target system | `DELETE /service/provisioning-api/api/target-systems/{id}` | `GET /service/provisioning-api/api/target-systems/get-systems-depending-on?systemId={id}`; rules granting on it (`entitlements-overview`); agent selection summary |
| source system | `DELETE /service/provisioning-api/api/source-systems/{id}` | `GET /service/provisioning-integration/api/blockedpersons/{id}/any`; `GET /service/provisioning-pipeline/api/snapshot/status?systemId={id}` (refuse while `isBusy`) |
| business rule | `DELETE /service/rules/api/rules/{id}/{revoke}`: `true` = revoke entitlements, `false` = mark them unmanaged; a draft-only rule: `true` (as HelloID's page sends) | persons in the rule (last evaluation), configured entitlements, published / draft |
| notification | `DELETE /service/notifications/api/notifications/{id}` | — |
| notification system | `DELETE /service/notifications/api/notification/systems/{id}` | notifications that use it; built-in systems are refused |
| custom event | `DELETE /service/notifications/api/custom-events/{id}` | `GET /service/notifications/api/custom-events/{id}/used` |
| toxic combination | `DELETE /service/rules/api/toxic-combinations/{id}` | — |

No other kinds can be deleted.

## Testing

- Unit and integration tests with `node:test` against `test/fake-helloid.ts`, which plays the portal (`/server/v2/security/token`, `/server/v2/bootstrap/provisioning`) and the gateway, with synthetic fixtures in HelloID's response shapes. Fixtures are made up: no data from the recordings in `gitignored/` is committed (the recordings may be read locally to learn the shapes).
- Tests for the script tools: the DryRun check with made-up PowerShell (a Tools4ever-style script with guarded splatted calls in functions, unguarded writes, overrides, else-branch and nested guards, strings with braces, here-strings, comments, continuations, functions), `helloid_check_scripts`, every dry-run tool (flag, any mode and readOnly, the exact request bodies with the real configuration values, never in the output or the audit, the refusal on findings, a given script, a planned script, person paging), the field mapping preview (saved, given, changed, planned), and the warnings in edit and import plans.
- Tests for: the entitlement action tools (labels, paging, filters), the health check (a failing check, a logged-out environment), and retry / approve / enforcement (flags, mode, readOnly, the exact requests, confirmCount / confirmEnvironment, changed since the plan, processing, not Error, another session, applied twice, audit); config validation; caller auth (no token, wrong token, wrong Origin); token renewal and 401 retry; expired session; mode and flag refusals; plan fingerprint mismatch; plan used twice; lock; audit lines (and that no secret or token is in them); secret masking; every read tool; every report; evaluation (including SSE parsing); every planner against the userscript's behaviour; every delete kind with its checks and refusals.
- The browser part is tested with an injectable browser interface (a fake) so tests do not start Chrome.
- `npm test` must pass. `npm run build` must pass with no TypeScript errors.
- Live tests on the user's training environment are done at the end, by the main session, after the user has logged in.

## Unknowns (find out, do not guess)

- The row format of `/evaluation/results/rule/{ruleId}/persons` when it has persons: the recordings show `{"pageData": ["<display name>", ...], "totalRowCount": n}` (strings). Confirm on training.
- The history filters for operation, entitlement type and system were not recorded (only `search` and `results` were). They are sent with the parameter names of the blocked overview: `operations=<code>`, `types=<code 1-3>`, `systems=<systemId>`, each repeated. To be verified live; `helloid_list_action_history` warns when HelloID answers rows that do not match a filter.
- The history result labels 2 Skipped and 3 Canceled are as given by the user (the filter order on HelloID's page); 0 Error is confirmed by data.
- The origin codes of the actions, the snapshot `status` codes and the log `level` codes have no known labels (passed on as numbers).
- Whether `skip` works on the action lists: HelloID's pages send none, so the server reads `take = offset + limit` and cuts.
- Whether an active reference cleaner is a problem or only information: it is listed under problems for now.
- Not recorded: `PUT /service/rules/api/rules/copy/{id}` (from the userscript, which reads the answer as a string or an object with ruleId/id); the create requests' answers used for `createdId` are the planners' (the userscript's). HelloID keeping the identifier the server sends for a new notification, and the scheduleId for a new schedule, is assumed as the userscript does.
- The real GET of a published rule with a draft seemed to have the draft's entitlements also at the top level; the fixtures keep the draft apart. Edit uses the draft when there is one, so both work; the export (and copy) gives the rule as HelloID does.
- Adding a notification template or script by `helloid_plan_edit` sends it without an ID (the planner keeps the file's IDs; HelloID may need one): not verified.
- Script tools (from two recordings of HelloID's script editors on one PowerShell v2 system):
  - The connector prefix of the dry runs is derived from the system's type, `/connector/<templateIdentifier>/api`; only `powershell-target` was recorded. For `powershell-onpremise` (v1) that gives `/connector/powershell-onpremise/api`, although its configuration and mapping are read and written under `/connector/powershell-target/api` (userscript): to be verified, as is whether HelloID offers these dry runs for v1 at all (v1 scripts guard on `$dryRun`; the check uses that for v1).
  - Permission dry runs were all recorded with `entitlementAction: 0` and `operation: 0`, the chosen script deciding what runs; sent so for Grant, Revoke and Update. For a set with one script for every action (`permissionActionScript`, sub-permissions) the action does not choose a script; whether the script then needs another operation is not known.
  - Account dry runs were recorded for Create, Enable and Update, all with `operation: 0`; Disable (4) and Delete (5) are sent with `operation: 0` too: not recorded.
  - `accountReference`, `manager` and `managerAccountReference` were null in every recording; they are taken from the person preview (which has these keys). Whether HelloID fills `accountReference` there for a person with an account is not known; granted entitlements do not have it. The output says when it is null.
  - The import permissions and uniqueness dry runs were recorded without `scriptConfiguration`, and are sent so.
  - The field mapping preview's `configuredForActions`, `useInNotificationsForActions` and `storeInAccountDataForActions` are derived as the recording shows them; new fields and actions get a random identifier for the preview (what the editor does for an unsaved field is not recorded).
  - The resources of a PowerShell system (`GET /connector/powershell-target/api/resources/{id}`) are read as a list or as `{ resources: [...] }`; their script keys are taken as every key ending in "script".
- Anything else not in this document or in the userscript: stop and report it instead of guessing an endpoint.
