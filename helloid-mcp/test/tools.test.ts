// The shared tool machinery (environment lookup, mode checks, audit, errors, structured output),
// tested with tools made for the test, over an in-memory MCP connection.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AuditLog } from '../src/audit.ts';
import { createContext, createMcpServer } from '../src/index.ts';
import { silentLogger } from '../src/log.ts';
import type { AppContext } from '../src/tools/context.ts';
import { defineTool, type ToolGroup } from '../src/tools/helpers.ts';
import { TOOL_GROUPS } from '../src/tools/index.ts';
import { makeJwt } from './fake-helloid.ts';
import { auditLines, auditText, FakeChrome, makeConfig, removeDir, tempDir } from './helpers.ts';

const readOnlyHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const testTools: ToolGroup = [
  defineTool({
    name: 'helloid_test_read',
    title: 'Test read',
    description: 'test',
    access: 'read',
    environment: true,
    input: { secretValue: z.string().optional().describe('a secret') },
    output: { environment: z.string(), sessionId: z.string().nullable() },
    annotations: readOnlyHints,
    async handler(call) {
      return { summary: `read ${call.environment.name}`, structured: { environment: call.environment.name, sessionId: call.sessionId ?? null } };
    },
  }),
  defineTool({
    name: 'helloid_test_write',
    title: 'Test write',
    description: 'test',
    access: 'write',
    environment: true,
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async handler(call) {
      call.recordChanges([{ item: 'thing', before: { name: 'old', password: 'p1' }, after: { name: 'new', password: 'p2' } }]);
      return { summary: 'written' };
    },
  }),
  defineTool({
    name: 'helloid_test_plan',
    title: 'Test plan',
    description: 'test',
    access: 'plan',
    environment: true,
    input: {},
    annotations: readOnlyHints,
    async handler() {
      return { summary: 'planned' };
    },
  }),
  defineTool({
    name: 'helloid_test_evaluate',
    title: 'Test evaluate',
    description: 'test',
    access: 'evaluate',
    environment: true,
    input: {},
    annotations: readOnlyHints,
    async handler() {
      return { summary: 'evaluated' };
    },
  }),
  defineTool({
    name: 'helloid_test_delete',
    title: 'Test delete',
    description: 'test',
    access: 'delete',
    environment: true,
    input: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async handler() {
      return { summary: 'deleted' };
    },
  }),
  defineTool({
    name: 'helloid_test_gateway',
    title: 'Test gateway',
    description: 'test',
    access: 'read',
    environment: true,
    input: {},
    annotations: readOnlyHints,
    async handler(call) {
      await call.environment.client.gateway({ path: '/service/anything' });
      return { summary: 'unreachable' };
    },
  }),
  defineTool({
    name: 'helloid_test_crash',
    title: 'Test crash',
    description: 'test',
    access: 'none',
    environment: false,
    input: {},
    annotations: readOnlyHints,
    async handler() {
      throw new Error(`boom with ${makeJwt({ aud: 'helloid.services' })}`);
    },
  }),
];

let dir: string;
let context: AppContext;
let client: Client;

async function connect(readOnly = false) {
  const config = makeConfig(
    undefined,
    dir,
    {
      reader: { baseUrl: 'https://reader.example.test', mode: 'read', allowEvaluate: false },
      planner: { baseUrl: 'https://planner.example.test', mode: 'plan' },
      writer: { baseUrl: 'https://writer.example.test', mode: 'write' },
      deleter: { baseUrl: 'https://deleter.example.test', mode: 'write', allowDelete: true },
    },
    { safety: { readOnly } },
  );
  context = createContext(config, { driver: new FakeChrome(), logger: silentLogger, audit: new AuditLog(dir, { logger: silentLogger }) });
  const server = createMcpServer(context, [...TOOL_GROUPS, testTools]);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  await client?.close();
  removeDir(dir);
});

