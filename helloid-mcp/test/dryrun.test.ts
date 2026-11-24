// The script tools over MCP against the fake HelloID: helloid_check_scripts, helloid_list_dryrun_persons,
// helloid_preview_field_mapping and the dry runs (flag, the exact requests with the real configuration
// values, which never reach the output or the audit, the refusal on findings, a given script, a
// planned script of helloid_plan_edit), and the DryRun warnings in edit and import plans. Made-up
// data only.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { installImportRoutes } from './import-routes.ts';
import {
  ALPHA_SECRETS,
  DRYRUN_IDS,
  GOOD_CREATE,
  GOOD_GRANT,
  GOOD_IMPORT,
  GOOD_REVOKE,
  GOOD_UNIQUENESS,
  installDryRunRoutes,
  UNGUARDED_UPDATE,
} from './dryrun-routes.ts';
import { auditLines, auditText, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

/** What must never be in a tool's output or the audit (the person's own data stays with HelloID and the script). */
const NEVER_RETURNED = [...ALPHA_SECRETS, 'generated-password-value', 'person-private-mail@example.test'];
/** What must never be in the audit (also what the script returns about the person). */
const NEVER_AUDITED = [...NEVER_RETURNED, 'anna@example.test', 'mail-of-1', 'https://alpha.example.test'];

let fake: FakeHelloId;
let data: Fixture;
let dir: string;
let server: TestServer;
let client: Client;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

async function start(extra: Record<string, unknown> = {}) {
  data = loadFixture();
  installFixtures(fake, data);
  installImportRoutes(fake, data);
  installDryRunRoutes(fake, data);
  // (a permission no system has would make the import retrieve the permissions and wait for them)
  data.rules[IDS.r2].entitlements = data.rules[IDS.r2].entitlements.filter((e: any) => e.type !== 'Permission');
  dir = tempDir();
  const base = { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl };
  server = await startTestServer(
    makeConfig(
      fake,
      dir,
      {
        training: { ...base, mode: 'write', allowDryRun: true },
        reader: { ...base, mode: 'read', allowDryRun: true },
        locked: { ...base, mode: 'write' },
      },
      extra,
    ),
  );
  client = await server.connect();
  for (const name of ['training', 'reader', 'locked']) await logIn(server, client, fake, name);
  fake.state.gatewayRequests = [];
  data.dryRunRequests.length = 0;
}

beforeEach(() => start());
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

function assertNone(value: unknown, forbidden: string[], what: string) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of forbidden) assert.ok(!text.includes(secret), `${what}: "${secret}" leaked`);
}

const env = (more: Record<string, unknown>, environment = 'training') => ({ environment, ...more });
const ok = async (name: string, args: Record<string, unknown>) => {
  const result = await callTool(client, name, args);
  if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
  assertNone(result, NEVER_RETURNED, name);
  return result;
};
const refused = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
  const result = await callTool(client, name, args);
  assert.equal(result.isError, true, `${name} should fail`);
  assert.match(resultText(result), pattern);
  return resultText(result);
};
const lastDryRun = () => data.dryRunRequests[data.dryRunRequests.length - 1];
const alphaConfig = () => data.powershellConfigurations[IDS.alpha];

const DRY_RUN_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['helloid_dryrun_account_action', { systemId: IDS.alpha, personId: IDS.anna, action: 'Create' }],
  ['helloid_dryrun_permission_action', { systemId: IDS.alpha, personId: IDS.anna, permission: 'Sales', action: 'Grant' }],
  ['helloid_dryrun_permission_import', { systemId: IDS.alpha }],
  ['helloid_dryrun_uniqueness', { systemId: IDS.alpha, personId: IDS.anna }],
];

