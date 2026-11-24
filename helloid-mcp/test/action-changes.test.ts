// The write tools of the entitlement actions over MCP, against the fake HelloID with made-up data:
// retry a failed action, approve a blocked group, enforcement. Per tool the plan and the apply (the
// exact requests sent, the audit with before and after) and the refusals (flags, mode, safety.readOnly,
// confirmCount / confirmEnvironment, changed since the plan, processing, not Error, another MCP
// session, applied twice), and that helloid_start_evaluation still never enforces.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ACTION_IDS, type ActionData, installActionRoutes } from './action-routes.ts';
import { type FakeHelloId, type FakeRequest, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { auditLines, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

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

const FLAGS = { allowRetryActions: true, allowApproveBlocked: true, allowEnforce: true };
const START = '/service/rule-evaluation/api/evaluation/start';

/** Runs started by the fake: each ends at once, with the report rows of the fixture's run 2. */
function installStart() {
  let started = 0;
  fake.route('POST', START, (r) => {
    started++;
    const id = `eeeeeeee-eeee-4eee-8eee-${String(started).padStart(12, '0')}`;
    data.evaluationRuns.unshift({
      id,
      startDateUtc: `2026-03-0${started}T10:00:00Z`,
      endDateUtc: `2026-03-0${started}T10:01:00Z`,
      state: 3,
      enforce: r.query.get('enforce') === 'true',
      stageFailed: false,
    });
    const rows = data.evaluationReport.filter((row: any) => row.runId === IDS.run2);
    data.evaluationReport.push(...rows.map((row: any) => ({ ...row, runId: id })));
    return { body: JSON.stringify(id), headers: { 'Content-Type': 'application/json' } };
  });
}

async function start(environment: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  data = loadFixture();
  installFixtures(fake, data);
  actions = installActionRoutes(fake, data);
  installStart();
  dir = tempDir();
  const base = { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl };
  server = await startTestServer(makeConfig(fake, dir, { training: { ...base, mode: 'write', ...FLAGS, ...environment } }, extra), { evaluationPollMs: 5 });
  client = await server.connect();
  await logIn(server, client, fake);
  fake.state.gatewayRequests = [];
}

async function restart(environment: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  await server.close();
  removeDir(dir);
  await start(environment, extra);
}

beforeEach(() => start());
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const call = (name: string, args: Record<string, unknown> = {}, on: Client = client) => callTool(on, name, { environment: 'training', ...args });
const ok = (name: string, args: Record<string, unknown> = {}) => callOk(client, name, { environment: 'training', ...args });
const refused = async (name: string, args: Record<string, unknown>, pattern: RegExp, on: Client = client) => {
  const result = await call(name, args, on);
  assert.equal(result.isError, true, `${name} should be refused`);
  assert.match(resultText(result), pattern);
  return result;
};
/** The POST requests to the rule-enforcement and evaluation services, as "POST <path>?<query> <body>". */
const writes = () =>
  fake.state.gatewayRequests
    .filter((r: FakeRequest) => r.method === 'POST' && (r.path.startsWith('/service/rule-enforcement/') || r.path === START))
    .map((r) => `POST ${r.path}${r.query.toString() ? `?${r.query}` : ''} ${r.body}`);
const lastAudit = (tool: string) => auditLines(dir).findLast((l) => l.tool === tool)!;

const PLAN_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['helloid_plan_retry_action', { actionId: ACTION_IDS.failed1 }],
  ['helloid_plan_approve_blocked', { systemId: IDS.alpha, type: 'Account', operation: 2 }],
  ['helloid_plan_enforcement', {}],
];
const APPLY_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['helloid_apply_retry_action', { planId: '00000000-0000-4000-8000-000000000000' }],
  ['helloid_apply_approve_blocked', { planId: '00000000-0000-4000-8000-000000000000', confirmCount: 6 }],
  ['helloid_apply_enforcement', { planId: '00000000-0000-4000-8000-000000000000', confirmEnvironment: 'training' }],
];

