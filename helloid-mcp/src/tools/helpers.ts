// Shared machinery for every tool: environment lookup, mode checks, an audit line for every call,
// errors as tool results (isError) and structured output. A tool is a ToolDefinition; register()
// turns it into an MCP tool.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { AuditChange, AuditResult } from '../audit.ts';
import type { EnvironmentConfig } from '../config.ts';
import type { HelloIdClient } from '../helloid/client.ts';
import { Exporter, GatewayReader } from '../helloid/exports.ts';
import type { EnvironmentSession } from '../helloid/session.ts';
import { errorMessage } from '../log.ts';
import { type Access, RefusedError, requireAccess } from '../safety.ts';
import type { AppContext } from './context.ts';

/** The environment a call is for, resolved from its `environment` argument. */
export interface ResolvedEnvironment {
  name: string;
  config: EnvironmentConfig;
  session: EnvironmentSession;
  client: HelloIdClient;
}

export interface ToolCall<Args, WithEnvironment extends boolean> {
  args: Args;
  environment: WithEnvironment extends true ? ResolvedEnvironment : undefined;
  /** The caller's MCP session. */
  sessionId: string | undefined;
  /** Aborted when the caller cancels the request. */
  signal: AbortSignal;
  /** Sends a progress notification when the caller asked for them (keeps long calls alive). */
  progress(progress: number, message?: string): Promise<void>;
  /** Adds before/after pairs to this call's audit line (apply and delete tools). */
  recordChanges(changes: AuditChange[]): void;
}

export interface ToolOutcome<Out> {
  /** A short text for `content`. */
  summary: string;
  /** For tools with an output schema: the structured result. */
  structured?: Out;
  /** More content after the summary (e.g. a resource link). */
  content?: CallToolResult['content'];
}

type Shape = z.ZodRawShape;
type Infer<S extends Shape> = z.infer<z.ZodObject<S>>;

export interface ToolDefinition<In extends Shape = Shape, Out extends Shape = Shape, WithEnvironment extends boolean = boolean> {
  /** helloid_<verb>_<thing> */
  name: string;
  title: string;
  /** What the tool does, what it changes, and which setting allows it. */
  description: string;
  /** What the environment's settings must allow (see safety.ts). */
  access: Access;
  /** Whether the tool takes `environment` (added to the input schema by register()). */
  environment: WithEnvironment;
  input: In;
  output?: Out;
  annotations: Required<Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>>;
  /** The arguments as the audit line has them, when not as given (e.g. file contents replaced by their size and hash). */
  auditArguments?(args: Record<string, unknown>): unknown;
  handler(call: ToolCall<Infer<In>, WithEnvironment>, context: AppContext): Promise<ToolOutcome<Infer<Out>>>;
}

/** Keeps the types of a tool definition (use it for every tool). */
export function defineTool<In extends Shape, Out extends Shape, WithEnvironment extends boolean>(
  definition: ToolDefinition<In, Out, WithEnvironment>,
): ToolDefinition<In, Out, WithEnvironment> {
  return definition;
}

/** A group of tools of one area (src/tools/<area>.ts exports one). */
export type ToolGroup = ReadonlyArray<ToolDefinition<any, any, any>>;

export const environmentArgument = z
  .string()
  .min(1)
  .describe('The name of the HelloID environment, as in config.json (helloid_list_environments lists them).');

// ---------------------------------------------------------------------------------------------
// Short answers: lists come in pages (offset, limit, default 100) with a total

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

