// The entitlement action read tools (pending, history, logging, blocked, blocked details), their
// labels and paging, and helloid_check_health (a failing check, a logged-out environment), against
// the fake HelloID with made-up data.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { codeOf, entitlementTypeOf, OPERATION_LABELS, RESULT_LABELS, typeCodeOf } from '../src/tools/actions.ts';
import { ACTION_IDS, type ActionData, installActionRoutes } from './action-routes.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { auditLines, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

describe('labels', () => {
  it('maps operations, results and entitlement types, from codes and labels', () => {
    assert.deepEqual(OPERATION_LABELS, { 0: 'Grant', 1: 'Revoke', 2: 'Update' });
    assert.deepEqual(RESULT_LABELS, { 0: 'Error', 1: 'Success', 2: 'Skipped', 3: 'Canceled' });
    assert.equal(codeOf('revoke', OPERATION_LABELS, 'operation'), 1);
    assert.equal(codeOf(2, OPERATION_LABELS, 'operation'), 2);
    assert.equal(codeOf('3', RESULT_LABELS, 'result'), 3);
    assert.throws(() => codeOf('Delete', OPERATION_LABELS, 'operation'), /Unknown operation "Delete": use one of 0 Grant, 1 Revoke, 2 Update/);
    assert.throws(() => codeOf(7, RESULT_LABELS, 'result'), /Unknown result 7/);
    assert.deepEqual(entitlementTypeOf('Account Access'), { code: 2, type: 'AccountAccess', label: 'Account Access' });
    assert.deepEqual(entitlementTypeOf('AccountAccess'), { code: 2, type: 'AccountAccess', label: 'Account Access' });
    assert.deepEqual(entitlementTypeOf(3), { code: 3, type: 'Permission', label: 'Permission' });
    assert.equal(entitlementTypeOf('Mailbox'), null);
    assert.equal(typeCodeOf('account'), 1);
    assert.throws(() => typeCodeOf(4), /Unknown entitlement type 4/);
  });
});

let fake: FakeHelloId;
let data: Fixture;
let actions: ActionData;
let dir: string;
let server: TestServer;
let client: Client;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

beforeEach(async () => {
  data = loadFixture();
  installFixtures(fake, data);
  actions = installActionRoutes(fake, data);
  dir = tempDir();
  const environment = { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl };
  server = await startTestServer(
    makeConfig(fake, dir, {
      training: { ...environment, mode: 'read' },
      other: { ...environment, mode: 'write' },
    }),
  );
  client = await server.connect();
  await logIn(server, client, fake);
  fake.state.gatewayRequests = [];
});
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const requests = (path: string) => fake.state.gatewayRequests.filter((r) => r.path === path);
const PENDING = '/service/rule-enforcement/api/actions/overview';
const HISTORY = '/service/rule-enforcement/api/actions/history/overview';
const OVERVIEW = '/service/rule-enforcement/api/enforcedstate/blocked/overview';
const DETAILS = '/service/rule-enforcement/api/enforcedstate/blocked/details';

describe('tool list', () => {
  it('has the action tools with their annotations', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      'helloid_list_entitlement_actions', 'helloid_list_action_history', 'helloid_get_action_logging',
      'helloid_list_blocked', 'helloid_get_blocked_details', 'helloid_check_health',
    ]) {
      const tool = byName.get(name)!;
      assert.ok(tool, `${name} is missing`);
      assert.equal(tool.annotations?.readOnlyHint, true, name);
      assert.equal(tool.annotations?.destructiveHint, false, name);
      assert.equal(tool.annotations?.openWorldHint, true, name);
      assert.ok(tool.outputSchema, name);
    }
    for (const name of ['helloid_plan_retry_action', 'helloid_plan_approve_blocked', 'helloid_plan_enforcement']) {
      assert.equal(byName.get(name)!.annotations?.readOnlyHint, true, name);
      assert.equal(byName.get(name)!.annotations?.destructiveHint, false, name);
    }
    for (const name of ['helloid_apply_retry_action', 'helloid_apply_approve_blocked', 'helloid_apply_enforcement']) {
      assert.equal(byName.get(name)!.annotations?.readOnlyHint, false, name);
      assert.equal(byName.get(name)!.annotations?.destructiveHint, true, name);
      assert.equal(byName.get(name)!.annotations?.idempotentHint, false, name);
    }
    assert.equal(byName.get('helloid_check_health')!.inputSchema.required?.includes('environment') ?? false, false, 'environment is optional');
  });
});

