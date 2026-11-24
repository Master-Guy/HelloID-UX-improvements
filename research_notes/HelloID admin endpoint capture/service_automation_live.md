# HelloID Service Automation admin UI: live endpoint map (Training tenant, read-only, 2026-11-24)

Method: Claude in Chrome, own tab, navigation and opening existing edit pages only. Endpoint lists from performance.getEntriesByType('resource') (path shapes and query KEYS only). No response bodies read. All "VERIFIED" = observed in this session; "GUESS" = inferred. PORTAL = https://mvrijzewijk-sogeti.helloid.training, SAGW = https://service-automation-training-we.helloid.cloud (discovered via PORTAL //api/v3/sa/url/<module>). Method (GET/POST) is NOT visible from resource timing; all methods below are unverified unless stated (lists are almost certainly GET).

Left-nav SA URLs (VERIFIED from anchors): /admin/delegatedforms, /admin/delegatedforms/categories, /admin/delegatedforms/activity, /admin/selfservice/products, /admin/selfservice/categories, /admin/selfservice/approvalworkflow, /admin/datasources/datasource, /admin/dynamicforms, /admin/selfservice/requesthistory, /admin/selfservice/selfserviceadministration, /admin/variablelibrary, /admin/powershell, /admin/automation, /admin/automationsystems, /admin/agents/pools.

## Delegation

### Delegated forms list /admin/delegatedforms/
- Endpoint: SAGW /service/delegatedform/api/delegatedform/getallforgrid q=search,skip,take (VERIFIED)
- Columns: Icon, Name, Status (Enabled), Actions (Edit/Clone/Delete). Pagination "20 forms per page". 7 forms. Buttons: Create Delegated Form, Import external template. Edit is a button (not an href).
- Public API: yes, /delegatedforms (spec line 677). Does the public API return the same fields: unknown (GUESS).

### Edit page /admin/delegatedforms/edit/{guid}/general (VERIFIED; sub-tabs general, form(guess), groups(guess), categories(guess), tasks (VERIFIED URL))
- Tabs: General, Form, Groups, Categories, Tasks.
- General fields: Name, Identifier, Dynamic form (reference to a dynamic form), Enabled, Use FA icon, Icon, Hide summary.
- Tasks tab: "Configure action" with PowerShell code editor, "Code snippet library", "Run on cloud agent" toggle, "Agent pool" select (reference), "Execute PowerShell", Input, "Audit logs received".
- Endpoints loaded on edit (VERIFIED, path shapes):
  - SAGW /service/delegatedform/api/delegatedform/{guid}
  - SAGW /service/delegatedform/api/delegatedformscategories (all categories, no paging)
  - SAGW /service/datasource/api/datasource/multiple
  - SAGW /service/delegatedform/api/github/repositories/tasks, /github/topics/tasks (code snippet library from GitHub)
  - PORTAL /api/v1/dynamicforms/{guid}/getLatest (dynamic form definition; the "api/v#" is masked so the version digit is unknown, GUESS v1)
  - PORTAL /server/v2/admin/sa/groups/getbyids and /server/v2/admin/group/getForSelector q=search,source,skip,take (groups)
  - PORTAL /server/v2/automationtasks/getForObject/{guid} (the automation task attached to the form)
  - PORTAL /server/v2/admin/agentpools/select
  - PORTAL /server/v2/variable/library, /server/v2/admin/userAttributes/functions, /admin/adconfigurations/getall q=skip,take
- Cross-references: dynamic form GUID, group GUIDs (access), category GUIDs, agent pool GUID, automation task (script) via getForObject, data sources (inside the form).

### Categories /admin/delegatedforms/categories (VERIFIED)
- Endpoint: SAGW /service/delegatedform/api/delegatedformscategories/paged q=search,skip,take
- Columns: Name, Actions (Edit/Delete). 3 rows.
- Public API: yes /delegatedformcategories (line 777).

### Activities /admin/delegatedforms/activity/ (from round 1 notes)
- SAGW /service/activity/api/activities/delegated-forms q=language,skip,take,search,searchFields. Public API: no.