describe('settings', () => {
  it('each flag off refuses its plan and apply tools, without asking HelloID', async () => {
    await restart({ allowRetryActions: false, allowApproveBlocked: false, allowEnforce: false });
    const flags = ['allowRetryActions', 'allowApproveBlocked', 'allowEnforce'];
    for (const [i, [name, args]] of [...PLAN_TOOLS, ...APPLY_TOOLS].entries()) {
      await refused(name, args, new RegExp(`environments\\.training\\.${flags[i % 3]} is false`));
    }
    assert.deepEqual(writes(), []);
    assert.ok(auditLines(dir).filter((l) => /_(plan|apply)_(retry|approve|enforcement)/.test(l.tool)).every((l) => l.result === 'refused'));
  });

  it('mode "plan" refuses them all', async () => {
    await restart({ mode: 'plan' });
    for (const [name, args] of [...PLAN_TOOLS, ...APPLY_TOOLS]) await refused(name, args, /needs mode "write"/);
  });

  it('safety.readOnly refuses them all', async () => {
    await restart({}, { safety: { readOnly: true } });
    for (const [name, args] of [...PLAN_TOOLS, ...APPLY_TOOLS]) await refused(name, args, /safety\.readOnly is true/);
    assert.deepEqual(writes(), []);
  });

  it('helloid_list_environments shows the flags', async () => {
    const { environments } = await callOk(client, 'helloid_list_environments');
    assert.deepEqual([environments[0].allowRetryActions, environments[0].allowApproveBlocked, environments[0].allowEnforce], [true, true, true]);
  });
});

describe('retry a failed action', () => {
  it('plans: the action with labels, its newest log messages, the retry request', async () => {
    const planned = await ok('helloid_plan_retry_action', { actionId: ACTION_IDS.failed1, search: 'anna' });
    assert.deepEqual(
      [planned.action.personName, planned.action.entitlementName, planned.action.systemName, planned.action.operationLabel, planned.action.resultLabel],
      ['Anna Example (E001)', 'Group - Sales', 'Alpha Directory', 'Grant', 'Error'],
    );
    assert.equal(planned.retryRequest, `POST /service/rule-enforcement/api/actions/history/retry/${IDS.alpha}/${ACTION_IDS.failed1} {}`);
    assert.equal(planned.logMessages.length, 2);
    assert.equal(planned.logMessageCount, 2);
    assert.match(planned.logMessages[0].message, /Failed to grant permission/);
    const history = fake.state.gatewayRequests.find((r) => r.path.endsWith('/history/overview'))!.query;
    assert.deepEqual([history.get('search'), history.getAll('results')], ['anna', ['0']]);
    assert.deepEqual(writes(), [], 'planning sends nothing');
  });

  it('applies: POST retry/{systemId}/{actionId} with body {}, audit with before and after', async () => {
    const planned = await ok('helloid_plan_retry_action', { actionId: ACTION_IDS.failed2 });
    const applied = await ok('helloid_apply_retry_action', { planId: planned.planId });
    assert.deepEqual(writes(), [`POST /service/rule-enforcement/api/actions/history/retry/${IDS.beta}/${ACTION_IDS.failed2} {}`]);
    const request = fake.state.gatewayRequests.find((r) => r.path.includes('/retry/'))!;
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(actions.retries, [ACTION_IDS.failed2]);
    assert.equal(applied.after.actionId, ACTION_IDS.failed2);
    const line = lastAudit('helloid_apply_retry_action');
    assert.equal(line.result, 'ok');
    assert.equal(line.changes.length, 1);
    assert.match(line.changes[0].item, new RegExp(`^entitlement action ${ACTION_IDS.failed2} \\(Revoke of Account Access "Mailbox access" for "Dana Nomatch \\(E004\\)"`));
    assert.equal(line.changes[0].before.resultLabel, 'Error');
    assert.equal(line.changes[0].after.actionId, ACTION_IDS.failed2);
  });

  it('refuses an action that is not an Error, with the reason', async () => {
    await refused('helloid_plan_retry_action', { actionId: ACTION_IDS.success1 }, /has result 1 \(Success\); only actions with result 0 \(Error\) can be retried/);
    await refused('helloid_plan_retry_action', { actionId: ACTION_IDS.skipped1 }, /has result 2 \(Skipped\)/);
    const missing = await call('helloid_plan_retry_action', { actionId: IDS.missing });
    assert.equal(missing.isError, true);
    assert.match(resultText(missing), /There is no action/);
  });

  it('refuses at apply when the action is no longer an Error, or changed since the plan', async () => {
    const first = await ok('helloid_plan_retry_action', { actionId: ACTION_IDS.failed1 });
    actions.actionHistory[0].result = 1;
    await refused('helloid_apply_retry_action', { planId: first.planId }, /has result 1 \(Success\)/);

    actions.actionHistory[0].result = 0;
    const second = await ok('helloid_plan_retry_action', { actionId: ACTION_IDS.failed1 });
    actions.actionHistory[0].finishedOn = '2026-03-01T10:00:00.000Z';
    await refused('helloid_apply_retry_action', { planId: second.planId }, /HelloID changed since the plan \(action\); plan again/);
    assert.deepEqual(writes(), []);
  });

  it('runs a plan once, and only in the MCP session that made it', async () => {
    const planned = await ok('helloid_plan_retry_action', { actionId: ACTION_IDS.failed1 });
    const other = await server.connect();
    await refused('helloid_apply_retry_action', { planId: planned.planId }, /another MCP session/, other);
    await ok('helloid_apply_retry_action', { planId: planned.planId });
    await refused('helloid_apply_retry_action', { planId: planned.planId }, /applied already/);
    assert.equal(actions.retries.length, 1);
  });
});

