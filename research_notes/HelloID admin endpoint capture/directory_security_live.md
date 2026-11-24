# HelloID admin UI: Directory, Security, Authentication, Applications (Training tenant, live, read-only, 2026-11-24)

## Key finding: how these areas are served

### Takeaway
None of these areas use the SAGW (service-automation) gateway. They are the legacy ASP.NET MVC admin pages on the PORTAL host (`/admin/<Controller>/<Action>`, mostly Kendo-grid `getall`-style POST/GET endpoints with `take,skip,page,pageSize,virtual` keys) plus a few `/server/v2/admin/...` endpoints (users, groups, identityprovider, agentpools, configuration). Most edit/settings pages are server-rendered (no XHR; the data is in the HTML), so there is no JSON endpoint to call for them. The only non-PORTAL pieces are the 2FA pages (iframe from the identity host) and a Directory-integrations SCIM URL.

### Verified (from performance entries, query KEYS only, no values, no bodies)
Method is NOT captured (performance entries give no method). Kendo `getall` endpoints are probably POST or GET; unverified.

Method note: all paths are on PORTAL host https://mvrijzewijk-sogeti.helloid.training. Query key `#` in my output means a non-letter key (likely `_` cache-buster) so treat as "one extra underscore-style key".

## Applications and application categories
- URL (verified): `/admin/applications`, `/admin/applicationcategories`
- Endpoints (verified): PORTAL `/admin/Applications/getall` keys=take,skip,page,pageSize,virtual,(+1 non-letter key); PORTAL `/admin/applicationcategories/getCategoriesAsync` keys=take,skip,page,pageSize,virtual,(+1)
- Columns (verified from header): Applications: Icon, Name, Type, Enabled, Actions; button "Open application catalog". Categories: Color, Name, Options, Actions; button "Add Category".
- Training tenant has 0 applications and 0 categories, so detail/edit pages could NOT be inspected (gap). Add/edit URLs not captured.
- Cross-references seen elsewhere (verified): Groups list row links "Applications" and "Application categories" per group; user edit has "Credential Sets" tab (endpoint `/admin/Users/GetUserApplications` keys=userGUID,take,skip,page,pageSize,virtual; columns Icon, Applications Name, Type, Actions; empty for the sample user).
- Public API: YES applications (`/applications`, spec line 47); application categories: no path in the spec.
- Secrets: unknown (no app to open).

## Directory: users
- URL (verified): `/admin/users`
- List endpoint (verified): PORTAL `/server/v2/admin/users/getall` keys=skip,take,search,searchFields,cachebust,showEnabledUsers,showDisabledUsers,showDeletedUsers,selectedADSources. Also PORTAL `/server/v2/admin/users/getsources` (no keys; fills the Source filter).
- Columns (verified, screenshot): checkbox, Username, Email, Source, Status, Actions (Edit, Reset second factor, Reset Password; the last only for Local users, not AzureAD ones). Footer shows total count; bulk Delete button; Create User button.
- Source values seen (verified): Local, AzureAD (also AD domain names appear as group source, e.g. the AD domain). Local vs remote is the Source column; filter via selectedADSources.
- Detail URL (verified): `/admin/users/edit?userGUID={guid}`; endpoint PORTAL `/admin/users/getuserbyguid/{guid-or-key}` (path ends with an id; query keys none significant), PORTAL `/server/v2/admin/group/getgroup` keys=groupNameOrGuid (resolves group names).
- Tabs (verified): General, Groups, Credential Sets, Attributes.
  - General fields: First name, Last name, Change icon, Email, Phone number, Enabled (toggle), Roles (read-only), Source (read-only), Last login (read-only, shows 1/1/1970 for never), Change password at next logon, Manager, Other manager, QR code (Generate/Scan buttons).
  - Groups tab: endpoint PORTAL `/admin/Users/GetGroupsForUser` keys=UserGUID,take,skip,page,pageSize,virtual; columns Name, Source; buttons Add Groups, Remove All Groups, Remove Selection.
  - Credential Sets: see Applications above.
  - Attributes tab: no XHR (data came with the user); simple Attribute/Value table (e.g. employeeId, displayName) for a remote user.
