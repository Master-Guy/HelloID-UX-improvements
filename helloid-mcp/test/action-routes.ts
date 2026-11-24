// The gateway routes of the entitlement action tools (pending, history, logging, retry, blocked,
// approve, entitlement types) and of the health checks on the fake HelloID, in HelloID's response
// shapes (from recordings of HelloID's Entitlements pages). All data is made up.

import type { FakeHelloId, FakeRequest, FakeResponse } from './fake-helloid.ts';
import { type Fixture, IDS } from './fixture-routes.ts';

const ok = (body: unknown = ''): FakeResponse => ({ body });
const notFound: FakeResponse = { status: 404, body: { message: 'Not found' } };
const ID = '([^/]+)';
const exact = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\(ID\\)', ID)}$`);
const idOf = (request: FakeRequest, pattern: RegExp, group = 1) => decodeURIComponent(pattern.exec(request.path)?.[group] ?? '');

export const ACTION_IDS = {
  pending1: 'a0000000-0000-4000-8000-000000000001',
  pending2: 'a0000000-0000-4000-8000-000000000002',
  pending3: 'a0000000-0000-4000-8000-000000000003',
  failed1: 'f0000000-0000-4000-8000-000000000001',
  failed2: 'f0000000-0000-4000-8000-000000000002',
  success1: 'f0000000-0000-4000-8000-000000000003',
  skipped1: 'f0000000-0000-4000-8000-000000000004',
  run: 'c0000000-0000-4000-8000-000000000001',
  entitlementAccount: 'e0000000-0000-4000-8000-000000000001',
  entitlementGroup: 'e0000000-0000-4000-8000-000000000002',
  entitlementMailbox: 'e0000000-0000-4000-8000-000000000003',
} as const;

const TYPE_NAMES: Record<string, string> = { 1: 'Account', 2: 'AccountAccess', 3: 'Permission' };

const entitlement = (entitlementId: string, systemId: string, type: string, displayName: string, permissionDefinitionDisplayName: string | null) => ({
  entitlementId,
  systemIdentifier: systemId,
  type,
  displayName,
  permissionDefinitionDisplayName,
});
const ACCOUNT = entitlement(ACTION_IDS.entitlementAccount, IDS.alpha, 'Account', 'Account', null);
const GROUP = entitlement(ACTION_IDS.entitlementGroup, IDS.alpha, 'Permission', 'Group - Sales', 'Groups');
const MAILBOX = entitlement(ACTION_IDS.entitlementMailbox, IDS.beta, 'AccountAccess', 'Mailbox access', null);
const person = (personId: string, displayName: string) => ({ personId, displayName });
const ANNA = person(IDS.anna, 'Anna Example (E001)');
const BRAM = person(IDS.bram, 'Bram Sample (E002)');
const DANA = person(IDS.dana, 'Dana Nomatch (E004)');

