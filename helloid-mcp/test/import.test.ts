// helloid_plan_import and helloid_apply_plan over MCP, against the fake HelloID: the overview per
// kind (create, overwrite, same, note, refused), items made earlier in the same run, choices,
// refusals, the plan's fingerprints, and the audit (before and after, without secrets).

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../src/config.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import * as files from './import-files.ts';
import { installImportRoutes, writes } from './import-routes.ts';
import { auditLines, auditText, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

/** Secret values in the fixtures: none may reach a tool result or the audit log. */
const SECRETS = ['alpha-client-secret-value', 'alpha-hidden-password', 'hr-api-key-value', 'hr-hidden-value', 'template-hidden-value'];

let fake: FakeHelloId;
let data: Fixture;
let dir: string;
let config: Config;
let server: TestServer;
let client: Client;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

async function start(mode = 'write') {
  data = loadFixture();
  installFixtures(fake, data);
  installImportRoutes(fake, data);
  dir = tempDir();
  config = makeConfig(fake, dir, { training: { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl, mode } });
  server = await startTestServer(config);
  client = await server.connect();
  await logIn(server, client, fake);
  fake.state.gatewayRequests = [];
}

beforeEach(() => start());
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const plan = (input: any[], answers: Record<string, unknown> = {}) =>
  callTool(client, 'helloid_plan_import', { environment: 'training', files: files.asInput(input), answers });
const planOk = async (input: any[], answers: Record<string, unknown> = {}) => {
  const result = await plan(input, answers);
  if (result.isError) throw new Error(resultText(result));
  return result.structuredContent as any;
};
const apply = (planId: string, on: Client = client) => callTool(on, 'helloid_apply_plan', { environment: 'training', planId });
const entry = (structured: any, label: string) => structured.entries.find((e: any) => e.label.startsWith(label));

function assertNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret ${secret} leaked`);
}

describe('helloid_plan_import', () => {
  it('is listed with its annotations, as is helloid_apply_plan', async () => {
    const { tools } = await client.listTools();
    const planTool = tools.find((t) => t.name === 'helloid_plan_import');
    const applyTool = tools.find((t) => t.name === 'helloid_apply_plan');
    assert.equal(planTool?.annotations?.readOnlyHint, true);
    assert.equal(planTool?.annotations?.destructiveHint, false);
    assert.equal(applyTool?.annotations?.readOnlyHint, false);
    assert.equal(applyTool?.annotations?.destructiveHint, true);
  });

  it('returns the open choices and no plan when answers miss one; plans with the answers', async () => {
    const open = await planOk([files.deltaFile()]);
    assert.equal(open.planId, null);
    const choice = open.choices.find((c: any) => c.key === `dependsByName:${files.OTHER.delta}`);
    assert.ok(choice);
    assert.equal(choice.section, 'Dependencies found only by name');
    assert.equal(choice.default, true);
    assert.deepEqual(choice.options.map((o: any) => o.value), [true, 'alternative']);
    assert.match(choice.detail, /ID here 11111111/);

    const planned = await planOk([files.deltaFile()], { [choice.key]: choice.default });
    assert.equal(planned.choices.length, 0);
    assert.match(planned.planId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(writes(fake.state.gatewayRequests), [], 'planning writes nothing');
  });

  it('refuses an answer that is not one of its options', async () => {
    const result = await plan([files.deltaFile()], { [`dependsByName:${files.OTHER.delta}`]: 'maybe' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /not one of its options/);
  });

  it('gives the overview per kind: create, overwrite, same, note, refused, and skipped files', async () => {
    const planned = await planOk([
      files.sameRuleFile(data),
      files.newRuleFile(),
      files.toxicFile(data),
      files.customEventFile(),
      { contents: 'unknown' },
      { contents: 'sourceSystem', system: {} },
    ]);
    assert.equal(entry(planned, '"Employees get Alpha"').status, 'same');
    assert.deepEqual(entry(planned, '"Employees get Alpha"').details, ['already as in the file']);
    assert.equal(entry(planned, '"Title changed" (new)').status, 'todo');
    assert.equal(entry(planned, '"Contractors" (new)').status, 'note');
    assert.ok(entry(planned, '"Contractors"').details.includes('left out: permission "Nowhere" of "Gone System": not an entitlement here'));
    assert.equal(entry(planned, '"No sales and finance" (overwrite)').status, 'note');
    assert.deepEqual(planned.skipped, ['file 5.json: not an export file this script knows', 'file 6.json: the file is incomplete']);
    assert.match(planned.overview, /✅ "Employees get Alpha" \(overwrite\)/);
  });

  it('does not report the empty source system ID in a rule condition', async () => {
    const planned = await planOk([files.sameRuleFile(data)]);
    assert.ok(!planned.overview.includes('00000000-0000-0000-0000-000000000000'));
    assert.ok(!/not in this HelloID environment/.test(planned.overview));
    assert.equal(planned.planId, null, 'nothing to do');
  });

  it('refuses a custom event of a system that is not here, and a new target system whose name is taken', async () => {
    const event = files.customEventFile();
    event.systemName = 'Nowhere';
    event.customEvent.systemId = 'd0000000-0000-4000-8000-0000000000ff';
    const taken = { ...files.deltaFile(), displayName: 'Beta Cloud' };
    taken.configuration = { ...taken.configuration, displayName: 'Beta Cloud', dependOnSystems: [] };
    const planned = await planOk([event, taken]);
    assert.equal(entry(planned, '"Title changed"').status, 'skip');
    assert.deepEqual(entry(planned, '"Title changed"').details, ['its system "Nowhere" is not in this HelloID environment']);
    assert.equal(entry(planned, '"Beta Cloud"').status, 'skip');
    assert.deepEqual(entry(planned, '"Beta Cloud"').details, ['a new target system, but another one is already named "Beta Cloud"']);
  });
});

describe('items made earlier in the same run', () => {
  it('notifications, a rule and reconciliation that refer to a target system made in the run', async () => {
    const planned = await planOk(
      [files.deltaFile(), files.deltaNotificationsFile(), files.ruleWithDeltaFile(data), files.reconciliationFile(data)],
      { [`dependsByName:${files.OTHER.delta}`]: true },
    );
    const notification = entry(planned, '"Delta created"');
    assert.equal(notification.status, 'note');
    assert.deepEqual(notification.needs, ['Delta Directory']);
    assert.ok(notification.details.includes('"Delta created" (Account create): the data of "Delta Directory" is linked after it is made'));
    assert.ok(!notification.details.some((d: string) => d.includes('not here')));
    // The rule's only change is a link to the system made in the run: to do, not same
    const rule = entry(planned, '"Employees get Alpha"');
    assert.equal(rule.status, 'note');
    assert.deepEqual(rule.details, ['the entitlements of "Delta Directory" are linked after it is made']);
    const reconciliation = entry(planned, 'Reconciliation configuration');
    assert.ok(reconciliation.details.includes('  - "Delta Directory" (new, after it is made)'));

    const result = await apply(planned.planId);
    assert.ok(!result.isError, resultText(result));
    const applied = result.structuredContent as any;
    assert.equal(applied.failed, 0, applied.overview);
    const delta = data.targetSystems.find((s: any) => s.displayName === 'Delta Directory');
    assert.ok(delta);
    const made = Object.values(data.notificationDetails).find((n: any) => n.name === 'Delta created') as any;
    assert.equal(made.systemId, delta.systemId);
    assert.deepEqual(made.dataReferences, [{ key: 'DeltaDirectory', type: 1, systemId: delta.systemId }]);
    assert.equal(made.enabled, false);
    assert.ok(data.reconciliationSystems.some((s: any) => s.systemId === delta.systemId));
  });

  it('a notification of a notification system made in the run', async () => {
    const planned = await planOk(files.teamsFiles());
    assert.equal(entry(planned, '"Teams Notify" (new)').status, 'todo');
    const notification = entry(planned, '"Teams card"');
    assert.equal(notification.status, 'note');
    assert.deepEqual(notification.needs, ['Teams Notify']);
    const applied = (await apply(planned.planId)).structuredContent as any;
    assert.equal(applied.failed, 0, applied.overview);
    const teams = data.notificationSystems.find((s: any) => s.displayName === 'Teams Notify');
    const card = Object.values(data.notificationDetails).find((n: any) => n.name === 'Teams card') as any;
    assert.equal(card.notificationSystemId, teams.systemId);
    assert.equal(card.notificationTemplateId, 'teams-template');
  });
});

describe('helloid_apply_plan', () => {
  it('keeps the value HelloID has for masked secrets, and audits before and after without secrets', async () => {
    const planned = await planOk([files.alphaFile(data), files.alphaNotificationFile(data), files.sourceFile(data)]);
    assertNoSecrets(planned);
    const result = await apply(planned.planId);
    assert.ok(!result.isError, resultText(result));
    assertNoSecrets(result);
    const applied = result.structuredContent as any;
    assert.equal(applied.failed, 0, applied.overview);

    const sent = writes(fake.state.gatewayRequests);
    const values = sent.find((w) => w.includes('/script-configuration'))!;
    assert.match(values, /"clientSecret":"alpha-client-secret-value"/);
    assert.match(values, /"hiddenValue":"alpha-hidden-password"/);
    assert.match(values, /"baseUrl":"https:\/\/alpha-new.example.test"/);
    assert.match(sent.find((w) => w.startsWith('POST /service/notifications/api/notifications '))!, /"secretWord":"template-hidden-value"/);
    // (the source system's masked values are what it has: not a difference, so not written)
    assert.equal(JSON.parse(data.sourceSystemDetails[IDS.hr].scriptConfiguration).apiKey, 'hr-api-key-value');
    assert.ok(!sent.some((w) => w.includes('/custom-configuration')));

    const line = auditLines(dir).find((l) => l.tool === 'helloid_apply_plan')!;
    assert.equal(line.result, 'ok');
    const items = line.changes.map((c: any) => c.item);
    assert.ok(items.includes('target system "Alpha Directory"'), JSON.stringify(items));
    assert.ok(items.some((i: string) => i.startsWith('notifications "Alpha account created"')));
    assert.ok(items.includes('source system "HR Source"'));
    const alpha = line.changes.find((c: any) => c.item === 'target system "Alpha Directory"');
    assert.equal(alpha.before.configuration.scriptConfiguration.baseUrl, 'https://alpha.example.test');
    assert.equal(alpha.after.configuration.scriptConfiguration.baseUrl, 'https://alpha-new.example.test');
    assert.equal(alpha.after.configuration.scriptConfiguration.clientSecret, '***');
    assertNoSecrets(auditText(dir));
  });

  it('refuses when HelloID changed since the plan', async () => {
    const planned = await planOk([files.toxicFile(data)]);
    data.toxicCombinations[0].enabled = false;
    const result = await apply(planned.planId);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /HelloID changed since the plan \(toxicPolicy:.*\); plan again/);
    assert.deepEqual(writes(fake.state.gatewayRequests), []);
    const again = await apply(planned.planId);
    assert.match(resultText(again), /there is no plan/);
  });

  it('runs a plan at most once', async () => {
    const planned = await planOk([files.customEventFile()]);
    assert.ok(!(await apply(planned.planId)).isError);
    const second = await apply(planned.planId);
    assert.equal(second.isError, true);
    assert.match(resultText(second), /applied already/);
    assert.equal(data.customEvents.filter((e: any) => e.name === 'Title changed').length, 1);
  });

  it('refuses a plan of another MCP session', async () => {
    const planned = await planOk([files.customEventFile()]);
    const other = await server.connect();
    const result = await apply(planned.planId, other);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /another MCP session/);
    assert.ok(!data.customEvents.some((e: any) => e.name === 'Title changed'));
  });

  it('goes on after a failure, and does not do what needs the failed item', async () => {
    const planned = await planOk([files.deltaFile(), files.deltaNotificationsFile(), files.customEventFile()], { [`dependsByName:${files.OTHER.delta}`]: true });
    fake.route('POST', '/connector/powershell-target/api/configuration/create/powershell-target', () => ({ status: 500, body: 'broken' }));
    const applied = (await apply(planned.planId)).structuredContent as any;
    assert.equal(entry(applied, '"Delta Directory"').status, 'failed');
    assert.match(entry(applied, '"Delta Directory"').details[0], /^HelloID answered 500 for POST \/connector\/powershell-target\/api\/configuration\/create\/powershell-target/);
    assert.deepEqual(entry(applied, '"Delta created"').details, ['not done: it needs "Delta Directory", which failed']);
    assert.equal(entry(applied, '"Title changed"').status, 'done');
    assert.equal(applied.failed, 2);
  });
});

describe('modes and the audit of the plan', () => {
  it('mode "read" refuses the plan; mode "plan" plans but refuses apply', async () => {
    await server.close();
    removeDir(dir);
    await start('read');
    const refused = await plan([files.customEventFile()]);
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), /needs mode "plan"/);
    await server.close();
    removeDir(dir);
    await start('plan');
    const planned = await planOk([files.customEventFile()]);
    const result = await apply(planned.planId);
    assert.equal(result.isError, true);
    assert.match(resultText(result), /needs mode "write"/);
  });

  it('writes the size and hash of each file to the audit, never its content', async () => {
    await planOk([files.sourceFile(data), files.customEventFile()]);
    const line = auditLines(dir).find((l) => l.tool === 'helloid_plan_import')!;
    assert.equal(line.arguments.files.length, 2);
    for (const file of line.arguments.files) {
      assert.equal(typeof file.size, 'number');
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(file.content, undefined);
    }
    assert.ok(!auditText(dir).includes('Title changed'));
  });
});