- Secrets: none displayed; the "Reset Password" is a separate page `/admin/users/resetpwd?UserGUID={guid}` (not opened).
- Public API: YES users, users/batch (spec lines 4483, 4545).

## Directory: groups
- URL (verified): `/admin/group`
- Endpoints (verified): PORTAL `/server/v2/admin/group/getsources`; PORTAL `/server/v2/admin/group/getall` keys=skip,take,search,searchFields,cachebust,showEnabledGroups,showDisabledGroups,showDeletedGroups,showGroupsWithoutSource,selectedADSources.
- Columns (verified): Name, Source, Status, Actions. Per-row action links: Edit, Delete, Users, Applications, Groups, Products, Self Service categories, Application categories, Forms (these are the "membership/assignment" sub-pages, i.e. cross-references to other objects). Source values seen: AzureAD, AD domain name (remote), Local (also "local" lowercase on the built-in Users group). Create Group button.
- Detail page not opened (gap).
- Public API: YES groups, groups/batch (lines 1276, 1400).

## Directory: mapping sets
- URL (verified): list `/admin/mappingsets`; edit `/Admin/MappingSets/Edit?MappingSetGUID={guid}`.
- List endpoint (verified): PORTAL `/admin/mappingsets/getall` keys=take,skip,page,pageSize,virtual,(+1). Columns: Name, Actions (Edit). Training: 1 mapping set (named after the AD domain).
- Edit page (verified): no XHR (server-rendered). Tab General: Name (read-only), Mapping configuration table (Object, Actions). Rows: "Active directory user" (object type User) and "Active directory group" (object type Group), each with "Change attributes" and "Change mappings" actions (not opened; they are not plain `<a href>` links, probably modals).
- Mapping-set type is AD only here; Entra/AzureAD and Google have no mapping sets in the UI (see below).
- Public API: NO.

## Directory: Active Directory configurations
- URL (verified): list `/admin/adconfigurations`; edit `/Admin/adconfigurations/Edit?ConfigurationGUID={guid}`; delete `/Admin/adconfigurations/Delete?configurationGUID={guid}`.
- List endpoint (verified): PORTAL `/admin/adconfigurations/getall` keys=take,skip,page,pageSize,virtual,(+1). Columns: Configuration Name, Domain, Actions (Edit, Delete). Button Create Configuration.
- Edit page endpoints (verified): PORTAL `/server/v2/admin/agentpools/select`; PORTAL `/server/v2/admin/configuration/validate-domain/{base64-of-domain}` keys=configurationGUID; PORTAL `/api/v1/activedirectory/ou/{guid}` (this one is a public-style v1 path on the portal host; likely the OU tree for the agent pool); PORTAL `/server/v2/admin/agentpool/{guid}/lowestagentversion`.
- Fields (verified): Name, Agent Pool, Domain, User OU filter (Allow all / Allow from specified OUs / Allow from manually entered OUs / Deny all), Domains and OUs for user sync, Group OU filter (Allow all / Allow groups from the OUs specified in user filter / specified / manual / Deny all), Domains and OUs for group sync, Deletion settings (Enable deletion, Enable deletion threshold + Threshold percentage, Enable user hard-delete), Mapping definition ("Edit Mapping Definition" button). No secrets on the page (no password inputs).
- Cross-references: Agent pool (agentpools), mapping set (via Mapping Definition), identity provider "AD - <domain>" (Security).
- Public API: NO (agentpools yes, spec line 18, but not the AD config).

## Directory: Entra / AzureAD ("directory integrations")
- URL (verified): `/admin/directoryintegrations` (nav label "AzureAD").
- No XHR; server-rendered. Fields: Url (SCIM endpoint, on identity host `.../service/directory-synchronization/scim`), Secret, "Use hard delete" checkbox; buttons "Delete secret", "New secret".
- SECRET DISPLAY (verified, important): the SCIM secret/token is shown IN CLEARTEXT in a read-only-looking text box (no mask, no 'show' toggle). I did not record it. Treat this page as sensitive; do not screenshot or log it.
- Public API: NO.

