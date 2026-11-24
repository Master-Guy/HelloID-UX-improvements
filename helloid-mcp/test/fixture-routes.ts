// The gateway routes of the read, report and evaluation tools on the fake HelloID, answering from the
// synthetic fixtures in fixtures/environment.json (HelloID's response shapes, made-up data).

import { readFileSync } from 'node:fs';
import type { FakeHelloId, FakeRequest, FakeResponse } from './fake-helloid.ts';

export type Fixture = Record<string, any>;

export const IDS = {
  alpha: '11111111-1111-4111-8111-111111111111',
  beta: '22222222-2222-4222-8222-222222222222',
  gamma: '33333333-3333-4333-8333-333333333333',
  hr: '44444444-4444-4444-8444-444444444444',
  missing: '99999999-9999-4999-8999-999999999999',
  email: '55555555-5555-4555-8555-555555555551',
  notify: '55555555-5555-4555-8555-555555555552',
  n1: '66666666-6666-4666-8666-666666666661',
  n2: '66666666-6666-4666-8666-666666666662',
  n3: '66666666-6666-4666-8666-666666666663',
  r1: '77777777-7777-4777-8777-777777777771',
  r2: '77777777-7777-4777-8777-777777777772',
  r3: '77777777-7777-4777-8777-777777777773',
  e1: '88888888-8888-4888-8888-888888888881',
  e3: '88888888-8888-4888-8888-888888888883',
  ce1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  tx1: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  anna: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  bram: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
  chris: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
  dana: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  run1: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  run2: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
  log2: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeee009',
} as const;

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(new URL('./fixtures/environment.json', import.meta.url), 'utf8')) as Fixture;
}

const ok = (body: unknown): FakeResponse => ({ body });
const notFound: FakeResponse = { status: 404, body: { message: 'Not found' } };
/** The ID in a path matched by a regex with one group. */
const idOf = (request: FakeRequest, pattern: RegExp) => decodeURIComponent(pattern.exec(request.path)?.[1] ?? '');
const byId = (map: Record<string, unknown> | undefined, pattern: RegExp) => (request: FakeRequest) => {
  const value = map?.[idOf(request, pattern)];
  return value === undefined ? notFound : ok(value);
};
/** skip and take of the query applied to rows. */
const paged = (request: FakeRequest, rows: unknown[]) => {
  const skip = Number(request.query.get('skip') ?? 0);
  const take = Number(request.query.get('take') ?? rows.length);
  return rows.slice(skip, skip + take);
};

const ID = '([^/]+)';

