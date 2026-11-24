// Evaluation: the runs, a run's report and logging (read), and the rule persons preview and a full
// evaluation (allowEvaluate). Evaluation never enforces: helloid_start_evaluation always sends
// enforce=false. The start and wait helpers are shared with helloid_plan_enforcement and
// helloid_apply_enforcement (action-changes.ts), the only caller that may start with enforce=true.

import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { parseEventStream } from '../helloid/client.ts';
import { GATEWAY, TAKE_ALL } from '../helloid/endpoints.ts';
import { rowsOf } from '../helloid/exports.ts';
import {
  bool,
  defineTool,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  num,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  type ResolvedEnvironment,
  str,
  type ToolGroup,
} from './helpers.ts';
import { typeName } from './rules.ts';

export const runRow = z.object({
  id: z.string().nullable(),
  startDateUtc: z.string().nullable(),
  endDateUtc: z.string().nullable().describe('null while the run is busy'),
  state: z.number().nullable().describe('HelloID\'s state code of the run'),
  enforce: z.boolean().nullable(),
  stageFailed: z.boolean().nullable(),
});

export const toRunRow = (r: any) => ({
  id: str(r?.id),
  startDateUtc: str(r?.startDateUtc),
  endDateUtc: str(r?.endDateUtc),
  state: num(r?.state),
  enforce: bool(r?.enforce),
  stageFailed: bool(r?.stageFailed),
});

export async function readRuns(environment: ResolvedEnvironment, take: number, signal?: AbortSignal) {
  return environment.client.gatewayJson<any>({ path: GATEWAY.evaluationRuns, query: { take }, signal });
}