## Directory: Google Workspace
- URL (verified): `/admin/googlegsuite`. No XHR (only the telemetry call).
- Fields (verified): ClientID, Client Secret (empty input, placeholder "Enter secret"), Domain Validation ID, Redirect Uri (read-only), Domain Verification URL (read-only, identity host `.../service/gsuite-sync/api/update/{guid}`), Scope (Select Type dropdown), Use hard delete, Authentication status (red = not connected), buttons Force Synchronization and Save. Not configured in Training. Secret input type not checked (page's non-hidden input scan found only one input, so the rest are probably rendered after load; guess: password type).
- Public API: NO.

## Security: Portal access rules and Application access rules
- URLs (verified): `/admin/accessrules/indexlogin` (Portal), `/admin/accessrules/indexapp` (Application). Add: `/Admin/AccessRules/Add?APRuleType=4096` (login type value 4096; app type value not captured). Edit: `/Admin/AccessRules/Edit?AccessRuleGuid={guid}&APRuleType=4096`. Delete: `/Admin/AccessRules/Delete?InAccessRuleGUID={guid}&APRuleType=...`.
- List endpoint (verified): PORTAL `/admin/AccessRules/GetAll` keys=APRuleType,take,skip,page,pageSize,virtual,(+1). Same endpoint serves both rule types, distinguished by APRuleType.
- Columns (verified): Portal: Name, Prio, Login Providers, Time Restriction, IP Restriction, Groups, Two Factor, Source, Actions (Edit, Delete). Application: Name, Prio, Applications, Time Restriction, IP Restriction, Groups, Two Factor, Source, Actions. Info banner states the default permit/deny behaviour. Training: 1 portal rule (a Deny rule for Local provider, with an IP "Not from" restriction and a Groups chip), 0 application rules.
- Edit page is a wizard (verified from text): Perform Action (Deny/Permit), When Accessing, By People, From Locations, From Network, At Time, Between Dates, Via, Message, Rule Name. Endpoints loaded by the wizard (verified): PORTAL `/Admin/Group/GetGroups`, `/admin/AccessRules/GetCountries`, `/admin/AccessRules/GetAuthenticationProviders`, `/admin/SMSConfig/GetSMSConfig`, `/admin/RadiusServers/GetAll` (keys not captured). Cross-references: groups, countries, authentication providers (identity providers, SMS, RADIUS).
- Secrets: none seen. Public API: NO.

## Security: Sign-on policies
- URL (verified): `/admin/settings/usersettings`. No XHR; server-rendered, one Save button.
- Fields (verified, labels): Lock user after number of invalid password entries (toggle), Lock user after invalid password count (number), Unlock user after specified amount of time (toggle), Lock time (minutes), Change password after specified amount of time (toggle), Change password time (days), User session timeout (minutes), Fixed session timeout instead of sliding, Always show login selector page, Allow self service enrollment for MFA via e-mail, Enable remember me for end users, Number of days the end user is remembered. Tenant-wide singleton, no secrets. Public API: NO.

## Security: password self-service and password policies
- Password self service (verified): `/admin/settings/security`. XHR: PORTAL `/admin/SMSProvider/GetDropDownProviderList`. Fields: Password reset enabled, Token valid time (minutes), Number of tries, Send using text (SMS), Token length. Singleton.
- Password policies (verified): `/admin/settings/passwordpolicies`. No XHR. Fields: Show password strength requirements, Minimum/Maximum password length, Minimum/Maximum lowercase, uppercase, numeric, special characters, Regular expression, Excluded characters, Excluded words. Singleton. Public API: NO for both.

## Security: mobile app
- URL (verified): `/admin/settings/deviceauthenticationoptions` (nav "Mobile app security"). No XHR. Fields: PIN enabled, Always reauthenticate when starting the app, Always reauthenticate when resuming the app, Re-authenticate on start timeout (seconds), Re-authenticate on resume timeout (seconds), Force authentication time (days), File selection timeout (seconds). Singleton. Public API: NO.

## Security: roles
- URL (verified): list `/admin/roles`; edit `/Admin/Roles/Edit?RoleGUID={guid}`; also `/Admin/Roles/Clone?RoleGUID=`, `/Admin/Roles/Delete?RoleGUID=`, `/Admin/Roles/Users?RoleGUID=`, `/Admin/Roles/Groups?RoleGUID=`; create `/Admin/Roles/Edit` (no guid).
- List endpoint (verified): PORTAL `/admin/roles/getall` keys=take,skip,page,pageSize,(+1).
- Columns (verified): Role Name, System, Default, Enabled, Actions (Edit, Delete, Clone, Users, Groups). 13 roles in Training (Administrator and User are system roles, read-only; User is the default role). Others are custom or built-in editable roles.
- Edit page (verified): no XHR (server-rendered). Tabs: General (Name, Description, Enabled, Default; buttons Users, Groups) and Rights (a checkbox tree; labels include Manage, Insights, Recertify, View campaigns, Manage campaigns, Start new campaign iteration, Manage recertification settings/requests, View/Manage request history, View, Edit, Manage, Configure, Overview, Create, Edit, Delete, Mark task as succeeded, Restart task, Add, History; group headings not captured so the mapping of rights to areas is unknown).
- Public API: YES roles (spec line 3746); rights set shape in the API not checked.

## Security: API configuration
- URL (verified): list `/admin/apikeys`; edit `/Admin/APIKeys/Edit?id={guid}`; add via "Add Api key" button.
- List endpoint (verified): PORTAL `/admin/APIKeys/GetAll` keys=take,skip,page,pageSize,virtual,(+1).
- Columns (verified): API Key Code, Note, Status, Actions (Edit, Delete). 2 keys in Training.
- Edit page (verified): no XHR; server-rendered. Fields: Key (text, 32 chars, shown plainly), Secret (input type=PASSWORD, value already loaded in the HTML, with a "Show secret" toggle), Enabled, Allowed IP addresses (comma separated; blank means all unless "Use Agent IP Address"), more fields below the fold not captured. Warning text states key and secret must be kept private.
- WARNING (verified, redacted): the Note column of one key contains what looks like key-plus-secret text typed by a user; the full secret appears in the list. Do not export the Note column blindly; mask it.
- Secrets: Secret is masked (password input) but is present in the page source; never click Show secret. Public API: the keys themselves are NOT in the spec (authentication uses them).

## Security: 2FA management and OATH tokens
- URLs (verified): `/admin/advancedmfamanagement` (Management) and `/admin/advancedmfamanagement/oathconfiguration` (OATH tokens).
- Both pages are shells with an IFRAME to the identity host (cross-origin): `training-identity.helloid.cloud/client/mfa-admin` and `.../client/mfa-admin/otp-managed/configuration`. The iframe's own XHR could not be observed (read_network_requests showed none; cross-origin). Endpoints unknown (gap).
- Management fields (verified, screenshot): checkboxes WebAuthn, Push to verify, Hardware token authentication (link "Manage OATH tokens"), Email, SMS (link "Configure", unchecked here), Remember MFA + Days to remember; buttons Cancel, Apply. Tenant-wide singleton.
- OATH page (verified, screenshot): title Token import; buttons Export tokens, Import tokens, Add single token; search; table columns Manufacturer, Model, Serial, Users; pager "0 - 0 of 0 tokens". Training: no tokens. Token seeds are secrets; not seen.
- Public API: NO.

## Authentication: identity providers
- URL (verified): `/admin/identityprovider`; edit `/Admin/IdentityProvider/Edit?InIDPGUID={guid}`; delete `/Admin/IdentityProvider/Delete?InIDPGUID={guid}`.
- List endpoint (verified): PORTAL `/server/v2/admin/identityprovider/getidps` (no keys). Rendered as cards, not a table: name, badges (Enabled, type e.g. Active Directory / Local, System), Edit and Delete (not for the Local system provider). Also an "Identity Provider Downloads" section (AD identity provider installer; not clicked).
- Edit page (verified, labels/types only): tabs Portal Information, Configuration, Client Restrictions. Fields seen: Name, several checkboxes, SSRPM URL, Custom text, Enable text on login page, Directory Configuration (reference to the AD configuration), Change icon (file), Display Icon, Consumer URL, Issuer, Login URL, Custom IDP-initiation URL, Binding (select), Request Certificate / Response Certificate / Response Decryption Certificate (selects; reference to settings certificates), Logout URL, Client Identifier, Client Secret (input type TEXT, empty on this AD provider), Additional scopes, Domain hint, On behalf of scopes, On behalf of client secret (type TEXT, empty here), Hide/Show radios, IP ranges (multi-select). Many fields are type-dependent (SAML/OIDC/AD/Local show different subsets).
- SECRET DISPLAY: Client Secret fields are plain text inputs (not password type) in the DOM; for OIDC/Entra providers they could expose the secret; not verifiable in Training (no such provider). The edit page's XHR list was blocked by the output filter; likely server-rendered.
- Public API: NO.

## Authentication: SMS configuration
- URL (verified): `/admin/smsconfig`; edit `/Admin/SMSConfig/Edit` (guid key not captured).
- List endpoint (verified): PORTAL `/admin/SMSConfig/GetAll` (keys not captured). Columns: Name, Enabled, Actions. Button "Create SMS Configuration". Training: empty, so no detail view. Provider list elsewhere: `/admin/SMSProvider/GetDropDownProviderList`. Provider credentials (API keys) are likely secrets (guess).
- Public API: NO.

## Authentication: RADIUS
- URL (verified): `/admin/radiusservers`. Endpoint (verified): PORTAL `/admin/radiusservers/getall` keys=take,skip,page,pageSize,(+1). Columns: Name, Status, Actions. Training: empty; detail not seen. Shared secret expected (guess).
- Public API: NO.

## Public API coverage summary (verified against spec path list)
Spec has: `/agentpools`, `/applications`, `/groups`, `/groups/batch`, `/roles`, `/users`, `/users/batch`. Not in spec: application categories, mapping sets, AD configs, AzureAD/Google integrations, access rules, sign-on and password policies, password self-service, mobile app, API keys, 2FA/OATH, identity providers, SMS, RADIUS.

## Provisioning-side pattern check
Not done for these areas (Export-HelloID.ps1 was not read; tasks for these areas have no `/server/v2` equivalent seen except users/groups/identityprovider/agentpools/configuration paths above, which are admin-session endpoints).

## User must capture (response bodies, secrets redacted, one sample each)
- PORTAL `/server/v2/admin/users/getall` (sample with Local and AzureAD user; field names for source, status, guid).
- PORTAL `/server/v2/admin/group/getall` (source, status, guid, member counts if any).
- PORTAL `/admin/Users/GetGroupsForUser` and `/admin/users/getuserbyguid/...` (user detail shape, attributes, manager).
- PORTAL `/admin/AccessRules/GetAll` with APRuleType=4096 (rule shape) and one rule's Edit data (page is a wizard; may need the page HTML or the save payload).
- PORTAL `/admin/roles/getall` and a role's Rights data (the Rights tab; may be in the page HTML).
- PORTAL `/admin/APIKeys/GetAll` (verify the secret is NOT in the list payload; redact Key and Secret).
- PORTAL `/admin/adconfigurations/getall`, `/admin/mappingsets/getall`.
- PORTAL `/server/v2/admin/identityprovider/getidps` (type enum, secret fields).
- Create one test application and category first (Training has none) if applications/categories must be mapped; then capture `/admin/Applications/getall` and `/admin/applicationcategories/getCategoriesAsync`.
- HTTP method for all Kendo `getall` endpoints (GET vs POST) and body shape (Kendo filter/sort).
- 2FA iframe XHR (identity host `/client/mfa-admin`) from DevTools network panel.
- Mapping set attribute/mapping definitions (Change attributes / Change mappings) and settings pages that have no XHR (they are in the HTML, so a "view source" of the edit pages is the only way).