describe('the flag allowDryRun', () => {
  it('is listed per environment (default false)', async () => {
    const listed = await callOk(client, 'helloid_list_environments');
    assert.deepEqual(
      listed.environments.map((e: any) => [e.name, e.allowDryRun]),
      [
        ['training', true],
        ['reader', true],
        ['locked', false],
      ],
    );
  });

  it('the dry runs need it; the check, the persons and the field mapping preview do not', async () => {
    for (const [name, args] of DRY_RUN_TOOLS) await refused(name, env(args, 'locked'), /allowDryRun is false/);
    assert.equal(data.dryRunRequests.length, 0);
    await ok('helloid_check_scripts', { environments: ['locked'] });
    await ok('helloid_list_dryrun_persons', env({}, 'locked'));
    await ok('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 1 }, 'locked'));
    assert.ok(auditLines(dir).some((l) => l.tool === 'helloid_dryrun_uniqueness' && l.result === 'refused'));
  });

  it('works in every mode, and safety.readOnly does not switch it off (as allowEvaluate)', async () => {
    for (const [name, args] of DRY_RUN_TOOLS) await ok(name, env(args, 'reader'));
    await server.close();
    removeDir(dir);
    await start({ safety: { readOnly: true } });
    await ok('helloid_dryrun_account_action', env(DRY_RUN_TOOLS[0]![1]));
    await refused('helloid_plan_edit', env({ kind: 'targetSystem', id: IDS.alpha, changes: { set: [{ path: 'configuration.description', value: 'x' }] } }), /safety\.readOnly/);
  });

  it('annotations: the check and previews are read-only; the dry runs are not destructive', async () => {
    const { tools } = await client.listTools();
    const of = (name: string) => tools.find((t) => t.name === name)!.annotations!;
    for (const name of ['helloid_check_scripts', 'helloid_list_dryrun_persons', 'helloid_preview_field_mapping']) assert.equal(of(name).readOnlyHint, true, name);
    for (const [name] of DRY_RUN_TOOLS) {
      assert.equal(of(name).readOnlyHint, false, name);
      assert.equal(of(name).destructiveHint, false, name);
      assert.match(tools.find((t) => t.name === name)!.description!, /must be inside a dry-run check/);
    }
    assert.match(tools.find((t) => t.name === 'helloid_plan_edit')!.description!, /helloid_dryrun_account_action/);
  });
});

describe('helloid_list_dryrun_persons', () => {
  it('HelloID\'s search and paging', async () => {
    const page = (await ok('helloid_list_dryrun_persons', env({ offset: 1, limit: 2 }))).structuredContent as any;
    assert.deepEqual(page.items.map((p: any) => p.displayName), ['Bram Sample (E002)', 'Chris Excluded (E003)']);
    assert.equal(page.total, 4);
    const request = fake.state.gatewayRequests.find((r) => r.path.endsWith('/selection-persons'))!;
    assert.deepEqual([request.query.get('skip'), request.query.get('take'), request.query.get('search')], ['1', '2', '']);
    const found = (await ok('helloid_list_dryrun_persons', env({ search: 'bram' }))).structuredContent as any;
    assert.deepEqual(found.items, [{ personId: IDS.bram, displayName: 'Bram Sample (E002)' }]);
  });
});

describe('helloid_preview_field_mapping', () => {
  it('the saved mapping: the request as the editor sends it, values and errors per field', async () => {
    const result = (await ok('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'create' }))).structuredContent as any;
    const get = fake.state.gatewayRequests.find((r) => r.method === 'GET' && r.path === `/connector/powershell-target/api/mapping/${IDS.alpha}`)!;
    assert.deepEqual(
      ['usedInNotificationOption', 'storedInAccountDataOption', 'noOption'].map((k) => get.query.get(k)),
      ['true', 'true', 'true'],
    );
    const body = lastDryRun().json;
    assert.equal(body.personId, IDS.anna);
    assert.equal(body.action, 1);
    const mail = body.fields[0];
    assert.deepEqual(Object.keys(mail), ['type', 'mappingActions', 'configuredForActions', 'identifier', 'name', 'description', 'useInNotificationsForActions', 'storeInAccountDataForActions']);
    assert.deepEqual(mail.configuredForActions, [1, 3, 2, 4, 5]);
    assert.equal(mail.useInNotificationsForActions, 'Create, Update');
    assert.equal(mail.storeInAccountDataForActions, 'Create, Enable, Update, Disable, Delete');
    assert.deepEqual(mail.mappingActions, alphaConfig().mappingConfiguration.fields[0].mappingActions);
    assert.equal(result.fieldsSource, 'saved');
    assert.deepEqual(
      result.fields.map((f: any) => [f.name, f.value, f.hasError]),
      [
        ['mail', 'mail-of-1', false],
        ['displayName', 'displayName-of-1', false],
        ['broken', null, true],
      ],
    );
    assert.equal(result.fields[2].error, 'Unexpected end of script');
    const update = (await ok('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 3 }))).structuredContent as any;
    assert.deepEqual(update.fields.map((f: any) => f.name), ['mail']);
    assert.deepEqual(update.notForAction, ['displayName', 'broken']);
    assert.match(resultText(await ok('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 3 }))), /1 field\(s\) with a value/);
  });

  it('an edited mapping: partial changes, a whole mapping, the mapping of a pending plan', async () => {
    const changed = (await ok(
      'helloid_preview_field_mapping',
      env({
        systemId: IDS.alpha,
        personId: IDS.anna,
        action: 1,
        changes: {
          set: [{ path: 'configuration.mappingConfiguration.fields[name=displayName].mappingActions[0].value', value: '"Person.Name.NickName"' }],
          lists: [{ path: 'configuration.mappingConfiguration.fields', op: 'remove', match: { name: 'broken' } }],
        },
      }),
    )).structuredContent as any;
    assert.equal(changed.changed, true);
    const body = lastDryRun().json;
    assert.deepEqual(body.fields.map((f: any) => f.name), ['mail', 'displayName']);
    assert.equal(body.fields[1].mappingActions[0].value, '"Person.Name.NickName"');
    assert.equal(alphaConfig().mappingConfiguration.fields.length, 3, 'nothing saved');

    const given = (await ok(
      'helloid_preview_field_mapping',
      env({ systemId: IDS.alpha, personId: IDS.bram, action: 'Create', fields: [{ name: 'upn', type: 1, mappingActions: [{ entitlementActions: [1], mode: 1, value: '"x"' }] }] }),
    )).structuredContent as any;
    assert.equal(given.fieldsSource, 'given');
    assert.deepEqual(given.fields.map((f: any) => [f.name, f.value]), [['upn', 'upn-of-2']]);
    assert.match(lastDryRun().json.fields[0].identifier, /^[0-9a-f-]{36}$/);
    assert.ok(given.notes.some((n: string) => /temporary/.test(n)));

    const planned = await callOk(client, 'helloid_plan_edit', env({
      kind: 'targetSystem',
      id: IDS.alpha,
      changes: { set: [{ path: 'configuration.mappingConfiguration.fields[name=mail].mappingActions[0].value', value: '"Person.Accounts.MicrosoftActiveDirectory.mail"' }] },
    }));
    assert.ok(planned.planId, planned.overview);
    const fromPlan = (await ok('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 1, planId: planned.planId }))).structuredContent as any;
    assert.equal(fromPlan.fieldsSource, 'plan');
    assert.equal(lastDryRun().json.fields[0].mappingActions[0].value, '"Person.Accounts.MicrosoftActiveDirectory.mail"');
    await refused('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 1, planId: planned.planId, fields: [] }), /fields or planId/);
    await refused('helloid_preview_field_mapping', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Rename' }), /Unknown action/);
  });
});

describe('helloid_dryrun_account_action', () => {
  it('the exact request with the real configuration values, which are never returned or audited', async () => {
    const result = await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create' }));
    const request = lastDryRun();
    assert.equal(request.path, '/connector/powershell-target/api/preview/entitlement-action');
    const body = request.json;
    assert.deepEqual(Object.keys(body), [
      'script', 'scriptConfiguration', 'executeOnPremises', 'systemId', 'operation', 'entitlementAction', 'person',
      'accountReference', 'manager', 'managerAccountReference', 'powerShellScriptContext',
    ]);
    assert.equal(body.script, GOOD_CREATE);
    assert.deepEqual(body.scriptConfiguration, alphaConfig().scriptConfiguration);
    assert.equal(body.scriptConfiguration.clientSecret, 'alpha-client-secret-value', 'the real value is sent');
    assert.equal(body.scriptConfiguration.hiddenValue, 'alpha-hidden-password');
    assert.deepEqual([body.executeOnPremises, body.systemId, body.operation, body.entitlementAction, body.powerShellScriptContext], [false, IDS.alpha, 0, 1, 1]);
    assert.equal(body.person.personId, IDS.anna);
    assert.equal(body.person.contact.business.email, 'person-private-mail@example.test', 'the person as the preview gives it');
    assert.deepEqual([body.accountReference, body.manager, body.managerAccountReference], [null, null, null]);
    const preview = fake.state.gatewayRequests.find((r) => r.path.endsWith('/actions/data/preview'))!;
    assert.equal(preview.path, `/service/rule-enforcement/api/entitlements/${IDS.alpha}/${IDS.anna}/actions/data/preview`);
    assert.ok(preview.query.get('cachebust'));

    const out = result.structuredContent as any;
    assert.equal(out.success, true);
    assert.equal(out.script, 'accountCreate');
    assert.equal(out.scriptSource, 'saved');
    assert.deepEqual(out.person, { personId: IDS.anna, displayName: 'Anna Example (E001)' });
    assert.equal(out.resultData.Data.password, '***');
    assert.equal(out.resultData.Data.note, 'uses ***');
    assert.equal(out.logMessages[1].message, 'Connected with secret ***');
    assert.equal(out.accountReference.source, 'none');
    assert.ok(out.notes.some((n: string) => /no account reference/.test(n)));
    assert.match(resultText(result), /ran successfully/);

    const line = auditLines(dir).find((l) => l.tool === 'helloid_dryrun_account_action')!;
    assert.equal(line.result, 'ok');
    assert.equal(line.arguments.personId, IDS.anna);
    assert.match(line.summary, /Anna Example \(E001\)/);
    assertNone(line, NEVER_AUDITED, 'audit');
    assertNone(auditText(dir), NEVER_AUDITED, 'audit file');
  });

  it('refuses a script with findings, with the line numbers, and sends nothing', async () => {
    const text = await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Update' }), /DryRun check found 1 problem/);
    assert.match(text, /line 3: unguarded-write/);
    assert.match(text, /must be inside a dry-run check/);
    assert.match(text, /false positives/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 2 }), /empty-script/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'disable' }), /empty-script/);
    assert.equal(data.dryRunRequests.length, 0);
    assert.equal(fake.state.gatewayRequests.filter((r) => r.path.endsWith('/actions/data/preview')).length, 0, 'the person is not even read');
    const line = auditLines(dir).find((l) => l.tool === 'helloid_dryrun_account_action')!;
    assert.equal(line.result, 'refused');
  });

  it('a given script runs instead of the saved one (and is checked first); the audit has its hash, not its text', async () => {
    const script = GOOD_CREATE.replace('/users"', '/people"');
    const out = (await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.bram, action: 'Delete', script }))).structuredContent as any;
    assert.equal(out.scriptSource, 'given');
    assert.equal(lastDryRun().json.script, script);
    assert.equal(lastDryRun().json.entitlementAction, 5);
    const line = auditLines(dir).find((l) => l.tool === 'helloid_dryrun_account_action')!;
    assert.equal(line.arguments.script.size, Buffer.byteLength(script));
    assert.match(line.arguments.script.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(line).includes('/people'));
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.bram, action: 'Create', script: UNGUARDED_UPDATE }), /line 3: unguarded-write/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.bram, action: 'Create', script: '$actionContext.DryRun = $false' }), /dryrun-override/);
  });

  it('the account reference: from HelloID\'s preview, or given', async () => {
    data.accountReferences[IDS.anna] = 'acc-0001';
    const out = (await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create' }))).structuredContent as any;
    assert.equal(lastDryRun().json.accountReference, 'acc-0001');
    assert.deepEqual(out.accountReference, { value: 'acc-0001', source: 'helloid' });
    const given = (await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', accountReference: { id: 'x-1' } }))).structuredContent as any;
    assert.deepEqual(lastDryRun().json.accountReference, { id: 'x-1' });
    assert.equal(given.accountReference.source, 'given');
  });

  it('only PowerShell target systems; an unknown system or person is an error', async () => {
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.beta, personId: IDS.anna, action: 'Create' }), /only PowerShell target systems/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.missing, personId: IDS.anna, action: 'Create' }), /not in HelloID's list/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.missing, action: 'Create' }), /404/);
  });

  it('a script that fails: success false and the error message, secrets scrubbed', async () => {
    data.dryRunAnswer = {
      resultData: { AuditLogs: [{ Message: 'Could not connect', IsError: true }], Success: false },
      resultDataCount: 0,
      dataLimited: false,
      logMessages: [{ messageTimeUtc: '2026-11-20T10:00:00Z', message: 'x'.repeat(2500), level: 4 }],
      scriptExecutionSuccessful: false,
      errorMessage: 'Login with alpha-hidden-password failed',
    };
    const result = await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create' }));
    const out = result.structuredContent as any;
    assert.equal(out.success, false);
    assert.equal(out.errorMessage, 'Login with *** failed');
    assert.equal(out.logMessages[0].message.length, 2000);
    assert.equal(out.logMessagesTruncated, true);
    assert.match(resultText(result), /FAILED/);
  });
});