### Import external template /admin/delegatedformsimport (VERIFIED)
- 3-step wizard: 1 Select a script, 2 Edit script, 3 Verification. List of ~190 templates each with name, tags, "Updated on" date, Import button (NOT clicked).
- Endpoints seen: PORTAL /server/v2/apikeys/hasEnabledKey; and a GitHub search call (shows as host "PORTAL" in my script, path /search/repositories q=q,per_page,page; actual host is probably api.github.com, GUESS). Templates therefore come from GitHub repositories (topics), not from a HelloID API.
- Export/import relevance: template format is a GitHub repo; not a HelloID export format. Public API: no.

## Self-Service

### Products /admin/selfservice/products/ (VERIFIED)
- Endpoints: PORTAL /server/v2/admin/products/overview q=skip,take (a second q key is masked by the filter in round 1; here only skip,take showed); SAGW /service/recertification/api/featureflag/segregatedproducts
- Columns: Icon, Name, Description, Visibility (All), Actions (Edit/Clone/Delete). AG Grid (row select checkboxes). 2 products.
- Public API: yes /selfservice/products (line 1928), /selfservice/products/batch (2065).

### Product edit /admin/selfservice/products/edit/{guid}/general (VERIFIED)
- Tabs: General, Form, Actions - new (URL /product-actions), Actions (URL /actions), Groups, Time Limit, Segregation.
- General fields: Name, Resource owner (group, with "Unassign resource owners"), Approval workflow (reference, e.g. "HelloID SA Training"), Description, Show price, Price (currency), Source identifier, SKU, Visibility (All / Resource owner and manager / Resource owner / Disabled), Request comment (Optional / Required / Hidden), Maximum amount, Risk factor enabled, Multiple requests (Once / Always), Type of icon (custom / predefined), Change icon, Category (reference), Agent pool (reference), Return on user disable.
- "Actions - new" tab shows States (Requested, Approved, Denied, Withdrawn, Returned) and per-state Actions; "Actions" (legacy) tab shows "Add Action" / "No actions configured" and a banner recommending migration to "Actions - new".
- Endpoints on edit (VERIFIED):
  - PORTAL /server/v2/admin/products/product/{guid}
  - PORTAL /server/v2/admin/products/product/{guid}/groups q=take,skip,search
  - PORTAL /server/v2/productaction/getall/{guid}
  - SAGW /service/product/api/products/{guid}/jobs (the new actions)
  - PORTAL /server/v2/admin/group/getForSelector, /server/v2/admin/sa/groups/{guid}, /server/v2/admin/sa/groups/has-users/{guid} (hyphen/underscore masked, GUESS)
  - PORTAL /admin/selfservice/productsegregation/GetProductsForSegregation q=selfserviceproductguid,take,skip,search
  - PORTAL /server/v2/admin/companysettings/currency
  - SAGW /service/product/api/approval/workflows/enabled (dropdown of approval workflows)
  - PORTAL /server/v2/admin/categories/dropdown
  - PORTAL /server/v2/admin/agentpools/select
  - PORTAL /api/v?/dynamicformsgrid q=skip,take (form selector)
  - SAGW /service/product/api/github/repositories/products, /github/topics/products
- Cross-references: approval workflow GUID, resource owner group, category, agent pool, dynamic form (Form tab), groups (Groups tab: who can request), segregation products, product actions/jobs (PowerShell or other action definitions; may use variables).

### Categories /admin/selfservice/categories (VERIFIED)
- PORTAL /admin/selfservice/categories/getall q=take,skip,page,pageSize,virtual (+ more keys masked; this is the Kendo-style paging).
- Columns: Icon, Name, Status (Enabled), Actions (Edit/Delete). 2 rows (Default Category, Random Category A).
- Public API: yes /selfservice/categories (line 2836).

### Approval workflows /admin/selfservice/approvalworkflow (VERIFIED)
- List: SAGW /service/product/api/approval/workflows/overview q=skip,take; SAGW .../approval/workflows/featureflag/advancedapproval. Columns: Name, Default (badge), Actions (Edit/Delete). 4 rows.
- Edit: /admin/selfservice/approvalworkflow/edit?approvalWorkflowGuid={guid} (query key approvalWorkflowGuid). Tabs: General, Approval, Reminder, Products. General fields: Name, Enabled, Default, Send default emails, Hide email approve buttons, Notify the requester.
- Edit endpoints: SAGW /service/product/api/approval/workflows/{guid}; SAGW /service/product/api/approval/workflows/{guid}/products q=skip,take; PORTAL /server/v2/admin/users/getusersforsearch/safe; PORTAL /server/v2/selfservice/products/getproductsforsearch q=search; SAGW /service/variable/api/variables; PORTAL /server/v2/variable/library, /server/v2/admin/agentpools/select, /server/v2/admin/userAttributes/functions.
- Approval and Reminder tab contents were NOT read (GUESS: steps with approver types incl. users, groups, variables).
- Public API: NO (not in spec). Must be exported through the admin endpoints above.

