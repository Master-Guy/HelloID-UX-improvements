# Last used / Last requested columns for HelloID Service Automation admin tables

Research status: the Claude in Chrome tools were NOT available in this session (ToolSearch found no mcp__claude-in-chrome__* tools), so no network calls or DOM were observed. The apidocs site (Stoplight SPA) returned 404/empty to the fetcher. The internal gateway endpoints for the activity and request history pages are therefore UNVERIFIED. Everything under "Inferences" is a hypothesis to confirm with the capture list in the Gaps sections.

## 1. Which endpoints do the Delegated Form activity page and Request History page call?

### Takeaway
No public documentation of the internal (browser) endpoints was found. HelloID docs only describe the pages in the UI (Delegation > Activities and Self Service > Request History). The userscript's existing pattern (Bearer-authorized calls to a "gateway" host under /service/<module>/api/...) suggests the admin pages call similar paths, but the exact paths must be captured.

### Cited Findings
- The delegated form activity page is Delegation > Activities (admin). It has a search bar (by delegated form name, or user first/last/user name/email), "Submission" and "Task state" filter buttons, and a "View details" row action. No columns, statuses, date range or retention are documented there. — [HelloID docs: delegated form activities](https://docs.helloid.com/en/service-automation/delegated-forms/delegated-form-activities/view-powershell-data-source-logs-for-a-delegated-form-submission.html)
- Each activity entry shows start date and time, the submitting user, the name of the delegated form used, whether the form was actually submitted, and the current status of the requested action. Details show form data, data sources used, task, audit logging. — [Tools4ever blog: Testing and Logging](https://www.tools4ever.com/blog/2024/service-automation-testing-and-logging/)
- Product requests: Admin dashboard > Self Service > Request History (a separate Recertification > Request history exists). Opening a request shows a Task Execution tab (View Log, Mark as succeeded, Retry) and log tabs Audit Logging, Task Logging, Notifications, Form data. Docs list no columns, filters or date range. — [HelloID docs: product action run history](https://docs.helloid.com/en/service-automation/products/product-actions/view-product-action-run-history.html)
- Viewing needs the "Self Service > Request History overview" right (depends on Admin Dashboard overview right). — [Rights reference (via search result summary)](https://docs.helloid.com/en/identity---authentication/roles---rights/rights/rights-reference.html)
- Public API v1 (API key/secret, "Basic" auth) exists for delegated forms (list with search/take, single by GUID) and for products (GET products; POST /api/v1/selfservice/products/request to request a product). No public endpoint listing form submissions or request history was found (search found none). — [PSHelloID Forms.psm1](https://www.powershellgallery.com/packages/PSHelloID/0.7/Content/Forms.psm1), [HelloID feedback: product API](https://helloid.canny.io/service-automation/p/choice-to-run-tasks-when-settingremoving-product-ownership-via-api), [docs: GET products](https://docs.helloid.com/hc/en-us/articles/115003027353-GET-Get-products)
- Existing userscript patterns: it captures the Authorization header and origin of the first request to a host matching /gateway/ (variable `gateway`), then calls `fetchFromGateway(path)` with `cache: 'no-store'`. Paths already used all look like `/service/<module>/api/...` with `?skip=0&take=<n>` paging (e.g. `/service/notifications/api/notifications?skip=0&take=...`). Grids are intercepted by URL pattern in an `INTERCEPTS` list and fetched with take = fetchAllTake (999999), with caching (minutes setting). — local file d:\Public\HelloID-UX-improvements\HelloID-UX-improvements.user.js (read-only)
- HelloID public API docs say there is no enforced rate limit, but advise avoiding excessive calls. — [Performance limits (Service Automation)](https://docs.helloid.com/en/service-automation/performance-limits--service-automation-.html)

### Inferences
- Likely path shape (HYPOTHESIS, unverified): `/service/<delegatedforms-or-servicedesk-module>/api/...activities...` and `/service/<selfservice-module>/api/...requests...`, a paged list with skip/take, either GET with query string or POST with a JSON body (the userscript INTERCEPTS already supports a `body` mode for POST grids, which Provisioning grids use).
- The userscript can reuse the already captured gateway headers, so no API key/secret is needed (consistent with the memory rule that HelloID has no API-key route for the admin UI). The public API v1 (key/secret) is not a route for a userscript.
- The activity list row probably carries form name and/or form GUID, a start timestamp, and a status; the request history row probably carries product name/GUID, requester, a timestamp, and a status. Whether GUIDs (not only names) are in the rows decides how robust the join is.

### Gaps
- Exact URLs, methods, query/body parameters (skip, take, sort, filter, date range), and response field names for both pages. Not documented publicly; browser not reachable.
- Whether the server supports sorting by date descending and a "group by form/product" or distinct query (unknown).
- Whether the activity page limits the date range by default (e.g. last N days) in its request.

What the user must capture (Chrome DevTools > Network, filter Fetch/XHR, reload each page; "Copy as fetch" then redact):
- /admin/delegatedforms/activity/: the request that fills the grid. Record: full URL (path + query), method, request headers EXCLUDING cookies and the Authorization value (keep header NAMES), request body if POST, and the first 2-3 rows of the JSON response (redact names if sensitive). Also a screenshot of the filter buttons.
- Same again after (a) clicking the Date column header to sort (to see sort parameters), (b) scrolling/paging to page 2, (c) applying the Submission and Task state filters and any date filter.
- /admin/selfservice/requesthistory/request/: same set (URL, method, headers by name, body, 2-3 response rows, sort/paging/filter behaviour, date range controls if any).
- /admin/delegatedforms/ and /admin/selfservice/products/: the request that fills each grid (to see the GUID field name for form/product, and whether the list response already includes any "last run" style field).
- The total row count of each response versus the number the page shows, and the oldest timestamp present (to detect retention).
- DOM: outerHTML of one grid row and one header cell of each of the two tables (is it ag-grid or a plain table; column definitions via the grid API).

## 2. Computing the max timestamp per form/product, pitfalls, caching

### Takeaway
Preferred design: one aggregated full fetch of the activity list and the request history list (sorted newest first if supported), reduce client-side to a Map(key -> max timestamp), then render the column from the Map. Per-item calls are not advisable unless the list endpoint supports a filter by form/product AND take=1 sort desc, and even then N calls for N items is worse than one big fetch for typical tenant sizes. This is design reasoning; none of it was verified against HelloID.

### Cited Findings
- The existing userscript already fetches whole paged grids with take=999999 and reuses the rows for a configurable number of minutes (cache), clearing on navigation; this is the established approach in this project. — d:\Public\HelloID-UX-improvements\HelloID-UX-improvements.user.js (SETTINGS.fetchAllTake, INTERCEPTS)
- Activity/Task logs per execution are capped at 50 messages (product actions, PowerShell data sources, delegated form tasks) and PowerShell data source output at 2 MB; these affect log size, not the list. — [Performance limits](https://docs.helloid.com/en/service-automation/performance-limits--service-automation-.html)
- Audit logs are retained for one year (guaranteed), and HelloID suggests exporting via the REST API for longer. — [Audit logs (HelloID docs, via search summary)](https://docs.helloid.com/en/incidents---logs/audit-logs.html)
- Heavy logging in product actions can fill the database, so docs advise limiting it (suggests logs/history can be large). — [Service Automation docs via search summary](https://docs.helloid.com/en/service-automation/products/product-actions/view-product-action-run-history.html)

### Inferences
- Retention: no documented retention for delegated form activities or request history was found. Treat "no entry" as "no entry in retained data", not "never used". Show the column cell as an em dash with a tooltip such as "No activity found in the retained history", and show the oldest timestamp seen in the data as a footer/tooltip so users can judge coverage. Derive this oldest timestamp from the data itself (min over all rows).
- Join key: prefer GUID (form GUID / product GUID) when the list rows carry it. If rows only carry names, join by name and expect false misses after a rename (old activities keep the old name) and collisions between duplicate names. Then the grid of forms/products must also be matched by name; check whether the table row exposes the GUID (ag-grid row data via the grid API, as the userscript does with findGridApi).
- Paging: if the server caps take (the script already works with take=999999 on other grids, but the activity/request endpoints may differ), loop skip += take until a short page; compare total count if the response gives one.
- "Last used" definition: decide between the start time of the most recent submission and the most recent activity of any kind. Count only submitted ones? The activity grid also lists non-submitted opens (the doc says "whether the form was actually submitted"), so filter to submitted = true to avoid inflating "last used" by people merely opening a form. Likewise for requests choose between requested date and including cancelled/denied; likely use all requests, optionally exclude cancelled. Ask the user.
- Timezone/format: expect ISO 8601 UTC strings ("...Z" or without offset). If without offset, parse as UTC, display in the browser locale, and sort/compare on the raw epoch value, not the displayed string. Verify with the capture.
- Caching: reuse the script's in-memory cache with TTL (minutes setting) plus clear on navigation; optionally persist the Map in GM_setValue/sessionStorage with a timestamp so the second visit renders immediately and refreshes in the background (stale-while-revalidate). Cache key per tenant origin. Do not cache across a hard TTL of more than a few minutes by default since history changes.
- Rendering: add the column to the existing table (the rows are in a DOM table/ag-grid, unknown); if ag-grid, add a column def through the grid API so sorting works (sort by epoch, empty last); if a plain table, append th/td and handle re-rendering with MutationObserver, which the script already uses.
- Failure handling: if the activity/request fetch returns 401/403 (user lacks the Request History overview right or delegation rights), leave the column hidden or show "no access", never an error banner.
- Performance: one list call per page visit at most; on tenants with very large histories (hundreds of thousands of rows), a full fetch could be heavy. Mitigation: request sorted newest first with a bounded take (e.g. last 12 months via date filter if supported) and label the column with the coverage window.

### Gaps
- Whether the endpoints support server-side sort, date filters, filter by form/product GUID, or an aggregate (group by) mode: unknown, needs capture.
- Maximum allowed take and total-count field: unknown.
- Retention of delegated form activities and product request history: not documented in the pages found; confirm with HelloID support or observe the oldest row on the tenant.
- Timestamp format and whether rows carry GUIDs: unknown.

## 3. Other discoverable UX improvements (optional suggestions, effort estimates)

### Takeaway
Once the same two lists are fetched, several cheap derived features follow. Estimates assume the data capture above is done and are rough.

### Cited Findings
- Admin pages already exist for these areas: Delegation > Activities, Self Service > Request History, Automation > Task history; docs say these are where Service Automation activity is reviewed. — [Service Automation administration](https://docs.helloid.com/en/admin-dashboard/helloid-administration/service-automation-administration.html)
- Product API does not expose access groups linked to a product (user request on HelloID feedback), so a "who can use this" summary is not obtainable through the public API. — [HelloID feedback: access groups on products](https://helloid.canny.io/service-automation/p/add-access-groups-to-products-api-v1-end-points)
- Deleting a delegated form or product leaves linked data sources and dynamic forms behind (feedback request), so an "orphaned data sources" report is a plausible cleanup helper. — [HelloID feedback](https://helloid.canny.io/service-automation/p/option-to-delete-linked-datasources-and-dynamic-forms-when-deleting-a-delegated)

### Inferences (suggestions with effort; S = under half a day, M = about 1 day, L = 2+ days, all after endpoint capture)
- "Uses (90 days)" count column per form/product, from the same Map plus a counter: S.
- Failed/last-failed indicator on the forms table (red dot when the most recent submission has a failed task state): S-M, depends on status field values.
- "Stale" highlighting/filter (not used for N days or never, with the retention caveat): S. Pair with a quick filter button "Unused".
- Last requested by (user) as a tooltip, and requester count: S.
- Same Last used info on delegated form/product detail pages (header badge): M.
- Visibility summary (who sees the product, from the Visibility column / access groups): M-L, may need per-product detail calls; the list API lacks group links, per the feedback item.
- Ownership summary (product owners): M, per-product detail call; unverified that endpoint exists.
- Export of the usage table into the existing export plan (CSV/JSON): S, fits the export features of the userscript.
- Orphan finder for data sources/dynamic forms not referenced by any form or product: L, needs several list calls and reference resolution.

### Gaps
- None of the suggestions were validated against live pages; status values and available detail endpoints are unknown.
