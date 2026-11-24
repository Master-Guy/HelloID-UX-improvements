// helloid_export_everything: the structure of the userscript's backup file, the resource link and
// reading it, masking, and items that cannot be read.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { exportKind } from '../src/helloid/exports.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { auditText, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

let fake: FakeHelloId;
let dir: string;
let server: TestServer;
let client: Client;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

beforeEach(async () => {
  installFixtures(fake, loadFixture());
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

async function exportAll() {
  const result = await callTool(client, 'helloid_export_everything', { environment: 'training' });
  assert.notEqual(result.isError, true, resultText(result));
  const link = result.content.find((c) => c.type === 'resource_link');
  assert.ok(link && link.type === 'resource_link');
  const read = await client.readResource({ uri: link.uri });
  const content = read.contents[0]!;
  assert.ok('text' in content);
  return { result, link, structured: result.structuredContent as any, text: content.text, backup: JSON.parse(content.text) };
}

describe('helloid_export_everything', () => {
  it('makes the userscript\'s backup file, as a resource link with a short summary', async () => {
    const { result, link, structured, text, backup } = await exportAll();
    assert.match(link.uri, /^helloid-export:\/\/[0-9a-f-]{36}$/);
    assert.equal(link.mimeType, 'application/json');
    assert.equal(link.size, Buffer.byteLength(text, 'utf8'));
    assert.match(String(link.name), /^HelloID backup - 127\.0\.0\.1 - \d{4}-\d{2}-\d{2}\.json$/);

    assert.deepEqual(Object.keys(backup), ['exportedAt', 'exportedFrom', 'exportedBy', 'contents', 'secretsIncluded', 'complete', 'files']);
    assert.equal(backup.contents, 'backups');
    assert.equal(backup.secretsIncluded, false);
    assert.equal(backup.complete, true);
    assert.equal(backup.exportedFrom, fake.portalUrl);
    // In the order of the import, one notification per file
    assert.deepEqual(backup.files.map(exportKind), [
      'targetSystem', 'targetSystem', 'targetSystem',
      'sourceSystem',
      'notificationSystem', 'notificationSystem',
      'notifications', 'notifications', 'notifications',
      'businessRule', 'businessRule', 'businessRule',
      'toxicPolicy',
      'customEvent', 'customEvent',
      'schedule',
      'sourceConfiguration', 'aggregationConfiguration', 'personLifecycle', 'excludedPersons', 'reconciliationConfiguration',
    ]);
    for (const file of backup.files) {
      assert.equal(file.exportedFrom, fake.portalUrl);
      assert.match(file.exportedBy, /^helloid-mcp /);
    }
    const rule = backup.files.find((f: any) => f.contents === 'businessRule' && f.ruleId === IDS.r1);
    assert.deepEqual(rule.systems, [
      { systemId: IDS.alpha, displayName: 'Alpha Directory' },
      { systemId: IDS.beta, displayName: 'Beta Cloud' },
    ]);
    const schedule = backup.files.find((f: any) => f.contents === 'schedule');
    assert.deepEqual(schedule.systems, [
      { systemId: IDS.hr, displayName: 'HR Source' },
      { systemId: IDS.missing, displayName: null },
    ]);
    assert.equal(backup.files.find((f: any) => f.contents === 'notifications').notifications.length, 1);

    assert.deepEqual(structured.counts, {
      targetSystem: 3, sourceSystem: 1, notificationSystem: 2, notifications: 3, businessRule: 3, toxicPolicy: 1, customEvent: 2,
      schedule: 1, sourceConfiguration: 1, aggregationConfiguration: 1, personLifecycle: 1, excludedPersons: 1,
      reconciliationConfiguration: 1,
    });
    assert.equal(structured.files, 21);
    assert.equal(structured.uri, link.uri);
    assert.equal(structured.complete, true);
    assert.ok(resultText(result).length < 500, 'the answer is short');
    for (const secret of ['alpha-client-secret-value', 'beta-exchange-password', 'hr-api-key-value', 'notify-token-value', 'template-hidden-value']) {
      assert.ok(!text.includes(secret), `${secret} leaked into the backup`);
      assert.ok(!auditText(dir).includes(secret));
    }
  });

  it('reads each list once (the userscript reads them per item)', async () => {
    await exportAll();
    const count = (path: string) => fake.state.gatewayRequests.filter((r) => r.path === path && r.method === 'GET').length;
    assert.equal(count('/service/provisioning-api/api/target-systems'), 1);
    assert.equal(count('/service/notifications/api/notifications'), 1);
    assert.equal(count(`/connector/powershell-target/api/configuration/${IDS.alpha}`), 1);
  });

  it('can only be read by the MCP session that made it', async () => {
    const { link } = await exportAll();
    const other = await server.connect();
    await assert.rejects(other.readResource({ uri: link.uri }), /no export/);
    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map((r) => r.uri), [link.uri]);
    assert.deepEqual((await other.listResources()).resources, []);
  });

  it('goes on when a list or an item cannot be read, and says which', async () => {
    fake.route('GET', '/service/rules/api/toxic-combinations', () => ({ status: 500, body: 'down' }));
    fake.route('GET', `/service/provisioning-api/api/source-systems/${IDS.hr}`, () => ({ status: 404, body: 'gone' }));
    const { backup, structured } = await exportAll();
    assert.equal(backup.complete, false);
    assert.equal(backup.couldNotRead.length, 2);
    assert.match(backup.couldNotRead[0], /^Source systems: "HR Source" \(HelloID answered 404/);
    assert.match(backup.couldNotRead[1], /^Toxic policies: the list could not be read \(HelloID answered 500/);
    assert.deepEqual(structured.couldNotRead, backup.couldNotRead);
    assert.equal(structured.counts.sourceSystem, undefined);
    assert.equal(structured.counts.toxicPolicy, undefined);
    assert.equal(structured.counts.businessRule, 3);
  });
});
