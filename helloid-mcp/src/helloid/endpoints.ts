// Every HelloID path in one place. Later phases add the gateway paths of their tools here.
// Portal paths are relative to the environment's baseUrl, gateway paths to its gateway origin.

/** Rows asked for in one go from lists that come in pages, as HelloID's own pages do. */
export const TAKE_ALL = 999999;

export const PORTAL = {
  /** The Bearer token(s) of the logged-in admin; needs the portal's cookies. */
  token: '/server/v2/security/token',
  /** The bootstrap of Provisioning; names the gateway (the provisioning API server). */
  bootstrapProvisioning: '/server/v2/bootstrap/provisioning',
  /** The start page; without a login it redirects to the sign-in page. */
  start: '/',
  /** The sign-in page with the identity providers (public). */
  signIn: '/Authentication/SignIn?ReturnUrl=%2F',
} as const;

/** A path segment of an ID (encoded). */
const id = (value: string | number) => encodeURIComponent(String(value));

// Gateway paths, as the userscript (HelloID-UX-improvements.user.js) and HelloID's own pages use them.
export const GATEWAY = {
  // Target systems
  /** All target systems with their general configuration; query showReferenceSystems=true. */
  targetSystems: '/service/provisioning-api/api/target-systems',
  /** The systems that depend on a system; query systemId, cachebust. */
  systemsDependingOn: '/service/provisioning-api/api/target-systems/get-systems-depending-on',
  powershellConfiguration: (systemId: string) => `/connector/powershell-target/api/configuration/${id(systemId)}`,
  powershellDefaultScripts: (systemId: string) => `/connector/powershell-target/api/configuration/${id(systemId)}/default`,
  powershellResources: (systemId: string) => `/connector/powershell-target/api/resources/${id(systemId)}`,
  azureAdConfiguration: (systemId: string) => `/connector/azure-active-directory/api/configuration/${id(systemId)}`,
  activeDirectoryConfiguration: (systemId: string) => `/connector/active-directory/api/configuration/${id(systemId)}`,
  /** The rules with an entitlement for a system (published); query skip, take. */
  entitlementsOverview: (systemId: string) => `/api/connectors/shared/rules/published/${id(systemId)}/entitlements-overview`,
  // Agents
  agentSelection: (systemId: string) => `/service/agent-repository/api/agents/selected-agents/${id(systemId)}`,
  agentSelectionSummary: (systemId: string) => `/service/agent-repository/api/agents/selections/summary/${id(systemId)}`,
  /** POST with a selection: all agents, the selected ones marked (it only looks them up). */
  agents: '/service/agent-repository/api/agents',
  // Source systems
  sourceSystems: '/service/provisioning-api/api/source-systems',
  sourceSystem: (systemId: string) => `/service/provisioning-api/api/source-systems/${id(systemId)}`,
  /** The catalog of source system templates; query take. */
  sourceCatalog: '/service/provisioning-api/api/systems-catalog/source',
  // Business rules and entitlements
  /** POST { search, skip, take, published, draft }; query cachebust. */
  rulesOverview: '/service/rules/api/rules/overview',
  rule: (ruleId: string) => `/service/rules/api/rules/${id(ruleId)}`,
  /** Query draft=false. */
  ruleConditionSummary: (ruleId: string) => `/service/rules/api/rules/${id(ruleId)}/condition-summary`,
  /** The rules with an entitlement; query skip, take, published, draft. */
  rulesForEntitlement: (entitlementId: string) => `/service/rules/api/rules/entitlement/${id(entitlementId)}`,
  /** All entitlements rules can have; query skip, take. */
  entitlements: '/service/rules/api/entitlements',
  /** Query take. */
  toxicCombinations: '/service/rules/api/toxic-combinations',
  /** Query entitlementIds (repeated). */
  toxicEntitlementsByIds: '/service/rules/api/toxic-combinations/entitlements/by-ids',
  // Notifications
  /** Query skip, take, enabled=false, disabled=false (no filter). */
  notifications: '/service/notifications/api/notifications',
  notification: (identifier: string) => `/service/notifications/api/notifications/${id(identifier)}`,
  notificationSystems: '/service/notifications/api/notification/systems',
  notificationSystem: (systemId: string) => `/service/notifications/api/notification/systems/${id(systemId)}`,
  /** Query take. */
  customEvents: '/service/notifications/api/custom-events',
  // Settings
  /** The schedules of the snapshots; query timeZone. */
  schedule: '/service/scheduler/api/schedule',
  reconciliationSchedule: '/service/scheduler/api/schedule/reconciliation/configuration',
  reconciliationSystems: '/service/reconciliation/api/report/system-configuration',
  /** POST { search, filters, skip, take }; query forBulkActions=false. */
  reconciliationExclusions: '/service/reconciliation/api/exclusions',
  calculatedLayers: '/service/provisioning-integration/api/calculatedlayers/config',
  customFields: '/service/provisioning-integration/api/customfields',
  aggregation: '/service/provisioning-pipeline/api/aggregation/automatic/configuration',
  personLifecycle: '/service/provisioning-pipeline/api/person-lifecycle',
  // Persons
  /** Query skip, take, search, includedOnly, excludedOnly. */
  vaultPersons: '/service/provisioning-integration/api/vault/latest/persons',
  /** Query skip, take, search, cachebust. */
  personsOverview: '/service/provisioning-integration/api/vault/latest/persons-overview',
  /** Query take, skip, person (optional). */
  granted: '/service/rule-enforcement/api/enforcedstate/granted',
  // Evaluation
  /** Query take. */
  evaluationRuns: '/service/rule-evaluation/api/evaluation/runs',
  /** Query take, skip. */
  evaluationReport: (runId: string) => `/service/rule-enforcement/api/evaluation-report/${id(runId)}`,
  /** Query take, origins (repeated), logLevels (repeated). */
  evaluationLogging: (runId: string) => `/service/rule-evaluation/api/evaluation/${id(runId)}/logging`,
  /**
   * POST, no body; query enforce. Answers the run ID as a JSON string. enforce=true only from
   * helloid_apply_enforcement (allowEnforce); every other caller sends enforce=false.
   */
  evaluationStart: '/service/rule-evaluation/api/evaluation/start',
  /** POST the rule as JSON; query skip, take, calculateTotalRowCount. Answers a server-sent event stream. */
  evaluateRulePersons: '/service/rule-evaluation/api/evaluation/evaluate/rule/persons',
  /** The persons of a rule in the last evaluation (display names); query skip, take. */
  ruleResultPersons: (ruleId: string) => `/service/rule-evaluation/api/evaluation/results/rule/${id(ruleId)}/persons`,
} as const;

