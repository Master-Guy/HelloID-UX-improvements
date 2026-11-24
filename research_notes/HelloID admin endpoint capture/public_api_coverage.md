# HelloID public API coverage for export, import, backup and Last-used columns

Scope and method. Source of all "spec" facts: `d:\Public\HelloID-UX-improvements\gitignored\HelloID_Original.yaml` (OpenAPI 3.1.0, "HelloID API" v1.0, 10,581 lines, 148 operations, 25 marked `deprecated: true`). Line numbers below refer to that file ("L677" = line 677). Nothing was called against any tenant; no API key was used or sought. "VERIFIED-SPEC" means stated in the YAML. "INFERRED" means my reasoning from the YAML or from local notes. Local project facts come from the notes under `research_notes\` , `reports\HelloID Service Automation export plan 2.md` ("report 2") and `helloid-mcp\docs\DESIGN.md` ("DESIGN"). These are local files, so the "sources" are file paths, not URLs.

Auth in the spec (L10536): one security scheme `Authorization` (apiKey in header `Authorization`), value `Basic base64(api_key:api_secret)`, server `https://your-company-name.helloid.com/api/v1` (L15-17). Every operation lists `security: Authorization`.

---

## 1. Spec inventory per path and family

### Takeaway
The public API is a CRUD-style surface of 148 operations over about 20 object families. It covers SA authoring objects (delegated forms, categories, dynamic forms, data sources, products, product categories, tasks, variables) and directory objects, but it has no approval workflows, no activity or request history, no segregation read for forms, no application create/update, no settings or security pages. Paging exists as `skip`/`take` on only some lists (spec gives no default or maximum except on `/metadata`); other lists have no paging parameters at all.

### Cited Findings
Paging parameters are generic: `skip` ("The number of objects to skip") and `take` ("The number of objects to take"), both optional integers, no default or max (L10185-10198). The only stated default is on `/metadata`: "By default, `skip` = 0 and `take` = 100. If you receive 100 records, you should assume there are more" (L5281). `search` (text) exists on delegated forms and dynamic forms lists (L10312). No rate limit, throttling, 429 or any non-200 response appears anywhere (grep for 4xx/5xx/429 returned nothing). Only `'200'` responses are documented. No pagination notes beyond the metadata one.

Family table. Columns: verbs and path; operationId; request/response schema; paging; identifier; notes.

**Agent pools** (tag Agent)
- GET `/agentpools` get-all-agent-pools -> array of `agentPool` {agentPoolGUID, name, options, creationTime, creationUser, modifyTime, modifyUser} (L18, L8440). No paging. No POST/PUT/DELETE, no GET one, no agent list.

**Applications** (tag Applications and Credential sets)
- GET `/applications` get-all-applications (query `enabled`, `includeIcon`) -> `application` {name, icon, url, helloIDUrl, isEnabled, type, description, applicationGUID, creationTime, modifyTime, modifyUser} (L47, L7595). GET `/applications/{ApplicationId}` get-an-application. GET/POST/DELETE group links: `/applications/{ApplicationId}/groups`, `/applications/{ApplicationId}/groups/{GroupId}` (L86-134). Credential-set operations: `/applications/{ApplicationId}/enrollment`, `/enduser/{UserGuid}/credentialconfiguration/{ApplicationGuid}`, `/users/{UserId}/enrollment`, `/credentialset/{UserId}/{ApplicationId}` (POST, DELETE), `/enduser/{UserGuid}/credential` (POST) (L152-380).
- No POST/PUT/DELETE on an application itself. The `application` schema has no SAML/OIDC/form-login configuration (no certificate, ACS URL, field mapping, credentials). Read-only list of shell metadata.

**Data sources** (tag Data sources)
- GET `/datasource/all` get-all-datasources -> array of anyOf `powerShellDataSource` | `staticDataSource` | `nativeDataSource` (L571). No paging, no params.
- GET `/datasource/named/{DataSourceName}` get-a-datasource-by-name (L592). GET `/datasource/{DataSourceGUID}` get-a-datasource-by-guid (L613). DELETE `/datasource/{DataSourceGUID}` (L634).
- POST `/datasource` add-or-update-a-datasource: request oneOf `powerShellDataSource` | `staticDataSource` only (native excluded), response oneOf the same two (L645-676). "To add a new data source, leave the `dataSourceGUID` empty. To update an existing data source, specify its GUID. ... only the properties included in the request body will be modified."
- Schemas: `powerShellDataSource` {script, runInCloud, input[], dataSourceGUID, type, name, model[]}; required script, type, name, model (L7808). `staticDataSource` {value[], dataSourceGUID, type, name, model[]}; required value, type, name, model (L7725). `nativeDataSource` {nativeType, input[], dataSourceGUID, type, name, model}; `model` is a single object ref here but an array in the other two (L8197-8311, inconsistent). `dataSourceType` enum 1 native, 2 static, 4 PowerShell (L8181). `dataSourceInputProperty` {description, translateDescription, inputFieldType (1 form input, 2 fixed value), key, type, options (0 optional, 1 required), predefinedValue} (L8312). `dataSourceModel` {key, type enum [0]} (L7875).
- There is no `agentPoolGuid` on a data source schema; only `runInCloud`. Whether the Agent pool is carried is not in the spec (see gaps).

**Delegated forms** (tag Delegated forms)
- GET `/delegatedforms` (query `search`, `skip`, `take`) -> object {total, data: delegatedForm[]} (L677-704).
- POST `/delegatedforms` add-or-update: request `delegatedFormPOST`, response `delegatedForm` (L705-744). "To add a new delegated form, leave the `delegatedFormGUID` empty. To update an existing delegated form, specify its GUID."
- GET `/delegatedforms/{DelegatedFormId}` ("The name or GUID", L10305-10311). DELETE same path ("you can only use a GUID in the path", L766).
- GET `/delegatedformcategories` -> array of `delegatedFormCategory` (L777). POST `/delegatedformcategories` add-or-update (request/response `delegatedFormCategory`; update merges only supplied properties, L851-854). GET `/delegatedformcategories/{DelegatedFormCategoryId}` ("English name or GUID", L10326; response anyOf object | array, L880). DELETE (GUID only, L924). No paging.
- POST `/delegatedforms/{DelegatedFormGUID}/categories` link-a-delegated-form-to-a-category, body array of `delegatedFormCategoryGuid` strings (L932-953).
- `delegatedForm` (L6922): delegatedFormGUID, name (required), slug, dynamicFormGUID (description: "The `formOriginalGUID` of the dynamic form"), isEnabled, useFaIcon, faIcon, accessGroups[{groupGUID, name}], categoryGuids[], task {id, name, script, agentPoolId, runInCloud}; deprecated: adConfigurationGUID, templateID, useManagedUsers, useUsersFromGroups, sourceGroups, adCommentAttribute. Note `hideSummary` and `icon` seen on the admin UI rows (report 2) are NOT in this schema.
- `delegatedFormPOST` (L7049): same, except `accessGroups` is an array of GUID strings (`delegatedFormAccessGroupGuid`, L7143-7147) instead of {groupGUID, name} objects; `task` has no id requirement; required name.