describe('helloid_list_entitlement_actions', () => {
  it('lists the pending actions with labels and system names (mode read is enough)', async () => {
    const result = await callOk(client, 'helloid_list_entitlement_actions', { environment: 'training' });
    assert.equal(result.total, 3);
    assert.deepEqual(result.items[0], {
      actionId: ACTION_IDS.pending1,
      personId: IDS.anna,
      personName: 'Anna Example (E001)',
      entitlementId: ACTION_IDS.entitlementGroup,
      systemId: IDS.alpha,
      systemName: 'Alpha Directory',
      entitlementType: 'Permission',
      entitlementTypeLabel: 'Permission',
      entitlementName: 'Group - Sales',
      permissionDefinitionDisplayName: 'Groups',
      operation: 0,
      operationLabel: 'Grant',
      origins: [1, 3],
      createdOn: '2026-03-02T08:00:00.000Z',
      actionInitiated: false,
      waitingReasons: ['Granted account'],
    });
    assert.deepEqual([result.items[2].operationLabel, result.items[2].entitlementTypeLabel, result.items[2].systemName], ['Revoke', 'Account Access', 'Beta Cloud']);
    assert.equal(requests(PENDING)[0]!.query.get('take'), '100');
  });

  it('pages with take = offset + limit, passes search on, and filters on a system', async () => {
    const second = await callOk(client, 'helloid_list_entitlement_actions', { environment: 'training', offset: 1, limit: 1 });
    assert.deepEqual([second.total, second.items.length, second.items[0].actionId], [3, 1, ACTION_IDS.pending2]);
    assert.equal(requests(PENDING)[0]!.query.get('take'), '2');

    const found = await callOk(client, 'helloid_list_entitlement_actions', { environment: 'training', search: 'dana' });
    assert.deepEqual(found.items.map((i: any) => i.actionId), [ACTION_IDS.pending3]);
    assert.equal(requests(PENDING)[1]!.query.get('search'), 'dana');

    const beta = await callOk(client, 'helloid_list_entitlement_actions', { environment: 'training', systemId: IDS.beta });
    assert.deepEqual([beta.total, beta.items[0].actionId], [1, ACTION_IDS.pending3]);
    assert.equal(requests(PENDING)[2]!.query.get('take'), '999999', 'all are read to filter on the system');
  });
});

describe('helloid_list_action_history', () => {
  it('lists the history with labels', async () => {
    const result = await callOk(client, 'helloid_list_action_history', { environment: 'training' });
    assert.equal(result.total, 4);
    assert.equal(result.exceededTotalRowCountLimit, false);
    assert.deepEqual(result.warnings, []);
    const first = result.items[0];
    assert.deepEqual(
      [first.actionId, first.runId, first.result, first.resultLabel, first.operationLabel, first.fromRules, first.matchingContracts, first.finishedOn],
      [ACTION_IDS.failed1, ACTION_IDS.run, 0, 'Error', 'Grant', [IDS.r1], ['C-0001'], '2026-03-01T09:00:05.000Z'],
    );
    assert.deepEqual(result.items.map((i: any) => i.resultLabel), ['Error', 'Success', 'Error', 'Skipped']);
    const query = requests(HISTORY)[0]!.query;
    assert.deepEqual([query.get('take'), query.has('results'), query.has('search')], ['100', false, false]);
  });

  it('sends the filters as HelloID\'s parameters (labels or codes)', async () => {
    const result = await callOk(client, 'helloid_list_action_history', {
      environment: 'training',
      search: 'dana',
      results: ['Error', 3],
      operations: ['revoke'],
      types: ['Account Access'],
      systemIds: [IDS.beta],
    });
    assert.deepEqual(result.items.map((i: any) => i.actionId), [ACTION_IDS.failed2]);
    const query = requests(HISTORY)[0]!.query;
    assert.equal(query.get('search'), 'dana');
    assert.deepEqual(query.getAll('results'), ['0', '3']);
    assert.deepEqual(query.getAll('operations'), ['1']);
    assert.deepEqual(query.getAll('types'), ['2']);
    assert.deepEqual(query.getAll('systems'), [IDS.beta]);
  });

  it('pages, and warns when HelloID does not apply a filter', async () => {
    const page = await callOk(client, 'helloid_list_action_history', { environment: 'training', offset: 2, limit: 2 });
    assert.deepEqual([page.total, page.items.map((i: any) => i.actionId)], [4, [ACTION_IDS.failed2, ACTION_IDS.skipped1]]);
    assert.equal(requests(HISTORY)[0]!.query.get('take'), '4');

    fake.route('GET', HISTORY, () => ({ body: { exceededTotalRowCountLimit: true, pageData: actions.actionHistory, totalRowCount: 5000 } }));
    const ignored = await callOk(client, 'helloid_list_action_history', { environment: 'training', operations: [1] });
    assert.equal(ignored.exceededTotalRowCountLimit, true);
    assert.deepEqual(ignored.warnings, ['HelloID answered rows that do not match the operations filter: it may not support it.']);
  });

  it('refuses an unknown label', async () => {
    const result = await callTool(client, 'helloid_list_action_history', { environment: 'training', results: ['Failed'] });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /Unknown result "Failed": use one of 0 Error, 1 Success, 2 Skipped, 3 Canceled/);
    assert.equal(requests(HISTORY).length, 0);
  });
});

