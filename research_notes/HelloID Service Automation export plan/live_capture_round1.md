# Live capture round 1 (Training tenant, read-only, 2026-11-24)

Method: Claude in Chrome, page navigation only, endpoint list from performance.getEntriesByType('resource') (URLs without tokens/values). No response bodies, no tokens read, nothing clicked besides the apidocs Export menu (no download by Claude).

## Public API spec (apidocs)
- Stoplight page works in a real browser. User downloaded both Export variants; they are byte-identical (HelloID_Original.yaml == HelloID_Bundled.yaml, 368483 bytes) in gitignored/.
- Paths in the spec (35): agentpools, applications, datasource, datasource/all, delegatedforms, delegatedformcategories, forms, groups, groups/batch, storageportal/imagesurl, selfservice/powershellscripts, selfservice/products(+batch), selfservice/actions, selfservice/products/request, selfservice/categories, products, product-assignment (+unassign/by-assignment, by-product), productownership (+batch, csv), roles, automationtasks, automationstore/tasks, automationtasks/powershell, users(+batch), automation/variables, automation/variable, metadata.
- NOT in the public spec: approval workflows, automation Systems, mapping sets, IdPs, access rules, sign-on/password policy, 2FA/OATH, SMS/RADIUS, mobile app, settings (appearance, certificates, logging, language, company), agent list details, activity/request history.
- Auth: Basic base64(apiKey:apiSecret), base https://<tenant>.helloid.com/api/v1.

## Transport of the admin UI (VERIFIED)
- Portal host: https://mvrijzewijk-sogeti.helloid.training
- Bootstrap: PORTAL /server/v2/bootstrap, /server/v2/security/account/
- Per-module gateway discovery: PORTAL `//api/v3/sa/url/<module>` (seen: activity, delegated-forms, jobs, product, recertification). Returns the Service Automation gateway; here https://service-automation-training-we.helloid.cloud (note: different host from the provisioning gateway; "-training-we" region suffix).
- Data calls: SAGW `/service/<module>/api/...` (CORS preflight OPTIONS seen, so a Bearer/Authorization header is sent; same style as provisioning gateway).
- Some admin lists come from the PORTAL host instead: `PORTAL /server/v2/admin/products/overview?skip&take`; `PORTAL /server/v2/users/getbyids/` (user name resolution).

## Page 1: /admin/delegatedforms/activity/
- Grid call: SAGW GET `/service/activity/api/activities/delegated-forms?language=EN&skip=0&take=25&search=&searchFields=`
- Follow-ups: SAGW `/service/delegatedform/api/delegatedform/getbyids?formIds=<guid>` (so activity rows carry form GUIDs -> join on GUID), SAGW `/service/delegatedform/api/submissions/status/<guid>`, SAGW `/service/job/api/execution`.
- Columns visible: Activity start time (e.g. "2:06 PM 10/28/2026", browser-locale string), Username, Delegated form, Submission ("Submitted"), Task state ("Successful"), Task error ("0 errors"), Actions. Filters: Submission, Task state. Page size options 25/...
- Training tenant currently has 1 activity (Item 1), form "New AD user", 2026-10-28.

## Page 2: /admin/delegatedforms/ (list)
- Grid is a table with 4 columnheaders + gridcells (role=gridcell DOM, not verified as AG Grid); rows have Edit/Clone/Delete buttons. 7 rows in Training. Links: Delegated forms, Categories (/admin/delegatedforms/categories), Activities (/admin/delegatedforms/activity), "Import external template" (/admin/delegatedformsimport).

## Page 3: /admin/selfservice/products/
- Grid call: PORTAL GET `/server/v2/admin/products/overview?skip&take` (other query keys not captured because of the output filter).
- Also: SAGW `/service/recertification/api/featureflag/segregatedproducts`.

## Page 4: /admin/selfservice/requesthistory/request/
- Grid call: SAGW GET `/service/product/api/requests/history?language&skip&take&search&searchFields&onlyrecertification`
- Also: SAGW `/service/product/api/requests/featureflag/requestsViaProductService`; PORTAL `/server/v2/users/getbyids/`.

## Not yet captured (needs response bodies)
- JSON field names/timestamp format of activities and request history (rows' form/product GUID field, status values for cancelled/denied).
- Products overview payload (product GUID field, last-request field if any).
- Everything on the other ~35 areas.
- Reading response bodies needs the page's Authorization header; do not extract tokens. Options: user copies one response from DevTools per page, or run a tiny in-page userscript prototype that reuses the page's own headers (as HelloID-UX-improvements.user.js already does) and logs only field names.
