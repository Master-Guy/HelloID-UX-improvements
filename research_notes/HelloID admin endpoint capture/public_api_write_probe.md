# Public API write/delete probe (Training tenant, 2026-11-24)

No credentials, tenant names or values recorded. Test objects were named zz-uxtest-* (variables zz_uxtest_*), all deleted afterwards; leftovers check across all API lists was clean.
Design rule from the owner: never hard-code hostnames. Only Training tenants run on *.helloid.training; other tenants use any domain. The API base URL must be derived from each environment's configured portal URL (+ /api/v1), never from a fixed domain.

## Verified behaviour
| Family | Create | Update | Delete | Notes |
|---|---|---|---|---|
| Variables | POST /automation/variable {name,value,secret} 200 | PUT /automation/variable/{name} 200 (also for secret=true, value required) | DELETE /automation/variable/{name} 200 | Name only letters, digits, underscore (hyphen -> 409 validation). Duplicate name -> 400 'Variable name already exists' unless OverwriteIfExists=true (then 200 and same GUID). Secret values are returned in clear on GET: exporters must mask by `secret`. |
| Delegated form categories | POST /delegatedformcategories {name:{en,...}} 200 | POST with delegatedFormCategoryGuid 200 | DELETE /delegatedformcategories/{guid} 200 | Client-supplied GUID on create -> 400. |
| Product categories | POST /selfservice/categories 200 | POST with selfServiceCategoryGUID 200; omitted optional fields reset (faIcon became null) | DELETE /selfservice/categories/{guid} 200 | Client GUID on create -> 400 'Category not found in database' (an id means update). |
| Dynamic forms | POST /forms {name,formSchema} 200, formOriginalGUID == first dynamicFormGUID, version 1 | POST with dynamicFormGUID creates a NEW version: version 2, new dynamicFormGUID, same formOriginalGUID; list shows only the latest | DELETE /forms/{formOriginalGUID} 200 | Delegated forms must reference formOriginalGUID. |
| Delegated forms | POST /delegatedforms {name,slug,dynamicFormGUID,isEnabled,useFaIcon,faIcon,task{script,runInCloud},accessGroups:[],categoryGuids:[...]} 200 | POST of the full GET body (with delegatedFormGUID) 200, name and task script updated: round-trip works | DELETE /delegatedforms/{guid} 200 | accessGroups [] accepted; the object-vs-GUID-array difference for non-empty accessGroups was NOT tested. |
| Static data sources | POST /datasource {name,type:2,value:[..],model:[{key,type}]} 200 | partial POST {dataSourceGUID,name} -> 500 (full body probably needed) | DELETE /datasource/{guid} 200 | GET /datasource/{guid} 200; GET /datasource (list) is 405. |
| Groups | POST /groups {name,isEnabled} 200 | not tested | DELETE /groups/{guid} 200 | |
| Products | NOT completed: minimal -> 400 'Categories can not be empty'; full body -> 400 'code (SKU) can only consist of letters and numbers' (hyphen). | not tested | not tested | Retry with an alphanumeric code. |

## Other verified facts
- Tools needing a non-default User-Agent (Cloudflare blocks python-urllib): send a clear client name.
- GUIDs are always server-generated on create; export/import must remap references by name or code.
- A POST with an unknown GUID is not an upsert-by-GUID.
- Error bodies differ per family (409 validation envelope, 400 {message}, 500 plain).

## Open / untested
- Product create/update/round-trip, accessGroups on products and on delegated forms with real groups, data source full-body update, PowerShell data source create, task create (/automationtasks/powershell), roles (security: intentionally not tested), users, applications (empty on Training), approval workflows (no API).