/** Made-up action data in HelloID's shapes. */
export function actionData() {
  const history = (actionId: string, who: { personId: string; displayName: string }, ent: ReturnType<typeof entitlement>, operation: number, result: number, finishedOn: string) => ({
    actionId,
    runId: ACTION_IDS.run,
    personEntitlementId: { personId: who.personId, entitlementId: ent.entitlementId },
    entitlement: ent,
    personRef: who,
    operation,
    createdOn: '2026-03-01T09:00:00.000Z',
    origins: [1, 4],
    fromRules: [IDS.r1],
    matchingContracts: ['C-0001'],
    finishedOn,
    result,
  });
  return {
    pendingActions: [
      { actionId: ACTION_IDS.pending1, entitlement: GROUP, personRef: ANNA, origins: [1, 3], operation: 0, createdOn: '2026-03-02T08:00:00.000Z', actionInitiated: false, waitingReasons: ['Granted account'] },
      { actionId: ACTION_IDS.pending2, entitlement: GROUP, personRef: BRAM, origins: [1, 3], operation: 0, createdOn: '2026-03-02T08:00:00.000Z', actionInitiated: false, waitingReasons: ['Granted account'] },
      { actionId: ACTION_IDS.pending3, entitlement: MAILBOX, personRef: DANA, origins: [0], operation: 1, createdOn: '2026-03-02T08:05:00.000Z', actionInitiated: true, waitingReasons: [] },
    ] as any[],
    actionHistory: [
      history(ACTION_IDS.failed1, ANNA, GROUP, 0, 0, '2026-03-01T09:00:05.000Z'),
      history(ACTION_IDS.success1, BRAM, ACCOUNT, 2, 1, '2026-03-01T09:00:04.000Z'),
      history(ACTION_IDS.failed2, DANA, MAILBOX, 1, 0, '2026-03-01T09:00:03.000Z'),
      history(ACTION_IDS.skipped1, BRAM, GROUP, 0, 2, '2026-03-01T09:00:02.000Z'),
    ] as any[],
    actionLogging: {
      [ACTION_IDS.failed1]: [
        { message: 'Failed to grant permission \'Group - Sales\', message: Error running script', messageTimeUtc: '2026-03-01T09:00:05.100Z', level: 3, scopeId: ACTION_IDS.run, objectId: `${IDS.anna}.${ACTION_IDS.entitlementGroup}` },
        { message: 'Error granting group to account: the account does not exist.', messageTimeUtc: '2026-03-01T09:00:05.000Z', level: 2, scopeId: ACTION_IDS.run, objectId: `${IDS.anna}.${ACTION_IDS.entitlementGroup}` },
      ],
    } as Record<string, any[]>,
    retries: [] as string[],
    entitlementTypes: { [IDS.alpha]: [1, 3], [IDS.beta]: [1, 2, 3] } as Record<string, number[]>,
    blockedGroups: [
      { operation: 2, entitlementType: 'Account', system: { systemId: IDS.alpha, displayName: 'Alpha Directory', templateIdentifier: 'powershell-target' }, configuration: 'Blocking when at least 5', count: 6, processing: false },
      { operation: 1, entitlementType: 'Permission', system: { systemId: IDS.alpha, displayName: 'Alpha Directory', templateIdentifier: 'powershell-target' }, configuration: 'Blocking when at least 2', count: 3, processing: false },
    ] as any[],
    blockedDetails: {
      [`${IDS.alpha}|Account|2`]: ['Anna Example (E001)', 'Bram Sample (E002)', 'Chris Excluded (E003)', 'Dana Nomatch (E004)', 'Eve Person (E005)', 'Finn Person (E006)'].map((name) => ({
        personDisplayName: name,
        entitlementName: 'Account',
        permissionDefinitionDisplayName: null,
      })),
      [`${IDS.alpha}|Permission|1`]: ['Anna Example (E001)', 'Bram Sample (E002)', 'Dana Nomatch (E004)'].map((name) => ({
        personDisplayName: name,
        entitlementName: 'Group - Sales',
        permissionDefinitionDisplayName: 'Groups',
      })),
    } as Record<string, any[]>,
    approvals: [] as string[],
    orphanedAny: false as unknown,
    referenceCleanerActive: false as unknown,
    latestSnapshots: {
      [IDS.alpha]: { snapshotId: 'b0000000-0000-4000-8000-000000000001', systemId: IDS.alpha, status: 4, succeeded: true, validationErrors: false, errorMessage: null, startedOn: '2026-03-01T01:00:00.000Z', completedOn: '2026-03-01T01:00:03.000Z', accountsImported: 4, accountAccessImported: 0, permissionsImported: 2, permissionMembershipsImported: 3 },
      [IDS.beta]: { snapshotId: 'b0000000-0000-4000-8000-000000000002', systemId: IDS.beta, status: 4, succeeded: false, validationErrors: false, errorMessage: 'No valid agent found to perform action', startedOn: '2026-03-01T02:00:00.000Z', completedOn: '2026-03-01T02:00:01.000Z', accountsImported: 0, accountAccessImported: 0, permissionsImported: 0, permissionMembershipsImported: 0 },
    } as Record<string, any>,
    successfulSnapshotTimes: { [IDS.alpha]: '2026-03-01T01:00:03.000Z', [IDS.beta]: '2026-02-20T02:00:01.000Z' } as Record<string, string>,
  };
}

export type ActionData = ReturnType<typeof actionData>;

/** take of the query applied to rows (HelloID's pages send no skip). */
const taken = (request: FakeRequest, rows: unknown[]) => rows.slice(0, Number(request.query.get('take') ?? rows.length));
const searched = (request: FakeRequest, rows: any[]) => {
  const search = (request.query.get('search') ?? '').toLowerCase();
  return rows.filter((r) => !search || String(r.personRef?.displayName).toLowerCase().includes(search) || String(r.entitlement?.displayName).toLowerCase().includes(search));
};