describe('a planned script (helloid_plan_edit + planId)', () => {
  it('the plan warns about an unguarded script; the dry run of that plan refuses it', async () => {
    const planned = await callOk(client, 'helloid_plan_edit', env({ kind: 'targetSystem', id: IDS.alpha, changes: { set: [{ path: 'configuration.scripts.accountCreate', value: UNGUARDED_UPDATE }] } }));
    assert.ok(planned.planId, planned.overview);
    const warnings: string[] = planned.changes[0].warnings;
    assert.match(warnings[0]!, /DryRun check of accountCreate/);
    assert.match(warnings[0]!, /must be inside a dry-run check/);
    assert.match(warnings[0]!, /warning only/);
    assert.match(warnings[1]!, /^line 3: unguarded-write/);
    assert.match(planned.overview, /line 3: unguarded-write/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', planId: planned.planId }), /planned accountCreate script/);
    assert.equal(data.dryRunRequests.length, 0);
  });

  it('a fixed script in a plan runs as planned; scriptPath picks another planned script; other plans are refused', async () => {
    const fixed = GOOD_CREATE.replace("Method = 'POST'", "Method = 'PATCH'");
    const planned = await callOk(client, 'helloid_plan_edit', env({ kind: 'targetSystem', id: IDS.alpha, changes: { set: [{ path: 'configuration.scripts.accountUpdate', value: fixed }] } }));
    assert.deepEqual(planned.changes[0].warnings, []);
    const out = (await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Update', planId: planned.planId }))).structuredContent as any;
    assert.equal(out.scriptSource, 'plan');
    assert.equal(lastDryRun().json.script, fixed);
    assert.equal(lastDryRun().json.entitlementAction, 3);
    assert.equal(alphaConfig().scripts.accountUpdate, UNGUARDED_UPDATE, 'nothing saved');
    await ok('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', planId: planned.planId, scriptPath: 'configuration.scripts.accountUpdate' }));
    assert.equal(lastDryRun().json.script, fixed);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', scriptPath: 'configuration.scripts.accountUpdate' }), /give planId too/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', planId: planned.planId, script: fixed }), /script or planId/);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', planId: 'no-such-plan' }), /no plan/);
    // A plan of another item
    const toxic = await callOk(client, 'helloid_plan_edit', env({ kind: 'toxicCombination', id: IDS.tx1, changes: { set: [{ path: 'policy.enabled', value: false }] } }));
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', planId: toxic.planId }), /changes a toxicCombination/);
    // A plan of helloid_plan_import has no planned scripts
    const exported = await callOk(client, 'helloid_get_target_system', env({ systemId: IDS.alpha }));
    exported.system.configuration.description = 'changed by an import';
    const imported = await callOk(client, 'helloid_plan_import', env({ files: [{ name: 'alpha.json', content: exported.system }] }));
    assert.ok(imported.planId, imported.overview);
    await refused('helloid_dryrun_account_action', env({ systemId: IDS.alpha, personId: IDS.anna, action: 'Create', planId: imported.planId }), /not a plan of helloid_plan_edit/);
  });
});