### Data sources /admin/datasources/datasource (PARTIAL)
- Endpoint: SAGW /service/datasource/api/datasource q=skip,take (take=100). Returned HTTP 403 twice on this tab (the page showed "Http failure response ... 403"), although /service/datasource/api/datasource/multiple worked from the form edit pages. Cause unknown (possible token scope/race with other agents' tabs). Columns visible in header: Name, Type, Actions. Edit page not reached.
- Public API: yes /datasource (line 645) and /datasource/all (571).

### Dynamic forms /admin/dynamicforms/ (VERIFIED)
- List: PORTAL /api/v?/dynamicformsgrid q=search,skip,take. Columns: Name, Actions (Edit/Clone Form/Delete). 9 forms.
- Edit: /admin/dynamicforms/editForm?dynamicFormGuid={guid} (query key dynamicFormGuid). Endpoints: PORTAL /api/v?/dynamicforms/{guid}; SAGW /service/datasource/api/datasource/multiple.
- Page shows: Form Name, "Multistep Form" toggle, "Switch to editor", field palette (Checkbox Input, Confirm Password Input, Date & Time, Drop down, Dual list, Email Input, Form Row, Grid, Header, Markdown, Multi Checkbox, Multiselect, Multiselect Grid, Number Input, Password Input, Radio, Text, Text Area, Text Banner, Text Input, Time, User Selector), steps (e.g. Details, Naming, "Add step"), fields with required marker and type.
- Cross-references: fields (Drop down, Grid, Multiselect...) point to data sources via /datasource/multiple (GUID inside the form JSON, GUESS).
- Public API: yes /forms (spec line 954).

### Request history /admin/selfservice/requesthistory/request/ (round 1)
- SAGW /service/product/api/requests/history q=language,skip,take,search,searchFields,onlyrecertification. Public API: no (only POST /selfservice/products/request).

## Automation

### Variable library /admin/variablelibrary (VERIFIED)
- PORTAL /server/v2/variable/library (list and save). SAGW /service/variable/api/variables also exists (seen in the approval workflow editor, GUESS it is a newer read endpoint).
- Page: "Built-in system variables" (Type, Name, Value, Actual value; e.g. companyName, portalBaseUrl, portalApiKey masked) and "User defined variables" (Type, Name, Value, Actions). Training tenant has no user-defined variables. Secret variables display "......" (masked).
- Public API: yes /automation/variables (spec line 5094) and /automation/variable.

### PowerShell scripts /admin/powershell (VERIFIED)
- PORTAL /Admin/PowerShell/getall q=take,skip,page,pageSize,virtual (+masked). Columns: Name, State, Actions. 0 rows in Training. Button: New Powershell Script.
- Public API: yes /selfservice/powershellscripts (spec line 1882), /automationtasks/powershell (4172).

### Tasks /admin/automation (VERIFIED)
- PORTAL /admin/automation/GetAllActive q=take,skip,page,pageSize,virtual (+masked); PORTAL /Admin/Automation/GetTaskStates.
- Columns: Name, State, Actions (Edit/Delete). 1 row (a system-generated directory synchronization task).
- Edit: /Admin/Automation/Edit?AutomationTaskGuid={guid}#general-tab. Tabs: General, Task, Settings, Schedules, History. General fields: Name, Agent pool. Header buttons Show Run, Run Now, Save (NOT clicked).
- Edit endpoints: PORTAL /server/v2/automationtasks/{guid}; /server/v2/automationtaskstore/tasks/{guid}/revisions and .../latestVersion and .../manifest (task store, versioned definitions); /server/v2/scheduledtask/history/{guid} q=search; /admin/schedules/getall q=objectGuid,take,skip,pageSize; /admin/adconfigurations/getall; /server/v2/variable/library; agentpools/select.
- Public API: yes /automationtasks (4001), /automationstore/tasks (spec). Schedules and history: not seen in spec paths (GUESS no).

### Systems /admin/automationsystems (VERIFIED)
- PORTAL /server/v2/admin/provisioning/systems/getbyfilter q=filter (shared with the provisioning module).
- Card list (no table): system name + image. 1 system ("MSDN - training.local"). Pencil opens a modal with fields System name, Domain, Server name, buttons Close/Save (closed without saving).
- Public API: NO.

## Agent pools /admin/agents/pools (VERIFIED)
- PORTAL /server/v2/admin/agentpools; PORTAL /server/v2/admin/agent/download. Also PORTAL /server/v2/admin/agentpools/select (dropdown, used on forms, products, tasks, approval workflows).
- Page: pools (Default pool flagged "Is default", HELLOID-O) each with Install agent / Edit / Delete; agent table columns Agent name, IP, Local IP, Version, with Shutdown and Delete. Buttons Download Agent, Add new pool.
- Public API: yes /agentpools (spec line 18; list/ids only, agent details no).

## Public API coverage summary (grep of d:\Public\HelloID-UX-improvements\gitignored\HelloID_Original.yaml)
Yes: agentpools (18), datasource (645) and datasource/all (571), delegatedforms (677), delegatedformcategories (777), forms (954), selfservice/products (1928) and /batch (2065), selfservice/categories (2836), selfservice/powershellscripts (1882), automationtasks (4001), automationtasks/powershell (4172), automation/variables (5094).
No: approval workflows, automation systems, activities, request history, task schedules/history, delegated form import templates, segregation.

## Gaps and caveats
- HTTP methods not observable; query keys for several PORTAL lists are partially masked by the output filter (".../getall" Kendo-style lists show take,skip,page,pageSize,virtual plus masked extras).
- Not opened: Form, Groups, Categories, Time Limit, Segregation sub-tabs of products and delegated forms; approval workflow Approval/Reminder tabs; data source edit; dynamic form field-level config; task Task/Settings/Schedules tabs; product Time Limit.
- Data source list returned 403 twice.
- "api/v#" version digits in /api/v?/dynamicforms* masked.
- A product edit page displayed "Product has unsaved changes" banner on load; nothing saved.

## User must capture (response bodies, secrets redacted, one sample each)
- PORTAL /server/v2/admin/products/overview?skip&take (product list fields)
- PORTAL /server/v2/admin/products/product/{guid} (full product incl. approval workflow, category, agent pool, resource owner, visibility)
- PORTAL /server/v2/admin/products/product/{guid}/groups (groups on a product)
- PORTAL /server/v2/productaction/getall/{guid} and SAGW /service/product/api/products/{guid}/jobs (product actions, legacy and new)
- SAGW /service/product/api/approval/workflows/overview and /approval/workflows/{guid} (approval steps/reminders) plus .../{guid}/products
- SAGW /service/delegatedform/api/delegatedform/{guid} and /getallforgrid (delegated form + task link) and PORTAL /server/v2/automationtasks/getForObject/{guid} (its PowerShell task and agent pool)
- SAGW /service/delegatedform/api/delegatedformscategories (+ /paged)
- PORTAL /api/v?/dynamicforms/{guid} (form definition incl. data source references; also the version digit) and /dynamicformsgrid
- SAGW /service/datasource/api/datasource (list; it returned 403 for me, user should retry) and /datasource/multiple
- PORTAL /admin/selfservice/categories/getall (full query string)
- PORTAL /server/v2/variable/library and SAGW /service/variable/api/variables (variable shape; check secret masking)
- PORTAL /Admin/PowerShell/getall (needs a script to exist) and /admin/automation/GetAllActive plus /server/v2/automationtasks/{guid}
- PORTAL /server/v2/admin/provisioning/systems/getbyfilter?filter=... (automation system shape)
- PORTAL /server/v2/admin/agentpools and /server/v2/admin/agentpools/select
- Request method (GET/POST/PUT) and the Save request payloads for: delegated form, product, approval workflow, category, dynamic form (observe in DevTools Network on a save; I was not allowed to save)