export const listEvaluationRuns = defineTool({
  name: 'helloid_list_evaluation_runs',
  title: 'List evaluation runs',
  description:
    'Lists the evaluation runs, newest first (ID, start, end, state, enforced or not), in pages. ' +
    'helloid_get_evaluation_report and helloid_get_evaluation_logging give the details of one. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(runRow, 'The evaluation runs'),
  annotations: readAnnotations,
  async handler(call) {
    const { offset, limit } = call.args;
    const answer = await readRuns(call.environment, offset + limit, call.signal);
    const rows = rowsOf(answer).map(toRunRow);
    const result = { total: num(answer?.totalRowCount) ?? rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
    return { summary: pageText(result, 'evaluation run(s)'), structured: result };
  },
});

const reportRow = z.object({
  personId: z.string().nullable(),
  personName: z.string().nullable(),
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  entitlementType: z.string().nullable().describe('Account, AccountAccess or Permission'),
  entitlementName: z.string().nullable(),
  permissionDefinitionDisplayName: z.string().nullable(),
  operation: z.number().nullable().describe('HelloID\'s operation code'),
  actionState: z.number().nullable().describe('HelloID\'s action state code'),
  origins: z.array(z.number()).describe('HelloID\'s origin codes'),
});

export const toReportRow = (r: any) => ({
  personId: str(r?.person?.personId),
  personName: str(r?.person?.displayName),
  systemId: str(r?.system?.systemId),
  systemName: str(r?.system?.displayName),
  entitlementType: typeName(r?.entitlementType),
  entitlementName: str(r?.entitlementName),
  permissionDefinitionDisplayName: str(r?.permissionDefinitionDisplayName),
  operation: num(r?.operation),
  actionState: num(r?.actionState),
  origins: Array.isArray(r?.origins) ? r.origins.filter((o: unknown) => typeof o === 'number') : [],
});

export const getEvaluationReport = defineTool({
  name: 'helloid_get_evaluation_report',
  title: 'Get an evaluation report',
  description:
    'Gets the report of one evaluation run: per person the entitlement actions it found (system, type, name, operation, ' +
    'state), in pages. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { runId: z.string().min(1).describe('The run ID (helloid_list_evaluation_runs)'), ...pagingInput },
  output: {
    ...pageOutput(reportRow, 'The actions of the run'),
    exceededTotalRowCountLimit: z
      .boolean()
      .nullable()
      .describe('HelloID\'s own flag, passed on as is; not an error. total is the full number of actions: page with offset.'),
  },
  annotations: readAnnotations,
  async handler(call) {
    const { runId, offset, limit } = call.args;
    const answer = await call.environment.client.gatewayJson<any>({
      path: GATEWAY.evaluationReport(runId),
      query: { take: limit, skip: offset },
      signal: call.signal,
    });
    const items = rowsOf(answer).map(toReportRow);
    const result = {
      total: num(answer?.totalRowCount) ?? offset + items.length,
      offset,
      limit,
      items,
      exceededTotalRowCountLimit: bool(answer?.exceededTotalRowCountLimit),
    };
    return { summary: pageText(result, 'action(s) in the report'), structured: result };
  },
});

const LOG_LEVELS = ['Debug', 'Info', 'Warning', 'Error'];

export const getEvaluationLogging = defineTool({
  name: 'helloid_get_evaluation_logging',
  title: 'Get the logging of an evaluation run',
  description:
    'Gets the log messages of one evaluation run (and of its permission import), newest first, as HelloID\'s Evaluations ' +
    'page shows them. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    runId: z.string().min(1).describe('The run ID (helloid_list_evaluation_runs)'),
    limit: pagingInput.limit.describe(`The number of messages. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`),
  },
  output: {
    runId: z.string(),
    messages: z.array(
      z.object({
        message: z.string().nullable(),
        messageTimeUtc: z.string().nullable(),
        level: z.number().nullable().describe('HelloID\'s level code'),
      }),
    ),
    moreDataAvailable: z.boolean().nullable().describe('true: HelloID has more messages than were asked for'),
  },
  annotations: readAnnotations,
  async handler(call) {
    const { runId, limit } = call.args;
    // The run's own logging and that of its permission import, as HelloID's page asks for them
    const run = rowsOf(await readRuns(call.environment, TAKE_ALL, call.signal)).find((r) => r?.id === runId);
    const origins = [runId, ...(typeof run?.permissionImportLoggingId === 'string' && run.permissionImportLoggingId ? [run.permissionImportLoggingId] : [])];
    const answer = await call.environment.client.gatewayJson<any>({
      path: GATEWAY.evaluationLogging(runId),
      query: { take: limit, origins, logLevels: LOG_LEVELS },
      signal: call.signal,
    });
    const messages = (Array.isArray(answer?.logMessages) ? answer.logMessages : []).map((m: any) => ({
      message: str(m?.message),
      messageTimeUtc: str(m?.messageTimeUtc),
      level: num(m?.level),
    }));
    const more = bool(answer?.moreDataAvailable);
    return {
      summary: `${messages.length} log message(s) of run ${runId}${more ? '; HelloID has more' : ''}.`,
      structured: { runId, messages, moreDataAvailable: more },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// The rule persons preview

export interface RulePersons {
  persons: string[];
  totalRowCount: number | null;
  exceededTotalRowCountLimit: boolean | null;
}

/**
 * The persons in the answer of evaluate/rule/persons: a server-sent event stream with
 * `data: {"pagedResult": {...}, "type": 0}` (the page; its totalRowCount is the size of the page) and,
 * with calculateTotalRowCount, `data: {"totalRowCount": n, "type": 1}` (the total).
 */
export function parseRulePersons(text: string): RulePersons {
  let paged: any;
  let total: number | null = null;
  for (const event of parseEventStream(text)) {
    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (data && typeof data === 'object' && data.pagedResult && typeof data.pagedResult === 'object') paged = data.pagedResult;
    else if (typeof data?.totalRowCount === 'number') total = data.totalRowCount;
  }
  if (!paged) throw new Error('HelloID\'s answer of the rule persons preview had no page of persons (pagedResult).');
  const persons = rowsOf(paged)
    .map((p) => (typeof p === 'string' ? p : str(p?.displayName)))
    .filter((p): p is string => typeof p === 'string');
  return {
    persons,
    totalRowCount: total ?? num(paged.totalRowCount),
    exceededTotalRowCountLimit: bool(paged.exceededTotalRowCountLimit),
  };
}

export const evaluateRulePersons = defineTool({
  name: 'helloid_evaluate_rule_persons',
  title: 'Preview the persons of a rule',
  description:
    'Shows the persons (display names) a business rule would match: for a rule as stored (ruleId), or for a rule definition ' +
    'given in the call (rule, unsaved: the rule JSON as helloid_get_business_rule gives it, changed). Uses HelloID\'s own ' +
    'preview; changes nothing in HelloID. Needs allowEvaluate for the environment (any mode). total is always the full ' +
    `number of persons. For the full list, call again with offset = nextOffset (limit up to ${MAX_LIMIT}) until ` +
    'nextOffset is null.',
  access: 'evaluate',
  environment: true,
  input: {
    ruleId: z.string().min(1).optional().describe('A stored rule (give ruleId or rule)'),
    rule: z.record(z.string(), z.unknown()).optional().describe('A rule definition, unsaved (give ruleId or rule)'),
    ...pagingInput,
  },
  output: {
    ...pageOutput(z.string(), 'The display names of the persons'),
    nextOffset: z
      .number()
      .nullable()
      .describe('The offset of the next page, to get the full list; null: this page is the last one'),
    exceededTotalRowCountLimit: z
      .boolean()
      .nullable()
      .describe(
        'HelloID\'s own flag, passed on as is. In this preview HelloID sets it to true whenever the rule matches more ' +
          'persons than limit, even on the last page. It is not an error and nothing is cut off: total is the full ' +
          'number. Use nextOffset to get the rest.',
      ),
  },
  annotations: readAnnotations,
  async handler(call) {
    const { ruleId, rule, offset, limit } = call.args;
    if ((ruleId === undefined) === (rule === undefined)) throw new Error('Give either ruleId (a stored rule) or rule (a rule definition), not both and not neither.');
    const { client } = call.environment;
    const body = rule ?? (await client.gatewayJson({ path: GATEWAY.rule(ruleId!), signal: call.signal }));
    const response = await client.gateway({
      method: 'POST',
      path: GATEWAY.evaluateRulePersons,
      query: { skip: offset, take: limit, calculateTotalRowCount: true },
      body,
      accept: 'text/event-stream',
      signal: call.signal,
    });
    const parsed = parseRulePersons(response.text);
    const result = {
      total: parsed.totalRowCount ?? offset + parsed.persons.length,
      offset,
      limit,
      items: parsed.persons,
      nextOffset: null as number | null,
      exceededTotalRowCountLimit: parsed.exceededTotalRowCountLimit,
    };
    const end = offset + parsed.persons.length;
    if (parsed.persons.length > 0 && end < result.total) result.nextOffset = end;
    const name = typeof (body as any)?.name === 'string' ? `"${(body as any).name}"` : 'The rule';
    const rest =
      result.nextOffset === null
        ? ''
        : ` For the full list, call again with offset ${result.nextOffset} (limit up to ${MAX_LIMIT}) until nextOffset is null.`;
    return {
      summary: `${name} would match ${result.total} person(s). ${pageText(result, 'person(s)')}${rest}`,
      structured: result,
    };
  },
});

// ---------------------------------------------------------------------------------------------
// A full evaluation

/** How long helloid_start_evaluation waits for the run at most. */
export const EVALUATION_WAIT_MS = 30 * 60 * 1000;

const counts = z.record(z.string(), z.number());

export type ReportRow = ReturnType<typeof toReportRow>;

/** Every action in a run's report. */
export async function readReportRows(environment: ResolvedEnvironment, runId: string, signal?: AbortSignal): Promise<ReportRow[]> {
  const answer = await environment.client.gatewayJson<any>({
    path: GATEWAY.evaluationReport(runId),
    query: { take: TAKE_ALL, skip: 0 },
    signal,
  });
  return rowsOf(answer).map(toReportRow);
}

/** Counts of the actions in a run's report. */
export async function reportSummary(environment: ResolvedEnvironment, runId: string, signal?: AbortSignal) {
  return summarizeReport(await readReportRows(environment, runId, signal));
}

/** Counts of report rows per system, entitlement type and operation code. */
export function summarizeReport(rows: ReportRow[]) {
  const countBy = (key: (row: ReportRow) => unknown) => {
    const result: Record<string, number> = {};
    for (const row of rows) {
      const k = String(key(row) ?? '?');
      result[k] = (result[k] ?? 0) + 1;
    }
    return result;
  };
  return {
    actions: rows.length,
    bySystem: countBy((r) => r.systemName ?? r.systemId),
    byEntitlementType: countBy((r) => r.entitlementType),
    byOperation: countBy((r) => r.operation),
  };
}

/**
 * Starts a full run: POST evaluation/start?enforce=<enforce>, no body. Answers the run ID.
 * helloid_start_evaluation always passes false; only helloid_apply_enforcement passes true.
 */
export async function startRun(environment: ResolvedEnvironment, enforce: boolean, signal?: AbortSignal): Promise<string> {
  const answer = await environment.client.gatewayJson<unknown>({
    method: 'POST',
    path: GATEWAY.evaluationStart,
    query: { enforce },
    signal,
  });
  const runId = typeof answer === 'string' ? answer : str((answer as any)?.id ?? (answer as any)?.runId);
  if (!runId) throw new Error(`HelloID started ${enforce ? 'an enforcement' : 'an evaluation'} but did not say its run ID.`);
  return runId;
}

/** The runs that have not ended (endDateUtc null), among the latest 30 (as HelloID's page asks for). */
export async function runsInProgress(environment: ResolvedEnvironment, signal?: AbortSignal) {
  return rowsOf(await readRuns(environment, 30, signal)).filter((r) => r && !r.endDateUtc);
}

/**
 * Polls the runs (30, as HelloID's own page asks for: the new one is among them) until the run has
 * ended or maxMs has passed. finished: whether it ended; run: as last seen.
 */
export async function waitForRun(
  environment: ResolvedEnvironment,
  runId: string,
  options: { maxMs: number; pollMs: number; now: () => number; signal: AbortSignal; progress(poll: number): Promise<void> },
): Promise<{ finished: boolean; run: any }> {
  const started = options.now();
  for (let poll = 1; ; poll++) {
    const run = rowsOf(await readRuns(environment, 30, options.signal)).find((r) => r?.id === runId);
    if (run?.endDateUtc) return { finished: true, run };
    if (options.now() - started >= options.maxMs) return { finished: false, run };
    await options.progress(poll);
    await sleep(options.pollMs, undefined, { signal: options.signal });
  }
}

export const startEvaluation = defineTool({
  name: 'helloid_start_evaluation',
  title: 'Start an evaluation',
  description:
    'Starts a full evaluation of the business rules WITHOUT enforcement (enforce=false: nothing is granted or revoked; ' +
    'this server never enforces). With wait, waits for the run to finish (up to 30 minutes, sending progress) and returns ' +
    'a summary of its report; otherwise returns the run ID at once. Needs allowEvaluate for the environment (any mode).',
  access: 'evaluate',
  environment: true,
  input: { wait: z.boolean().default(false).describe('Wait for the run to finish and summarise its report') },
  output: {
    runId: z.string(),
    finished: z.boolean().describe('Whether the run finished while waiting (false without wait)'),
    run: runRow.nullable().describe('The run, as last seen'),
    report: z
      .object({
        actions: z.number(),
        bySystem: counts,
        byEntitlementType: counts,
        byOperation: counts.describe('Per HelloID operation code'),
      })
      .nullable()
      .describe('A summary of the report, once finished'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const environment = call.environment;
    // Never enforce here: enforcement is helloid_apply_enforcement (allowEnforce)
    const runId = await startRun(environment, false, call.signal);
    if (!call.args.wait) {
      return {
        summary: `Started evaluation run ${runId} (no enforcement). helloid_list_evaluation_runs shows when it is done.`,
        structured: { runId, finished: false, run: null, report: null },
      };
    }
    const { finished, run } = await waitForRun(environment, runId, {
      maxMs: EVALUATION_WAIT_MS,
      pollMs: context.evaluationPollMs,
      now: context.now,
      signal: call.signal,
      progress: (poll) => call.progress(poll, `Evaluation run ${runId} is running`),
    });
    if (!finished) {
      return {
        summary: `Evaluation run ${runId} is still running after 30 minutes; helloid_list_evaluation_runs shows when it is done.`,
        structured: { runId, finished: false, run: run ? toRunRow(run) : null, report: null },
      };
    }
    const report = await reportSummary(environment, runId, call.signal);
    return {
      summary:
        `Evaluation run ${runId} finished${run.stageFailed ? ' with a failed stage' : ''}: ${report.actions} action(s) in the report ` +
        '(not enforced).',
      structured: { runId, finished: true, run: toRunRow(run), report },
    };
  },
});

export const evaluationTools: ToolGroup = [
  listEvaluationRuns,
  getEvaluationReport,
  getEvaluationLogging,
  evaluateRulePersons,
  startEvaluation,
];