// The paths of the delete tools (helloid_plan_delete, helloid_apply_delete): the delete requests and
// the checks HelloID's own pages make before them (from a recording of those pages).
export const DELETE_PATHS = {
  // Delete requests (HelloID answers 200 with an empty body)
  targetSystem: (systemId: string) => `/service/provisioning-api/api/target-systems/${id(systemId)}`,
  sourceSystem: (systemId: string) => `/service/provisioning-api/api/source-systems/${id(systemId)}`,
  /** revoke true: revoke the entitlements; false: mark them unmanaged. A draft-only rule: true, as HelloID's page sends. */
  businessRule: (ruleId: string, revoke: boolean) => `/service/rules/api/rules/${id(ruleId)}/${revoke}`,
  notification: (identifier: string) => `/service/notifications/api/notifications/${id(identifier)}`,
  notificationSystem: (systemId: string) => `/service/notifications/api/notification/systems/${id(systemId)}`,
  customEvent: (eventId: string) => `/service/notifications/api/custom-events/${id(eventId)}`,
  toxicCombination: (combinationId: string) => `/service/rules/api/toxic-combinations/${id(combinationId)}`,
  // Checks
  /** Whether the source system has blocked persons; answers true or false. */
  blockedPersonsAny: (systemId: string) => `/service/provisioning-integration/api/blockedpersons/${id(systemId)}/any`,
  /** The snapshot status of a source system ({ isBusy, ... }); query systemId. */
  snapshotStatus: '/service/provisioning-pipeline/api/snapshot/status',
  /** Whether notifications use the custom event; answers true or false. */
  customEventUsed: (eventId: string) => `/service/notifications/api/custom-events/${id(eventId)}/used`,
} as const;

