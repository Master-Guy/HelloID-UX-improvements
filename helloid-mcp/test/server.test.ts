// The HTTP server end to end: caller auth, MCP sessions, the session and browser tools, the CLI.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatProviders, formatStatus, parseCommand, runCli } from '../src/cli.ts';
import type { Config } from '../src/config.ts';
import { BOOTSTRAP_GATEWAY, type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { auditLines, auditText, makeConfig, removeDir, type TestServer, startTestServer, tempDir, TOKEN } from './helpers.ts';

let fake: FakeHelloId;
let dir: string;
let config: Config;
let server: TestServer;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());

beforeEach(async () => {
  dir = tempDir();
  fake.state.validSession = undefined;
  config = makeConfig(fake, dir, {
    training: { baseUrl: fake.portalUrl, gatewayUrl: null, mode: 'write', allowDelete: true, login: { provider: 'LOCAL' } },
    production: { baseUrl: 'https://production.example.test', gatewayUrl: null, mode: 'read' },
  });
  server = await startTestServer(config);
});
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};

function post(headers: Record<string, string>, body: unknown = initialize) {
  return fetch(server.running.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

describe('HTTP and callers', () => {
  it('listens on 127.0.0.1 /mcp', () => {
    assert.match(server.running.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('refuses a request without a token: 401 with WWW-Authenticate', async () => {
    const response = await post({});
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  });

  it('refuses a wrong token', async () => {
    const response = await post({ Authorization: 'Bearer wrong-token-wrong-token-wrong-token-wrong' });
    assert.equal(response.status, 401);
  });

  it('refuses a foreign Origin with 403', async () => {
    const response = await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example.test' });
    assert.equal(response.status, 403);
  });

  it('accepts its own Origin', async () => {
    const response = await post({ Authorization: `Bearer ${TOKEN}`, Origin: `http://localhost:${server.running.port}` });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('mcp-session-id'));
    await response.body?.cancel();
  });

  it('answers 404 elsewhere, 400 without a session, 404 for an unknown session', async () => {
    const other = await fetch(server.running.url.replace('/mcp', '/other'), { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(other.status, 404);
    const noSession = await post({ Authorization: `Bearer ${TOKEN}` }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(noSession.status, 400);
    const unknown = await post({ Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': 'nope' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(unknown.status, 404);
    const bad = await post({ Authorization: `Bearer ${TOKEN}` }, '{not json');
    assert.equal(bad.status, 400);
  });

  it('keeps several MCP sessions at once, sharing the HelloID sessions', async () => {
    const a = await server.connect();
    const b = await server.connect();
    assert.equal(server.running.sessionCount(), 2);
    server.chrome.onGetCookies = () => server.chrome.simulateLogin(fake);
    const login = (await a.callTool({ name: 'helloid_login', arguments: { environment: 'training' } })) as CallToolResult;
    assert.notEqual(login.isError, true, text(login));
    const list = (await b.callTool({ name: 'helloid_list_environments', arguments: {} })) as CallToolResult;
    const environments = (list.structuredContent as { environments: Array<{ name: string; loggedIn: boolean }> }).environments;
    assert.equal(environments.find((e) => e.name === 'training')?.loggedIn, true);
    await a.close();
  });
});

describe('session and browser tools', () => {
  it('lists the seven session and browser tools with annotations', async () => {
    const client = await server.connect();
    const sessionTools = [
      'helloid_browser_close',
      'helloid_browser_hide',
      'helloid_browser_show',
      'helloid_list_environments',
      'helloid_list_identity_providers',
      'helloid_login',
      'helloid_logout',
    ];
    const tools = (await client.listTools()).tools.filter((t) => sessionTools.includes(t.name));
    assert.deepEqual(tools.map((t) => t.name).sort(), sessionTools);
    for (const tool of tools) {
      assert.equal(tool.annotations?.openWorldHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.ok(tool.outputSchema, tool.name);
    }
    assert.equal(tools.find((t) => t.name === 'helloid_list_environments')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'helloid_list_identity_providers')?.annotations?.readOnlyHint, true);
  });

  it('lists the identity providers without a login, and says whether the configured one is there', async () => {
    const client = await server.connect();
    const result = (await client.callTool({
      name: 'helloid_list_identity_providers',
      arguments: { environment: 'training' },
    })) as CallToolResult;
    assert.notEqual(result.isError, true, text(result));
    const structured = result.structuredContent as any;
    assert.deepEqual(
      structured.providers.map((p: any) => p.name),
      ['AD - fake.local', 'Contoso & Partners', 'Local'],
    );
    assert.equal(structured.providers[2].path, '/authentication/admlogin?returnUrl=%2F');
    assert.equal(structured.configured, 'LOCAL');
    assert.equal(structured.found, true);
    assert.equal(structured.environment, 'training');
    assert.match(text(result), /3 identity provider\(s\).*login\.provider 'LOCAL' is 'Local'/);
    assert.equal(server.chrome.calls.length, 0, 'Chrome is not used');
    assert.equal(server.running.context.sessions.peek('training')?.loggedIn ?? false, false);

    // A provider that is not there, and no provider at all
    await server.close();
    for (const [login, configured, found] of [
      [{ provider: 'Nope' }, 'Nope', false],
      [undefined, null, null],
    ] as const) {
      const other = makeConfig(fake, dir, {
        training: { baseUrl: fake.portalUrl, gatewayUrl: null, mode: 'read', ...(login ? { login } : {}) },
      });
      server = await startTestServer(other);
      const c = await server.connect();
      const r = (await c.callTool({
        name: 'helloid_list_identity_providers',
        arguments: { environment: 'training' },
      })) as CallToolResult;
      assert.notEqual(r.isError, true, text(r));
      assert.equal((r.structuredContent as any).configured, configured);
      assert.equal((r.structuredContent as any).found, found);
      await server.close();
    }
    server = await startTestServer(config);
  });

  it('reports an unreadable sign-in page as a tool error', async () => {
    const client = await server.connect();
    fake.state.signInStatus = 503;
    try {
      const result = (await client.callTool({
        name: 'helloid_list_identity_providers',
        arguments: { environment: 'training' },
      })) as CallToolResult;
      assert.equal(result.isError, true);
      assert.match(text(result), /Cannot read the identity providers of 'training'.*503/);
    } finally {
      fake.state.signInStatus = undefined;
    }
  });

  it('logs in, lists, logs out, and audits without secrets', async () => {
    const client = await server.connect();
    const before = (await client.callTool({ name: 'helloid_list_environments', arguments: {} })) as CallToolResult;
    const first = (before.structuredContent as any).environments;
    assert.deepEqual(
      first.map((e: any) => [e.name, e.mode, e.loggedIn, e.sessionState, e.allowDelete]),
      [
        ['training', 'write', false, 'logged-out', true],
        ['production', 'read', false, 'logged-out', false],
      ],
    );

    server.chrome.onGetCookies = (calls) => {
      if (calls === 2) server.chrome.simulateLogin(fake);
    };
    const login = (await client.callTool({ name: 'helloid_login', arguments: { environment: 'training' } })) as CallToolResult;
    assert.notEqual(login.isError, true, text(login));
    assert.match(text(login), /Logged in to 'training'/);
    assert.equal((login.structuredContent as any).gateway, BOOTSTRAP_GATEWAY);

    const listed = (await client.callTool({ name: 'helloid_list_environments', arguments: {} })) as CallToolResult;
    const training = (listed.structuredContent as any).environments[0];
    assert.equal(training.loggedIn, true);
    assert.ok(Date.parse(training.tokenValidUntil) > Date.now());
    assert.equal(training.gateway, BOOTSTRAP_GATEWAY);
    assert.equal((listed.structuredContent as any).chromeOpen, true);
    assert.doesNotMatch(JSON.stringify(listed), /eyJ|fake_hid_session/);

    const logout = (await client.callTool({ name: 'helloid_logout', arguments: { environment: 'training' } })) as CallToolResult;
    assert.deepEqual(logout.structuredContent, { environment: 'training', wasLoggedIn: true });
    assert.equal(server.running.context.sessions.peek('training')?.loggedIn, false);

    const lines = auditLines(dir);
    assert.deepEqual(
      lines.map((l) => [l.tool, l.environment, l.result]),
      [
        ['helloid_list_environments', null, 'ok'],
        ['helloid_login', 'training', 'ok'],
        ['helloid_list_environments', null, 'ok'],
        ['helloid_logout', 'training', 'ok'],
      ],
    );
    assert.ok(lines.every((l) => typeof l.sessionId === 'string'));
    const audit = auditText(dir);
    assert.doesNotMatch(audit, /eyJ/);
    assert.doesNotMatch(audit, /session-1/);
    assert.doesNotMatch(audit, new RegExp(TOKEN));
  });

  it('reports a login timeout as a tool error', async () => {
    await server.close();
    server = await startTestServer(config, { loginTimeoutMs: 30 });
    const client = await server.connect();
    const result = (await client.callTool({ name: 'helloid_login', arguments: { environment: 'training' } })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out/);
    assert.equal(auditLines(dir).at(-1)!.result, 'error');
  });

  it('sends progress while waiting for the login', async () => {
    const client = await server.connect();
    server.chrome.onGetCookies = (calls) => {
      if (calls === 4) server.chrome.simulateLogin(fake);
    };
    const progress: number[] = [];
    const result = (await client.callTool({ name: 'helloid_login', arguments: { environment: 'training' } }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    })) as CallToolResult;
    assert.notEqual(result.isError, true);
    assert.ok(progress.length >= 1);
  });

  it('shows, hides and closes Chrome', async () => {
    const client = await server.connect();
    const show = (await client.callTool({ name: 'helloid_browser_show', arguments: {} })) as CallToolResult;
    assert.deepEqual(show.structuredContent, { launched: true, tabsOpened: [] });
    const hide = (await client.callTool({ name: 'helloid_browser_hide', arguments: {} })) as CallToolResult;
    assert.deepEqual(hide.structuredContent, { chromeOpen: true });
    assert.equal(server.chrome.minimized, true);
    const close = (await client.callTool({ name: 'helloid_browser_close', arguments: {} })) as CallToolResult;
    assert.deepEqual(close.structuredContent, { closed: true });
    assert.equal(server.chrome.isOpen(), false);
    const again = (await client.callTool({ name: 'helloid_browser_hide', arguments: {} })) as CallToolResult;
    assert.deepEqual(again.structuredContent, { chromeOpen: false });
  });

  it('refuses an unknown environment', async () => {
    const client = await server.connect();
    const result = (await client.callTool({ name: 'helloid_login', arguments: { environment: 'nope' } })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown environment 'nope'\. Known environments: training, production\./);
  });
});

describe('CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
  }

  it('parses commands', () => {
    assert.deepEqual(parseCommand(['login', 'training']), { tool: 'helloid_login', args: { environment: 'training' } });
    assert.deepEqual(parseCommand(['browser', 'show']), { tool: 'helloid_browser_show', args: {} });
    assert.deepEqual(parseCommand(['browser', 'hide']), { tool: 'helloid_browser_hide', args: {} });
    assert.deepEqual(parseCommand(['browser', 'close']), { tool: 'helloid_browser_close', args: {} });
    assert.deepEqual(parseCommand(['status']), { tool: 'helloid_list_environments', args: {} });
    assert.deepEqual(parseCommand(['providers', 'training']), {
      tool: 'helloid_list_identity_providers',
      args: { environment: 'training' },
    });
    for (const wrong of [[], ['login'], ['browser', 'open'], ['status', 'x'], ['delete'], ['providers'], ['providers', 'a', 'b']]) {
      assert.ok('error' in parseCommand(wrong), wrong.join(' '));
    }
  });

  it('runs status, login and browser commands against the server', async () => {
    const status = io();
    assert.equal(await runCli(['status'], config, server.running.url, status.io), 0);
    const table = status.out.join('\n');
    assert.match(table, /ENVIRONMENT\s+MODE\s+ALLOWS\s+SESSION/);
    assert.match(table, /training\s+write\s+evaluate,delete\s+logged-out/);
    assert.match(table, /production\s+read\s+evaluate\s+logged-out/);

    server.chrome.onGetCookies = () => server.chrome.simulateLogin(fake);
    const login = io();
    assert.equal(await runCli(['login', 'training'], config, server.running.url, login.io), 0);
    assert.match(login.out.join('\n'), /Logged in to 'training'/);

    const show = io();
    assert.equal(await runCli(['browser', 'hide'], config, server.running.url, show.io), 0);
    assert.match(show.out.join('\n'), /minimized/);

    const unknown = io();
    assert.equal(await runCli(['login', 'nope'], config, server.running.url, unknown.io), 1);
    assert.match(unknown.err.join('\n'), /Unknown environment 'nope'/);

    const providers = io();
    assert.equal(await runCli(['providers', 'training'], config, server.running.url, providers.io), 0);
    const listing = providers.out.join('\n');
    assert.match(listing, /Identity providers of 'training':/);
    assert.match(listing, /^\* Local$/m);
    assert.match(listing, /^  AD - fake\.local$/m);

    const usage = io();
    assert.equal(await runCli(['bogus'], config, server.running.url, usage.io), 2);
    assert.match(usage.err.join('\n'), /Usage:/);
  });

  it('says when the server cannot be reached or the token is wrong', async () => {
    const wrong = io();
    const wrongConfig = { ...config, auth: { bearerToken: 'another-token-another-token-another-token' } };
    assert.equal(await runCli(['status'], wrongConfig, server.running.url, wrong.io), 1);
    assert.match(wrong.err.join('\n'), /Cannot reach the server|bearer token/);
  });

  it('formats the identity providers', () => {
    const providers = [
      { name: 'Fake IdP', path: '/a?returnUrl=%2F' },
      { name: 'Local', path: '/authentication/admlogin?returnUrl=%2F' },
    ];
    const marked = formatProviders({ environment: 't', providers, configured: 'fake idp', found: true });
    assert.match(marked, /^\* Fake IdP$/m);
    assert.match(marked, /^  Local$/m);
    assert.match(marked, /login\.provider: 'fake idp' \(\*\)/);
    const missing = formatProviders({ environment: 't', providers, configured: 'Other', found: false });
    assert.doesNotMatch(missing, /^\*/m);
    assert.match(missing, /'Other' is NOT on the sign-in page/);
    assert.match(formatProviders({ environment: 't', providers, configured: null, found: null }), /login\.provider: not set/);
  });

  it('formats the status', () => {
    const table = formatStatus({
      readOnly: true,
      chromeOpen: false,
      environments: [
        { name: 't', mode: 'read', allowEvaluate: false, allowDelete: false, allowRevokingRuleDelete: false, sessionState: 'expired', tokenValidUntil: null },
      ],
    });
    assert.match(table, /t\s+read\s+-\s+expired/);
    assert.match(table, /Chrome: closed\s+safety\.readOnly: on/);
  });
});
