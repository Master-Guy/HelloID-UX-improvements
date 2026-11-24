// Start: config, HTTP server, MCP server. Streamable HTTP on http://127.0.0.1:<port>/mcp, one MCP
// session per Claude session (Mcp-Session-Id), all sharing the same HelloID sessions.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { AuditLog, type AuditWriter } from './audit.ts';
import { authenticateCaller } from './auth/caller.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { BrowserService, type ChromeDriver, PuppeteerChrome } from './helloid/browser.ts';
import type { FetchLike } from './helloid/client.ts';
import { ExportStore } from './helloid/exports.ts';
import { SessionStore } from './helloid/session.ts';
import { errorMessage, type Logger, stderrLogger } from './log.ts';
import { EnvironmentLocks, PlanStore } from './safety.ts';
import { type AppContext, makeClientFactory } from './tools/context.ts';
import { registerExportResource } from './tools/export.ts';
import { registerAllTools, TOOL_GROUPS } from './tools/index.ts';
import type { ToolGroup } from './tools/helpers.ts';

export const SERVER_NAME = 'helloid-mcp';
export const SERVER_VERSION = '0.1.0';
/** The largest request body accepted (import files of later phases can be large). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ServerOptions {
  /** Chrome; tests pass a fake. Default: the installed Chrome via puppeteer-core. */
  driver?: ChromeDriver;
  audit?: AuditWriter;
  logger?: Logger;
  fetch?: FetchLike;
  now?: () => number;
  /** Overrides config.server.port (0: any free port; tests). */
  port?: number;
  loginPollMs?: number;
  loginTimeoutMs?: number;
  /** Time between polls while waiting for an evaluation run (default 5 seconds). */
  evaluationPollMs?: number;
  toolGroups?: ReadonlyArray<ToolGroup>;
}

export interface RunningServer {
  /** http://<host>:<port>/mcp */
  url: string;
  port: number;
  context: AppContext;
  /** Number of open MCP sessions. */
  sessionCount(): number;
  close(): Promise<void>;
}

/** Builds the shared context: sessions, browser, plans, locks, audit. */
export function createContext(config: Config, options: ServerOptions = {}): AppContext {
  const logger = options.logger ?? stderrLogger;
  const now = options.now ?? Date.now;
  const sessions = new SessionStore(now);
  const clientFor = makeClientFactory(config, sessions, { fetch: options.fetch, now });
  const driver =
    options.driver ??
    new PuppeteerChrome({ executablePath: config.chrome.executablePath, profileDir: config.chrome.profileDir });
  const browser = new BrowserService({
    config,
    sessions,
    driver,
    clientFor,
    logger,
    fetch: options.fetch,
    now,
    pollMs: options.loginPollMs,
    timeoutMs: options.loginTimeoutMs,
  });
  return {
    config,
    sessions,
    browser,
    plans: new PlanStore({ now }),
    locks: new EnvironmentLocks(),
    audit: options.audit ?? new AuditLog(config.audit.dir, { now, logger }),
    logger,
    clientFor,
    exports: new ExportStore({ now }),
    exportedBy: `${SERVER_NAME} ${SERVER_VERSION}`,
    evaluationPollMs: options.evaluationPollMs ?? 5000,
    now,
  };
}

/** A new MCP server (one per MCP session) with every tool. */
export function createMcpServer(context: AppContext, groups: ReadonlyArray<ToolGroup> = TOOL_GROUPS): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAllTools(server, context, groups);
  registerExportResource(server, context);
  return server;
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Starts the HTTP server with the MCP endpoint. */
export async function startServer(config: Config, options: ServerOptions = {}): Promise<RunningServer> {
  const context = createContext(config, options);
  const logger = context.logger;
  const groups = options.toolGroups ?? TOOL_GROUPS;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  let port = options.port ?? config.server.port;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const check = authenticateCaller(req, { bearerToken: config.auth.bearerToken, port });
    if (!check.ok) {
      sendJsonRpcError(res, check.status, -32001, check.message, check.headers);
      return;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const existing = sessionId ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        const text = await readBody(req, MAX_BODY_BYTES);
        body = JSON.parse(text);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJsonRpcError(res, 413, -32000, `Request body larger than ${MAX_BODY_BYTES} bytes`);
        } else {
          sendJsonRpcError(res, 400, -32700, 'Parse error: the body is not valid JSON');
        }
        return;
      }
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (sessionId) {
        sendJsonRpcError(res, 404, -32001, 'Session not found: start a new MCP session');
        return;
      }
      if (!isInitializeRequest(body)) {
        sendJsonRpcError(res, 400, -32000, 'Bad Request: no valid Mcp-Session-Id, and not an initialize request');
        return;
      }
      const server = createMcpServer(context, groups);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          servers.set(id, server);
          logger.info(`MCP session ${id} started (${transports.size} open).`);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && transports.delete(id)) {
          servers.delete(id);
          logger.info(`MCP session ${id} closed (${transports.size} open).`);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        sendJsonRpcError(res, sessionId ? 404 : 400, -32000, sessionId ? 'Session not found' : 'Missing Mcp-Session-Id');
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error(`Request failed: ${errorMessage(error)}`);
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, config.server.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  port = (httpServer.address() as AddressInfo).port;
  const host = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;

  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}/mcp`,
    port,
    context,
    sessionCount: () => transports.size,
    close() {
      closing ??= (async () => {
        for (const transport of [...transports.values()]) await transport.close().catch(() => {});
        for (const server of [...servers.values()]) await server.close().catch(() => {});
        transports.clear();
        servers.clear();
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections();
        });
        await context.browser.close().catch((error: unknown) => logger.warn(`Closing Chrome: ${errorMessage(error)}`));
      })();
      return closing;
    },
  };
}

/**
 * Trust the certificates of the operating system's store as well as Node's own. A company network
 * that inspects TLS uses its own root certificate, which Chrome trusts (from Windows) but Node does
 * not; without this, every request to HelloID fails with SELF_SIGNED_CERT_IN_CHAIN.
 */
function trustSystemCertificates(): void {
  try {
    const system = tls.getCACertificates('system');
    if (system.length) tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system])]);
  } catch (error) {
    stderrLogger.warn(`Could not add the system's certificates: ${errorMessage(error)}`);
  }
}

async function main(): Promise<void> {
  trustSystemCertificates();
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    stderrLogger.error(error instanceof ConfigError ? error.message : errorMessage(error));
    process.exitCode = 1;
    return;
  }
  const running = await startServer(config);
  stderrLogger.info(`${SERVER_NAME} ${SERVER_VERSION} listening on ${running.url}`);
  stderrLogger.info(`Audit log: ${config.audit.dir}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      stderrLogger.warn('Stopping now.');
      process.exit(1);
    }
    stopping = true;
    stderrLogger.info(`${signal}: shutting down (the HelloID sessions are forgotten).`);
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        stderrLogger.error(`Shutdown failed: ${errorMessage(error)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    stderrLogger.error(errorMessage(error));
    process.exit(1);
  });
}
