# HelloID admin: Settings endpoints and admin table DOM (Training tenant, read-only, 2026-11-24)

Method: Claude in Chrome, navigation only, DOM reads via javascript_tool, endpoint list from performance.getEntriesByType('resource'). No clicks on state-changing controls, no response bodies, no tokens. Product version shown in footer: 2026.11.259170. [V] = verified live, [G] = guess.

## Part 1. Settings areas

### Global finding [V]
All five Settings areas are classic server-rendered ASP.NET MVC pages (anti-forgery hidden field `__RequestVerificationToken`, HTML form POST back to the same URL, `application/x-www-form-urlencoded`). They do NOT call the SAGW or the /server/v2 JSON API for their data. Values are rendered into the HTML (inputs), so the only way to read them is an HTML GET of the page URL (needs admin session cookie, no Bearer). The only XHR on these pages is Application Insights telemetry (dc.services.visualstudio.com /v2/track, ignore). Certificates is the one exception (Kendo grid, see below).

Nav hrefs in left menu [V]: /admin/settings/appearance, /admin/certificates, /admin/settings/logging, /admin/settings/language, /admin/settings/company.

### Appearance: /admin/settings/appearance [V]
- Tabs (in-page, anchors, same page): Logos & icons `#image-tab`, Custom CSS `#css-tab`, Tile Behaviour `#behaviour-tab`.
- Page-level buttons (do not click): Reset custom styling, Cancel, Save; form POST /admin/settings/appearance.
- Endpoints at load: none (no JSON). Resources: GET PORTAL `/appearance/css` (stylesheet link, no query; this is the tenant's custom CSS output), GET PORTAL `/appearance/companyicon` (img, no query; company icon served by the portal).
- Logos & icons tab fields:
  - CompanyLogo (hidden input, file upload widget "Select or drag and drop", max 400x400, shown on sign-in page): hidden value is a 32-char id (not a data URI), the preview `<img>` src points to the CDN `https://cdn.helloid.cloud/<env>/images/<long id>` (path shape `/production-training-we/images/{long}`, no query keys). Binary/image: YES.
  - CompanyIcon (hidden, max 128x128, top-left corner): same shape (32-char id; img `/production-training-we/images/{long}`); also served via PORTAL `/appearance/companyicon`. Binary: YES.
  - LoadingIcon: radio true/false; choices rendered as static CDN gifs `/production-training-we/Assets/img/loading/tools4ever.gif` and `.../pines.gif` (not tenant specific, these are product assets).
  - BackGroundImage (hidden, 32-char id, sign-in background): CDN `/production-training-we/images/{long}`. Binary: YES.
  - 6 further checkbox+hidden pairs in image-tab whose input names are GUID-like hex strings without label (looks like one toggle per loading-icon/option or per image). Names are tenant/product constants [G]; not decoded.
- Custom CSS tab: textarea `CustomApplicationCss` (empty in Training, length 0) plus a second unnamed textarea (editor helper). Content is free text, tenant-specific; may be long.
- Tile Behaviour tab: checkbox `OpenApplicationInSameTab` (false) with hidden twin (MVC checkbox pattern).
- Secrets: none. Tenant-specific: all image ids, CSS, CDN env segment `production-training-we`.

### Certificates: /admin/certificates [V]
- Page links: /admin/certificates/create (self-signed), /admin/certificates/import, /admin/certificates/usageoverview ("Show certificate usage in applications"). Do not open create/import actions.
- Kendo grid (jQuery, `table role=grid`, `.k-header`, columns Name, Actions; `data-field="Name"`, `"Actions"`), NOT AG Grid.
- Endpoint: PORTAL GET `/admin/Certificates/GetAll` query keys `take, skip, page, pageSize, virtual, _` (Kendo remote datasource; `_` is jQuery cache buster) [V]. Response is presumably Kendo style `{Data/Total}` [G].
- Training tenant has 0 certificates (empty grid), so row fields not observed. Row actions (edit/export PFX/CER/delete) not observed.
- Binary/secret: certificates are certificate material (private key/PFX export); the list should carry only name (and probably thumbprint/dates) [G]. Never export.

### Logging: /admin/settings/logging [V]
- Form POST /admin/settings/logging, no XHR. Fields (name, type, Training value):
  - LoggingAuthEnabled checkbox true, LoggingAuthRetentionDuration number 90
  - LoggingUserEnabled true, LoggingUserRetentionDuration 90
  - LoggingAppEnabled true, LoggingAppRetentionDuration 90
  - LoggingTaskEnabled false, LoggingTaskRetentionDuration 90
  - LoggingActionEnabled false, LoggingActionRetentionDuration 90
- Labels: Log authentication/user/application/task/action events + Log retention (days). No binary, no secrets. Not tenant-specific beyond values.

### Language: /admin/settings/language [V]
- Form POST /admin/settings/language, no XHR. One field: select `ConfiguredLanguage`, 7 options: EN, NL, FR, DE, IT, ES, autodetect (current value: autodetect). Page also loads flags sprite from CDN (static).

### Company: /admin/settings/company [V]
- Form POST /admin/settings/company, no XHR. Tabs (in-page anchors): Company info `#company-tab`, Service desk `#servicedesk-tab`, Mail domain `#mailserver-tab`, Custom Domains `#customdomains-tab`, Self Service `#selfservice-tab`, Incidents `#incident-tab`, Advanced `#advanced-tab`.
- Company info: CompanyName (text, empty in Training), CompanyDefaultAdDomain (text, empty), DefaultRedirectURL (empty), LogoutRedirectURL (empty), Currency (select, 111 options, ISO-like names with symbol), TimeZone (select, 144 Windows time zones; the two selects have a selected option not read).
- Service desk: ServiceDeskEmailAddress (text, empty; contact data, tenant-specific), ServiceDeskLanguage (select DE EN ES FR IT NL).
- Mail domain: pane only contains heading "Mail domain verification", rendered empty in Training (probably populated only when a custom mail domain feature is on) [G].
- Custom Domains: heading only, empty. Incidents: heading only, empty. Both empty here, so fields not known.
- Self Service: checkbox SelfServiceUseCustomFromAddress (false, hidden twin), SelfServiceFromAddress (text, suffix "@ helloid.com") and SelfServiceFromAddressDomain (select, 1 option).
- Advanced: checkbox HidePluginWarning (false), NotificationRefreshInterval (text, filled, minutes, value not read).
- Binary/secrets: none seen. Tenant-specific: company name, domains, redirect URLs, service desk mail, time zone.

### Implication for the exporter [V/G]
Settings (Appearance, Logging, Language, Company) have no JSON API in the portal; reading means fetching HTML and parsing form inputs (names above), writing means posting the form with the anti-forgery token (do not do this blindly). Appearance images are fetchable as plain GET from the CDN path (no auth query seen). Certificates is the only JSON list (Kendo GetAll).

## Part 2. Admin table DOM

### Common finding for both tables [V]
Both are **AG Grid (community, old version, older API: `api.getColumnDefs`, no `getGridOption`) wrapped in Angular** custom elements, hosted as `helloid-ag-grid > div.helloid-ag-grid-container > ag-grid-angular.ag-theme-material`. Not a plain table, not Angular Material. Rows are `div role=row`, cells `div role=gridcell`. No `<table>` exists. Row model type `infinite` (server-side paged data source); pageSize = number of rows when few rows (7 and 2 here), paging panel `.ag-paging-panel` present (hidden on products when single page). Columns/rows are virtualised and re-rendered by AG Grid on sort, page change, resize, and window width change, and Angular `ng-star-inserted` wrappers appear after each render, so injected DOM is not stable. Pinned left/right containers exist but are hidden/empty (`.ag-pinned-left-cols-container.ag-hidden`).

The existing userscript already uses the right route: `findGridApi(gridEl)` (looks at keys starting `__ag` on `.ag-root-wrapper` / `.ag-header-cell`, then candidate paths `api`, `gridApi`, `beans.gridApi`, `gos.api`, `gridOptionsService.api`, `gridOptionsWrapper.gridOptions.api`) and `api.setColumnDefs`. I verified this approach works on both grids: it returned an API exposing `getColumnDefs`, `getDisplayedRowAtIndex`, `getDisplayedRowCount`, `getModel`, `paginationGetPageSize`.

Attributes: no row-id attribute, no `data-id`/GUID on row DOM. Row node id is just the index ("0","1",...). `col-id` is a random GUID that changes (generated per grid instance, so do not select by it; use `aria-colindex`). Angular markers present: `_ngcontent-*` / `_nghost-*` (random suffix like `ddn-c143`, differs per build/page: do not use), `ng-star-inserted`. No `ng-version`, no AngularJS (`window.angular` false). The GUID for an item is available only in row data (`node.data`), not in the DOM.

### /admin/delegatedforms/ [V]
- Root: `helloid-ag-grid ag-grid-angular.ag-theme-material.has-paging`; `div.ag-root-wrapper`. 3 header rows exist (header, filter placeholders), real header cells `.ag-header-container .ag-header-cell` x4 with `aria-colindex` 1-4.
- Header cell structure (placeholders, 2nd column "Name", sortable):

```html
<div class="ag-header-cell ag-focus-managed ag-header-cell-sortable" role="columnheader" unselectable="on" tabindex="-1" aria-sort="none" aria-colindex="2" col-id="{GUID}" style="...">
  <div class="ag-header-cell-resize" role="presentation"></div>
  <div role="presentation" class="ag-header-select-all ag-labeled ag-label-align-right ag-checkbox ag-input-field ag-hidden">...</div>
  <helloid-ag-grid-column-header class="ng-star-inserted"><div><span class="ng-star-inserted">HEADER_TEXT</span></div></helloid-ag-grid-column-header>
</div>
```
(Reconstructed from the attribute/tag skeleton printed by DOM walking; the raw outerHTML read was blocked by the tool filter because of the GUID/data content, so inline style values were elided.)
- Sortable: Name (field `name`) and Status (field `isEnabled`) have `ag-header-cell-sortable` + `aria-sort`; Icon and Actions not sortable. Sorting is done through the infinite datasource (server or client callback), click on header cell.
- Row structure: `div.ag-row[role=row][row-index][aria-rowindex][comp-id]`, 4 children `div.ag-cell[role=gridcell][aria-colindex][col-id]`. Row skeleton (text/user data replaced):

```html
<div role="row" row-index="0" aria-rowindex="2" comp-id="49" class="ag-row ag-row-no-focus ag-row-even ag-row-level-0 ag-row-position-absolute ag-row-first" style="..." aria-label="Press SPACE to select this row.">
  <div role="gridcell" aria-colindex="1" col-id="{GUID}" class="ag-cell ag-cell-not-inline-editing ag-cell-auto-height ag-cell-value" tabindex="-1">
    <helloid-ag-grid-custom-cell-renderer><div class="custom-cell-container"><helloid-delegated-form-icon><div style="..."><i class="fa fa-2x fa-ICON"></i></div></helloid-delegated-form-icon></div></helloid-ag-grid-custom-cell-renderer></div>
  <div role="gridcell" aria-colindex="2" col-id="{GUID}" class="ag-cell ...">
    <helloid-ag-default-cell-renderer data-cy="form-name"><span title="NAME">NAME</span></helloid-ag-default-cell-renderer></div>
  <div role="gridcell" aria-colindex="3" col-id="{GUID}" class="ag-cell ...">
    <helloid-ag-grid-custom-cell-renderer><div class="custom-cell-container"><helloid-delegated-form-status><span class="label label-success">STATUS</span></helloid-delegated-form-status></div></helloid-ag-grid-custom-cell-renderer></div>
  <div role="gridcell" aria-colindex="4" col-id="{GUID}" class="ag-cell ...">
    <helloid-ag-grid-custom-cell-renderer><div class="custom-cell-container"><helloid-delegated-form-action-buttons><div class="d-flex flex-lg-column justify-content-center"><helloid-action-button>...<button type="button" class="ag-action-button btn btn-sm btn-link p-0 text-left border-0" title="Edit" data-cy="edit-delegated-form"><i class="fa fa-pencil mr-lg-1"></i></button>... (Edit, Clone, Delete)</div></helloid-delegated-form-action-buttons></div></helloid-ag-grid-custom-cell-renderer></div>
</div>
```
- Handy stable hooks: `data-cy="form-name"`, `data-cy="edit-delegated-form"`, custom element names `helloid-delegated-form-icon`, `helloid-delegated-form-status`, `helloid-delegated-form-action-buttons`.
- Row data keys (`node.data`, values masked): `id` (guid, the form GUID; page navigates to /admin/delegatedforms/edit/{id}/general), `dynamicFormId` (guid), `name`, `slug`, `isEnabled` (bool), `useFaIcon`, `faIcon`, `icon` (undefined when FA icon), `hideSummary`, `categories` (array), `accessGroups` (array), `automationTaskId` (null), `job` (null).
- Column defs keys: `headerComponentFramework, headerName, field, sortable, colId, cellRendererParams, cellRendererFramework, width, resizable, hide, pinned, sort...` (framework renderers => Angular components; the old-style `cellRendererFramework` confirms AG Grid < v26-ish Angular wrapper). Fields: [no field], name, isEnabled, [no field].
- 7 rows, 1 page.

### /admin/selfservice/products/ [V]
- Same wrapper (`ag-grid-angular.ag-theme-material.w-100`, inside `div.helloid-ag-grid-container` in `helloid-ag-grid` in `div.panel-body`). Only one grid on the page. 5 header cells, none sortable (`ag-header-cell` without `-sortable`, no `aria-sort`).
- Row skeleton (5 cells):
  1. `helloid-product-icon-renderer` with `<i class="fa fa-2x fa-ICON">`
  2. `helloid-ag-default-cell-renderer` > `<span title="NAME">NAME</span>` (field `name`)
  3. `helloid-ag-default-cell-renderer` > `<span title="DESC">DESC</span>` (field `description`)
  4. `helloid-visibility-renderer` > `<span class="label label-success" title="T">T</span>`
  5. `helloid-action-cell` > `helloid-action-button` x N (Edit pencil `fa-pencil`, Copy `fa-copy fa-regular`, ...), buttons `ag-action-button btn btn-sm btn-link p-0 text-left border-0` with `title`, no data-cy seen here.
- Row data keys (masked): `selfServiceProductGuid` (guid), `name`, `description`, `visibility` (number), `useFaIcon`, `faIcon`, `icon` (null). Row node id = index, GUID only in data.
- Paging: infinite model, pageSize here 2 (page size scales with rows), 2 rows in Training, paging panel hidden (single page). Data comes from PORTAL `/server/v2/admin/products/overview` (from round 1).

### Recommendation: appending a column [G, based on verified structure]
1. Do not append DOM cells. Rows/cells are recycled by AG Grid and re-created by Angular after sort, page, resize, resize of the viewport. Added nodes are lost or become misaligned (absolute-positioned cells with `left` offsets inside `.ag-center-cols-container`; the header uses pixel widths set from column defs).
2. Use the grid API as the existing userscript does: `const api = findGridApi(document.querySelector('ag-grid-angular'))`, then `const defs = api.getColumnDefs(); api.setColumnDefs([...defs, { headerName:'X', colId:'tm-x', width:120, sortable:false, resizable:true, cellRenderer: p => { const el=document.createElement('span'); el.textContent = lookup(p.data.id /* forms */ or p.data.selfServiceProductGuid /* products */); return el; } }])`. A plain-JS `cellRenderer` works alongside the Angular `cellRendererFramework` defs. Key the join on the GUID from `data` (forms `id`, products `selfServiceProductGuid`). Re-apply when the grid is recreated: watch for `ag-grid-angular` appearing (MutationObserver on `.page-content-wrapper`) and when `getColumnDefs()` no longer contains your colId (route changes within the Angular SPA destroy/recreate the grid). Keep a WeakMap per api to avoid double-adding (setColumnDefs also rebuilds the header, so only call it once per api).
3. Fallback (header-only DOM) if API cannot be found: select cells by `aria-colindex` and `role=gridcell` within `.ag-center-cols-container .ag-row`, map row -> GUID is NOT possible from DOM (no GUID attribute); the Edit button handler navigates by data, so you would need the API or a name-to-GUID lookup via the list endpoint. Not recommended.
- Example selectors: grid `ag-grid-angular.ag-theme-material`; header cells `.ag-header-container .ag-header-cell[role=columnheader]`; rows `.ag-center-cols-container .ag-row[role=row]`; Name cell on forms `[data-cy="form-name"]`; edit button `[data-cy="edit-delegated-form"]`; custom elements `helloid-delegated-form-status`, `helloid-visibility-renderer`.
- Do not rely on `_ngcontent-*`/`_nghost-*` suffixes (build-specific) or `col-id` (random GUID, per instance).

## User must capture (response bodies needed)
1. PORTAL GET `/admin/Certificates/GetAll?take=...&skip=...&page=...&pageSize=...&virtual=...` on a tenant that has at least one certificate: one sample response (redact thumbprint-ish secrets; certificate private data must not appear; confirm which fields the list holds).
2. HTML source (View page source, secrets redacted: `__RequestVerificationToken` and any embedded values) of `/admin/settings/company` (to confirm the options of Currency and TimeZone selects' selected values, Mail domain, Custom Domains and Incidents tabs, which render empty here), best captured on a tenant with a custom mail/domain configured.
3. HTML source of `/admin/settings/appearance` (the form hidden values: the 6 GUID-named checkbox fields, the exact format of the CompanyLogo/CompanyIcon/BackGroundImage hidden values) and one fetch of `/appearance/css`; plus whether the CDN image URL `https://cdn.helloid.cloud/<env>/images/<id>` is publicly GET-able (no auth).
4. Delegated forms list payload: the infinite-datasource response behind `/admin/delegatedforms/` (call not captured in this run; round 1 only knows the activity endpoints) with one row (fields seen in grid data: `id, dynamicFormId, name, slug, isEnabled, useFaIcon, faIcon, icon, hideSummary, categories, accessGroups, automationTaskId, job`), to confirm endpoint path (likely SAGW `/service/delegatedform/api/delegatedform...`) and whether the `icon` is base64 when `useFaIcon` is false.
5. PORTAL `/server/v2/admin/products/overview?skip&take...` one sample row (fields seen in grid data: `selfServiceProductGuid, name, description, visibility, useFaIcon, faIcon, icon`), including the full query key list (not captured in round 1) and how an uploaded `icon` is represented (inline base64 vs URL).
6. Optional: row data of a form/product with an uploaded (non-FA) icon, to see the image shape.

Not verified: sorting is client-visible (aria-sort) but the sort request (server vs client) was not triggered; Certificates row fields; Mail domain/Custom domains/Incidents tab content; the data endpoint for the delegated forms grid (no read of the endpoint list on that page was done in this run).