/** Installs the routes on top of installFixtures (later routes win); the action data is put in data.actions. */
export function installActionRoutes(fake: FakeHelloId, data: Fixture, actions: ActionData = actionData()): ActionData {
  const route = (method: string, path: string | RegExp, handler: (request: FakeRequest) => FakeResponse) => fake.route(method, path, handler);
  data.actions = actions;

  route('GET', '/service/rule-enforcement/api/actions/overview', (r) => {
    const rows = searched(r, actions.pendingActions);
    return ok({ pageData: taken(r, rows), totalRowCount: rows.length });
  });
  route('GET', '/service/rule-enforcement/api/actions/history/overview', (r) => {
    const filter = (name: string) => r.query.getAll(name);
    const [results, operations, types, systems] = ['results', 'operations', 'types', 'systems'].map(filter) as [string[], string[], string[], string[]];
    const rows = searched(r, actions.actionHistory).filter(
      (row) =>
        (!results.length || results.includes(String(row.result))) &&
        (!operations.length || operations.includes(String(row.operation))) &&
        (!types.length || types.some((t) => TYPE_NAMES[t] === row.entitlement.type)) &&
        (!systems.length || systems.includes(row.entitlement.systemIdentifier)),
    );
    return ok({ exceededTotalRowCountLimit: false, pageData: taken(r, rows), totalRowCount: rows.length });
  });
  const logging = exact('/service/rule-enforcement/api/actions/history/(ID)/logging');
  route('GET', logging, (r) =>
    ok({ logMessages: actions.actionLogging[idOf(r, logging)] ?? [], skipToken: '', moreDataAvailable: false, stackdriverQuery: '', containsOutdatedLogging: false }),
  );
  const retry = exact('/service/rule-enforcement/api/actions/history/retry/(ID)/(ID)');
  route('POST', retry, (r) => {
    const actionId = idOf(r, retry, 2);
    const row = actions.actionHistory.find((a) => a.actionId === actionId);
    if (!row || row.entitlement.systemIdentifier !== idOf(r, retry)) return notFound;
    actions.retries.push(actionId);
    return ok();
  });
  route('GET', '/service/rule-enforcement/api/entitlement-import/entitlement-types', () => ok(actions.entitlementTypes));

  route('GET', '/service/rule-enforcement/api/enforcedstate/blocked/any', () => ok(actions.blockedGroups.length > 0));
  route('GET', '/service/rule-enforcement/api/enforcedstate/blocked/overview', (r) => {
    const systems = r.query.getAll('systems');
    const types = r.query.getAll('types');
    const operations = r.query.getAll('operations');
    const rows = actions.blockedGroups.filter(
      (g) => systems.includes(g.system.systemId) && types.some((t) => TYPE_NAMES[t] === g.entitlementType) && operations.includes(String(g.operation)),
    );
    return ok({ pageData: taken(r, rows), totalRowCount: rows.length });
  });
  route('GET', '/service/rule-enforcement/api/enforcedstate/blocked/details', (r) => {
    const rows = actions.blockedDetails[`${r.query.get('system')}|${r.query.get('type')}|${r.query.get('operation')}`] ?? [];
    return ok({ pageData: taken(r, rows), totalRowCount: rows.length });
  });
  const process = exact('/service/rule-enforcement/api/enforcedstate/process-blocked/(ID)/(ID)/(ID)');
  route('POST', process, (r) => {
    const [systemId, type, operation] = [1, 2, 3].map((g) => idOf(r, process, g));
    const group = actions.blockedGroups.find((g) => g.system.systemId === systemId && g.entitlementType === type && String(g.operation) === operation);
    if (!group) return notFound;
    group.processing = true;
    actions.approvals.push(`${systemId}/${type}/${operation}`);
    return ok();
  });

  route('GET', '/service/rules/api/entitlements/orphaned/any', () => ok(actions.orphanedAny));
  route('GET', '/service/maintenance/api/reference-cleaner/is-active', () => ok(actions.referenceCleanerActive));
  route('GET', '/service/provisioning-api/api/target-systems/snapshots/latest', () => ok(actions.latestSnapshots));
  route('GET', '/service/provisioning-api/api/target-systems/snapshots/latest/successful-times', () => ok(actions.successfulSnapshotTimes));
  return actions;
}

/** The POST requests sent, as "POST <path> <body>". */
export function posts(requests: FakeRequest[]): string[] {
  return requests.filter((r) => r.method === 'POST').map((r) => `POST ${r.path} ${r.body}`);
}