export const pagingInput = {
  offset: z.number().int().min(0).default(0).describe('The first row to return (0-based). Default 0.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`The number of rows to return. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`),
};

/** The output fields of a page of rows. */
export function pageOutput<Item extends z.ZodType>(item: Item, describe: string) {
  return {
    total: z.number().describe('The number of rows in all'),
    offset: z.number(),
    limit: z.number(),
    items: z.array(item).describe(describe),
  };
}

export interface Page<T> {
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

/** One page of rows. */
export function page<T>(rows: readonly T[], offset: number, limit: number): Page<T> {
  return { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
}

/** "rows 1-100 of 250" for a summary. */
export function pageText(result: { total: number; offset: number; items: unknown[] }, noun: string): string {
  if (result.total === 0) return `No ${noun}.`;
  if (result.items.length === 0) return `${result.total} ${noun}; none from offset ${result.offset}.`;
  const first = result.offset + 1;
  const last = result.offset + result.items.length;
  return first === 1 && last === result.total
    ? `${result.total} ${noun}.`
    : `${result.total} ${noun}; showing ${first}-${last} (use offset for more).`;
}

/** Annotations of the read tools: they change nothing in HelloID. */
export const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * The collectors (the userscript's exports, ported) for a call's environment. memo: read each list
 * once during the call (for calls that read many items).
 */
export function exporterFor(call: ToolCall<unknown, true>, context: AppContext, memo = false): Exporter {
  return exporterForEnvironment(call.environment, context, call.signal, memo);
}

/** The collectors for any environment (tools that work on several environments). */
export function exporterForEnvironment(environment: ResolvedEnvironment, context: AppContext, signal: AbortSignal | undefined, memo = false): Exporter {
  const { client, config } = environment;
  return new Exporter(new GatewayReader(client, { signal, memo }), {
    exportedFrom: config.baseUrl,
    exportedBy: context.exportedBy,
    now: context.now,
  });
}

/**
 * An environment for a tool that takes several (no `environment` argument): resolved, and checked
 * against what the tool needs there.
 */
export function environmentWithAccess(context: AppContext, name: string, access: Access): ResolvedEnvironment {
  const environment = resolveEnvironment(context, name);
  requireAccess(context.config, environment.name, environment.config, access);
  return environment;
}

/** The environments the server is logged in to, in the order of config.json. */
export function loggedInEnvironments(context: AppContext): string[] {
  return Object.keys(context.config.environments).filter((name) => context.sessions.peek(name)?.state === 'logged-in');
}

// Values of HelloID's answers in the types of the output schemas
export const str = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === 'string' ? value : String(value);
export const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** An error result Claude can act on. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolves an environment name; throws with the known names when it is unknown. */
export function resolveEnvironment(context: AppContext, name: string): ResolvedEnvironment {
  const config = context.config.environments[name];
  if (!config) {
    const known = Object.keys(context.config.environments).join(', ');
    throw new UnknownEnvironmentError(`Unknown environment '${name}'. Known environments: ${known}.`);
  }
  const client = context.clientFor(name);
  return { name, config, session: client.session, client };
}

export class UnknownEnvironmentError extends Error {
  override name = 'UnknownEnvironmentError';
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Registers one tool on an MCP server, wrapped with the environment lookup, mode check and audit. */
export function register(server: McpServer, context: AppContext, tool: ToolDefinition<any, any, any>): void {
  const inputShape: Shape = tool.environment ? { environment: environmentArgument, ...tool.input } : tool.input;

  const callback = async (args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
    const sessionId = extra.sessionId;
    const environmentName = tool.environment ? String(args.environment) : null;
    const changes: AuditChange[] = [];
    let result: AuditResult = 'ok';
    let summary: string;
    let response: CallToolResult;

    try {
      let environment: ResolvedEnvironment | undefined;
      if (tool.environment && environmentName !== null) {
        environment = resolveEnvironment(context, environmentName);
        requireAccess(context.config, environment.name, environment.config, tool.access);
      }
      const progressToken = extra._meta?.progressToken;
      const call: ToolCall<Record<string, unknown>, boolean> = {
        args,
        environment,
        sessionId,
        signal: extra.signal,
        progress: async (progress, message) => {
          if (progressToken === undefined) return;
          await extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress, ...(message ? { message } : {}) },
            })
            .catch(() => {});
        },
        recordChanges: (more) => {
          changes.push(...more);
        },
      };
      const outcome = await tool.handler(call as never, context);
      summary = outcome.summary;
      response = { content: [{ type: 'text', text: outcome.summary }, ...(outcome.content ?? [])] };
      if (tool.output) response.structuredContent = (outcome.structured ?? {}) as Record<string, unknown>;
    } catch (error) {
      summary = errorMessage(error);
      result = error instanceof RefusedError ? 'refused' : 'error';
      if (result === 'error' && !(error instanceof UnknownEnvironmentError)) {
        context.logger.warn(`${tool.name}${environmentName ? ` (${environmentName})` : ''}: ${summary}`);
      }
      response = errorResult(summary);
    }

    await context.audit.write({
      sessionId: sessionId ?? null,
      environment: environmentName,
      tool: tool.name,
      arguments: tool.auditArguments ? tool.auditArguments(args) : args,
      result,
      summary,
      ...(changes.length > 0 ? { changes } : {}),
    });
    return response;
  };

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: inputShape,
      ...(tool.output ? { outputSchema: tool.output } : {}),
      annotations: { title: tool.title, ...tool.annotations },
    },
    callback as never,
  );
}