describe('helloid_get_action_logging', () => {
  it('gets the log messages of an action, with cachebust as HelloID\'s page sends it', async () => {
    const result = await callOk(client, 'helloid_get_action_logging', { environment: 'training', actionId: ACTION_IDS.failed1 });
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages[1], {
      message: 'Error granting group to account: the account does not exist.',
      messageTimeUtc: '2026-03-01T09:00:05.000Z',
      level: 2,
      scopeId: ACTION_IDS.run,
      objectId: `${IDS.anna}.${ACTION_IDS.entitlementGroup}`,
    });
    assert.equal(result.moreDataAvailable, false);
    const request = requests(`/service/rule-enforcement/api/actions/history/${ACTION_IDS.failed1}/logging`)[0]!;
    assert.match(request.query.get('cachebust') ?? '', /^\d+$/);
  });
});

describe('blocked', () => {
  it('lists the groups with labels, asking for every target system, type and operation', async () => {
    const result = await callOk(client, 'helloid_list_blocked', { environment: 'training' });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items[0], {
      systemId: IDS.alpha,
      systemName: 'Alpha Directory',
      templateIdentifier: 'powershell-target',
      entitlementType: 'Account',
      entitlementTypeCode: 1,
      entitlementTypeLabel: 'Account',
      operation: 2,
      operationLabel: 'Update',
      configuration: 'Blocking when at least 5',
      count: 6,
      processing: false,
    });
    const query = requests(OVERVIEW)[0]!.query;
    assert.deepEqual(query.getAll('systems'), [IDS.alpha, IDS.beta, IDS.gamma], 'every target system, the disabled one too');
    assert.deepEqual(query.getAll('types'), ['1', '2', '3']);
    assert.deepEqual(query.getAll('operations'), ['0', '1', '2']);
    assert.equal(requests('/service/provisioning-api/api/target-systems')[0]!.query.toString(), '', 'the systems as HelloID\'s page reads them');
  });

  it('says so when nothing is blocked', async () => {
    actions.blockedGroups.length = 0;
    const result = await callTool(client, 'helloid_list_blocked', { environment: 'training' });
    assert.equal(resultText(result), 'No blocked entitlement actions.');
  });

  it('gets the actions of one group in pages (type and operation as labels or codes)', async () => {
    const result = await callOk(client, 'helloid_get_blocked_details', { environment: 'training', systemId: IDS.alpha, type: 'Account', operation: 'Update', offset: 4, limit: 10 });
    assert.deepEqual([result.total, result.entitlementType, result.entitlementTypeLabel, result.operation, result.operationLabel], [6, 'Account', 'Account', 2, 'Update']);
    assert.deepEqual(result.items, [
      { personDisplayName: 'Eve Person (E005)', entitlementName: 'Account', permissionDefinitionDisplayName: null },
      { personDisplayName: 'Finn Person (E006)', entitlementName: 'Account', permissionDefinitionDisplayName: null },
    ]);
    const query = requests(DETAILS)[0]!.query;
    assert.deepEqual([query.get('system'), query.get('type'), query.get('operation')], [IDS.alpha, 'Account', '2']);

    const byCode = await callOk(client, 'helloid_get_blocked_details', { environment: 'training', systemId: IDS.alpha, type: 3, operation: 1 });
    assert.equal(byCode.total, 3);
    assert.equal(requests(DETAILS)[1]!.query.get('type'), 'Permission');
  });
});

