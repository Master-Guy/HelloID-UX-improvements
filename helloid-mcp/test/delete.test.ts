// helloid_plan_delete and helloid_apply_delete over MCP, against the fake HelloID: per kind the plan
// (with HelloID's checks) and the apply (the right delete request, read back, the audit with before
// and after null, no secrets), the business rule choices, and the refusals (settings, confirmName,
// fingerprints, used twice, another MCP session, built-in notification system, busy source system).

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { deletes, installDeleteRoutes, snapshotStatus } from './delete-routes.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { auditLines, auditText, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

/** Secret values in the fixtures: none may reach a tool result or the audit log. */
const SECRETS = [
  'alpha-client-secret-value',
  'alpha-hidden-password',
  'beta-client-secret-value',
  'beta-exchange-password',
  'hr-api-key-value',
  'hr-hidden-value',
  'notify-hidden-value',
  'notify-token-value',
  'template-hidden-value',
];

let fake: FakeHelloId;
let data: Fixture;
let dir: string;
let server: TestServer;
let client: Client;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

async function start(environment: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  data = loadFixture();
  installFixtures(fake, data);
  installDeleteRoutes(fake, data);
  dir = tempDir();
  const config = makeConfig(
    fake,
    dir,
    { training: { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl, mode: 'write', allowDelete: true, ...environment } },
    extra,
  );
  server = await startTestServer(config);
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

const plan = (kind: string, id: string, more: Record<string, unknown> = {}) =>
  callTool(client, 'helloid_plan_delete', { environment: 'training', kind, id, ...more });
const planOk = async (kind: string, id: string, more: Record<string, unknown> = {}) => {
  const result = await plan(kind, id, more);
  if (result.isError) throw new Error(resultText(result));
  assertNoSecrets(result);
  return result.structuredContent as any;
};
const apply = (planId: string, confirmName: string, on: Client = client) =>
  callTool(on, 'helloid_apply_delete', { environment: 'training', planId, confirmName });
const applyOk = async (planId: string, confirmName: string) => {
  const result = await apply(planId, confirmName);
  if (result.isError) throw new Error(resultText(result));
  assertNoSecrets(result);
  return result.structuredContent as any;
};

function assertNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret ${secret} leaked`);
}

/** The audit line of the last apply: one change, after null, no secrets anywhere in the log. */
function deleteAudit(item: string) {
  const line = auditLines(dir).findLast((l) => l.tool === 'helloid_apply_delete')!;
  assert.equal(line.result, 'ok');
  assert.equal(line.changes.length, 1);
  assert.equal(line.changes[0].item, item);
  assert.equal(line.changes[0].after, null);
  assert.ok(line.changes[0].before);
  assertNoSecrets(auditText(dir));
  return line.changes[0].before;
}

describe('the delete tools', () => {
  it('are listed with their annotations', async () => {
    const { tools } = await client.listTools();
    const planTool = tools.find((t) => t.name === 'helloid_plan_delete')!;
    const applyTool = tools.find((t) => t.name === 'helloid_apply_delete')!;
    assert.equal(planTool.annotations?.readOnlyHint, true);
    assert.equal(planTool.annotations?.destructiveHint, false);
    assert.equal(applyTool.annotations?.readOnlyHint, false);
    assert.equal(applyTool.annotations?.destructiveHint, true);
    assert.equal(applyTool.annotations?.idempotentHint, false);
    assert.match(applyTool.description!, /DELETES/);
    assert.match(applyTool.description!, /confirmName/);
    assert.match(applyTool.description!, /allowDelete/);
    assert.match(planTool.description!, /allowDelete/);
    assert.deepEqual((planTool.inputSchema.properties as any).kind.enum, [
      'targetSystem',
      'sourceSystem',
      'businessRule',
      'notification',
      'notificationSystem',
      'customEvent',
      'toxicCombination',
    ]);
  });
});

describe('per kind: plan and apply', () => {
  it('target system: the checks in the plan, DELETE target-systems/{id}, audit with secrets masked', async () => {
    const planned = await planOk('targetSystem', IDS.alpha);
    assert.equal(planned.name, 'Alpha Directory');
    assert.equal(planned.deleteRequest, `DELETE /service/provisioning-api/api/target-systems/${IDS.alpha}`);
    assert.deepEqual(planned.checks.systemsDependingOn, []);
    assert.deepEqual(planned.checks.rulesGranting.map((r: any) => r.ruleName), ['Employees get Alpha', 'Sales get Alpha']);
    assert.deepEqual(planned.checks.agentSelectionSummary, { agentCount: 2 });
    assert.ok(planned.warnings.some((w: string) => /2 published business rule\(s\) grant entitlements on it/.test(w)));
    assert.deepEqual(deletes(fake.state.gatewayRequests), [], 'planning deletes nothing');
    assert.ok(fake.state.gatewayRequests.some((r) => r.path === '/service/provisioning-api/api/target-systems/get-systems-depending-on' && r.query.get('systemId') === IDS.alpha));

    const applied = await applyOk(planned.planId, 'Alpha Directory');
    assert.equal(applied.deleted, true);
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/provisioning-api/api/target-systems/${IDS.alpha}`]);
    assert.ok(!data.targetSystems.some((s: any) => s.systemId === IDS.alpha));
    const before = deleteAudit(`target system "Alpha Directory" (${IDS.alpha})`);
    assert.equal(before.configuration.scriptConfiguration.clientSecret, '***');
    assert.equal(before.configuration.scriptConfiguration.baseUrl, 'https://alpha.example.test');
  });

  it('target system: the systems depending on it are in the plan', async () => {
    const planned = await planOk('targetSystem', IDS.beta);
    assert.deepEqual(planned.checks.systemsDependingOn, [{ systemId: IDS.alpha, displayName: 'Alpha Directory' }]);
    assert.ok(planned.warnings.some((w: string) => w.includes('1 other system(s) depend on it') && w.includes('"Alpha Directory"')));
  });

  it('source system: blocked persons and snapshot status in the plan, DELETE source-systems/{id}', async () => {
    data.blockedPersons[IDS.hr] = true;
    const planned = await planOk('sourceSystem', IDS.hr);
    assert.equal(planned.name, 'HR Source');
    assert.equal(planned.checks.blockedPersons, true);
    assert.equal(planned.checks.snapshotStatus.isBusy, false);
    assert.ok(planned.warnings.some((w: string) => /blocked persons/.test(w)));
    await applyOk(planned.planId, 'HR Source');
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/provisioning-api/api/source-systems/${IDS.hr}`]);
    const before = deleteAudit(`source system "HR Source" (${IDS.hr})`);
    assert.equal(JSON.parse(before.scriptConfiguration).apiKey, '***');
  });

  it('notification: DELETE notifications/{id}', async () => {
    const planned = await planOk('notification', IDS.n1);
    assert.equal(planned.name, 'Alpha account created');
    assert.deepEqual(planned.checks, {});
    await applyOk(planned.planId, 'Alpha account created');
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/notifications/api/notifications/${IDS.n1}`]);
    const before = deleteAudit(`notification "Alpha account created" (${IDS.n1})`);
    assert.equal(before.notificationTemplateData.secretWord, '***');
  });

  it('notification system: the notifications using it in the plan, DELETE notification/systems/{id}', async () => {
    const planned = await planOk('notificationSystem', IDS.notify);
    assert.equal(planned.name, 'PowerShell Notify');
    assert.equal(planned.checks.isBuiltin, false);
    assert.deepEqual(planned.checks.notificationsUsingIt.map((n: any) => n.name), ['Alpha account created']);
    assert.ok(planned.warnings.some((w: string) => w.includes('1 notification(s) use it: "Alpha account created"')));
    await applyOk(planned.planId, 'PowerShell Notify');
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/notifications/api/notification/systems/${IDS.notify}`]);
    const before = deleteAudit(`notification system "PowerShell Notify" (${IDS.notify})`);
    assert.equal(before.systemConfiguration.data.hidden, '***');
  });

  it('custom event: used in the plan, DELETE custom-events/{id}', async () => {
    data.customEventUsed[IDS.ce1] = true;
    const planned = await planOk('customEvent', IDS.ce1);
    assert.equal(planned.name, 'Manager changed');
    assert.equal(planned.checks.used, true);
    assert.ok(planned.warnings.some((w: string) => /notifications use this custom event/.test(w)));
    assert.ok(fake.state.gatewayRequests.some((r) => r.path === `/service/notifications/api/custom-events/${IDS.ce1}/used`));
    await applyOk(planned.planId, 'Manager changed');
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/notifications/api/custom-events/${IDS.ce1}`]);
    deleteAudit(`custom event "Manager changed" (${IDS.ce1})`);
  });

  it('toxic combination: DELETE toxic-combinations/{id}', async () => {
    const planned = await planOk('toxicCombination', IDS.tx1);
    assert.equal(planned.name, 'No sales and finance');
    await applyOk(planned.planId, 'No sales and finance');
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/rules/api/toxic-combinations/${IDS.tx1}`]);
    assert.equal(data.toxicCombinations.length, 0);
    deleteAudit(`toxic combination "No sales and finance" (${IDS.tx1})`);
  });

  it('an item that is not there is an error, not a plan', async () => {
    const result = await plan('customEvent', IDS.missing);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /There is no custom event/);
  });
});

describe('business rules', () => {
  it('a published rule needs ruleEntitlements (no default)', async () => {
    const result = await plan('businessRule', IDS.r1);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /is published, so ruleEntitlements is required: "unmanaged".*or "revoke"/);
    assert.equal(auditLines(dir).findLast((l) => l.tool === 'helloid_plan_delete')!.result, 'refused');
  });

  it('unmanaged sends /false; the plan shows published, the entitlements and the persons', async () => {
    const planned = await planOk('businessRule', IDS.r2, { ruleEntitlements: 'unmanaged' });
    assert.deepEqual(planned.rule, { published: true, hasDraft: true, ruleEntitlements: 'unmanaged' });
    assert.equal(planned.deleteRequest, `DELETE /service/rules/api/rules/${IDS.r2}/false`);
    assert.equal(planned.checks.published, true);
    assert.deepEqual(planned.checks.entitlements.map((e: any) => e.displayName), ['Account Access', 'Removed group']);
    assert.deepEqual(planned.checks.draftEntitlements.map((e: any) => e.displayName), ['Account']);
    assert.deepEqual(planned.checks.personsInRuleLastEvaluation, { total: 2, first: ['Anna Example (E001)', 'Bram Sample (E002)'] });
    assert.ok(planned.warnings.includes('2 person(s) were in the rule at the last evaluation'));
    assert.ok(planned.warnings.includes('the entitlements of the rule are marked as unmanaged'));
    const applied = await applyOk(planned.planId, 'Sales get Alpha');
    assert.equal(applied.deleteRequest, `DELETE /service/rules/api/rules/${IDS.r2}/false`);
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/rules/api/rules/${IDS.r2}/false`]);
    assert.ok(!data.rulesOverview.some((r: any) => r.ruleId === IDS.r2));
    deleteAudit(`business rule "Sales get Alpha" (${IDS.r2})`);
  });

  it('revoke is refused without allowRevokingRuleDelete', async () => {
    const result = await plan('businessRule', IDS.r1, { ruleEntitlements: 'revoke' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /allowRevokingRuleDelete/);
  });

  it('revoke sends /true with allowRevokingRuleDelete', async () => {
    await restart({ allowRevokingRuleDelete: true });
    const planned = await planOk('businessRule', IDS.r1, { ruleEntitlements: 'revoke' });
    assert.equal(planned.rule.ruleEntitlements, 'revoke');
    assert.ok(planned.warnings.includes('the entitlements of the rule are revoked'));
    const applied = await apply(planned.planId, 'Employees get Alpha');
    assert.ok(!applied.isError, resultText(applied));
    assert.match(resultText(applied), /entitlements revoked/);
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/rules/api/rules/${IDS.r1}/true`]);
  });

  it('a draft-only rule needs no choice and is deleted with /true', async () => {
    const planned = await planOk('businessRule', IDS.r3);
    assert.deepEqual(planned.rule, { published: false, hasDraft: true, ruleEntitlements: null });
    assert.equal(planned.deleteRequest, `DELETE /service/rules/api/rules/${IDS.r3}/true`);
    await applyOk(planned.planId, 'Empty rule');
    assert.deepEqual(deletes(fake.state.gatewayRequests), [`DELETE /service/rules/api/rules/${IDS.r3}/true`]);
  });

  it('ruleEntitlements is refused for other kinds', async () => {
    const result = await plan('toxicCombination', IDS.tx1, { ruleEntitlements: 'unmanaged' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /only for kind "businessRule"/);
  });
});

describe('refusals of the kinds', () => {
  it('a built-in notification system is refused', async () => {
    const result = await plan('notificationSystem', IDS.email);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /built-in notification system/);
  });

  it('a source system with a snapshot running is refused, at plan and at apply', async () => {
    data.snapshotStatuses[IDS.hr] = snapshotStatus(true);
    const refused = await plan('sourceSystem', IDS.hr);
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), /snapshot of this source system is running/);

    data.snapshotStatuses[IDS.hr] = snapshotStatus(false);
    const planned = await planOk('sourceSystem', IDS.hr);
    data.snapshotStatuses[IDS.hr] = snapshotStatus(true);
    const result = await apply(planned.planId, 'HR Source');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /snapshot of this source system is running/);
    assert.deepEqual(deletes(fake.state.gatewayRequests), []);
  });
});

describe('settings and plan refusals', () => {
  it('mode "plan" refuses both tools', async () => {
    await restart({ mode: 'plan' });
    for (const result of [await plan('toxicCombination', IDS.tx1), await apply('00000000-0000-4000-8000-000000000000', 'x')]) {
      assert.equal(result.isError, true);
      assert.match(resultText(result), /needs mode "write"/);
    }
  });

  it('allowDelete false refuses both tools', async () => {
    await restart({ allowDelete: false });
    for (const result of [await plan('toxicCombination', IDS.tx1), await apply('00000000-0000-4000-8000-000000000000', 'x')]) {
      assert.equal(result.isError, true);
      assert.match(resultText(result), /environments\.training\.allowDelete is false/);
    }
    assert.ok(auditLines(dir).filter((l) => l.tool.endsWith('_delete')).every((l) => l.result === 'refused'));
  });

  it('safety.readOnly refuses both tools', async () => {
    await restart({}, { safety: { readOnly: true } });
    for (const result of [await plan('toxicCombination', IDS.tx1), await apply('00000000-0000-4000-8000-000000000000', 'x')]) {
      assert.equal(result.isError, true);
      assert.match(resultText(result), /safety\.readOnly is true/);
    }
  });

  it('a wrong confirmName is refused, deletes nothing, and the plan can still be applied', async () => {
    const planned = await planOk('toxicCombination', IDS.tx1);
    for (const wrong of ['no sales and finance', 'No sales and finance ', 'Alpha Directory']) {
      const result = await apply(planned.planId, wrong);
      assert.equal(result.isError, true);
      assert.match(resultText(result), /is not exactly the current name of the toxic combination/);
    }
    assert.deepEqual(deletes(fake.state.gatewayRequests), []);
    assert.equal(auditLines(dir).findLast((l) => l.tool === 'helloid_apply_delete')!.result, 'refused');
    await applyOk(planned.planId, 'No sales and finance');
    assert.equal(deletes(fake.state.gatewayRequests).length, 1);
  });

  it('refuses when the item changed since the plan (fingerprint)', async () => {
    const planned = await planOk('notificationSystem', IDS.notify);
    data.notificationSystemDetails[IDS.notify].displayName = 'PowerShell Notify v2';
    const result = await apply(planned.planId, 'PowerShell Notify v2');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /HelloID changed since the plan \(item\); plan again/);
    assert.deepEqual(deletes(fake.state.gatewayRequests), []);
  });

  it('refuses when a check changed since the plan (fingerprint)', async () => {
    const planned = await planOk('customEvent', IDS.ce1);
    data.customEventUsed[IDS.ce1] = true;
    const result = await apply(planned.planId, 'Manager changed');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /HelloID changed since the plan \(check:used\); plan again/);
    assert.deepEqual(deletes(fake.state.gatewayRequests), []);
  });

  it('refuses when the item is gone since the plan', async () => {
    const planned = await planOk('toxicCombination', IDS.tx1);
    data.toxicCombinations.splice(0, 1);
    const result = await apply(planned.planId, 'No sales and finance');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /HelloID changed since the plan/);
  });

  it('runs a plan at most once', async () => {
    const planned = await planOk('toxicCombination', IDS.tx1);
    await applyOk(planned.planId, 'No sales and finance');
    const second = await apply(planned.planId, 'No sales and finance');
    assert.equal(second.isError, true);
    assert.match(resultText(second), /applied already/);
    assert.equal(deletes(fake.state.gatewayRequests).length, 1);
  });

  it('refuses a plan of another MCP session', async () => {
    const planned = await planOk('toxicCombination', IDS.tx1);
    const other = await server.connect();
    const result = await apply(planned.planId, 'No sales and finance', other);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /another MCP session/);
    assert.deepEqual(deletes(fake.state.gatewayRequests), []);
  });

  it('refuses an unknown plan', async () => {
    const result = await apply('11111111-0000-4000-8000-000000000000', 'x');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /there is no plan/);
  });

  it('says so when HelloID still has the item after the delete', async () => {
    const planned = await planOk('toxicCombination', IDS.tx1);
    fake.route('DELETE', /^\/service\/rules\/api\/toxic-combinations\/[^/]+$/, () => ({ body: '' }));
    const result = await apply(planned.planId, 'No sales and finance');
    assert.equal(result.isError, true);
    assert.match(resultText(result), /but it is still there/);
    const line = auditLines(dir).findLast((l) => l.tool === 'helloid_apply_delete')!;
    assert.equal(line.result, 'error');
    assert.equal(line.changes, undefined);
  });
});
