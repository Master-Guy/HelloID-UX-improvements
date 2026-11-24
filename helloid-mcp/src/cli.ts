// The command line: an MCP client of the running server (bearer token from config.json), so one
// process holds the HelloID sessions.
//
//   npm run cli -- login <environment>
//   npm run cli -- providers <environment>
//   npm run cli -- browser show|hide|close
//   npm run cli -- status

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { LOGIN_TIMEOUT_MS } from './helloid/browser.ts';

const USAGE = `Usage:
  npm run cli -- login <environment>    log in to an environment (in the server's Chrome window)
  npm run cli -- providers <environment>
                                        the identity providers on its sign-in page (* = login.provider)
  npm run cli -- browser show           show the Chrome window (starts Chrome when it is closed)
  npm run cli -- browser hide           minimize the Chrome window
  npm run cli -- browser close          close Chrome (the server keeps its sessions)
  npm run cli -- status                 the environments, their mode and whether logged in`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

/** The tool call for a command line, or an error text. */
export function parseCommand(argv: string[]): { tool: string; args: Record<string, unknown> } | { error: string } {
  const [command, sub, ...rest] = argv;
  if (command === 'login' && sub && rest.length === 0) return { tool: 'helloid_login', args: { environment: sub } };
  if (command === 'providers' && sub && rest.length === 0) {
    return { tool: 'helloid_list_identity_providers', args: { environment: sub } };
  }
  if (command === 'browser' && rest.length === 0 && (sub === 'show' || sub === 'hide' || sub === 'close')) {
    return { tool: `helloid_browser_${sub}`, args: {} };
  }
  if (command === 'status' && sub === undefined) return { tool: 'helloid_list_environments', args: {} };
  return { error: USAGE };
}

interface EnvironmentRow {
  name: string;
  mode: string;
  allowEvaluate: boolean;
  allowDelete: boolean;
  allowRevokingRuleDelete: boolean;
  allowRevokingRulePublish?: boolean;
  allowRetryActions?: boolean;
  allowApproveBlocked?: boolean;
  allowEnforce?: boolean;
  allowDryRun?: boolean;
  sessionState: string;
  tokenValidUntil: string | null;
}

/** The status as a table. */
export function formatStatus(structured: { readOnly?: boolean; chromeOpen?: boolean; environments?: EnvironmentRow[] }): string {
  const rows = (structured.environments ?? []).map((e) => [
    e.name,
    e.mode,
    [
      e.allowEvaluate ? 'evaluate' : '',
      e.allowDelete ? 'delete' : '',
      e.allowRevokingRuleDelete ? 'revoke' : '',
      e.allowRevokingRulePublish ? 'revoke-publish' : '',
      e.allowRetryActions ? 'retry' : '',
      e.allowApproveBlocked ? 'approve' : '',
      e.allowEnforce ? 'enforce' : '',
      e.allowDryRun ? 'dryrun' : '',
    ]
      .filter(Boolean)
      .join(',') || '-',
    e.sessionState,
    e.tokenValidUntil ? new Date(e.tokenValidUntil).toLocaleString() : '',
  ]);
  const header = ['ENVIRONMENT', 'MODE', 'ALLOWS', 'SESSION', 'TOKEN VALID UNTIL'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const lines = [line(header), ...rows.map(line)];
  lines.push('', `Chrome: ${structured.chromeOpen ? 'open' : 'closed'}${structured.readOnly ? '   safety.readOnly: on' : ''}`);
  return lines.join('\n');
}

/** The identity providers, one per line; the configured one marked with *. */
export function formatProviders(structured: {
  environment?: string;
  providers?: Array<{ name: string; path: string }>;
  configured?: string | null;
  found?: boolean | null;
}): string {
  const providers = structured.providers ?? [];
  const configured = structured.configured ?? null;
  const wanted = configured?.trim().toLowerCase();
  const lines = [`Identity providers of '${structured.environment ?? ''}':`];
  for (const provider of providers) {
    const mark = wanted !== undefined && provider.name.trim().toLowerCase() === wanted;
    lines.push(`${mark ? '*' : ' '} ${provider.name}`);
  }
  lines.push(
    '',
    configured === null
      ? 'login.provider: not set (the login shows the sign-in page)'
      : structured.found
        ? `login.provider: '${configured}' (*)`
        : `login.provider: '${configured}' is NOT on the sign-in page; the login fails until it is changed`,
  );
  return lines.join('\n');
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

/** Runs one command against the server at `url`. Returns the exit code. */
export async function runCli(argv: string[], config: Config, url: string, io: CliIo = defaultIo): Promise<number> {
  const parsed = parseCommand(argv);
  if ('error' in parsed) {
    io.err(parsed.error);
    return 2;
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${config.auth.bearerToken}` } },
  });
  const client = new Client({ name: 'helloid-mcp-cli', version: '0.1.0' });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      io.err(
        `Cannot reach the server at ${url}: ${error instanceof Error ? error.message : String(error)}\n` +
          'Is it running (npm start), and is the bearer token in config.json the same?',
      );
      return 1;
    }
    if (parsed.tool === 'helloid_login') io.out(`Log in to '${String(parsed.args.environment)}' in the Chrome window...`);
    const result = (await client.callTool({ name: parsed.tool, arguments: parsed.args }, undefined, {
      // The login waits for the user (up to 10 minutes)
      timeout: LOGIN_TIMEOUT_MS + 60_000,
    })) as CallToolResult;
    if (result.isError) {
      io.err(textOf(result));
      return 1;
    }
    if (parsed.tool === 'helloid_list_environments' && result.structuredContent) {
      io.out(formatStatus(result.structuredContent as Parameters<typeof formatStatus>[0]));
    } else if (parsed.tool === 'helloid_list_identity_providers' && result.structuredContent) {
      io.out(formatProviders(result.structuredContent as Parameters<typeof formatProviders>[0]));
    } else {
      io.out(textOf(result));
    }
    return 0;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const host = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
  process.exitCode = await runCli(process.argv.slice(2), config, `http://${host}:${config.server.port}/mcp`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