describe('helloid_check_health', () => {
  it('checks one environment and lists the problems', async () => {
    data.evaluationRuns[0].stageFailed = true;
    const result = await callTool(client, 'helloid_check_health', { environment: 'training' });
    assert.notEqual(result.isError, true, resultText(result));
    const [health] = (result.structuredContent as any).environments;
    assert.equal(health.environment, 'training');
    assert.equal(health.loggedIn, true);
    const { checks } = health;
    assert.deepEqual(checks.blockedAny, { ok: true, error: null, value: true });
    assert.deepEqual(checks.orphanedEntitlementsAny, { ok: true, error: null, value: false });
    assert.deepEqual(checks.referenceCleanerActive, { ok: true, error: null, value: false });
    assert.deepEqual(checks.snapshots.value[1], {
      systemId: IDS.beta,
      systemName: 'Beta Cloud',
      status: 4,
      succeeded: false,
      errorMessage: 'No valid agent found to perform action',
      startedOn: '2026-03-01T02:00:00.000Z',
      completedOn: '2026-03-01T02:00:01.000Z',
      lastSuccessfulOn: '2026-02-20T02:00:01.000Z',
    });
    assert.deepEqual(checks.latestEvaluationRun.value, {
      id: IDS.run2, startDateUtc: '2026-01-20T10:00:00Z', endDateUtc: '2026-01-20T10:01:00Z', state: 3, enforce: false, stageFailed: true,
    });
    assert.deepEqual(checks.failedActions.value, { count: 2, exceededTotalRowCountLimit: false });
    assert.deepEqual(health.problems, [
      'entitlement actions are blocked, waiting for approval (helloid_list_blocked)',
      'the latest snapshot of "Beta Cloud" failed: No valid agent found to perform action',
      `the latest evaluation run (${IDS.run2}) has a failed stage`,
      '2 failed (Error) action(s) in the history (helloid_list_action_history with results ["Error"])',
    ]);
    const failed = requests(HISTORY)[0]!.query;
    assert.deepEqual([failed.get('take'), failed.getAll('results')], ['1', ['0']]);
    assert.equal(requests('/service/rule-evaluation/api/evaluation/runs')[0]!.query.get('take'), '1');
  });

  it('reports a failing check as failed and still answers the others', async () => {
    fake.route('GET', '/service/rules/api/entitlements/orphaned/any', () => ({ status: 500, body: { message: 'Internal error' } }));
    actions.referenceCleanerActive = true;
    const { environments } = await callOk(client, 'helloid_check_health', { environment: 'training' });
    const { checks, problems } = environments[0];
    assert.equal(checks.orphanedEntitlementsAny.ok, false);
    assert.equal(checks.orphanedEntitlementsAny.value, null);
    assert.match(checks.orphanedEntitlementsAny.error, /HelloID answered 500/);
    assert.equal(checks.blockedAny.ok, true);
    assert.equal(checks.snapshots.ok, true);
    assert.ok(problems[0].startsWith('check orphanedEntitlementsAny failed: HelloID answered 500'));
    assert.ok(problems.includes('the reference cleaner is active'));
  });

  it('checks every environment without environment; logged-out ones are listed, not an error', async () => {
    const result = await callTool(client, 'helloid_check_health', {});
    assert.notEqual(result.isError, true, resultText(result));
    const { environments } = result.structuredContent as any;
    assert.deepEqual(environments.map((e: any) => [e.environment, e.loggedIn, e.sessionState]), [
      ['training', true, 'logged-in'],
      ['other', false, 'logged-out'],
    ]);
    assert.equal(environments[1].checks, null);
    assert.deepEqual(environments[1].problems, []);
    assert.match(resultText(result), /^other: not logged in \(helloid_login\), not checked\.$/m);
    assert.match(resultText(result), /^training: 3 problem\(s\)/m);
    const line = auditLines(dir).findLast((l) => l.tool === 'helloid_check_health')!;
    assert.equal(line.result, 'ok');
  });

  it('refuses an unknown environment', async () => {
    const result = await callTool(client, 'helloid_check_health', { environment: 'nope' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /Unknown environment 'nope'/);
  });
});