**Dynamic forms** (tag Dynamic forms)
- GET `/forms` (query `search`, `skip`, `take`) -> object {total, data[]} where each item has only formOriginalGUID, version, isPendingDelete, isUpdated, dynamicFormGUID, name (NO formSchema) (L954-1048).
- POST `/forms` add-or-update; body {dynamicFormGUID, name, isPendingDelete, formSchema: formElement[]}; response `form` (L1050-1216). "To add a new dynamic form, leave the `dynamicFormGUID` empty ... only the properties included in the request body will be modified."
- GET `/forms/{DynamicFormID}` -> `form` {formOriginalGUID, version, isPendingDelete, isUpdated, dynamicFormGUID, name, formSchema}; required name, formSchema (L1217-1234, L7292). `DynamicFormID` accepts either `formOriginalGUID` or `dynamicFormGUID` (L10354-10360). DELETE same path.
- POST `/forms/{DynamicFormID}/linkto/{ProductGuid}` and `/unlinkfrom/{ProductGuid}` (L1246-1275).
- `dynamicFormGuid` "Changes with the form's version. A form also has a stable GUID, its `formOriginalGUID`" (L7449). `formOriginalGUID` "does not change with the form's version" (L8956).
- `formElement` item (L7452): key, templateOptions {label, useObjects, useFilter, useSwitch, useDataSource, mustBeTrue, alignVertical, required, options[{value, text, mustBeTrue, label}]}, type, summaryVisibility (Show | Hide value | Hide element), requiresTemplateOptions, requiresKey, requiresDataSource. Description: "The configuration of this form element. Some element types may have additional properties."

**Groups** (tag Groups)
- GET `/groups` (skip, take) -> `group-get-all-groups`. POST `/groups` add-a-group, POST `/groups/batch` add-groups. GET/PUT/DELETE `/groups/{GroupId}`. Link/unlink: users, applications, selfserviceproducts, membergroups (two DELETE variants, "(1)" and "(2)"), categories (L1276-1858). GET `/groups/{GroupGuid}/products` (get-products-linked-to-a-group, L1716).
- `group` carries name, groupGuid, managedByUserGuid, immutableId, isEnabled, isDefault, isQrEnabled, isDeleted, source, users[], applications[], selfServiceProducts[], groups[], selfServiceCategories[] (GUID arrays) (L6767).

**Users** (tag Users)
- GET `/users` (enabled, skip, take, isDeleted). POST `/users`, POST `/users/batch`. GET/PUT/DELETE `/users/{UserId}`. Group, role links. PUT `/users/{UserGuid}/photo`. Deprecated POST `/users/addUserCredentials/{UserId}`. End-user views `/enduser/{UserGuid}/applications|categories` (L4483-5090).
- `user` has `password` as an input property and `userAttributes` (L5391); POST user description: "Do not include the `userGUID` property in your request. HelloID auto-generates this value" (L4542).

**Roles** (tag Roles)
- GET/POST `/roles`, GET/PUT/DELETE `/roles/{RoleId}`, link/unlink users and groups (L3746-4000). `role` {groups[], roleGUID, name, description, isSystem, isEnabled, isDefault, rights[int], users[]}; required name, description (L7190). Update note: "`right`s are completely replaced, not OR'ed. To remove all rights for an object type, send 0 as mask" (L3871). `right` is a 32-bit int: high 16 bits object type 1..17 (Dashboard, Users, Applications, Groups, Roles, SMS Providers, Certificates, AD Connectors, Identity Providers, Reporting, Settings, Login Access Rules, Application Access Rules, Integrations, API Access, SMS Configurations, Admin Dashboard), low 16 bits a bitmask (L7260-7288). No Service Automation object types in that list.

**Self-service products, old model** (tags Products; mostly deprecated)
- GET/POST `/selfservice/products` (deprecated, "Use GET /products instead", L1928-1980). GET/DELETE `/selfservice/products/{ProductId}` (deprecated). POST `/selfservice/products/{ProductId}` adds a catalog task (L2019). POST `/selfservice/products/batch` add-products (not deprecated, L2065). POST `/selfservice/products/clone/{ProductGuid}` (L2093). GET `/selfservice/actions` get-all-product-tasks (skip, take; response {totalRowCount, pageData[]} per example, L2112). POST `/selfservice/products/{ProductId}/powershellaction`, `/filesystemdirectorysecurityaction`, `/filesystemcreatedirectoryaction`, `/adcreategroupaction`, `/adgroupmemberaction`, `/groupmemberaction`, `/emailaction` (L2196-2706). DELETE `/selfservice/actions/{ActionGuid}` and `/selfservice/products/{ProductGuid}/deleteallactions` (L2707-2735). Segregation: GET/POST/DELETE `/selfservice/products/{ProductId}/segregatedproducts`, DELETE `.../segregatedproducts/all` (L2992-3063).
- `productTask` (L6058): actionGUID, name, options, objectGUID (product), executeOnState, automationStoreTaskId, automationStoreTaskVersion, executionType (native | powershell), executionEntry, executionEnvironment (helloid | helloid-agent), executionMinimumVersion, variables[] (`variable`: id, name, value, realValue, itemType, itemGuid, typeConstraint, options, secret, resolvesTo, isNew, isDeleted, isAdded, isTemp, isUpdated, isScriptVariable).
- `executeOnState` enum 1 Requested, 3 Approved, 5 Denied, 9 Withdrawn, 11 Returned (L8574).