// The paths of the entitlement actions (pending, history, retry), blocked actions (approve) and the
// health checks, as HelloID's Entitlements pages and its header send them (from recordings of those
// pages). Lists answer { pageData, totalRowCount } unless noted.
export const ACTION_PATHS = {
  /** The pending (open) entitlement actions; query take, search. */
  pending: '/service/rule-enforcement/api/actions/overview',
  /**
   * The history of the entitlement actions; query take, search, results (repeated). HelloID caps
   * totalRowCount at 5000 (then exceededTotalRowCountLimit is true).
   */
  history: '/service/rule-enforcement/api/actions/history/overview',
  /** The log messages of one action in the history ({ logMessages, moreDataAvailable, ... }); query cachebust. */
  historyLogging: (actionId: string) => `/service/rule-enforcement/api/actions/history/${id(actionId)}/logging`,
  /** POST {}: retries an action of the history; answers 200 with an empty body. */
  retry: (systemId: string, actionId: string) => `/service/rule-enforcement/api/actions/history/retry/${id(systemId)}/${id(actionId)}`,
  /** The entitlement types (codes 1-3) per target system: { "<systemId>": [codes] }. */
  entitlementTypes: '/service/rule-enforcement/api/entitlement-import/entitlement-types',
  /** Whether any entitlement actions are blocked; answers true or false. */
  blockedAny: '/service/rule-enforcement/api/enforcedstate/blocked/any',
  /** The blocked groups; query take, systems (repeated, every target system), types (1-3), operations (0-2). */
  blockedOverview: '/service/rule-enforcement/api/enforcedstate/blocked/overview',
  /** The actions of one blocked group; query take, system, type (Account, AccountAccess, Permission), operation. */
  blockedDetails: '/service/rule-enforcement/api/enforcedstate/blocked/details',
  /** POST {}: approves (processes) every action of one blocked group; answers 200 with an empty body. */
  processBlocked: (systemId: string, type: string, operation: number) =>
    `/service/rule-enforcement/api/enforcedstate/process-blocked/${id(systemId)}/${id(type)}/${id(operation)}`,
  // Health checks (HelloID's header and Entitlements pages)
  /** Whether there are orphaned entitlements; answers true or false. */
  orphanedAny: '/service/rules/api/entitlements/orphaned/any',
  /** Whether the reference cleaner is active; answers true or false. */
  referenceCleanerActive: '/service/maintenance/api/reference-cleaner/is-active',
  /** The latest snapshot per target system: { "<systemId>": { status, succeeded, errorMessage, startedOn, completedOn, ... } }. */
  latestSnapshots: '/service/provisioning-api/api/target-systems/snapshots/latest',
  /** The time of the latest successful snapshot per target system: { "<systemId>": "<time>" }. */
  latestSuccessfulSnapshotTimes: '/service/provisioning-api/api/target-systems/snapshots/latest/successful-times',
} as const;

// The paths of publishing and cloning a business rule (helloid_plan_publish_rule,
// helloid_apply_publish_rule, helloid_clone_business_rule). Publishing is from a recording of
// HelloID's Business rules page; the copy is the request the userscript's "Clone rule" sends.
export const RULE_PATHS = {
  /**
   * What publishing the rule's draft would change: { personCounts: { current, added, removed },
   * entitlementCounts: { current, added, removed }, addedEntitlements: [names] | null,
   * removedEntitlements: [names] | null }. changeId: the rule's changeId (GET rule).
   */
  publishSummary: (ruleId: string, changeId: string) =>
    `/service/rule-evaluation/api/evaluation/evaluate/rule/${id(ruleId)}/summary/${id(changeId)}`,
  /** PUT with the summary's names and counts, the changeId and unmanageRemovedEntitlements; answers an empty 200. */
  publish: (ruleId: string) => `/service/rules/api/rules/publish/${id(ruleId)}`,
  /** PUT {}: copies a rule; answers the new rule's ID (a string, or an object with ruleId or id). Not in a recording. */
  copy: (ruleId: string) => `/service/rules/api/rules/copy/${id(ruleId)}`,
} as const;