describe('helloid_dryrun_permission_action', () => {
  it('Grant by name: the permission of its set, the grant script, the recorded codes', async () => {
    const out = (await ok('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: 'sales', action: 'Grant' }))).structuredContent as any;
    const body = lastDryRun().json;
    assert.deepEqual(Object.keys(body), [
      'script', 'scriptConfiguration', 'executeOnPremises', 'permissionDefinitionIdentifier', 'permission', 'systemId', 'operation',
      'hasSubPermissions', 'entitlementAction', 'person', 'accountReference', 'manager', 'managerAccountReference', 'powerShellScriptContext',
    ]);
    assert.equal(body.script, GOOD_GRANT);
    assert.deepEqual(body.scriptConfiguration, alphaConfig().scriptConfiguration);
    assert.equal(body.permissionDefinitionIdentifier, DRYRUN_IDS.groups);
    assert.deepEqual(body.permission, { displayName: 'Sales', entitlementId: DRYRUN_IDS.sales, reference: { Id: 'grp-sales', Name: 'Sales', Type: 'Group' } });
    assert.deepEqual([body.operation, body.entitlementAction, body.hasSubPermissions, body.powerShellScriptContext], [0, 0, false, 2]);
    const list = fake.state.gatewayRequests.find((r) => r.path === `/connector/powershell-target/api/configuration/${IDS.alpha}/permissions/${DRYRUN_IDS.groups}`)!;
    assert.equal(list.query.get('skip'), '0');
    assert.equal(out.permission.permissionDefinitionName, 'Groups');
    assert.equal(out.script, 'grantPermissionScript');
    assertNone(auditText(dir), NEVER_AUDITED, 'audit');
  });

  it('Revoke by entitlementId; Update is refused (the script changes DryRun)', async () => {
    await ok('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: DRYRUN_IDS.finance, action: 1 }));
    assert.equal(lastDryRun().json.script, GOOD_REVOKE);
    assert.equal(lastDryRun().json.permission.displayName, 'Finance');
    const count = data.dryRunRequests.length;
    const text = await refused('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: 'Finance', action: 'Update' }), /updatePermissionScript of permission set "Groups"/);
    assert.match(text, /line 1: dryrun-override/);
    assert.match(text, /line 2: unguarded-write/);
    assert.equal(data.dryRunRequests.length, count);
  });

  it('a name in several sets needs permissionDefinition; a set with one script for every action runs it', async () => {
    await refused('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: 'Shared', action: 'Grant' }), /2 permissions match "Shared".*"Groups".*"Mailboxes"/);
    const out = (await ok('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: 'Shared', permissionDefinition: 'mailboxes', action: 'Revoke' }))).structuredContent as any;
    assert.equal(out.script, 'permissionActionScript');
    assert.equal(lastDryRun().json.script, GOOD_GRANT);
    assert.equal(lastDryRun().json.hasSubPermissions, true);
    assert.equal(lastDryRun().json.permissionDefinitionIdentifier, DRYRUN_IDS.mailboxes);
    assert.ok(out.notes.some((n: string) => /one script for every action/.test(n)));
    await refused('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: 'Nothing', action: 'Grant' }), /No permission "Nothing".*"Sales"/);
    await refused('helloid_dryrun_permission_action', env({ systemId: IDS.alpha, personId: IDS.anna, permission: 'Sales', permissionDefinition: 'Roles', action: 'Grant' }), /no permission set "Roles"/);
  });
});

describe('helloid_dryrun_permission_import', () => {
  it('the recorded request (no configuration, no person) and the permissions in pages', async () => {
    const result = await ok('helloid_dryrun_permission_import', env({ systemId: IDS.alpha, offset: 1, limit: 1 }));
    assert.equal(lastDryRun().path, '/connector/powershell-target/api/preview/permission-import');
    assert.deepEqual(lastDryRun().json, { script: GOOD_IMPORT, systemId: IDS.alpha, executeOnPremises: false });
    const out = result.structuredContent as any;
    assert.equal(out.permissionDefinitionName, 'Groups');
    assert.equal(out.permissions.total, 3);
    assert.deepEqual(out.permissions.items, [{ displayName: 'Finance', permissionReference: { Name: 'Finance', Type: 'Group', Id: 'grp-finance' } }]);
    assert.equal(out.dataLimited, true);
    assert.equal(out.resultDataCount, 7);
    assert.match(resultText(result), /found 7 in all/);
  });

  it('a given script is checked first', async () => {
    await refused('helloid_dryrun_permission_import', env({ systemId: IDS.alpha, script: 'Remove-ExampleGroup -All' }), /line 1: unguarded-write/);
    await ok('helloid_dryrun_permission_import', env({ systemId: IDS.alpha, script: GOOD_IMPORT.replace('/groups', '/roles') }));
    assert.match(lastDryRun().json.script, /\/roles/);
  });
});

describe('helloid_dryrun_uniqueness', () => {
  it('the recorded request and the answer', async () => {
    const result = await ok('helloid_dryrun_uniqueness', env({ systemId: IDS.alpha, personId: IDS.anna }));
    const body = lastDryRun().json;
    assert.equal(lastDryRun().path, '/connector/powershell-target/api/preview/uniqueness-check');
    assert.deepEqual(Object.keys(body), ['script', 'selectedPerson', 'person', 'accountReference', 'manager', 'managerAccountReference', 'entitlementAction', 'systemId', 'powerShellScriptContext']);
    assert.equal(body.script, GOOD_UNIQUENESS);
    assert.deepEqual(body.selectedPerson, { personId: IDS.anna, displayName: 'Anna Example (E001)' });
    assert.deepEqual([body.entitlementAction, body.systemId, body.powerShellScriptContext], ['Create', IDS.alpha, 128]);
    assert.ok(fake.state.gatewayRequests.some((r) => r.path === `/connector/powershell-target/api/mapping/${IDS.alpha}/uniqueness`));
    assert.deepEqual((result.structuredContent as any).resultData, { Success: false, NonUniqueFields: ['mail'], Iteration: null });
    assert.match(resultText(result), /NOT unique \(mail\)/);
  });

  it('refuses an empty uniqueness script', async () => {
    alphaConfig().mappingConfiguration.uniquenessConfiguration.script = null;
    await refused('helloid_dryrun_uniqueness', env({ systemId: IDS.alpha, personId: IDS.anna }), /empty-script/);
  });
});

describe('helloid_check_scripts', () => {
  it('every script of every PowerShell system, findings with line numbers, empty ones apart', async () => {
    const result = await ok('helloid_check_scripts', {});
    const out = result.structuredContent as any;
    assert.deepEqual(out.environments.map((e: any) => e.environment), ['training', 'reader', 'locked']);
    const alpha = out.environments[0].systems.find((s: any) => s.systemId === IDS.alpha);
    assert.equal(out.environments[0].systems.length, 1, 'only PowerShell systems');
    assert.deepEqual(alpha.notSet.sort(), ['accountDisable', 'accountEnable', 'permission "Groups" permissionActionScript', 'permission "Groups" retrievePermissionsScript', 'permission "Mailboxes" permissionImportScript'].sort());
    assert.deepEqual(
      alpha.scripts.map((s: any) => [s.name, s.unused, s.findings.map((f: any) => `${f.line}:${f.kind}`)]),
      [
        ['accountUpdate', false, ['3:unguarded-write']],
        ['permission "Groups" updatePermissionScript', false, ['1:dryrun-override', '2:unguarded-write']],
        ['permission "Mailboxes" grantPermissionScript', true, ['1:unguarded-write']],
      ],
    );
    assert.equal(alpha.scripts[0].path, 'configuration.scripts.accountUpdate');
    assert.equal(out.findings, 12);
    assert.match(out.limitations, /static check/);
    assert.match(out.rule, /must be inside a dry-run check/);
    assert.match(resultText(result), /12 finding\(s\) in 9 script\(s\)/);
  });

  it('one system; environments that cannot be read are listed', async () => {
    const out = (await ok('helloid_check_scripts', { environments: ['training', 'nowhere'], systemId: IDS.alpha })).structuredContent as any;
    assert.equal(out.environments.length, 1);
    assert.deepEqual(out.unavailable.map((u: any) => u.environment), ['nowhere']);
    await refused('helloid_check_scripts', { environments: ['training'], systemId: IDS.beta }, /no PowerShell target system/);
  });
});

describe('DryRun warnings in import plans', () => {
  it('a changed script of a planned target system: the entry\'s warnings; unchanged scripts are not repeated', async () => {
    const exported = await callOk(client, 'helloid_get_target_system', env({ systemId: IDS.alpha }));
    exported.system.configuration.scripts.accountCreate = 'Set-ExampleUser -Identity $actionContext.References.Account';
    const planned = await callOk(client, 'helloid_plan_import', env({ files: [{ name: 'alpha.json', content: exported.system }] }));
    assert.ok(planned.planId, planned.overview);
    const entry = planned.entries.find((e: any) => e.group === 'Target systems');
    assert.match(entry.warnings[0], /DryRun check of accountCreate/);
    assert.match(entry.warnings[1], /^line 1: unguarded-write/);
    assert.ok(!entry.warnings.some((w: string) => /accountUpdate/.test(w)), 'accountUpdate did not change');
    assert.match(planned.overview, /DryRun check of the planned scripts \(warnings only/);
    // (a warning only: the plan can be applied)
    const applied = await callOk(client, 'helloid_apply_plan', env({ planId: planned.planId }));
    assert.equal(applied.failed, 0, applied.overview);
    assert.equal(alphaConfig().scripts.accountCreate, 'Set-ExampleUser -Identity $actionContext.References.Account');
  });

  it('a new system: every script is checked', async () => {
    const exported = await callOk(client, 'helloid_get_target_system', env({ systemId: IDS.alpha }));
    const file = { ...exported.system, systemId: 'c9000000-0000-4000-8000-000000000001', displayName: 'Alpha Copy' };
    file.configuration = { ...file.configuration, systemId: file.systemId, displayName: 'Alpha Copy' };
    const planned = await callOk(client, 'helloid_plan_import', env({ files: [{ name: 'copy.json', content: file }] }));
    const entry = planned.entries.find((e: any) => e.group === 'Target systems');
    assert.match(entry.label, /\(new\)/);
    assert.ok(entry.warnings.some((w: string) => /DryRun check of accountUpdate/.test(w)), JSON.stringify(entry.warnings));
    assert.ok(entry.warnings.some((w: string) => /updatePermissionScript/.test(w)));
  });
});