**Products, new model** (tag "Products (with new tasks)")
- GET `/products` (skip, take) -> `productWithNewTask-get-all-products-response`. POST `/products` add-or-update, request `productWithNewTask-post-products-request`, response `productWithNewTask-get-product-and-post-product-response`. GET/DELETE `/products/{ProductId}` ("The GUID or SKU of a HelloID product", L10164). (L3064-3338)
- Request body description: "To add a new product, leave the `productId` empty ... You can create/update new product tasks with this endpoint (`onRequest`, `onApprove`, `onDeny`, `onReturn`, `onWithdrawn`)" (L3197-3200).
- Response schema (L9056, properties from L9312): actions[] (old `productTask`), agentPool {name, id}, resourceOwnerGroup {name, id}, categories[{name, id}], approvalWorkflow {name, id}, dynamicForm {name, id} (id = `dynamicFormGUID`, the version GUID), onRequest/onApprove/onDeny/onReturn/onWithdrawn[] (`newProductTask`: id, name, script, agentPoolId, runInCloud), productId, name, description, code (SKU), hasTimeLimit, managerCanOverrideDuration, limitType (Fixed | Maximum), ownershipMaxDuration, showPrice, price, icon, useFaIcon, faIcon, allowMultipleRequests, hasRiskFactor, riskFactor, maxCount, sourceIdentifier, visibility (All | ResourceOwnerAndManager | ResourceOwner | Disabled), returnOnUserDisable, requestComment (Optional | Required | Hidden), accessGroups[{id, name}].
- Request schema (L9812, properties from L9952): same, but nested objects carry only `id` (agentPool.id, resourceOwnerGroup.id, categories[].id, approvalWorkflow.id, dynamicForm.id); NO `accessGroups`; NO `actions` among its properties (the schema's example does include `actions`, but the `properties:` block does not); `ownershipMaxDuration` described "in seconds" on the request versus no unit on the response.
- The get-all response schema (L9474-9811) has the same property set including accessGroups (L9795) and the five state task arrays, so one paged GET returns full definitions (INFERRED from the schema; the response is typed `items: $ref` with no `type: array` at the top).

**Product categories** (tag Products)
- GET `/selfservice/categories` (no paging), POST add-or-update, DELETE `/selfservice/categories/{ProductCategoryGUID}`. No GET one. `productCategory` {selfServiceCategoryGUID, name (required), isEnabled, useFaIcon, faIcon, icon}. Update behaviour differs from the other families: "any properties not included in the request body will be reset to their default values" (L2883).
- Link group to product: POST `/selfserviceproducts/{ProductId}/groups`, DELETE `/selfserviceproducts/{ProductGuid}/groups/{GroupId}`; category to group: POST `/categories/{ProductCategoryGUID}/groups`, DELETE (L2902-2991). Note these two path prefixes lack `/selfservice/`.

**PowerShell script templates**
- GET `/selfservice/powershellscripts` (deprecated; "not recommended and not documented", L1924) -> array {powerShellGUID, name, options, enabled, t4eScript, script}. No write endpoint.

**Automation tasks** (tag Tasks)
- GET `/automationtasks` (search, container enum 1/2/8, includeDisabledTasks) -> `task`[]; "Get all tasks, including all scheduled tasks and all product tasks"; "`variables` is not included in the response" (L4002-4030). GET `/automationtasks/{TaskGUID}` -> `task` (L4032).
- POST `/automationtasks/powershell` add-or-update-a-task, request/response `task` (L4172-4227); "To add a new task, leave the `automationTaskGUID` empty ... only the properties included in the request body will be modified." Response: "`powerShellScript`, `powerShellScriptGuid`, and `useTemplate` are returned inside `variables`" (L4177-4182). DELETE `/automationtasks/powershell/{TaskGUID}`. POST `/automation/tasks/{TaskGUID}/start` run-a-task (L4242).
- GET `/automation/variables/named/{AutomationVariableName}`, `/automation/variables/id/{AutomationVariableGuid}`, `/automation/variables/{TaskGUID}` (local task variables) (L4377-4440). Task template catalog GETs under `/automationstore/tasks...`, `/automationstore/categories/context/...`, `/automationstore/tasks/{TaskTemplateGuid}/revisions` (L4050-4375).
- `task` (L6580): automationTaskGuid, id (catalog template GUID), name, objectGuid, automationContainer (enum 1 scheduled, 2 product), metaData (= executeOnState), agentPoolGuid, isEnabled, uSN, emailAddresses, sendMail, sendMailWhenFailed, sendMailForCriticalEvent, isScriptTimeoutEnabled, scriptTimeout, useTemplate, powerShellScriptTemplateGuid, powerShellScript, variables[{name, value, typeConstraint, secret, automationVariableGuid}]; required name, automationContainer. There are no schedule objects (no cron/recurrence fields) and no run-history fields.

**Automation variables** (tag Variables)
- GET `/automation/variables` -> `systemOrCustomVariable`[] {automationVariableGuid, name, value (integer|number|string|boolean), secret}; includes built-in system variables and user-defined ones (L5094-5110, L8045). No paging.
- POST `/automation/variable` add (body name, value required; secret; OverwriteIfExists; ItemType 0 global / 1 scheduled task / 2 script template / 3 product task; ItemGuid) (L5112-5193). PUT `/automation/variable/{CustomVariableName}` (name, value required; L5194). DELETE by name (same path) and by GUID `/automation/variable/id/{CustomVariableGuid}` (L5247).

**Misc**
- GET `/storageportal/imagesurl` -> {url}: "the location where images like the application icons are stored" (L1860-1881). Read only. Icons in product, category, application schemas are 32-char ids (examples such as `D139C36BC0F28FF34025AD212C8AB7E6`, L6442); there is no upload endpoint in the spec.

**Metadata** (tag Metadata)
- GET `/metadata` (objectId, objectType enum Product | DelegatedForm | DataSource | DynamicForm, key, skip, take; default skip 0 take 100), POST `/metadata` create-or-update (`id`, objectId, objectType, key up to 128 chars, value up to 255 chars), DELETE `/metadata/{MetadataGUID}` (L5261-5388). "Object metadata is stored completely separate from the object it's about ... only retrievable & editable via the /metadata endpoint" (L5327). For a dynamic form use `FormOriginalGUID`, not `dynamicFormGUID` (L5336). It is a free key/value store set by integrators; HelloID does not populate it with usage data (INFERRED from the description "mainly for HelloID resellers").

**Product assignments** (tag Product assignments)
- GET `/product-assignment` (skip, take), `/product-assignment/by-assignment/{AssignmentGuid}`, `/by-user/{UserGuid}`, `/by-product/{ProductGuid}`, `/by-source/{AssignmentSource}` (all but the by-assignment one take skip/take) -> `productAssignment` (L3339-3453). POST `/product-assignment/{ProductId}` assign (userGuid, source required; formData, executeApprovalActions, toDate, comment) (L3454). POST `/product-assignment/unassign/by-assignment` and `/by-product` with `executeActions` (L3480-3543). Deprecated `/productownership` family (L3544-3745), keyed by SKU/UserName.
- `productAssignment` (L6290): assignmentGuid, requestedAt, approvedAt, source, userGuid, userName, productGuid, productName, productSku, approvalHistory[{order, time, userGuid, userName, comment, approved}], returnDate.

**Request a product**
- POST `/selfservice/products/request`: required requestedProductGUID, requestedByUserGUID, requestedForUserGUID; optional formData, comment, toDate, source. This CREATES a request (L2735-2835). There is no GET for requests.

**Not present at all** (VERIFIED-SPEC by exhaustive path list): approval workflows; activities and request history; delegated form submissions/activity; segregation read for forms; AD configurations; mapping sets; identity providers; access rules; policies and settings pages; API keys; certificates; SMS/RADIUS; application categories; automation systems; schedules of tasks; task run history; notifications (a `notification`, `notificationType`, `notificationLevel` schema and a "Notifications" tag exist, L7896-8044, L10560, but no path references them); the `Credential sets` tag is present.

### Inferences
- The only paging with a documented default is metadata (take=100). For every other list, assume nothing: the safe client loops `skip`/`take` until a page returns fewer rows than `take` (or `total` is reached where {total,data} is returned: delegated forms, dynamic forms).
- Lists without paging parameters (agentpools, datasource/all, delegatedformcategories, selfservice/categories, automation/variables, applications) presumably return everything in one answer.
- `GET /forms` returns metadata only; the schema comes per form from `GET /forms/{id}`, so a full dynamic form export is N+1 calls. In contrast `GET /delegatedforms` and `GET /products` appear to return full definitions in the list itself (list item schema equals detail schema).

### Gaps
- Real default/maximum `take` per list, whether `skip`/`take` is honoured on `/forms`, `/delegatedforms` and `/products`, and how `total` relates to filters: spec silent; needs a live call.
- Behaviour of `GET /products` when `take` is omitted (all, or a default page): spec silent.
- Exact response top-level type of `GET /products` and `GET /selfservice/actions` (schema is malformed or example-only, see section 7).

---

## 2. Export, import and backup suitability per family

### Takeaway
For read/export the API can list and return full definitions for: delegated forms (incl. script and groups), delegated form categories, dynamic forms (per-form GET), data sources (PowerShell and static; native read-only), products in the new model (incl. five state task scripts, approval workflow reference, form reference, groups), product categories, automation tasks (script yes, variables not in the list), global automation variables, roles, users, groups, agent pools (list only), applications (shell only). Create/update exist for all of those except agent pools and applications; delete exists for all except agent pools, applications and product categories GET-one. Round-trip is NOT exact: several GET/POST shape gaps exist (listed below), and GUIDs are not client-suppliable (create = empty GUID; any GUID means update).

### Cited Findings

**Capability matrix** (L = list all, G = get one full, C = create, U = update, D = delete). "full def" = response contains everything the admin UI exposes for recreation per the schema.

| Family | L | G | C | U | D | Full definition in GET | Notes (all VERIFIED-SPEC unless marked) |
|---|---|---|---|---|---|---|---|
| Agent pools | yes `/agentpools` | no | no | no | no | list fields only | No agents, no create. Read for GUID to name mapping only. |
| Applications | yes | yes | no | no | no | no: shell only | No SAML/OIDC/credential config. Only group links writable. |
| Data sources PS | yes `/datasource/all` | yes by name or GUID | yes `POST /datasource` | yes (partial merge) | yes by GUID | yes: script, runInCloud, input[], model[] | `agentPool` not in schema. |
| Data sources static | yes | yes | yes | yes | yes | yes: value[], model[] | Different model; `value[].id` integer only declared. |
| Data sources native | yes | yes | no (POST oneOf excludes it) | no | probably yes (delete by GUID) | read-only built-ins | Built-in "HelloID Users/Groups" examples (L8197). |
| Delegated forms | yes (skip/take/search, {total,data}) | yes (name or GUID) | yes | yes | yes (GUID only) | yes: task.script, runInCloud, agentPoolId, accessGroups, categoryGuids, dynamicFormGUID, slug, icon fields | See round-trip gaps below. |
| Delegated form categories | yes | yes | yes | yes (merge) | yes (GUID only) | yes: delegatedFormCategoryGuid + multilingual `name` map | Link form to category via POST `/delegatedforms/{guid}/categories`; also embedded as `categoryGuids` in form POST. |
| Dynamic forms | yes (metadata only) | yes (either GUID) | yes | yes (merge) | yes | yes: formSchema | `isPendingDelete` flag exists; versioned GUID. |
| Products (new, `/products`) | yes (skip/take) | yes (GUID or SKU) | yes | yes | yes | mostly: see below | Preferred. Old `/selfservice/products*` deprecated. |
| Product legacy actions | in product `actions[]` or `GET /selfservice/actions` | via product | per-type POST | via POST product (not in request properties) / action endpoints | yes | yes (productTask) | Admin UI itself says legacy tab is superseded (report 2). |
| Product categories | yes | no | yes | yes (reset-to-default on omitted) | yes | yes | |
| Product to group links | via `accessGroups` in product GET; `GET /groups/{GroupGuid}/products` | | POST `/groups/{GroupId}/selfserviceproducts` | | DELETE | | Request body of POST /products has no accessGroups. |
| Segregation | GET `/selfservice/products/{ProductId}/segregatedproducts` | | POST | | DELETE (one and all) | yes: productGuid, productName, productSku | Spec covers it; report 2 listed segregation as "no", that is wrong for read and write (the admin UI has a Segregation tab; public API has the three verbs). |
| Automation tasks (scheduled and product) | yes (`container` filter 1/2/8) | yes | yes `POST /automationtasks/powershell` | yes (merge) | yes | script yes; variables NOT in the list ("`variables` is not included"), GET one example shows variables | No schedule, no run history. |
| Global variables | yes `/automation/variables` (system + custom) | by name/GUID only for task-local; global: via list | yes `POST /automation/variable` | yes `PUT .../{name}` | yes by name/GUID | name, value, secret | See secrets below. |
| PowerShell script templates | yes (deprecated) | | no | no | no | yes | Not recommended by HelloID. |
| Roles | yes | yes | yes | yes (PUT) | yes | yes: rights ints, users, groups | Rights are opaque 32-bit ints. |
| Users | yes (enabled, isDeleted, skip, take) | yes | yes (+batch) | yes (PUT) | yes | yes except password | `password` is an input property only. |
| Groups | yes | yes | yes (+batch) | yes (PUT) | yes | yes + member GUID arrays | Members embedded as GUID arrays. |
| Metadata | yes | via filter | yes | yes | yes | yes | Not HelloID object config. |
| Approval workflows | no | no | no | no | no | n/a | Only referenced by `approvalWorkflow.id` on product. |

**Delegated form: completeness and round-trip**
- GET returns `task.script`, `task.runInCloud`, `task.agentPoolId`, `accessGroups[{groupGUID, name}]`, `categoryGuids[]`, `dynamicFormGUID` (= formOriginalGUID), `slug`, `isEnabled`, `useFaIcon`, `faIcon` (L6922-7046). That is enough to recreate the form body except the following gaps (INFERRED by comparing GET and POST schemas):
  1. `accessGroups`: GET objects `{groupGUID, name}`; POST (`delegatedFormPOST`) array of GUID strings. A raw GET body cannot be re-posted unchanged; map to `groupGUID`. The POST example itself contains a malformed GUID "f3e0d8ba - dd08 - 4 a0e - bf6d - df89ec02de11" (L738).
  2. `task.id`: GET returns the script's GUID. POST `task.id` is described as the GUID of the delegated form's PowerShell script; on a new form it is presumably left empty (not stated for delegated forms; stated for `newProductTask.id`, L9040).
  3. `dynamicFormGUID` references the stable `formOriginalGUID`. On a different tenant or after re-create the GUID differs, so it must be remapped by name after importing dynamic forms.
  4. `delegatedFormGUID` empty = create (L740). GUIDs are not client-suppliable on create; supplying one is documented as update (INFERRED: a non-existing GUID is unspecified).
  5. Admin UI fields not in the schema: `hideSummary`, `icon` (row keys observed in report 2), "Hide summary", notification settings, inputs. A delegated form exported through the public API would lose these (INFERRED from schema absence; the schema may simply be incomplete).
  6. Category membership has two write paths: `categoryGuids` in the form POST, and POST `/delegatedforms/{guid}/categories`. Category `name` is a language map; the path parameter accepts the English name (L10326).
- Name lookups: GET one accepts name or GUID (L10311), so import can match by name without listing.

**Dynamic form: completeness**
- `formSchema` is `formElement[]` with `key`, `templateOptions`, `type`, plus "additional properties" per element type (L7538). The spec does not name any data source reference field (no `dataSourceGuid`, `dataSourceConfig`, `dataSourceModel` etc. appear in `formElement`; grep `dataSourceGUID` hits only data source schemas). `useDataSource` and `requiresDataSource` booleans exist. Whether data source GUIDs are embedded in the schema is therefore NOT verifiable from the spec; report 2 assumes yes (as GUID inside the form JSON) from the live trace of `/service/datasource/api/datasource/multiple`. Treat as INFERRED: the schema is open-ended ("additional properties"), so unknown fields should pass through a client untouched, but nothing in the spec guarantees the API returns every field the admin editor stores (multistep forms, steps, field layout "Form Row", "Grid" etc.). The example only shows 4 simple elements, no step objects.
- Versioning: each POST creates a new `dynamicFormGUID` version; list shows `version` (examples up to 158). A restore therefore changes `dynamicFormGUID`; the product's `dynamicForm.id` is documented as the `dynamicFormGUID` (L9364) and the delegated form's reference as the `formOriginalGUID` (L6986). Two different identifiers for the same concept; the product reference may go stale after a form update (INFERRED).

**Product (new model): completeness and round-trip**
- GET returns: five state arrays of `newProductTask` {id, name, script, agentPoolId, runInCloud}, `approvalWorkflow {name, id}`, `dynamicForm {name, id}`, `categories[{name,id}]`, `resourceOwnerGroup`, `agentPool`, `accessGroups[{id, name}]`, time limit, risk, visibility, requestComment etc., legacy `actions[]` (L9312-9473). This covers actions (new and legacy), approval workflow reference (only GUID+name, the workflow itself is not available), and form reference.
- Round-trip gaps (INFERRED from GET vs POST schemas):
  1. `accessGroups` is returned but not accepted by POST /products (no property). Groups must be re-linked with the group endpoints (`POST /groups/{GroupId}/selfserviceproducts`, L1689, or `POST /selfserviceproducts/{ProductId}/groups`, L2902).
  2. Legacy `actions[]` is returned but is not in the POST request `properties`. Legacy actions would need the per-type `/selfservice/products/{ProductId}/...action` POSTs (seven types) or be skipped (the admin UI recommends the new model).
  3. Nested objects (categories, approvalWorkflow, dynamicForm, resourceOwnerGroup, agentPool) are `{id}` only on POST; the GUIDs differ per tenant, so import needs name-to-GUID maps. `approvalWorkflow.id` cannot be resolved by name through the public API (no workflows endpoint), so it can only be resolved with the admin session or carried over unchanged within one tenant.
  4. `newProductTask.id`: "When adding a new product task, leave `id` empty" (L9040); `agentPoolId` mapping needed.
  5. `riskFactor` and `sourceIdentifier` nullable on request but not on response (L9438 vs L10084-10098): benign.
  6. `ownershipMaxDuration` documented "in seconds" only on the request (L10059).
  7. Segregation is a separate endpoint (not in product body).
  8. `productId` in POST may be a GUID; "leave empty to add"; GET/DELETE accept GUID or SKU. SKU (`code`) is a stable cross-tenant natural key, usable for matching.

**Task scripts and variables**
- Scheduled and product task scripts: `task.powerShellScript` is in the list response. `variables` is omitted from the list but present on GET one (and returned in POST). Each task variable: `{name, value, typeConstraint, secret, automationVariableGuid}`.
- Secret handling: the `secret` schema only states "true: Hide the variable's value in the HelloID UI. false: Show" (L8696-8700). The spec says nothing about whether GET returns the secret `value` in clear, masked or absent. The admin UI shows dots (report 2, service_automation_live.md L99). So: UNKNOWN whether a secret variable's value is retrievable; for the global variable list `value` is typed `integer|number|string|boolean` with no `null`. Never export or log it; mask as `***` the same way the project already does for target systems. An import needs an "unchanged" token convention because `PUT /automation/variable/{name}` requires `value` (required: name, value, L5231-5233), so a secret cannot be re-saved without knowing its value.
- Legacy `variable` schema carries `secret`, `realValue`, `resolvesTo` and client-state flags (isNew, isDeleted, isAdded, isTemp, isUpdated), which suggests the legacy shape is a pass-through of the internal model (INFERRED).

**GUIDs client-suppliable?** No create-with-chosen-GUID is documented for any family. Each POST says "leave the GUID empty" to add and "specify its GUID" to update. Exceptions: `POST /metadata` (`id` only on update), `POST /automation/variable` (no GUID input), `POST /product-assignment/{ProductId}` (returns assignmentGuid). So GUID preservation across restore is not possible via the public API (INFERRED; the admin endpoints' behaviour is unknown, report 2 also found "no seen endpoint accepts a client GUID").

**Update semantics differ per family** (VERIFIED-SPEC): merge only supplied properties for data sources, delegated form categories, dynamic forms, products (L3197), delegated forms (L740 states only create vs update), tasks (L4204); full replace/reset for product categories (L2883), role `rights` replaced (L3871). A plan-apply tool must model this per family.

### Inferences
- Best fits for a public-API backup: delegated forms with categories, dynamic forms, data sources (PS and static), products (new model) with state tasks and category/form/resource-owner references, product categories, global variables (non-secret), roles, groups, agent pools (names for mapping), plus metadata (cheap).
- Backup/export JSON is complete enough for restore only after a transform step per family: map accessGroups objects to GUID strings, drop legacy actions or replay them, remap GUIDs by name/SKU, strip secrets. A "same-tenant undo" restore (update existing GUID) is simpler than "clone into another tenant" because GUIDs line up.
- Approval workflows, activity, segregation-for-forms, application config, directory/security settings remain admin-session only.

### Gaps
- Whether GET of a secret variable returns value, masked text, empty or omitted: spec silent, needs one live call on a tenant with a secret variable (output redacted).
- Whether the admin-UI-only fields (`hideSummary`, `icon`, form steps) are returned/accepted by the public API: unknown.
- Whether `dynamicForm` field settings that reference data sources, and `dataSourceGUID`s embedded in them, are returned and accepted: unknown.
- Whether update of a delegated form replaces or merges omitted properties, and whether `task` is replaced as a block: spec silent for delegated forms.
- Whether `task.id` must be omitted or may be reused on update of a delegated form: spec silent.

---

## 3. Owner-listed items with NO public API coverage

### Takeaway
Of the items the project has been mapping, these have no path in the spec and therefore need the admin session (Bearer on gateways or cookie on portal): approval workflows, delegated form activity, product request history, automation systems, task schedules and run history, application categories, AD configurations, mapping sets, identity providers, access rules, sign-on and password policies, password self-service, mobile app settings, 2FA/OATH, SMS, RADIUS, API keys, Settings (appearance, logging, language, company), certificates, and partial gaps inside covered families.

### Cited Findings
- No path or schema for any of these in the spec (VERIFIED-SPEC by full path list above). Admin-session transports for them are in `service_automation_live.md` and `directory_security_live.md`: SA gateway `/service/product/api/approval/workflows/...`, `/service/activity/api/activities/delegated-forms`, `/service/product/api/requests/history`, portal `/server/v2/admin/provisioning/systems/getbyfilter`, `/admin/schedules/getall`, `/server/v2/scheduledtask/history/{guid}`, portal Kendo `getall` and server-rendered HTML forms for settings and security (report 2).
- Partially covered families that still need the admin session for the missing part: applications (config; the spec only lists shells and links), data source native create, products (approval workflow definition, legacy-action parity, segregation is covered), tasks (schedules and history), delegated forms (UI-only fields, task run state), agent pools (agents), variables (secret values), dynamic forms (anything the schema does not carry).
- Unavailable in both: API key secrets (the keys themselves are not in the spec; report 2 notes secret is in the page HTML), certificates private keys.

### Inferences
- The "HTML-form-only" family set is Settings and most Security pages (report 2 line 17, 53, 57); the public API never helps there.
- If the owner insists on public-API-only, the following owner-list entries cannot be exported: approval workflows, request history, activities, application categories, AD configurations, mapping sets, IdPs, access rules, policies, settings, schedules.

### Gaps
- Whether `/applications` full objects can be created by another unlisted route (e.g., templates): none in spec.

---

## 4. "Last used" (delegated form submissions) and "Last requested" (product requests)

### Takeaway
Not obtainable from the public API for delegated forms at all. For products, only an approximation from `/product-assignment` (approved assignments with `requestedAt`, `approvedAt`, `returnDate`, `approvalHistory`) is possible; cancelled, denied and pending requests are not documented as returned, so "Last requested including cancelled/denied" cannot be satisfied. The userscript's columns must keep using the admin-session endpoints.

### Cited Findings
- Delegated forms: no activity, submission, audit or history path exists. The `delegatedForm` schema has no lastUsed/lastSubmitted/submissionCount field (L6922-7046). The task endpoints (`/automationtasks`, `container` 8 = DelegatedForms in the query-parameter enum, L10227-10236) return `task` objects with no run timestamp. `POST /automation/tasks/{TaskGUID}/start` returns a queue entry {scheduledTaskQueueGuid, automationTaskGuid, state, addedDate, startDate, endDate} (L4249-4262): that is a write that executes the task, not a history read; there is no corresponding GET for queue or history.
- Products: `POST /selfservice/products/request` only creates (L2735). `GET /product-assignment`, `/by-product/{ProductGuid}`, `/by-user/{UserGuid}`, `/by-source/...` (skip/take) return `productAssignment` with `requestedAt`, `approvedAt`, `returnDate`, and `approvalHistory[].approved` (true = approved, false = denied by that responder) (L6290-6381). Description of assignment: "All responses to the associated product request" (L6353).
- Metadata is a user-written key/value store; HelloID does not write usage into it (L5325-5327).
- No "requests", "history", "log", "audit", "activity" path or schema exists. Only a `requestHistory`-like substitute is the assignment list.

### Inferences
- A "Last requested" built from `/product-assignment` would be `max(requestedAt)` per `productGuid`. It would miss requests that never became assignments (pending, denied everywhere, withdrawn, cancelled), unless the endpoint also returns denied ones; the schema's `approved: false` in `approvalHistory` hints that denied requests may appear (UNVERIFIED), and `returnDate` hints returned ones appear. A live check is needed before relying on it.
- Fetching all assignments (paging with skip/take) is O(total assignments) per refresh and may be large; per-product queries (`by-product/{guid}`) multiply calls. This is worse for token and request cost than the admin history grid.
- Can be used as a cross-check or fallback, not as the primary source.

### Gaps
- Whether `/product-assignment` returns denied, cancelled, pending, returned and expired assignments: spec silent.
- Retention and max take of both admin-session lists: unknown (already open in report 2).

---

## 5. Write-capable and dangerous operations, DryRun and plan-then-apply, key permissions

### Takeaway
The spec has 148 operations, of which roughly 85 are writes. The dangerous ones are deletes, the unassign/assign pair (can run product Return/Approved tasks), `run-a-task` (executes PowerShell), product request creation, user and group batch creation, role right replacement and categories' reset-to-default update. The spec states nothing about API key scopes or rights beyond an "API Access" right object type in the role right list.

### Cited Findings
- Spec is silent on key scopes, permissions, or per-endpoint roles. The only related text: `right` object type 15 "API Access" (L7285) and the security scheme description pointing to the "generate an API key" doc (L10541). Report 2 and `directory_security_live.md` show API keys are managed under `/admin/apikeys` with a secret in page HTML.
- Delete operations: `delete-a-datasource-by-guid`, `delete-a-delegated-form`, `delete-a-delegated-form-category`, `delete-a-dynamic-form`, `delete-a-product`, `delete-a-product-2`, `delete-a-product-category`, `delete-a-product-task-from-a-product`, `delete-all-product-tasks-from-a-product`, `delete-a-task`, `delete-a-custom-variable-by-name/guid`, `delete-metadata`, `delete-a-role`, `delete-a-group`, `delete-a-user`, `delete-a-credential-set`, plus all unlink variants and `desegregate-all-products`.
- Execution-side effects: `POST /product-assignment/unassign/...` with `executeActions` "Execute product task(s) attached to the product's Return step" (L3493-3494); `POST /product-assignment/{ProductId}` with `executeApprovalActions`; deprecated `DELETE /productownership` "will not execute Returned tasks"; `POST /automation/tasks/{TaskGUID}/start` runs a task; `POST /selfservice/products/request` starts the approval flow and can run request-state tasks; `POST /selfservice/products/clone/{ProductGuid}`.
- Batch: `POST /users/batch`, `/groups/batch`, `/selfservice/products/batch`, `/productownership/batch` and `/csv` (deprecated).
- Bulk-destructive: `DELETE .../deleteallactions`, `DELETE .../segregatedproducts/all`; `DELETE /automation/variable/{name}` affects scripts that use it; `PUT /roles/{id}` replaces rights; `POST /selfservice/categories` resets omitted fields; `DELETE /delegatedforms` for a form with history loses the link to its activity (report 2: GUID remap loses history).
- No dry-run, validate-only or `whatIf` parameter exists on any operation.
- The project rule for target-system scripts ("DryRun" guard on every write) applies to scripts that run on HelloID, not to the API itself. A script stored in a data source, delegated form task or product task is code that will run on the tenant; the DryRun guard check in DESIGN (`changes/dryrun-check.ts`) concerns Provisioning target system scripts, so delegated-form/product tasks are a different category (INFERRED).

### Inferences
- There is no server-side dry-run, so plan-then-apply must be client-side: read, diff against the current state (fingerprint, as in DESIGN "Safety"), print the planned verb plus path plus body, then apply only with the confirmation flags (`allowDelete`, `confirmName`, existing pattern in DESIGN). The existing pattern (fingerprint recheck, one write at a time per environment, audit log with before/after) maps directly to API calls.
- Classify API operations in the MCP as: read (GET), additive write (POST create), mutating write (POST update, PUT), destructive (DELETE, unassign with executeActions, `deleteallactions`, `segregatedproducts/all`), executing (`start`, `request`, `assign/unassign`). Executing operations should be excluded from backup/restore tooling entirely.
- The API key probably needs the "API Access" right plus the rights of the target object types; the least-privileged key per mode (read-only export key versus a write key for import) would be a good practice. This is INFERRED; verify in the admin UI whether a key can be scoped.

### Gaps
- Key scope model, whether keys are tied to a role/user, whether read-only keys exist: not in spec; needs HelloID documentation or UI check.
- Server rate limits and concurrency limits: not in spec.

---

## 6. Hybrid architecture recommendation

### Takeaway
Use the public API as first choice, for SA authoring families and directory objects, in the PowerShell script and the MCP server (where the key can be held in a protected store). Keep the admin session for everything outside the spec and for the two Last-used columns. The userscript should not use the API key (it runs in a page; any key in the script or in browser storage would be exposed to the page and to anyone with the script); it should stay on the cookie/Bearer session of the logged-in admin, or delegate to the MCP server over the loopback HTTP endpoint, if a "read via API" path is wanted.

### Cited Findings
Per-family recommendation (API-first = A, admin-session-only = S, HTML-form-only = H, mixed = A+S):

| Family | Route | Reason |
|---|---|---|
| Delegated forms, categories | A (S as fallback for fields missing) | Full def incl. script; two shape gaps to transform. |
| Dynamic forms | A (verify data-source references) | Per-form GET; schema open-ended. |
| Data sources PS and static | A | Full def; native read-only. |
| Products (new), categories, groups link | A+S | API has everything except approval workflow definition; workflow GUIDs need S. |
| Segregation | A | Public endpoints exist. |
| Automation tasks and scripts | A for definition; S for schedules/history | |
| Variables | A for non-secret; secrets masked everywhere | |
| Roles, users, groups | A | |
| Agent pools | A read (mapping only) | |
| Applications | A for shell list; S for configuration | |
| Approval workflows | S | not in spec |
| Activity, request history (Last-used columns) | S | not in spec |
| Automation systems, AD configs, mapping sets, IdPs, access rules, API keys, certificates | S | |
| Settings, sign-on, password policies, mobile app, Appearance | H | server-rendered forms with anti-forgery token |

Transport changes needed (INFERRED from DESIGN and `Export-HelloID.ps1`):
- Today both the PS script and the MCP server authenticate only through the admin session. `Export-HelloID.ps1` header: logs in with a local admin account at `/authentication/admlogin` (without MFA), takes the Bearer from `/server/v2/security/token`, discovers the provisioning gateway (`Find-Gateway`). DESIGN: "The server is the only holder of HelloID sessions. No HelloID password, cookie or token is ever written to disk... Passwords are typed by the user... Logging in is interactive" (L9-11), config has no API key field (L58-85), and the `auth.bearerToken` in config.json is only for callers of the MCP. Also "Everything in this document was agreed with the user. Do not add features, flags or behaviour that are not described here" (L5), and "The userscripts and `Export-HelloID.ps1` are not changed by this project" (L24, scoping of the MCP project). So an API key path is a DESIGN change, not allowed to be added silently.
- DESIGN changes required: (a) Principles: add that a per-environment API key and secret may be held, and the rule for storage; the current "no secret on disk" principle must be restated (for example: read from an environment variable or the Windows Credential Manager at start, never in `config.json`, never logged, never returned to Claude; audit log masks `Authorization`). (b) Config: per environment an `api` block `{ "baseUrl": "https://<tenant>.helloid.com", "keyRef": "<name of env var or credential target>" }`; note the spec host is `<tenant>.helloid.com` while existing environments use `https://example.helloid.training` for training: the API base may differ per environment (INFERRED, the spec base `.helloid.com`; training uses `.helloid.training`). (c) Session section: a "public API client" next to `helloid/client.ts` that builds `Authorization: Basic base64(key:secret)`, no cookies, no token refresh, no gateway discovery; one origin per environment; `endpoints.ts` gets an API section. (d) Safety: classify API write operations and add flags (existing `mode`, `allowDelete`) so the same plan/apply pipeline governs them, including an API-specific flag for the executing operations (start/request/assign/unassign) kept disabled by default. (e) Tools: tool descriptions must say which transport they use (API versus session); add a `source` field to outputs. (f) Unknowns section: list the API unknowns from section 2.
- PowerShell script: add parameters `-ApiKey`, `-ApiSecret` (SecureString or `-ApiCredential` as PSCredential: username=key, password=secret) and a switch/`-Transport Api|Session|Auto`; `Auto` uses the API for covered families and the session for the rest. Keep `-IncludeSecrets` semantics. Provide the key via `Get-Secret`/SecretManagement or Credential Manager so it never appears in the shell history. This is a single `Invoke-RestMethod` with `-Headers @{Authorization=...}`, simpler than the current JWT/gateway dance for these families.
- Userscript: cannot hold a secret; options: (1) stay on the admin session (cookie plus captured Bearer) for everything, which is how it works today; (2) call the local MCP over `http://127.0.0.1:3917/mcp` (needs its bearer secret in the browser, so the same problem in a smaller form: only the MCP's own loopback token would be exposed, not the HelloID key) and let the MCP use the API key. (3) not to use the API in the userscript at all. Recommended: (1) for the Last-used columns and import/export buttons that need live data, (2) not before the MCP has CORS/Origin support for the userscript (DESIGN refuses requests with an Origin other than 127.0.0.1/localhost, L107, so a page on `*.helloid.com` would be refused by design). So practically: no API in the userscript.
- Effort and token-cost angle (INFERRED, qualitative):
  - Lower effort: one transport (Basic header, JSON), one origin, documented schemas, `skip`/`take`, no token refresh, no per-module gateway discovery (the admin UI uses four transports per report 2: portal JSON, SA gateways per module, Kendo MVC, HTML forms). For covered families that saves discovery work and probing (each undocumented admin endpoint required live capture).
  - Lower token cost: schemas exist in the spec, so a planner can be built from the YAML without live DevTools captures (report 2's Phase 2/3 are blocked on captured bodies). The spec is 368 KB; never load it whole in a prompt; extract the needed schemas (a few KB per family) into the project once.
  - Stability: versioned public surface with deprecation notices (25 deprecated ops, `/selfservice/products` replaced by `/products`) versus undocumented UI endpoints that change with product versions (the notes cite product version 2026.11.259170).
  - Security: a revocable key/secret scoped to an integration versus an interactive admin session; no password in scripts (the PS script currently needs a local admin account without MFA).
  - Costs of the hybrid: two code paths and two shape normalisers; a shared exporter format must hide which transport produced it; round-trip transforms per family; bodies from the admin UI and from the API may differ in field names (report 2: "Public API shapes are a hint, not a contract"), so import tools must normalise both into one canonical export format, otherwise a file exported by the userscript might not import via the API path.
- Recommended order: (1) one live read-only call per family to confirm schema completeness against the admin UI (section 2 gaps) using a read-only key, (2) PS script `-Transport Api` for the covered families, (3) MCP API client plus DESIGN update, (4) leave userscript and Last-used columns on the session.

### Inferences
- The API-first split removes roughly half the families from the multi-gateway problem (report 2: "About half of the object families have no public API path"), but the other half stays as hard as before; the saving is mostly on SA authoring (delegated forms, forms, data sources, products, tasks, variables).
- A canonical export format per family (the "same file" rule from the PS header: "Where the userscript has an Export button, the file is the same") conflicts with two transports unless the API result is transformed to the UI-bodies; decide which shape is canonical.

### Gaps
- Whether the API host for the tenants is `<tenant>.helloid.com` for training/sandbox tenants (`.helloid.training`) too: not verified.
- Whether the API key can be restricted to read-only: unknown.
- Whether the existing local admin (no-MFA) login route remains permitted: not an API question.

---

## 7. Spec quality issues to watch

### Takeaway
The spec is useful but loose: inconsistent identifier naming and casing, GET/POST asymmetries, a few schema/example mismatches, and only 200 responses. Treat it as a hint and verify with one live call per family.

### Cited Findings
- Casing and naming: `delegatedFormGUID`, `dynamicFormGUID`, `formOriginalGUID`, `agentPoolGUID` (agentPool schema) versus `agentPoolGuid` (task schema, L6650) versus `agentPoolGUID` in the task example (L6613); `groupGuid`/`groupGUID`; `selfServiceProductGuid` is not in the spec while the admin UI row key is; `productId` (new model) versus `selfServiceProductGUID` (old model, L1972) versus `objectGUID` (productTask); `code` (new) versus `productSku`/`ProductSKU` (old); product reference `dynamicForm.id` = `dynamicFormGUID` (versioned) vs delegated form `dynamicFormGUID` = `formOriginalGUID` (stable).
- GET versus POST asymmetries: delegated form `accessGroups` objects vs strings; product `accessGroups` and `actions` absent from POST; response nested objects with `name` vs request `id` only; delegated category `name` language map.
- `/datasource` POST excludes native; `nativeDataSource.model` is an object while others have arrays; `nativeType` enum [1] only; `dataSourceModel.type` enum [0] only (L7890), `dataSourceInputProperty.type` enum [0] only.
- `automationContainer` schema enum [1, 2] (L8658) while the `container` query allows 1, 2, 8 (L10227-10236) (DelegatedForms tasks).
- `GET /products` response schema has `items` without `type: array` (L3066-3085); `GET /selfservice/actions` responses are an example-only object {totalRowCount, pageData} (L2123-2127) while the other lists use {total, data}; paging envelope is inconsistent: array (groups, users, products, assignments), {total, data} (delegated forms, dynamic forms), {totalRowCount, pageData} (selfservice/actions).
- `/delegatedformcategories/{id}` GET response is anyOf object or array (L880).
- The spec has two near-duplicate operations "unlink-a-group-from-a-group-1" and "-2" on two different DELETE paths (`/groups/{GroupId}/membergroups/{MemberGroupId}` and `/groups/{GroupId}/groups/{MemberGroupId}`, L1779-1801).
- Product category path families lack the `/selfservice/` prefix (`/selfserviceproducts/{ProductId}/groups`, `/categories/{ProductCategoryGUID}/groups`).
- Example data inconsistencies: delegated form POST example `accessGroups: ["f3e0d8ba - dd08 - 4 a0e - ..."]` is a malformed GUID (L738); `formData` is an object in one example and a JSON string in another (L2796-2799 vs L2828); `selfservice/products/request` response shows `durationInSeconds` as string; `productAssignment` timestamps without time zone.
- Secrets: no field-level secret documentation beyond the boolean `secret`; the user `password` is an input property but the spec does not say it is write-only.
- Missing in the schemas versus the admin UI (INFERRED from report 2 and `service_automation_live.md`): delegated form `hideSummary`, `icon`, notifications; dynamic form step/multistep structure; product Time Limit nuance; data source agent pool; application configuration.
- Error model: only 200; no 400/401/403/404/409/429 documented; no pagination or rate-limit text.
- Deprecations: 25 operations; `/selfservice/products` (old) and `/productownership*` (SKU based) are deprecated; do not build on them. `/selfservice/powershellscripts` is deprecated and "not recommended".
- Naming in docs: tag "Products (with new tasks)" for the new model vs tag "Products" for old actions and categories.

### Inferences
- Because the schemas contain examples that do not validate against themselves (e.g., malformed GUID), codegen from this YAML should be avoided or limited; hand-written minimal schemas per family plus a live contract test are safer.

### Gaps
- Spec versioning: `info.version: '1.0'`, no changelog; unknown which tenant version it corresponds to (report 2: product version 2026.11.259170 for the admin UI).
- The published apidocs site contains only this one project node (per the brief); no separate spec for provisioning/other APIs was checked.