// The paths of the dry runs and previews of target system scripts (helloid_list_dryrun_persons,
// helloid_preview_field_mapping, helloid_dryrun_*), from recordings of HelloID's script editors.
// The connector paths start with connectorApi(templateIdentifier): /connector/<templateIdentifier>/api.
// Only powershell-target was recorded; that powershell-onpremise has its own prefix is to be
// verified (the configuration and mapping of both types are read and written under
// /connector/powershell-target/api, see GATEWAY and IMPORT_PATHS).
export const DRYRUN_PATHS = {
  /** The persons to pick for a dry run ({ pageData: [{ personId, displayName }], totalRowCount }); query skip, take, search. */
  selectionPersons: '/service/provisioning-integration/api/vault/latest/selection-persons',
  /**
   * The person as the scripts see it, for one system: { person, accountReference, manager,
   * managerAccountReference }; query cachebust.
   */
  personPreview: (systemId: string, personId: string) =>
    `/service/rule-enforcement/api/entitlements/${id(systemId)}/${id(personId)}/actions/data/preview`,
  /** The prefix of a target system type's connector API (powershell-target recorded; others to be verified). */
  connectorApi: (templateIdentifier: string) => `/connector/${id(templateIdentifier)}/api`,
  /** The field mapping ({ fields, fieldsNotInFilter }); query cachebust, usedInNotificationOption, storedInAccountDataOption, noOption. */
  mapping: (api: string, systemId: string) => `${api}/mapping/${id(systemId)}`,
  /** POST { personId, fields, action }: the value of every field for the person ({ <identifier>: { field, value, hasError, error } }). */
  mappingPreview: (api: string, systemId: string) => `${api}/mapping/${id(systemId)}/preview`,
  /** The uniqueness check ({ script, mappingEntitlementActions, selectedUniqueFields }). */
  uniqueness: (api: string, systemId: string) => `${api}/mapping/${id(systemId)}/uniqueness`,
  /** The permissions of a permission set ({ pageData: [{ displayName, entitlementId, reference }], totalRowCount }); query skip, take. */
  permissions: (api: string, systemId: string, permissionDefinitionId: string) =>
    `${api}/configuration/${id(systemId)}/permissions/${id(permissionDefinitionId)}`,
  /** POST: runs an account script (context 1) or a permission script (context 2) with DryRun on. */
  previewEntitlementAction: (api: string) => `${api}/preview/entitlement-action`,
  /** POST { script, systemId, executeOnPremises }: runs an import permissions script (context 16). */
  previewPermissionImport: (api: string) => `${api}/preview/permission-import`,
  /** POST: runs the uniqueness script (context 128). */
  previewUniquenessCheck: (api: string) => `${api}/preview/uniqueness-check`,
} as const;

