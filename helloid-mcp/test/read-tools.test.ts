// The read tools against the fake HelloID with synthetic fixtures: what each one reads, its short
// answer with paging, and the masking of secrets (also in the audit log).

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Config } from '../src/config.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { auditText, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

/** Secret values in the fixtures: none of them may reach a tool result or the audit log. */
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
let config: Config;
let server: TestServer;
let client: Client;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

beforeEach(async () => {
  data = loadFixture();
  installFixtures(fake, data);
  dir = tempDir();
  fake.state.gatewayRequests = [];
  config = makeConfig(fake, dir, { training: { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl, mode: 'read', allowEvaluate: false } });
  server = await startTestServer(config);
  client = await server.connect();
  await logIn(server, client, fake);
});
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const requests = (path: string) => fake.state.gatewayRequests.filter((r) => r.path === path);

function assertNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret ${secret} leaked`);
}

describe('tool list', () => {
  it('has every read, report and evaluation tool with annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const expected = [
      'helloid_list_target_systems', 'helloid_get_target_system', 'helloid_list_source_systems', 'helloid_get_source_system',
      'helloid_list_business_rules', 'helloid_get_business_rule', 'helloid_list_entitlements',
      'helloid_list_toxic_combinations', 'helloid_get_toxic_combination',
      'helloid_list_notifications', 'helloid_get_notification', 'helloid_list_notification_systems',
      'helloid_get_notification_system', 'helloid_list_custom_events', 'helloid_get_custom_event',
      'helloid_list_schedules', 'helloid_get_reconciliation_configuration', 'helloid_get_aggregation_configuration',
      'helloid_get_person_lifecycle', 'helloid_get_calculated_layers', 'helloid_list_custom_fields', 'helloid_list_excluded_persons',
      'helloid_list_persons', 'helloid_get_person', 'helloid_list_granted_entitlements',
      'helloid_list_evaluation_runs', 'helloid_get_evaluation_report', 'helloid_get_evaluation_logging',
      'helloid_export_everything',
      'helloid_report_rules_without_entitlements', 'helloid_report_rules_without_persons', 'helloid_report_rules_for_entitlement',
      'helloid_report_system_access', 'helloid_check_references',
      'helloid_evaluate_rule_persons', 'helloid_start_evaluation',
    ];
    for (const name of expected) assert.ok(names.includes(name), `${name} is missing`);
    for (const tool of tools.filter((t) => expected.includes(t.name))) {
      assert.equal(tool.annotations?.openWorldHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, tool.name !== 'helloid_start_evaluation', tool.name);
      assert.ok(tool.outputSchema, tool.name);
      assert.ok(tool.inputSchema.properties?.environment, tool.name);
    }
  });
});

describe('target systems', () => {
  it('lists them in pages, in mode read', async () => {
    const all = await callOk(client, 'helloid_list_target_systems', { environment: 'training' });
    assert.equal(all.total, 3);
    assert.deepEqual(all.items[0], {
      systemId: IDS.alpha,
      displayName: 'Alpha Directory',
      templateIdentifier: 'powershell-target',
      isDisabled: false,
      isReferenceSystem: false,
      entitlementTypes: [
        { code: 1, type: 'Account', label: 'Account' },
        { code: 3, type: 'Permission', label: 'Permission' },
      ],
    });
    assert.equal(all.items[2].entitlementTypes.length, 0, 'a system HelloID gives no types for has none');
    assert.equal(requests('/service/rule-enforcement/api/entitlement-import/entitlement-types').length, 1, 'the map is read once');
    assert.equal(requests('/service/provisioning-api/api/target-systems')[0]?.query.get('showReferenceSystems'), 'true');
    const second = await callOk(client, 'helloid_list_target_systems', { environment: 'training', offset: 1, limit: 1 });
    assert.deepEqual([second.total, second.offset, second.limit, second.items.length, second.items[0].displayName], [3, 1, 1, 1, 'Beta Cloud']);
  });

  it('gets a PowerShell system as the userscript\'s export collects it, secrets masked', async () => {
    const result = await callTool(client, 'helloid_get_target_system', { environment: 'training', systemId: IDS.alpha });
    assert.notEqual(result.isError, true, resultText(result));
    const { system, systemsDependingOn } = result.structuredContent as any;
    assert.equal(system.secretsIncluded, false);
    assert.equal(system.exportedFrom, fake.portalUrl);
    assert.match(system.exportedBy, /^helloid-mcp /);
    assert.equal(system.contents, undefined, 'a target system export has no contents');
    assert.deepEqual(Object.keys(system).slice(0, 8), [
      'exportedAt', 'exportedFrom', 'exportedBy', 'secretsIncluded', 'systemId', 'displayName', 'templateIdentifier', 'configuration',
    ]);
    const script = system.configuration.scriptConfiguration;
    assert.equal(script.clientSecret, '***');
    assert.equal(script.hiddenValue, '***', 'a password field of the form');
    assert.equal(script.emptySecret, '', 'an empty secret stays empty');
    assert.equal(script.baseUrl, 'https://alpha.example.test');
    assert.deepEqual(system.secrets, [
      { key: 'clientSecret', hasValue: true },
      { key: 'hiddenValue', hasValue: true },
      { key: 'emptySecret', hasValue: false },
    ]);
    assert.deepEqual(system.configuration.dependOnSystems, [{ systemId: IDS.beta, displayName: 'Beta Cloud' }]);
    assert.deepEqual(system.listEntry, { icon: 'alpha.png', listOnlyField: 'only in the list' });
    assert.deepEqual(system.agents.selected, [{ type: 'tag', value: 'onprem' }]);
    assert.deepEqual(system.agents.selectedAgents.map((a: any) => a.agentId), ['agent-1']);
    assert.deepEqual(system.defaultScripts, { create: "Write-Output 'create'" });
    assert.deepEqual(system.resources, { resources: [] });
    assert.equal(system.accountsReference, 'Person.Accounts._11111111111141118111111111111111');
    assert.deepEqual(
      system.usedBy.map((u: any) => [u.displayName, u.dependsOnThisSystem, u.references]),
      [
        ['Beta Cloud', false, ['mappingConfiguration.fields[mail].mappingActions[0].value']],
        ['Gamma Files', false, ['mappingConfiguration.fields[manager].mappingActions[0].value']],
      ],
    );
    assert.deepEqual(system.notifications.map((n: any) => [n.name, n.customEventName]), [['Alpha account created', 'Manager changed']]);
    assert.deepEqual(system.notificationSystems.map((s: any) => s.systemConfiguration.data), [
      { hidden: '***', apiToken: '***', text: { required: 'hello' } },
    ]);
    assert.deepEqual(system.notificationsUsingThisSystem.map((n: any) => [n.name, n.dataReferences.length]), [['Beta update', 1]]);
    assert.deepEqual(system.rules.map((r: any) => r.ruleName), ['Employees get Alpha', 'Sales get Alpha']);
    for (const rule of system.rules) for (const e of rule.entitlements) assert.equal(e.systemIdentifier, IDS.alpha);
    assert.equal(system.rules[0].condition.hasActiveContract, true);
    assert.deepEqual(systemsDependingOn, []);
    assert.equal(requests('/service/provisioning-api/api/target-systems/get-systems-depending-on')[0]?.query.get('systemId'), IDS.alpha);
    assert.equal(system.couldNotRead, undefined);
    assertNoSecrets(result);
    assertNoSecrets(auditText(dir));
  });

  it('masks the settings of a built-in type and lists them as secrets', async () => {
    const { system, systemsDependingOn, entitlementTypes } = await callOk(client, 'helloid_get_target_system', { environment: 'training', systemId: IDS.beta });
    assert.deepEqual(entitlementTypes.map((t: any) => [t.code, t.type, t.label]), [[1, 'Account', 'Account'], [2, 'AccountAccess', 'Account Access'], [3, 'Permission', 'Permission']]);
    assert.equal(system.configuration.clientSecret, '***');
    assert.equal(system.configuration.exchangeConfiguration.password, '***');
    assert.equal(system.configuration.exchangeConfiguration.server, 'mail.example.test');
    assert.deepEqual(system.secrets, [
      { key: 'clientSecret', hasValue: true },
      { key: 'exchangeConfiguration.password', hasValue: true },
    ]);
    assert.deepEqual(systemsDependingOn, [{ systemId: IDS.alpha, displayName: 'Alpha Directory' }]);
    assert.deepEqual(system.usedBy.map((u: any) => [u.displayName, u.dependsOnThisSystem]), [['Alpha Directory', true]]);
    assertNoSecrets(system);
  });

  it('says which optional part could not be read', async () => {
    fake.route('GET', /^\/connector\/powershell-target\/api\/resources\//, () => ({ status: 500, body: 'broken' }));
    const { system } = await callOk(client, 'helloid_get_target_system', { environment: 'training', systemId: IDS.alpha });
    assert.deepEqual(system.couldNotRead, ['resources']);
    assert.equal(system.resources, undefined);
  });

  it('refuses an unknown system with an error Claude can act on', async () => {
    const result = await callTool(client, 'helloid_get_target_system', { environment: 'training', systemId: IDS.missing });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /not in HelloID's list of target systems/);
  });
});

describe('source systems', () => {
  it('lists and gets them, the configuration masked and the template with its catalog ID', async () => {
    const list = await callOk(client, 'helloid_list_source_systems', { environment: 'training' });
    assert.deepEqual(list.items, [{ systemId: IDS.hr, displayName: 'HR Source', description: null, executeOnPremises: false }]);
    const result = await callTool(client, 'helloid_get_source_system', { environment: 'training', systemId: IDS.hr });
    const { system } = result.structuredContent as any;
    assert.equal(system.contents, 'sourceSystem');
    assert.equal(system.secretsIncluded, false);
    assert.deepEqual(JSON.parse(system.system.scriptConfiguration), { url: 'https://hr.example.test', apiKey: '***', passphrase: '***' });
    assert.deepEqual(system.system.repositoryMetaData, { name: 'HelloID-Conn-Prov-Source-Example', version: '1.0.0', repositoryId: 123456 });
    assert.deepEqual(system.agents, { selected: [], summary: { agentCount: 0 } });
    assertNoSecrets(result);
  });
});

describe('business rules, entitlements and toxic combinations', () => {
  it('lists the rules with their counts', async () => {
    const list = await callOk(client, 'helloid_list_business_rules', { environment: 'training' });
    assert.equal(list.total, 3);
    assert.deepEqual(list.items[2], {
      ruleId: IDS.r3,
      name: 'Empty rule',
      published: false,
      hasDraft: true,
      configuredEntitlementCount: 0,
      personInRuleLastEvaluationCount: 0,
      lastChanged: '2026-01-04T03:04:05Z',
    });
    const overview = requests('/service/rules/api/rules/overview')[0]!;
    assert.deepEqual(overview.json, { search: '', skip: 0, take: 999999, published: true, draft: true });
    assert.ok(overview.query.get('cachebust'));
  });

  it('gets a rule with its condition summary; null when there is none', async () => {
    const one = await callOk(client, 'helloid_get_business_rule', { environment: 'training', ruleId: IDS.r1 });
    assert.equal(one.rule.name, 'Employees get Alpha');
    assert.equal(one.conditionSummary.person.value, 'active');
    assert.equal(requests(`/service/rules/api/rules/${IDS.r1}/condition-summary`)[0]?.query.get('draft'), 'false');
    const draft = await callOk(client, 'helloid_get_business_rule', { environment: 'training', ruleId: IDS.r3 });
    assert.equal(draft.conditionSummary, null);
  });

  it('lists the entitlements with type names and system names', async () => {
    const list = await callOk(client, 'helloid_list_entitlements', { environment: 'training' });
    assert.deepEqual(
      list.items.map((e: any) => [e.type, e.displayName, e.systemName]),
      [
        ['Account', 'Account', 'Alpha Directory'],
        ['AccountAccess', 'Account Access', 'Alpha Directory'],
        ['Permission', 'Group Sales', 'Alpha Directory'],
        ['Account', 'Account', 'Beta Cloud'],
      ],
    );
  });

  it('lists and gets toxic combinations with their entitlements', async () => {
    const list = await callOk(client, 'helloid_list_toxic_combinations', { environment: 'training' });
    assert.deepEqual(list.items[0], {
      toxicCombinationId: IDS.tx1, name: 'No sales and finance', description: '', enabled: true, type: 1, inputCount: 2, outputCount: 1,
    });
    const { toxicCombination } = await callOk(client, 'helloid_get_toxic_combination', { environment: 'training', toxicCombinationId: IDS.tx1 });
    assert.equal(toxicCombination.contents, 'toxicPolicy');
    assert.deepEqual(toxicCombination.entitlements.map((e: any) => e.entitlementId), [IDS.e3]);
    assert.deepEqual(toxicCombination.systems, [{ systemId: IDS.alpha, displayName: 'Alpha Directory' }]);
    assert.deepEqual(fake.state.gatewayRequests.find((r) => r.path.endsWith('/by-ids'))?.query.getAll('entitlementIds'), [
      IDS.e3, '88888888-8888-4888-8888-888888888899',
    ]);
    const missing = await callTool(client, 'helloid_get_toxic_combination', { environment: 'training', toxicCombinationId: 'nope' });
    assert.equal(missing.isError, true);
  });
});

describe('notifications', () => {
  it('lists notifications and gets one with names and masked template data', async () => {
    const list = await callOk(client, 'helloid_list_notifications', { environment: 'training' });
    assert.equal(list.total, 3);
    const query = requests('/service/notifications/api/notifications')[0]!.query;
    assert.deepEqual([query.get('enabled'), query.get('disabled'), query.get('take')], ['false', 'false', '999999']);
    const result = await callTool(client, 'helloid_get_notification', { environment: 'training', identifier: IDS.n1 });
    const { notification } = result.structuredContent as any;
    assert.deepEqual(notification.notificationTemplateData, { secretWord: '***', subject: 'Welcome' });
    assert.equal(notification.systemName, 'Alpha Directory');
    assert.equal(notification.notificationSystemName, 'PowerShell Notify');
    assert.equal(notification.notificationSystemBuiltin, false);
    assert.equal(notification.notificationTemplateName, 'Template One');
    assert.equal(notification.customEventName, 'Manager changed');
    assertNoSecrets(result);
  });

  it('lists and gets notification systems, masked', async () => {
    const list = await callOk(client, 'helloid_list_notification_systems', { environment: 'training' });
    assert.deepEqual(list.items.map((s: any) => [s.displayName, s.isBuiltin]), [['Email', true], ['PowerShell Notify', false]]);
    const result = await callTool(client, 'helloid_get_notification_system', { environment: 'training', systemId: IDS.notify });
    const { system } = result.structuredContent as any;
    assert.equal(system.contents, 'notificationSystem');
    assert.deepEqual(system.system.systemConfiguration.data, { hidden: '***', apiToken: '***', text: { required: 'hello' } });
    assertNoSecrets(result);
  });

  it('lists and gets custom events', async () => {
    const list = await callOk(client, 'helloid_list_custom_events', { environment: 'training' });
    assert.deepEqual(list.items[0], { customEventId: IDS.ce1, name: 'Manager changed', systemId: IDS.alpha, action: 3 });
    const { customEvent } = await callOk(client, 'helloid_get_custom_event', { environment: 'training', customEventId: IDS.ce1 });
    assert.equal(customEvent.contents, 'customEvent');
    assert.equal(customEvent.systemName, 'Alpha Directory');
    assert.deepEqual(customEvent.customEvent.conditions, []);
  });
});

describe('settings', () => {
  it('reads the schedules in the local time zone', async () => {
    const result = await callOk(client, 'helloid_list_schedules', { environment: 'training' });
    assert.equal(result.schedules[0].name, 'Nightly');
    assert.equal(requests('/service/scheduler/api/schedule')[0]?.query.get('timeZone'), result.timeZone);
  });

  it('reads the reconciliation configuration with system names', async () => {
    const { configuration } = await callOk(client, 'helloid_get_reconciliation_configuration', { environment: 'training' });
    assert.equal(configuration.contents, 'reconciliationConfiguration');
    assert.deepEqual(configuration.systems, [{ systemId: IDS.alpha, displayName: 'Alpha Directory' }]);
    assert.deepEqual(configuration.exclusions, { pageData: [], totalRowCount: 0 });
    const exclusions = requests('/service/reconciliation/api/exclusions')[0]!;
    assert.equal(exclusions.query.get('forBulkActions'), 'false');
    assert.deepEqual(exclusions.json, { search: '', filters: [], skip: 0, take: 999999 });
  });

  it('reads aggregation, lifecycle, calculated layers, custom fields and excluded persons', async () => {
    const aggregation = await callOk(client, 'helloid_get_aggregation_configuration', { environment: 'training' });
    assert.deepEqual(aggregation.configuration.configuration.configuration, { enabled: true, suggestions: false });
    const lifecycle = await callOk(client, 'helloid_get_person_lifecycle', { environment: 'training' });
    assert.deepEqual(lifecycle.configuration.configuration, [{ eventType: 1, daysBefore: 7 }]);
    const layers = await callOk(client, 'helloid_get_calculated_layers', { environment: 'training' });
    assert.deepEqual(layers.calculatedLayers.displayNameConfiguration, { format: 1 });
    const fields = await callOk(client, 'helloid_list_custom_fields', { environment: 'training' });
    assert.deepEqual(fields.items, [{ customFieldIdentifier: 'cf-1', name: 'costCode', displayName: 'Cost code', type: 0 }]);
    const excluded = await callOk(client, 'helloid_list_excluded_persons', { environment: 'training' });
    assert.deepEqual(excluded.items, [{ personId: IDS.chris, displayName: 'Chris Excluded (E003)', externalId: 'E003' }]);
    const query = requests('/service/provisioning-integration/api/vault/latest/persons')[0]!.query;
    assert.deepEqual([query.get('includedOnly'), query.get('excludedOnly'), query.get('search')], ['false', 'true', '']);
  });
});

describe('persons and granted entitlements', () => {
  it('lists persons with HelloID\'s search and paging', async () => {
    const result = await callOk(client, 'helloid_list_persons', { environment: 'training', search: 'a', offset: 1, limit: 2 });
    const query = requests('/service/provisioning-integration/api/vault/latest/persons-overview')[0]!.query;
    assert.deepEqual([query.get('skip'), query.get('take'), query.get('search')], ['1', '2', 'a']);
    assert.ok(query.get('cachebust'));
    assert.equal(result.total, 3);
    assert.deepEqual(result.items[0], {
      personId: IDS.bram, displayName: 'Bram Sample (E002)', externalId: 'E002', excluded: false, blocked: false,
      title: 'Seller', department: 'Sales', source: 'HR Source',
    });
  });

  it('gets one person in full, and says when it is not found', async () => {
    const { person } = await callOk(client, 'helloid_get_person', { environment: 'training', personId: IDS.dana, search: 'Dana' });
    assert.equal(person.displayName, 'Dana Nomatch (E004)');
    assert.deepEqual(person.status, { blocked: true });
    const missing = await callTool(client, 'helloid_get_person', { environment: 'training', personId: IDS.dana, search: 'Anna' });
    assert.equal(missing.isError, true);
    assert.match(resultText(missing), /among the persons found with "Anna"/);
  });

  it('lists granted entitlements of all, of one person and of one system', async () => {
    const all = await callOk(client, 'helloid_list_granted_entitlements', { environment: 'training' });
    assert.equal(all.total, 5);
    assert.equal(all.complete, true);
    assert.deepEqual(all.items[0], {
      personId: IDS.anna, personName: 'Anna Example (E001)', systemId: IDS.alpha, systemName: 'Alpha Directory',
      entitlementId: IDS.e1, type: 'Account', displayName: 'Account', permissionDefinitionDisplayName: null,
      subPermissionCount: 0, lastChangedOnUtc: '2026-01-10T00:00:00Z', hasOpenActions: false,
    });
    const person = await callOk(client, 'helloid_list_granted_entitlements', { environment: 'training', personId: IDS.anna });
    assert.equal(person.total, 2);
    assert.equal(requests('/service/rule-enforcement/api/enforcedstate/granted').at(-1)?.query.get('person'), IDS.anna);
    const system = await callOk(client, 'helloid_list_granted_entitlements', { environment: 'training', systemId: IDS.beta });
    assert.deepEqual(system.items.map((g: any) => g.personName), ['Chris Excluded (E003)']);
  });
});

describe('evaluation runs, reports and logging', () => {
  it('lists runs, gets a report in pages and the logging of a run', async () => {
    const runs = await callOk(client, 'helloid_list_evaluation_runs', { environment: 'training', limit: 1 });
    assert.deepEqual([runs.total, runs.items.length, runs.items[0].id, runs.items[0].enforce], [2, 1, IDS.run2, false]);
    assert.equal(requests('/service/rule-evaluation/api/evaluation/runs')[0]?.query.get('take'), '1');

    const report = await callOk(client, 'helloid_get_evaluation_report', { environment: 'training', runId: IDS.run2, offset: 1, limit: 1 });
    assert.equal(report.total, 3);
    assert.deepEqual(report.items, [{
      personId: IDS.bram, personName: 'Bram Sample (E002)', systemId: IDS.alpha, systemName: 'Alpha Directory',
      entitlementType: 'Permission', entitlementName: 'Group Sales', permissionDefinitionDisplayName: 'Groups',
      operation: 2, actionState: 2, origins: [0],
    }]);

    const logging = await callOk(client, 'helloid_get_evaluation_logging', { environment: 'training', runId: IDS.run2 });
    assert.deepEqual(logging.messages[0], { message: 'Completed evaluation', messageTimeUtc: '2026-01-20T10:01:00Z', level: 2 });
    assert.equal(logging.moreDataAvailable, false);
    const query = requests(`/service/rule-evaluation/api/evaluation/${IDS.run2}/logging`)[0]!.query;
    assert.deepEqual(query.getAll('origins'), [IDS.run2, IDS.log2]);
    assert.deepEqual(query.getAll('logLevels'), ['Debug', 'Info', 'Warning', 'Error']);
    assert.equal(query.get('take'), '100');
  });
});

describe('errors', () => {
  it('says to log in when there is no session', async () => {
    await callOk(client, 'helloid_logout', { environment: 'training' });
    const result = await callTool(client, 'helloid_list_target_systems', { environment: 'training' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /helloid_login/);
  });

  it('passes HelloID\'s error on as a tool error', async () => {
    fake.route('GET', '/service/rules/api/entitlements', () => ({ status: 500, body: { message: 'boom' } }));
    const result = await callTool(client, 'helloid_list_entitlements', { environment: 'training' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /HelloID answered 500/);
  });
});
