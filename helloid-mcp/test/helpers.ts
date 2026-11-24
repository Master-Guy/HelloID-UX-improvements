// Test helpers: a fake Chrome, configs pointing at the fake HelloID, a temporary audit folder, and a
// running server with an MCP client.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Config, parseConfig } from '../src/config.ts';
import type { ChromeDriver } from '../src/helloid/browser.ts';
import type { Cookie } from '../src/helloid/session.ts';
import { type RunningServer, type ServerOptions, startServer } from '../src/index.ts';
import { silentLogger } from '../src/log.ts';
import { type FakeHelloId, SESSION_COOKIE } from './fake-helloid.ts';

export const TOKEN = 'test-bearer-token-0123456789-abcdefghijklmnop';

/** A Chrome that only remembers what was asked of it. */
export class FakeChrome implements ChromeDriver {
  open = false;
  minimized = false;
  cookies: Cookie[] = [];
  tabs = new Map<string, string>();
  calls: string[] = [];
  launches = 0;
  private listeners: Array<() => void> = [];
  /** Called on every getCookies() (a test can log the user in after a few polls). */
  onGetCookies: ((calls: number) => void) | undefined;
  private getCookiesCalls = 0;

  isOpen(): boolean {
    return this.open;
  }
  async launch(): Promise<void> {
    this.calls.push('launch');
    this.launches++;
    this.open = true;
    this.minimized = false;
  }
  private requireOpen(): void {
    if (!this.open) throw new Error('Chrome is not open.');
  }
  async openTab(key: string, url: string): Promise<void> {
    this.requireOpen();
    this.calls.push(`openTab ${key} ${url}`);
    this.tabs.set(key, url);
    this.minimized = false;
  }
  async getCookies(): Promise<Cookie[]> {
    this.requireOpen();
    this.getCookiesCalls++;
    this.onGetCookies?.(this.getCookiesCalls);
    return this.cookies.map((c) => ({ ...c }));
  }
  async setCookies(cookies: Cookie[]): Promise<void> {
    this.requireOpen();
    this.calls.push(`setCookies ${cookies.map((c) => c.name).join(',')}`);
    for (const cookie of cookies) {
      this.cookies = this.cookies.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain));
      this.cookies.push({ ...cookie });
    }
  }
  async showWindow(): Promise<void> {
    this.requireOpen();
    this.calls.push('showWindow');
    this.minimized = false;
  }
  async minimizeWindow(): Promise<void> {
    this.requireOpen();
    this.calls.push('minimizeWindow');
    this.minimized = true;
  }
  async close(): Promise<void> {
    this.calls.push('close');
    this.simulateUserClose();
  }
  onDisconnected(listener: () => void): void {
    this.listeners.push(listener);
  }
  /** The user closes Chrome: cookies of the profile stay on disk, like a real profile. */
  simulateUserClose(): void {
    if (!this.open) return;
    this.open = false;
    this.tabs.clear();
    for (const listener of this.listeners) listener();
  }
  /** The user logs in to the fake portal: the browser now has its session cookie. */
  simulateLogin(fake: FakeHelloId, sessionValue = 'session-1'): void {
    fake.state.validSession = sessionValue;
    this.cookies.push({ name: SESSION_COOKIE, value: sessionValue, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true });
  }
}

export function tempDir(prefix = 'helloid-mcp-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A valid config with environments pointing at the fake HelloID. */
export function makeConfig(
  fake: FakeHelloId | undefined,
  auditDir: string,
  environments?: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Config {
  const portal = fake?.portalUrl ?? 'https://training.example.test';
  return parseConfig({
    server: { host: '127.0.0.1', port: 3917 },
    auth: { bearerToken: TOKEN },
    chrome: { executablePath: 'C:\\chrome.exe', profileDir: join(auditDir, 'profile'), closeAfterLogin: false },
    audit: { dir: auditDir },
    environments: environments ?? {
      training: { baseUrl: portal, gatewayUrl: fake?.gatewayUrl ?? null, mode: 'write' },
    },
    ...extra,
  });
}

/** The audit lines written so far (all days). */
export function auditLines(dir: string): Array<Record<string, any>> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>),
  );
}

/** The audit files' raw text. */
export function auditText(dir: string): string {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
  } catch {
    return '';
  }
}

/** The text content of a tool result. */
export function resultText(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/** Calls a tool. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** Calls a tool that must succeed; its structured content. */
export async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callTool(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${resultText(result)}`);
  return result.structuredContent;
}

/** Logs the test server in to an environment of the fake HelloID (the user logs in in the fake Chrome). */
export async function logIn(server: TestServer, client: Client, fake: FakeHelloId, environment = 'training'): Promise<void> {
  server.chrome.onGetCookies = () => server.chrome.simulateLogin(fake);
  const result = await callTool(client, 'helloid_login', { environment });
  if (result.isError) throw new Error(`Login failed: ${resultText(result)}`);
}

export interface TestServer {
  running: RunningServer;
  chrome: FakeChrome;
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

export async function startTestServer(config: Config, options: ServerOptions = {}): Promise<TestServer> {
  const chrome = (options.driver as FakeChrome | undefined) ?? new FakeChrome();
  const running = await startServer(config, {
    driver: chrome,
    logger: silentLogger,
    port: 0,
    loginPollMs: 5,
    loginTimeoutMs: 2000,
    ...options,
  });
  const clients: Client[] = [];
  return {
    running,
    chrome,
    async connect(token = TOKEN) {
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(running.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients) await client.close().catch(() => {});
      await running.close();
    },
  };
}