describe('approve a blocked group', () => {
  const group = { systemId: IDS.alpha, type: 'Account', operation: 'Update' };

  it('plans: count, threshold, the full list in pages and a fingerprint', async () => {
    const planned = await ok('helloid_plan_approve_blocked', { ...group, limit: 2 });
    assert.equal(planned.count, 6);
    assert.equal(planned.configuration, 'Blocking when at least 5');
    assert.deepEqual([planned.group.entitlementTypeLabel, planned.group.operationLabel, planned.group.systemName], ['Account', 'Update', 'Alpha Directory']);
    assert.deepEqual([planned.total, planned.offset, planned.limit, planned.items.length], [6, 0, 2, 2]);
    assert.deepEqual(planned.items[0], { personDisplayName: 'Anna Example (E001)', entitlementName: 'Account', permissionDefinitionDisplayName: null });
    assert.match(planned.detailsFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(planned.approveRequest, `POST /service/rule-enforcement/api/enforcedstate/process-blocked/${IDS.alpha}/Account/2 {}`);
    assert.deepEqual(planned.warnings, []);
    assert.equal(fake.state.gatewayRequests.find((r) => r.path.endsWith('/blocked/details'))!.query.get('take'), '999999', 'all pages of the details');
    assert.deepEqual(writes(), []);
  });

  it('applies with confirmCount: POST process-blocked/{systemId}/{Type}/{operation} with body {}, every pair in the audit', async () => {
    const planned = await ok('helloid_plan_approve_blocked', group);
    const applied = await ok('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 });
    assert.deepEqual(writes(), [`POST /service/rule-enforcement/api/enforcedstate/process-blocked/${IDS.alpha}/Account/2 {}`]);
    assert.equal(applied.approved, 6);
    assert.equal(applied.after.processing, true, 'read back: HelloID processes the group');
    const line = lastAudit('helloid_apply_approve_blocked');
    assert.equal(line.result, 'ok');
    assert.equal(line.changes[0].item, `blocked group Account Update on "Alpha Directory" (${IDS.alpha}/Account/2)`);
    assert.deepEqual(
      line.changes[0].before.approved.map((d: any) => d.personDisplayName),
      ['Anna Example (E001)', 'Bram Sample (E002)', 'Chris Excluded (E003)', 'Dana Nomatch (E004)', 'Eve Person (E005)', 'Finn Person (E006)'],
    );
    assert.equal(line.changes[0].after.group.processing, true);
  });

  it('refuses a confirmCount that is not the planned count, and the plan can still be applied', async () => {
    const planned = await ok('helloid_plan_approve_blocked', group);
    await refused('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 5 }, /confirmCount 5 is not the planned count .* \(6\)\. Nothing was approved/);
    assert.deepEqual(writes(), []);
    await ok('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 });
    assert.equal(actions.approvals.length, 1);
  });

  it('refuses when the group changed since the plan', async () => {
    const planned = await ok('helloid_plan_approve_blocked', group);
    actions.blockedDetails[`${IDS.alpha}|Account|2`]!.push({ personDisplayName: 'Gina Person (E007)', entitlementName: 'Account', permissionDefinitionDisplayName: null });
    actions.blockedGroups[0].count = 7;
    await refused('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 }, /HelloID changed since the plan \(group, details\); plan again/);
    assert.deepEqual(writes(), []);
  });

  it('refuses a group HelloID is processing, at plan and at apply', async () => {
    const planned = await ok('helloid_plan_approve_blocked', group);
    actions.blockedGroups[0].processing = true;
    await refused('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 }, /is processing the blocked .* already/);
    await refused('helloid_plan_approve_blocked', group, /is processing the blocked Account Update on "Alpha Directory" already/);
    assert.deepEqual(writes(), []);
  });

  it('refuses when the group is gone, and says so when there is no such group', async () => {
    const planned = await ok('helloid_plan_approve_blocked', group);
    actions.blockedGroups.splice(0, 1);
    await refused('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 }, /is no longer blocked/);
    const none = await call('helloid_plan_approve_blocked', { systemId: IDS.beta, type: 'Permission', operation: 0 });
    assert.equal(none.isError, true);
    assert.match(resultText(none), /There is no blocked group Permission Grant/);
  });

  it('runs a plan once, and only in the MCP session that made it', async () => {
    const planned = await ok('helloid_plan_approve_blocked', group);
    const other = await server.connect();
    await refused('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 }, /another MCP session/, other);
    await ok('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 });
    await refused('helloid_apply_approve_blocked', { planId: planned.planId, confirmCount: 6 }, /applied already/);
    assert.equal(actions.approvals.length, 1);
  });
});

describe('enforcement', () => {
  const expectedGroups = [
    { systemId: IDS.alpha, systemName: 'Alpha Directory', entitlementType: 'Account', entitlementTypeLabel: 'Account', operation: 1, operationLabel: 'Revoke', count: 1 },
  ];

  it('plans with an evaluation without enforcement, and shows its report with labels', async () => {
    const planned = await ok('helloid_plan_enforcement');
    assert.deepEqual(writes(), [`POST ${START}?enforce=false `]);
    assert.equal(planned.evaluationRun.enforce, false);
    assert.equal(planned.expected.actions, 3);
    assert.deepEqual(planned.expected.byOperation, { Revoke: 2, Update: 1 });
    assert.deepEqual(planned.expected.byEntitlementType, { Account: 2, Permission: 1 });
    assert.deepEqual(planned.expected.bySystem, { 'Alpha Directory': 2, 'Beta Cloud': 1 });
    assert.deepEqual(planned.expected.groups[0], expectedGroups[0]);
    assert.equal(planned.expected.groups.reduce((n: number, g: any) => n + g.count, 0), 3);
  });

  it('applies with confirmEnvironment: starts with enforce=true and answers the run ID (no wait)', async () => {
    const planned = await ok('helloid_plan_enforcement');
    const applied = await ok('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training' });
    assert.deepEqual(writes(), [`POST ${START}?enforce=false `, `POST ${START}?enforce=true `]);
    assert.equal(applied.finished, false);
    assert.equal(applied.runId, data.evaluationRuns[0].id);
    assert.equal(data.evaluationRuns[0].enforce, true);
    assert.equal(applied.report, null);
    const line = lastAudit('helloid_apply_enforcement');
    assert.equal(line.result, 'ok');
    assert.match(line.changes[0].item, new RegExp(`^enforcement run ${applied.runId} \\(planned with evaluation run ${planned.evaluationRun.id}\\)$`));
    assert.equal(line.changes[0].before.expected.actions, 3);
    assert.deepEqual(line.changes[0].after, { runId: applied.runId, started: true });
  });

  it('with wait, waits for the run and summarises its report', async () => {
    const planned = await ok('helloid_plan_enforcement');
    const applied = await ok('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training', wait: true });
    assert.equal(applied.finished, true);
    assert.equal(applied.run.enforce, true);
    assert.equal(applied.report.actions, 3);
    assert.deepEqual(applied.report.groups[0], expectedGroups[0]);
    assert.equal(lastAudit('helloid_apply_enforcement').changes[0].after.report.actions, 3);
  });

  it('refuses a confirmEnvironment that is not the environment\'s name', async () => {
    const planned = await ok('helloid_plan_enforcement');
    for (const wrong of ['Training', 'training ', 'other']) {
      await refused('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: wrong }, /is not exactly the environment's name \("training"\)\. Nothing was started/);
    }
    assert.ok(!writes().some((w) => w.includes('enforce=true')));
  });

  it('refuses while a run is in progress, at plan and at apply', async () => {
    const planned = await ok('helloid_plan_enforcement');
    data.evaluationRuns.unshift({ id: 'eeeeeeee-eeee-4eee-8eee-0000000000ff', startDateUtc: '2026-03-09T10:00:00Z', endDateUtc: null, state: 1, enforce: false, stageFailed: false });
    await refused('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training' }, /an evaluation or enforcement run is in progress/);
    await refused('helloid_plan_enforcement', {}, /an evaluation or enforcement run is in progress/);
    assert.ok(!writes().some((w) => w.includes('enforce=true')));
  });

  it('refuses when another run started since the plan', async () => {
    const planned = await ok('helloid_plan_enforcement');
    data.evaluationRuns.unshift({ id: 'eeeeeeee-eeee-4eee-8eee-0000000000fe', startDateUtc: '2026-03-09T10:00:00Z', endDateUtc: '2026-03-09T10:01:00Z', state: 3, enforce: false, stageFailed: false });
    await refused('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training' }, /HelloID changed since the plan \(latestRun\); plan again/);
  });

  it('runs a plan once, and only in the MCP session that made it', async () => {
    const planned = await ok('helloid_plan_enforcement');
    const other = await server.connect();
    await refused('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training' }, /another MCP session/, other);
    await ok('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training' });
    await refused('helloid_apply_enforcement', { planId: planned.planId, confirmEnvironment: 'training' }, /applied already/);
    assert.equal(writes().filter((w) => w.includes('enforce=true')).length, 1);
  });

  it('the plan needs allowEvaluate too (it runs an evaluation)', async () => {
    await restart({ allowEvaluate: false });
    await refused('helloid_plan_enforcement', {}, /allowEvaluate is false/);
    assert.deepEqual(writes(), []);
  });

  it('helloid_start_evaluation still never enforces, with allowEnforce on', async () => {
    await ok('helloid_start_evaluation', { wait: true });
    assert.deepEqual(writes(), [`POST ${START}?enforce=false `]);
    const schema = (await client.listTools()).tools.find((t) => t.name === 'helloid_start_evaluation')!.inputSchema;
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['environment', 'wait'], 'no enforce argument');
  });
});
