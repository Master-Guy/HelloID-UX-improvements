// Evaluation: the server-sent event parsing, the rule persons preview, a full evaluation (never
// enforced), and the refusals when allowEvaluate is false.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { parseEventStream } from '../src/helloid/client.ts';
import { parseRulePersons } from '../src/tools/evaluation.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import { auditLines, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

describe('parseEventStream', () => {
  it('splits events on blank lines, with their name and data', () => {
    const text = 'event: Data\ndata: {"a":1}\n\nevent: Data\ndata: {"b":2}\n\n\n';
    assert.deepEqual(parseEventStream(text), [
      { event: 'Data', data: '{"a":1}' },
      { event: 'Data', data: '{"b":2}' },
    ]);
  });

  it('handles CRLF, comments, several data lines and events without a name', () => {
    const text = ': a comment\r\nevent:Data\r\ndata: line 1\r\ndata:line 2\r\n\r\ndata: plain\r\n\r\nevent: Empty\r\n\r\n';
    assert.deepEqual(parseEventStream(text), [
      { event: 'Data', data: 'line 1\nline 2' },
      { event: 'message', data: 'plain' },
    ]);
  });
});

describe('parseRulePersons', () => {
  it('takes the page from pagedResult and the total from the second event', () => {
    const text =
      'event: Data\ndata: {"pagedResult":{"exceededTotalRowCountLimit":true,"pageData":["A (1)","B (2)"],"totalRowCount":2},"type":0}\n\n' +
      'event: Data\ndata: {"totalRowCount":7,"type":1}\n\n';
    assert.deepEqual(parseRulePersons(text), { persons: ['A (1)', 'B (2)'], totalRowCount: 7, exceededTotalRowCountLimit: true });
  });

  it('falls back to the page\'s count, accepts rows with a displayName, and skips data that is not JSON', () => {
    const text = 'event: Data\ndata: not json\n\nevent: Data\ndata: {"pagedResult":{"pageData":[{"displayName":"C (3)"}],"totalRowCount":1},"type":0}\n\n';
    assert.deepEqual(parseRulePersons(text), { persons: ['C (3)'], totalRowCount: 1, exceededTotalRowCountLimit: null });
  });

  it('says so when there is no page of persons', () => {
    assert.throws(() => parseRulePersons('event: Data\ndata: {"totalRowCount":3,"type":1}\n\n'), /no page of persons/);
  });
});

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
  const environment = { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl };
  server = await startTestServer(
    makeConfig(fake, dir, {
      training: { ...environment, mode: 'read', allowEvaluate: true },
      locked: { ...environment, mode: 'write', allowEvaluate: false },
    }),
    { evaluationPollMs: 5 },
  );
  client = await server.connect();
  await logIn(server, client, fake);
  await logIn(server, client, fake, 'locked');
});
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const requests = (path: string) => fake.state.gatewayRequests.filter((r) => r.path === path);
const PREVIEW = '/service/rule-evaluation/api/evaluation/evaluate/rule/persons';
const START = '/service/rule-evaluation/api/evaluation/start';

describe('helloid_evaluate_rule_persons', () => {
  it('previews a stored rule: the rule as HelloID gives it is the body; the stream is parsed (mode read is enough)', async () => {
    const result = await callOk(client, 'helloid_evaluate_rule_persons', { environment: 'training', ruleId: IDS.r1, limit: 2 });
    assert.deepEqual(result, {
      total: 3,
      offset: 0,
      limit: 2,
      items: ['Anna Example (E001)', 'Bram Sample (E002)'],
      nextOffset: 2,
      exceededTotalRowCountLimit: false,
    });
    const request = requests(PREVIEW)[0]!;
    assert.deepEqual(request.json, data.rules[IDS.r1]);
    assert.deepEqual([request.query.get('skip'), request.query.get('take'), request.query.get('calculateTotalRowCount')], ['0', '2', 'true']);
    assert.equal(request.headers.accept, 'text/event-stream');
    assert.equal(request.headers['content-type'], 'application/json');
  });

  it('previews an unsaved rule definition', async () => {
    const rule = { ...data.rules[IDS.r1], name: 'Changed, not saved', condition: { hasActiveContract: false } };
    const result = await callOk(client, 'helloid_evaluate_rule_persons', { environment: 'training', rule, offset: 2 });
    assert.deepEqual(result.items, ['Dana Nomatch (E004)']);
    assert.equal(result.nextOffset, null, 'the last page has no next offset');
    assert.deepEqual(requests(PREVIEW)[0]!.json, rule);
    assert.equal(requests(`/service/rules/api/rules/${IDS.r1}`).length, 0, 'the stored rule is not read');
  });

  it('needs ruleId or rule, not both', async () => {
    for (const args of [{}, { ruleId: IDS.r1, rule: { name: 'x' } }]) {
      const result = await callTool(client, 'helloid_evaluate_rule_persons', { environment: 'training', ...args });
      assert.equal(result.isError, true);
      assert.match(resultText(result), /either ruleId .* or rule/);
    }
    assert.equal(requests(PREVIEW).length, 0);
  });
});