// The paths of the import (helloid_plan_import, helloid_apply_plan), as the userscript's import
// sends them (the names are the userscript's). Like the userscript, they are full paths with their
// query; an `id` given as "encoded" was encoded by the caller, as the userscript does.
const enc = (value: string) => encodeURIComponent(value);
export const IMPORT_PATHS = {
  /** All target systems (the userscript's SYSTEMS_PATH). */
  systems: '/service/provisioning-api/api/target-systems?showReferenceSystems=true',
  /** GET: is a target system named so? Answers true or false. */
  targetNameExists: (name: string) => `/service/provisioning-api/api/target-systems/exists?name=${enc(name)}`,
  dependOnSystems: (encoded: string) => `/service/provisioning-api/api/target-systems/${encoded}/depend-on-systems`,
  /** POST {}: lets HelloID retrieve the permissions of a system (answers when done, or fails after 30 s). */
  retrievePermissions: (encoded: string) =>
    `/service/provisioning-api/api/target-systems/snapshots/create/${encoded}?permissionsOnly=true`,
  /** POST {}: makes a new, empty system of a type; answers its ID. */
  createSystem: {
    'powershell-target': '/connector/powershell-target/api/configuration/create/powershell-target',
    'powershell-onpremise': '/connector/powershell-target/api/configuration/create/powershell-onpremise',
    activedirectory: '/connector/active-directory/api/configuration/create/activedirectory',
  } as Record<string, string>,
  powershellConfiguration: (encoded: string) => `/connector/powershell-target/api/configuration/${encoded}`,
  powershellPart: (encoded: string, part: string) => `/connector/powershell-target/api/configuration/${encoded}/${part}`,
  powershellResources: (encoded: string) => `/connector/powershell-target/api/resources/${encoded}`,
  powershellMapping: (encoded: string, part: string) => `/connector/powershell-target/api/mapping/${encoded}/${part}`,
  activeDirectoryConfiguration: (encoded: string) => `/connector/active-directory/api/configuration/${encoded}`,
  activeDirectoryPart: (encoded: string, part: string) => `/connector/active-directory/api/configuration/${encoded}/${part}`,
  activeDirectoryMapping: (encoded: string, part: string) => `/connector/active-directory/api/mapping/${encoded}/${part}`,
  azureAdConfiguration: (encoded: string) => `/connector/azure-active-directory/api/configuration/${encoded}`,
  agentSelection: (encoded: string) => `/service/agent-repository/api/agents/selected-agents/${encoded}`,
  entitlementsOverview: (systemId: string, take: number) =>
    `/api/connectors/shared/rules/published/${enc(systemId)}/entitlements-overview?skip=0&take=${take}`,
  // Source systems
  sourceSystems: '/service/provisioning-api/api/source-systems',
  sourceSystem: (id: string) => `/service/provisioning-api/api/source-systems/${enc(id)}`,
  sourceCatalog: (take: number) => `/service/provisioning-api/api/systems-catalog/source?take=${take}`,
  // Notifications
  notifications: '/service/notifications/api/notifications',
  allNotifications: (take: number) => `/service/notifications/api/notifications?skip=0&take=${take}&enabled=false&disabled=false`,
  notification: (id: string) => `/service/notifications/api/notifications/${enc(id)}`,
  notificationSystems: '/service/notifications/api/notification/systems',
  notificationSystem: (id: string) => `/service/notifications/api/notification/systems/${enc(id)}`,
  notificationSystemNameExists: (name: string) => `/service/notifications/api/notification/systems/exists?name=${enc(name)}`,
  customEventList: (take: number) => `/service/notifications/api/custom-events?take=${take}`,
  customEvents: '/service/notifications/api/custom-events',
  customEvent: (id: string) => `/service/notifications/api/custom-events/${enc(id)}`,
  // Business rules, entitlements, toxic policies
  rules: '/service/rules/api/rules',
  rule: (id: string) => `/service/rules/api/rules/${enc(id)}`,
  ruleEntitlements: (take: number) => `/service/rules/api/entitlements?skip=0&take=${take}`,
  toxic: '/service/rules/api/toxic-combinations',
  // Settings
  schedule: '/service/scheduler/api/schedule',
  calculatedLayers: '/service/provisioning-integration/api/calculatedlayers',
  customFields: '/service/provisioning-integration/api/customfields',
  aggregation: '/service/provisioning-pipeline/api/aggregation/automatic/configuration',
  personLifecycle: '/service/provisioning-pipeline/api/person-lifecycle',
  vaultPersons: (included: boolean, take: number) =>
    `/service/provisioning-integration/api/vault/latest/persons?skip=0&take=${take}&search=&includedOnly=${included}&excludedOnly=${!included}`,
  /** PUT {}: action exclude or include. */
  person: (action: string, id: string) => `/service/provisioning-integration/api/vault/latest/person/${action}?personId=${enc(id)}`,
  reconciliationSchedule: '/service/scheduler/api/schedule/reconciliation/configuration',
  reconciliationSystems: '/service/reconciliation/api/report/system-configuration',
  reconciliationExclusions: '/service/reconciliation/api/exclusions?forBulkActions=false',
} as const;

/** Encodes one path segment (an ID or name taken from a caller). */
export function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

export type QueryValue = string | number | boolean | undefined | ReadonlyArray<string | number>;

/** A path with a query string; undefined values are left out, arrays repeat the key. */
export function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path;
}

/** The cachebust value HelloID's pages send: the time in milliseconds. */
export function cachebust(now: () => number = Date.now): number {
  return now();
}
