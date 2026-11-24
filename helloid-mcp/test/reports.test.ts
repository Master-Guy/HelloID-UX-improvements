// The report tools against the fake HelloID with synthetic fixtures.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { EMPTY_ID } from '../src/helloid/exports.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { callOk, logIn, makeConfig, removeDir, type TestServer, startTestServer, tempDir } from './helpers.ts';

let fake: FakeHelloId;
let data: Fixture;
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
  dir = tempDir();
  fake.state.gatewayRequests = [];
  server = await startTestServer(makeConfig(fake, dir, { training: { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl, mode: 'read' } }));
  client = await server.connect();
  await logIn(server, client, fake);
});
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

describe('rule reports', () => {
  it('finds the rules without entitlements and without persons', async () => {
    const noEntitlements = await callOk(client, 'helloid_report_rules_without_entitlements', { environment: 'training' });
    assert.deepEqual(noEntitlements.items.map((r: any) => r.name), ['Empty rule']);
    const noPersons = await callOk(client, 'helloid_report_rules_without_persons', { environment: 'training' });
    assert.deepEqual(noPersons.items.map((r: any) => r.name), ['Sales get Alpha', 'Empty rule']);
    const paged = await callOk(client, 'helloid_report_rules_without_persons', { environment: 'training', offset: 1, limit: 5 });
    assert.deepEqual([paged.total, paged.items.map((r: any) => r.name)], [2, ['Empty rule']]);
  });

  it('lists the rules of an entitlement, published and draft', async () => {
    const result = await callOk(client, 'helloid_report_rules_for_entitlement', { environment: 'training', entitlementId: IDS.e1 });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items[1], {
      ruleId: IDS.r2,
      name: 'Sales get Alpha',
      published: true,
      hasDraft: true,
      entitlementConfiguredInPublished: false,
      entitlementConfiguredInDraft: true,
    });
    const query = fake.state.gatewayRequests.find((r) => r.path === `/service/rules/api/rules/entitlement/${IDS.e1}`)!.query;
    assert.deepEqual([query.get('published'), query.get('draft'), query.get('skip'), query.get('take')], ['true', 'true', '0', '100']);
  });
});

describe('helloid_report_system_access', () => {
  it('lists every account-granting rule per person, and the persons that match none apart', async () => {
    const result = await callOk(client, 'helloid_report_system_access', { environment: 'training', systemId: IDS.alpha });
    assert.deepEqual(result.system, { systemId: IDS.alpha, displayName: 'Alpha Directory' });
    assert.deepEqual(result.rules, {
      account: [
        { ruleId: IDS.r1, ruleName: 'Employees get Alpha', personCount: 1 },
        { ruleId: IDS.r2, ruleName: 'Sales get Alpha', personCount: 2 },
      ],
      accountAccess: [{ ruleId: IDS.r2, ruleName: 'Sales get Alpha' }],
      permissions: [{ ruleId: IDS.r1, ruleName: 'Employees get Alpha' }],
    });
    assert.equal(result.matchedTotal, 2);
    assert.deepEqual(result.matched, [
      {
        personId: IDS.anna,
        personName: 'Anna Example (E001)',
        accounts: ['Account'],
        rules: [
          { ruleId: IDS.r1, ruleName: 'Employees get Alpha' },
          { ruleId: IDS.r2, ruleName: 'Sales get Alpha' },
        ],
      },
      { personId: IDS.bram, personName: 'Bram Sample (E002)', accounts: ['Account'], rules: [{ ruleId: IDS.r2, ruleName: 'Sales get Alpha' }] },
    ]);
    assert.equal(result.unmatchedTotal, 1);
    assert.deepEqual(result.unmatched, [{ personId: IDS.dana, personName: 'Dana Nomatch (E004)', accounts: ['Account'], rules: [] }]);
    // Only the account-granting rules' persons are read, all of them
    const personRequests = fake.state.gatewayRequests.filter((r) => r.path.includes('/evaluation/results/rule/'));
    assert.deepEqual(personRequests.map((r) => r.path.split('/')[7]).sort(), [IDS.r1, IDS.r2]);
    assert.equal(personRequests[0]!.query.get('take'), '999999');
  });

  it('pages the persons', async () => {
    const result = await callOk(client, 'helloid_report_system_access', { environment: 'training', systemId: IDS.alpha, offset: 1, limit: 1 });
    assert.deepEqual([result.matchedTotal, result.matched.map((p: any) => p.personName), result.unmatched.length], [2, ['Bram Sample (E002)'], 0]);
  });

  it('accepts rows with a displayName in the persons of a rule', async () => {
    data.ruleResultPersons[IDS.r1] = [{ displayName: 'Dana Nomatch (E004)' }];
    const result = await callOk(client, 'helloid_report_system_access', { environment: 'training', systemId: IDS.alpha });
    assert.equal(result.unmatchedTotal, 0);
  });
});

describe('helloid_check_references', () => {
  it('finds references to things that do not exist, not the empty source system', async () => {
    const result = await callOk(client, 'helloid_check_references', { environment: 'training' });
    const lines = result.items.map((f: any) => `${f.kind} | ${f.name} | ${f.problem}`);
    const expect = (pattern: RegExp) => assert.ok(lines.some((l: string) => pattern.test(l)), `${pattern} not in:\n${lines.join('\n')}`);
    expect(/^target system \| Gamma Files \| depends on system .*99999999/);
    expect(/^business rule \| Sales get Alpha \| published entitlement permission "Removed group" \(Groups\) of "Alpha Directory": not an entitlement here/);
    expect(/^business rule \| Sales get Alpha \| draft condition: "Old sales" is of source system "Old HR"/);
    expect(/^notification \| Beta update \| it uses the data of target system "OldSystem"/);
    expect(/^notification \| Orphan custom \| its notification system .* is not in this HelloID environment/);
    expect(/^notification \| Orphan custom \| its custom event .* is not in this HelloID environment/);
    expect(/^custom event \| Old event \| its system 99999999/);
    expect(/^toxic policy \| No sales and finance \| entitlement 88888888-8888-4888-8888-888888888899: not an entitlement here/);
    expect(/^schedule \| Nightly \| the task for system 99999999/);
    assert.equal(result.total, 9, lines.join('\n'));
    assert.ok(!lines.some((l: string) => l.includes(EMPTY_ID)), 'the empty source system is intended');
    assert.ok(!lines.some((l: string) => l.includes('Employees get Alpha')), 'the first rule is fine');
    assert.deepEqual(result.checked, {
      targetSystem: 3, businessRule: 3, notification: 3, customEvent: 2, toxicPolicy: 1, schedule: 1, reconciliation: 1,
    });
    assert.deepEqual(result.couldNotCheck, []);
    // Each list is read once
    assert.equal(fake.state.gatewayRequests.filter((r) => r.path === '/service/rules/api/entitlements').length, 1);
  });

  it('reports a template that is not in the notification system, and what could not be checked', async () => {
    data.notificationDetails[IDS.n1].notificationTemplateId = 'tpl-gone';
    fake.route('GET', '/service/scheduler/api/schedule', () => ({ status: 500, body: 'down' }));
    const result = await callOk(client, 'helloid_check_references', { environment: 'training' });
    assert.ok(result.items.some((f: any) => f.name === 'Alpha account created' && /template tpl-gone is not in notification system "PowerShell Notify"/.test(f.problem)));
    assert.equal(result.couldNotCheck.length, 1);
    assert.match(result.couldNotCheck[0], /^Schedules: HelloID answered 500/);
  });
});