/** Installs the routes; `data` is the fixture (changed by a test to change HelloID's answers). */
export function installFixtures(fake: FakeHelloId, data: Fixture = loadFixture()): Fixture {
  const route = (method: string, path: string | RegExp, handler: (request: FakeRequest) => FakeResponse) => fake.route(method, path, handler);
  const exact = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\(ID\\)', ID)}$`);

  // Target systems
  route('GET', '/service/provisioning-api/api/target-systems', () => ok(data.targetSystems));
  route('GET', '/service/provisioning-api/api/target-systems/get-systems-depending-on', (r) =>
    ok(data.targetSystems.filter((s: any) => (s.dependOnSystems ?? []).some((d: any) => d.systemId === r.query.get('systemId'))).map((s: any) => ({ systemId: s.systemId, displayName: s.displayName }))),
  );
  const psConfig = exact('/connector/powershell-target/api/configuration/(ID)');
  route('GET', psConfig, byId(data.powershellConfigurations, psConfig));
  const psDefault = exact('/connector/powershell-target/api/configuration/(ID)/default');
  route('GET', psDefault, byId(data.powershellDefaultScripts, psDefault));
  const psResources = exact('/connector/powershell-target/api/resources/(ID)');
  route('GET', psResources, byId(data.powershellResources, psResources));
  const azure = exact('/connector/azure-active-directory/api/configuration/(ID)');
  route('GET', azure, byId(data.azureAdConfigurations, azure));
  const overview = exact('/api/connectors/shared/rules/published/(ID)/entitlements-overview');
  route('GET', overview, (r) => ok(data.entitlementsOverview[idOf(r, overview)] ?? { pageData: [], totalRowCount: 0 }));
  // Agents
  const selected = exact('/service/agent-repository/api/agents/selected-agents/(ID)');
  route('GET', selected, byId(data.agentSelections, selected));
  const summary = exact('/service/agent-repository/api/agents/selections/summary/(ID)');
  route('GET', summary, byId(data.agentSummaries, summary));
  route('POST', '/service/agent-repository/api/agents', () => ok(data.agents));
  // The entitlement types per target system ({ systemId: [codes] })
  data.entitlementTypes ??= { [IDS.alpha]: [1, 3], [IDS.beta]: [1, 2, 3] };
  route('GET', '/service/rule-enforcement/api/entitlement-import/entitlement-types', () => ok(data.entitlementTypes));
  // Source systems
  route('GET', '/service/provisioning-api/api/source-systems', () => ok(data.sourceSystems));
  const source = exact('/service/provisioning-api/api/source-systems/(ID)');
  route('GET', source, byId(data.sourceSystemDetails, source));
  route('GET', '/service/provisioning-api/api/systems-catalog/source', () => ok({ pageData: data.sourceCatalog, totalRowCount: data.sourceCatalog.length }));
  // Rules and entitlements
  route('POST', '/service/rules/api/rules/overview', (r) => ok({ pageData: paged(r, data.rulesOverview), totalRowCount: data.rulesOverview.length }));
  const rule = exact('/service/rules/api/rules/(ID)');
  route('GET', rule, byId(data.rules, rule));
  const conditionSummary = exact('/service/rules/api/rules/(ID)/condition-summary');
  route('GET', conditionSummary, byId(data.conditionSummaries, conditionSummary));
  const forEntitlement = exact('/service/rules/api/rules/entitlement/(ID)');
  route('GET', forEntitlement, (r) => {
    const rows = data.rulesForEntitlement[idOf(r, forEntitlement)] ?? [];
    return ok({ pageData: paged(r, rows), totalRowCount: rows.length });
  });
  route('GET', '/service/rules/api/entitlements', () => ok({ exceededTotalRowCountLimit: false, pageData: data.entitlements, totalRowCount: data.entitlements.length }));
  route('GET', '/service/rules/api/toxic-combinations', () => ok({ pageData: data.toxicCombinations, totalRowCount: data.toxicCombinations.length }));
  route('GET', '/service/rules/api/toxic-combinations/entitlements/by-ids', (r) => {
    const ids = r.query.getAll('entitlementIds');
    return ok({ pageData: data.entitlements.filter((e: any) => ids.includes(e.entitlementId)) });
  });
  // Notifications
  route('GET', '/service/notifications/api/notifications', () => ok({ pageData: data.notifications, totalRowCount: data.notifications.length }));
  const notification = exact('/service/notifications/api/notifications/(ID)');
  route('GET', notification, byId(data.notificationDetails, notification));
  route('GET', '/service/notifications/api/notification/systems', () => ok(data.notificationSystems));
  const notificationSystem = exact('/service/notifications/api/notification/systems/(ID)');
  route('GET', notificationSystem, byId(data.notificationSystemDetails, notificationSystem));
  route('GET', '/service/notifications/api/custom-events', () => ok({ pageData: data.customEvents, totalRowCount: data.customEvents.length }));
  // Settings
  route('GET', '/service/scheduler/api/schedule', () => ok(data.schedules));
  route('GET', '/service/scheduler/api/schedule/reconciliation/configuration', () => ok(data.reconciliationSchedule));
  route('GET', '/service/reconciliation/api/report/system-configuration', () => ok(data.reconciliationSystems));
  route('POST', '/service/reconciliation/api/exclusions', () => ok(data.reconciliationExclusions));
  route('GET', '/service/provisioning-integration/api/calculatedlayers/config', () => ok(data.calculatedLayers));
  route('GET', '/service/provisioning-integration/api/customfields', () => ok(data.customFields));
  route('GET', '/service/provisioning-pipeline/api/aggregation/automatic/configuration', () => ok(data.aggregation));
  route('GET', '/service/provisioning-pipeline/api/person-lifecycle', () => ok(data.personLifecycle));
  // Persons
  route('GET', '/service/provisioning-integration/api/vault/latest/persons', (r) => {
    const rows = r.query.get('excludedOnly') === 'true' ? data.excludedPersons : data.persons.filter((p: any) => !p.excluded);
    return ok({ pageData: paged(r, rows), totalRowCount: rows.length });
  });
  route('GET', '/service/provisioning-integration/api/vault/latest/persons-overview', (r) => {
    const search = (r.query.get('search') ?? '').toLowerCase();
    const rows = data.persons.filter((p: any) => !search || String(p.displayName).toLowerCase().includes(search));
    return ok({ pageData: paged(r, rows), totalRowCount: rows.length });
  });
  route('GET', '/service/rule-enforcement/api/enforcedstate/granted', (r) => {
    const person = r.query.get('person');
    const rows = data.granted.filter((g: any) => !person || g.personEntitlementId.personId === person);
    return ok({ exceededTotalRowCountLimit: false, pageData: paged(r, rows), totalRowCount: rows.length });
  });
  // Evaluation
  route('GET', '/service/rule-evaluation/api/evaluation/runs', (r) => ok({ pageData: paged(r, data.evaluationRuns), totalRowCount: data.evaluationRuns.length }));
  const report = exact('/service/rule-enforcement/api/evaluation-report/(ID)');
  route('GET', report, (r) => {
    const rows = data.evaluationReport.filter((row: any) => row.runId === idOf(r, report));
    return ok({ exceededTotalRowCountLimit: false, pageData: paged(r, rows), totalRowCount: rows.length });
  });
  const logging = exact('/service/rule-evaluation/api/evaluation/(ID)/logging');
  route('GET', logging, () => ok(data.evaluationLogging));
  const resultPersons = exact('/service/rule-evaluation/api/evaluation/results/rule/(ID)/persons');
  route('GET', resultPersons, (r) => {
    const rows = data.ruleResultPersons[idOf(r, resultPersons)] ?? [];
    return ok({ pageData: paged(r, rows), totalRowCount: rows.length });
  });
  route('POST', '/service/rule-evaluation/api/evaluation/evaluate/rule/persons', (r) => {
    const rows = paged(r, data.rulePreviewPersons);
    const events = [
      `event: Data\ndata: ${JSON.stringify({ pagedResult: { exceededTotalRowCountLimit: false, pageData: rows, totalRowCount: rows.length }, type: 0 })}\n\n`,
      ...(r.query.get('calculateTotalRowCount') === 'true'
        ? [`event: Data\ndata: ${JSON.stringify({ totalRowCount: data.rulePreviewPersons.length, type: 1 })}\n\n`]
        : []),
    ];
    return { headers: { 'Content-Type': 'text/event-stream' }, body: `${events.join('')}\n` };
  });
  return data;
}
