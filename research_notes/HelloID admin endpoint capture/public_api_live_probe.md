# Public API live probe (Training tenant, read-only GET, 2026-11-24)

No credentials or values recorded here. Structure only.

## Transport (VERIFIED)
- Host: https://<tenant>.helloid.training/api/v1 (the tenant's own training host, NOT .helloid.com). Auth: Basic base64(key:secret) works.
- Cloudflare returns error 1010 for the default python-urllib User-Agent; any non-default client name is accepted (curl/PowerShell/Node defaults are likely fine, but set a clear User-Agent in the MCP client).
- The key used here is permitted on every GET tried (agentpools, delegatedforms, delegatedformcategories, roles, products, selfservice/categories, forms, automationtasks, automation/variables, product-assignment, groups, applications, users, metadata). Whether it is read-only was not tested (no write calls made).

## Paging (VERIFIED)
- /delegatedforms?take=2 returned all 7 items with envelope {total,data}: `take` is IGNORED or default is large; always page by total.
- /products?take=1 returned 1 (bare array, honours take). /forms envelope {total,data}. /agentpools, /roles, /selfservice/categories, /delegatedformcategories, /automation/variables, /groups: bare arrays.
- GET /datasource (list) is 405: data sources are not listable via GET /datasource (use /datasource/all per the spec, not probed).

## List vs single (VERIFIED)
- Delegated forms: the list returns `task: null` for every form; GET /delegatedforms/{guid} returns task {id,name,script,includedVariableNames,agentPoolId,runInCloud}. So full export = list + one GET per form. accessGroups and categoryGuids are present in both.
- Products: list lacks actions; single GET /products/{id} adds actions[], onRequest/onApprove/onDeny/onReturn/onWithdrawn[] (empty on the sample), agentPool/resourceOwnerGroup/approvalWorkflow {id,name}. dynamicForm was null on the sample.
- Dynamic forms: GET /forms lists metadata {formOriginalGUID,version,dynamicFormGUID,name,isPendingDelete,isUpdated}; GET /forms/{dynamicFormGUID} adds formSchema[] and the schema DOES contain a dataSourceGuid reference (confirmed). Delegated forms reference formOriginalGUID, products reference the versioned dynamicFormGUID (per spec analysis).
- Tasks: list items {automationTaskGuid,id,name,objectGuid,agentPoolGUID,metaData,variables[],isEnabled,automationContainer}.
- Variables: [{automationVariableGuid,name,value,secret}]. **Secret variables come back with their real value in plain text** (non-empty, not masked). So the API itself does not mask: exporters MUST mask based on the `secret` flag (and the existing name regex) unless the include-secrets setting is on.
- Delegated form categories: name is a localized object {en,nl,fr,de,it,es}.
- Roles: {roleGUID,name,description,isSystem,isEnabled,isDefault,rights:[int]}.
- Groups: {groupGuid,name,source,isEnabled,isDefault,isDeleted,managedByUserGuid,immutableId,isQrEnabled}. Users: includes lastLogin, source, roles[], userAttributes{}, contactEmail (PII) - never log.
- Applications: empty list on Training (so no shape observed). /metadata: empty.

## Last requested via API (VERIFIED limitation)
- /product-assignment returned 6 items, all approved (approvedAt set, approvalHistory[].approved all true). It lists granted assignments only: NO denied or cancelled requests. It cannot satisfy the owner's rule 'Last requested includes cancelled and denied'. The column must stay on the admin-session endpoint /service/product/api/requests/history.
- Delegated form submissions: no public API (unchanged).

## Implications
- API-first is viable for: delegated forms (+categories), dynamic forms, products, product categories, tasks, variables, roles, users, groups, agent pools (list). Needs per-item GETs for forms/products (N+1 calls).
- Round-trip gaps from the spec analysis still apply (accessGroups object vs GUID array on POST etc.) and were NOT tested with writes.
- Masking: export code must mask secret variable values itself.
- Open: write behaviour (create/update/GUID handling) untested; whether the key can be limited to read-only; rate limits.