describe('tool machinery', () => {
  it('adds the environment argument and the annotations', async () => {
    await connect();
    const { tools } = await client.listTools();
    const read = tools.find((t) => t.name === 'helloid_test_read')!;
    assert.deepEqual(read.inputSchema.required, ['environment']);
    assert.ok((read.inputSchema.properties as Record<string, unknown>).environment);
    assert.deepEqual(read.annotations, { title: 'Test read', ...readOnlyHints });
    assert.ok(read.outputSchema);
  });

  it('refuses by mode, and says which setting refuses', async () => {
    await connect();
    const cases: Array<[string, string, RegExp | null]> = [
      ['helloid_test_read', 'reader', null],
      ['helloid_test_plan', 'reader', /environments\.reader\.mode is "read"/],
      ['helloid_test_plan', 'planner', null],
      ['helloid_test_write', 'planner', /needs mode "write".*environments\.planner\.mode is "plan"/],
      ['helloid_test_write', 'writer', null],
      ['helloid_test_evaluate', 'reader', /environments\.reader\.allowEvaluate is false/],
      ['helloid_test_evaluate', 'planner', null],
      ['helloid_test_delete', 'writer', /environments\.writer\.allowDelete is false/],
      ['helloid_test_delete', 'deleter', null],
    ];
    for (const [tool, environment, refusal] of cases) {
      const result = await call(tool, { environment });
      if (refusal) {
        assert.equal(result.isError, true, `${tool} on ${environment}`);
        assert.match(text(result), refusal);
      } else {
        assert.notEqual(result.isError, true, `${tool} on ${environment}: ${text(result)}`);
      }
    }
    const lines = auditLines(dir);
    assert.equal(lines.length, cases.length);
    assert.deepEqual(
      lines.map((l) => l.result),
      cases.map(([, , refusal]) => (refusal ? 'refused' : 'ok')),
    );
  });

  it('safety.readOnly refuses plan, write and delete everywhere', async () => {
    await connect(true);
    for (const [tool, environment] of [['helloid_test_write', 'writer'], ['helloid_test_delete', 'deleter'], ['helloid_test_plan', 'writer']]) {
      const result = await call(tool!, { environment });
      assert.equal(result.isError, true);
      assert.match(text(result), /safety\.readOnly is true/);
    }
    assert.notEqual((await call('helloid_test_read', { environment: 'writer' })).isError, true);
  });

  it('names the known environments for an unknown one', async () => {
    await connect();
    const result = await call('helloid_test_read', { environment: 'nope' });
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown environment 'nope'\. Known environments: reader, planner, writer, deleter\./);
    assert.equal(auditLines(dir)[0]!.result, 'error');
  });

  it('returns structured content with a text summary', async () => {
    await connect();
    const result = await call('helloid_test_read', { environment: 'reader' });
    assert.equal(text(result), 'read reader');
    assert.deepEqual(result.structuredContent, { environment: 'reader', sessionId: null });
  });

  it('says to log in when there is no session', async () => {
    await connect();
    const result = await call('helloid_test_gateway', { environment: 'reader' });
    assert.equal(result.isError, true);
    assert.match(text(result), /Not logged in to 'reader': call helloid_login/);
  });

  it('turns a crash into an error result without secrets', async () => {
    await connect();
    const result = await call('helloid_test_crash');
    assert.equal(result.isError, true);
    assert.match(text(result), /boom/);
    assert.doesNotMatch(auditText(dir), /eyJ/);
  });

  it('writes an audit line per call with masked arguments and changes', async () => {
    await connect();
    await call('helloid_test_read', { environment: 'reader', secretValue: 'hunter2' });
    await call('helloid_test_write', { environment: 'writer' });
    const [read, write] = auditLines(dir);
    assert.equal(read!.tool, 'helloid_test_read');
    assert.equal(read!.environment, 'reader');
    assert.deepEqual(read!.arguments, { environment: 'reader', secretValue: '***' });
    assert.equal(read!.summary, 'read reader');
    assert.equal(read!.result, 'ok');
    assert.deepEqual(write!.changes, [{ item: 'thing', before: { name: 'old', password: '***' }, after: { name: 'new', password: '***' } }]);
    assert.doesNotMatch(auditText(dir), /hunter2|p1|p2/);
  });
});