describe('helloid_start_evaluation', () => {
  it('starts with enforce=false and no body, and answers the run ID at once', async () => {
    fake.route('POST', START, () => ({ body: JSON.stringify('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3'), headers: { 'Content-Type': 'application/json' } }));
    const result = await callOk(client, 'helloid_start_evaluation', { environment: 'training' });
    assert.deepEqual(result, { runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', finished: false, run: null, report: null });
    const request = requests(START)[0]!;
    assert.equal(request.query.get('enforce'), 'false');
    assert.equal(request.body, '');
  });

  it('waits for the run (polling the runs) and summarises its report', async () => {
    const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
    fake.route('POST', START, () => {
      data.evaluationRuns.unshift({ id: runId, startDateUtc: '2026-02-01T00:00:00Z', endDateUtc: null, state: 1, enforce: false, stageFailed: false });
      data.evaluationReport.push(
        { ...data.evaluationReport[0], runId },
        { ...data.evaluationReport[1], runId },
        { ...data.evaluationReport[2], runId },
      );
      return { body: JSON.stringify(runId) };
    });
    let polls = 0;
    fake.route('GET', '/service/rule-evaluation/api/evaluation/runs', () => {
      polls++;
      if (polls === 3) data.evaluationRuns[0].endDateUtc = '2026-02-01T00:02:00Z';
      return { body: { pageData: data.evaluationRuns, totalRowCount: data.evaluationRuns.length } };
    });
    const result = await callOk(client, 'helloid_start_evaluation', { environment: 'training', wait: true });
    assert.equal(polls, 3);
    assert.equal(result.finished, true);
    assert.equal(result.run.endDateUtc, '2026-02-01T00:02:00Z');
    assert.deepEqual(result.report, {
      actions: 3,
      bySystem: { 'Alpha Directory': 2, 'Beta Cloud': 1 },
      byEntitlementType: { Account: 2, Permission: 1 },
      byOperation: { 1: 2, 2: 1 },
    });
    assert.equal(requests('/service/rule-evaluation/api/evaluation/runs')[0]?.query.get('take'), '30');
    assert.ok(fake.state.gatewayRequests.every((r) => r.query.get('enforce') !== 'true'), 'never enforce=true');
  });
});

describe('allowEvaluate false', () => {
  it('refuses both evaluation tools, whatever the mode, without asking HelloID', async () => {
    for (const [name, args] of [
      ['helloid_evaluate_rule_persons', { ruleId: IDS.r1 }],
      ['helloid_start_evaluation', { wait: true }],
    ] as const) {
      const result = await callTool(client, name, { environment: 'locked', ...args });
      assert.equal(result.isError, true, name);
      assert.match(resultText(result), /environments\.locked\.allowEvaluate is false/);
    }
    assert.equal(requests(PREVIEW).length + requests(START).length, 0);
    const lines = auditLines(dir).filter((l) => l.environment === 'locked' && l.tool !== 'helloid_login');
    assert.deepEqual(lines.map((l) => [l.tool, l.result]), [
      ['helloid_evaluate_rule_persons', 'refused'],
      ['helloid_start_evaluation', 'refused'],
    ]);
  });

  it('still allows the read tools of the runs', async () => {
    const runs = await callOk(client, 'helloid_list_evaluation_runs', { environment: 'locked' });
    assert.equal(runs.total, 2);
  });
});
