// The write tools of the entitlement actions, each in two steps (plan, then apply), like delete.ts:
// - retry a failed action of the history (allowRetryActions)
// - approve a blocked group: every blocked action of one target system, entitlement type and
//   operation at once, as HelloID's page does (allowApproveBlocked)
// - a full enforcement run (allowEnforce): the plan runs an evaluation without enforcement and
//   shows its report as what the enforcement is expected to do; apply starts the run with enforce=true.
// All of them need mode "write" and are refused under safety.readOnly. Plans live 30 minutes, in the
// MCP session that made them, and are applied once, inside the environment's lock; apply reads
// HelloID again and refuses when it changed since the plan. The audit line of an apply has the
// before and after.

import { z } from 'zod';
import { ACTION_PATHS } from '../helloid/endpoints.ts';
import { NotFoundError, rowsOf } from '../helloid/exports.ts';
import { fingerprint, RefusedError } from '../safety.ts';
import {
  blockedDetailRow,
  type BlockedDetail,
  type BlockedGroup,
  blockedGroupKey,
  blockedGroupRow,
  describeGroup,
  entitlementTypeOf,
  findHistoryAction,
  groupInput,
  historyRow,
  type HistoryRow,
  isGroup,
  logMessageRow,
  OPERATION_LABELS,
  readActionLogging,
  readBlockedDetails,
  readBlockedGroups,
  RESULT_LABELS,
  systemNames,
  toHistoryRow,
} from './actions.ts';
import type { AppContext } from './context.ts';
import {
  EVALUATION_WAIT_MS,
  readReportRows,
  readRuns,
  type ReportRow,
  runRow,
  runsInProgress,
  startRun,
  summarizeReport,
  toRunRow,
  waitForRun,
} from './evaluation.ts';
import { defineTool, page, pageOutput, pageText, pagingInput, type ResolvedEnvironment, type ToolGroup } from './helpers.ts';

type Any = any;

/** Annotations of the plan tools: they change nothing in HelloID (the enforcement plan runs an evaluation without enforcement). */
const planAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Annotations of the apply tools. */
const applyAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const ERROR = 0;
/** The log messages of an action the retry plan shows (the newest). */
export const RETRY_LOG_MESSAGES = 10;

// ---------------------------------------------------------------------------------------------
// Retry a failed action

export const RETRY_PLAN_KIND = 'retry-action';

interface RetryPlanData {
  actionId: string;
  systemId: string;
  search: string | undefined;
  row: HistoryRow;
}

const actionLabel = (row: HistoryRow) =>
  `${row.operationLabel ?? row.operation} of ${row.entitlementTypeLabel ?? row.entitlementType} "${row.entitlementName}" ` +
  `for "${row.personName}" on "${row.systemName ?? row.systemId}"`;

/** The action in the history with result Error (raw), or a refusal that says why it cannot be retried. */
async function readFailedAction(environment: ResolvedEnvironment, actionId: string, search: string | undefined, signal: AbortSignal) {
  const failed = await findHistoryAction(environment, actionId, { search, results: [ERROR], signal });
  if (failed && failed.result === ERROR) return failed;
  const any = failed ?? (await findHistoryAction(environment, actionId, { search, signal }));
  if (!any) {
    throw new NotFoundError(
      `There is no action '${actionId}' in the history of '${environment.name}'${search ? ` among the actions found with "${search}"` : ''}. ` +
        'Give search (e.g. the person\'s name) when the history is long: HelloID counts at most 5000 rows.',
    );
  }
  const label = RESULT_LABELS[any.result as number] ?? String(any.result);
  throw new RefusedError(`Refused: action '${actionId}' has result ${any.result} (${label}); only actions with result 0 (Error) can be retried.`);
}

export const planRetryAction = defineTool({
  name: 'helloid_plan_retry_action',
  title: 'Plan retrying a failed entitlement action',
  description:
    'Plans retrying one failed action of the entitlement action history (HelloID\'s History page, "Retry"). Reads the ' +
    'action (by actionId; give search, e.g. the person\'s name, to find it fast in a long history) and its newest log ' +
    'messages, and returns the person, entitlement, system, operation and result, the retry request and a plan ID for ' +
    'helloid_apply_retry_action (valid 30 minutes, this MCP session only). Only actions with result Error can be retried. ' +
    'Changes nothing. Needs mode "write" and allowRetryActions true for the environment.',
  access: 'retryActions',
  environment: true,
  input: {
    actionId: z.string().min(1).describe('The action ID (helloid_list_action_history)'),
    search: z.string().optional().describe('HelloID\'s search of the history that finds the action, e.g. the person\'s name (faster)'),
  },
  output: {
    planId: z.string().describe('The plan for helloid_apply_retry_action'),
    expiresAt: z.string(),
    action: historyRow,
    retryRequest: z.string().describe('The request apply sends'),
    logMessages: z.array(logMessageRow).describe(`The newest log messages of the action (at most ${RETRY_LOG_MESSAGES})`),
    logMessageCount: z.number().describe('The number of log messages HelloID gave'),
  },
  annotations: planAnnotations,
  async handler(call, context) {
    const { actionId, search } = call.args;
    const environment = call.environment;
    const [raw, names] = await Promise.all([readFailedAction(environment, actionId, search, call.signal), systemNames(environment, call.signal)]);
    const row = toHistoryRow(raw, names);
    if (!row.systemId) throw new Error(`HelloID's history does not say the target system of action '${actionId}'.`);
    const { messages } = await readActionLogging(environment, actionId, context.now, call.signal);
    const path = ACTION_PATHS.retry(row.systemId, actionId);
    const plan = context.plans.create<RetryPlanData>({
      environment: environment.name,
      sessionId: call.sessionId,
      kind: RETRY_PLAN_KIND,
      items: { action: raw },
      data: { actionId, systemId: row.systemId, search, row },
    });
    const last = messages[0]?.message ? ` Newest log message: ${messages[0].message.replace(/\s+/g, ' ').slice(0, 300)}` : '';
    return {
      summary:
        `Plan ${plan.id} (valid 30 minutes): retry the failed ${actionLabel(row)}.${last} Run it with helloid_apply_retry_action.`,
      structured: {
        planId: plan.id,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        action: row,
        retryRequest: `POST ${path} {}`,
        logMessages: messages.slice(0, RETRY_LOG_MESSAGES),
        logMessageCount: messages.length,
      },
    };
  },
});

export const applyRetryAction = defineTool({
  name: 'helloid_apply_retry_action',
  title: 'Retry a failed entitlement action (apply a retry plan)',
  description:
    'RETRIES a failed entitlement action in HelloID: HelloID runs the grant, revoke or update again in the target system. ' +
    'Runs a plan of helloid_plan_retry_action: reads the action again and refuses when it is no longer in the history ' +
    'with result Error or changed since the plan, then sends HelloID\'s retry request. A plan runs at most once, only in ' +
    'the MCP session that made it, within 30 minutes. The action before and after is written to the audit log. Needs ' +
    'mode "write" and allowRetryActions true for the environment.',
  access: 'retryActions',
  environment: true,
  input: { planId: z.string().min(1).describe('The plan ID from helloid_plan_retry_action') },
  output: {
    action: historyRow.describe('The action as planned'),
    retryRequest: z.string().describe('The request that was sent'),
    after: historyRow.nullable().describe('The action as read back from the history after the retry; null when not found'),
  },
  annotations: applyAnnotations,
  async handler(call, context) {
    const environment = call.environment;
    return context.locks.run(environment.name, async () => {
      const plan = context.plans.get<RetryPlanData>(call.args.planId, { environment: environment.name, sessionId: call.sessionId, kind: RETRY_PLAN_KIND });
      const { actionId, systemId, search, row } = plan.data;
      const raw = await readFailedAction(environment, actionId, search, call.signal);
      context.plans.verify(plan, { action: raw });
      context.plans.markApplied(plan);
      const path = ACTION_PATHS.retry(systemId, actionId);
      await environment.client.gateway({ method: 'POST', path, body: {}, signal: call.signal });
      const names = await systemNames(environment, call.signal);
      const afterRaw = await findHistoryAction(environment, actionId, { search, signal: call.signal }).catch(() => undefined);
      const after = afterRaw ? toHistoryRow(afterRaw, names) : null;
      call.recordChanges([{ item: `entitlement action ${actionId} (${actionLabel(row)})`, before: row, after }]);
      return {
        summary: `Retried the failed ${actionLabel(row)}. helloid_list_entitlement_actions and helloid_list_action_history show how it goes.`,
        structured: { action: row, retryRequest: `POST ${path} {}`, after },
      };
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Approve a blocked group

export const APPROVE_PLAN_KIND = 'approve-blocked';

interface ApprovePlanData {
  key: ReturnType<typeof blockedGroupKey>;
  systemName: string | null;
  count: number;
}

/** What is fingerprinted: the group (without processing, which apply checks on its own) and its blocked actions. */
const approveItems = (group: BlockedGroup | undefined, details: BlockedDetail[] | undefined): Record<string, unknown> => {
  if (!group) return {};
  const { processing: _processing, ...rest } = group;
  return { group: rest, details: details ?? [] };
};

const processingRefusal = (what: string) =>
  `Refused: HelloID is processing the blocked ${what} already (processing is true); wait until it is done and look again.`;

export const planApproveBlocked = defineTool({
  name: 'helloid_plan_approve_blocked',
  title: 'Plan approving a blocked group',
  description:
    'Plans approving one group of blocked entitlement actions (HelloID\'s Blocked page, "Approve"): every blocked action ' +
    'of one target system, entitlement type and operation at once; HelloID cannot approve per person. Reads the group ' +
    '(helloid_list_blocked) and all its blocked actions, and returns the count, the threshold, the persons and ' +
    'entitlements (in pages, with the total), a fingerprint of them, and a plan ID for helloid_apply_approve_blocked ' +
    '(valid 30 minutes, this MCP session only), which needs confirmCount equal to the count. A group HelloID is ' +
    'processing already is refused. Changes nothing. Needs mode "write" and allowApproveBlocked true for the environment.',
  access: 'approveBlocked',
  environment: true,
  input: { ...groupInput, ...pagingInput },
  output: {
    planId: z.string().describe('The plan for helloid_apply_approve_blocked'),
    expiresAt: z.string(),
    group: blockedGroupRow,
    count: z.number().describe('The number of blocked actions: helloid_apply_approve_blocked needs it as confirmCount'),
    configuration: z.string().nullable().describe('The threshold that blocks them, as HelloID says it'),
    detailsFingerprint: z.string().describe('A hash of the blocked actions; apply refuses when they changed'),
    approveRequest: z.string().describe('The request apply sends'),
    warnings: z.array(z.string()),
    ...pageOutput(blockedDetailRow, 'The blocked actions that are approved'),
  },
  annotations: planAnnotations,
  async handler(call, context) {
    const environment = call.environment;
    const key = blockedGroupKey(call.args);
    const group = (await readBlockedGroups(environment, call.signal)).find(isGroup(key));
    if (!group) throw new NotFoundError(`There is no blocked group ${describeGroup(key)} in '${environment.name}' (helloid_list_blocked lists them).`);
    const what = describeGroup(key, group.systemName);
    if (group.processing === true) throw new RefusedError(processingRefusal(what));
    const details = await readBlockedDetails(environment, key, call.signal);
    const count = group.count ?? details.length;
    const warnings: string[] = [];
    if (details.length !== count) warnings.push(`HelloID counts ${count} blocked action(s) but listed ${details.length}`);
    const path = ACTION_PATHS.processBlocked(key.systemId, key.type, key.operation);
    const plan = context.plans.create<ApprovePlanData>({
      environment: environment.name,
      sessionId: call.sessionId,
      kind: APPROVE_PLAN_KIND,
      items: approveItems(group, details),
      data: { key, systemName: group.systemName, count },
    });
    const listed = page(details, call.args.offset, call.args.limit);
    return {
      summary:
        `Plan ${plan.id} (valid 30 minutes): approve ${count} blocked ${what} (${group.configuration ?? 'no threshold given'}). ` +
        `${pageText(listed, 'blocked action(s)')}${warnings.length ? ` Warnings: ${warnings.join('; ')}.` : ''} ` +
        `Run it with helloid_apply_approve_blocked, with confirmCount ${count}.`,
      structured: {
        planId: plan.id,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        group,
        count,
        configuration: group.configuration,
        detailsFingerprint: fingerprint(details),
        approveRequest: `POST ${path} {}`,
        warnings,
        ...listed,
      },
    };
  },
});

export const applyApproveBlocked = defineTool({
  name: 'helloid_apply_approve_blocked',
  title: 'Approve a blocked group (apply an approve plan)',
  description:
    'APPROVES a group of blocked entitlement actions in HelloID: HelloID then runs every blocked action of the group ' +
    '(grants, revokes or updates in the target system). Runs a plan of helloid_plan_approve_blocked: refuses unless ' +
    'confirmCount is the planned count, reads the group and its blocked actions again and refuses when the count or the ' +
    'actions changed since the plan or HelloID is processing the group, then sends HelloID\'s approve request. A plan ' +
    'runs at most once, only in the MCP session that made it, within 30 minutes. Every approved person and entitlement ' +
    'is written to the audit log. Needs mode "write" and allowApproveBlocked true for the environment.',
  access: 'approveBlocked',
  environment: true,
  input: {
    planId: z.string().min(1).describe('The plan ID from helloid_plan_approve_blocked'),
    confirmCount: z.number().int().describe('The number of blocked actions, exactly as the plan shows it; anything else is refused'),
  },
  output: {
    group: blockedGroupRow.describe('The group as planned'),
    approved: z.number().describe('The number of blocked actions approved'),
    approveRequest: z.string().describe('The request that was sent'),
    after: blockedGroupRow.nullable().describe('The group as read back after the approval; null when it is no longer blocked'),
  },
  annotations: applyAnnotations,
  async handler(call, context) {
    const environment = call.environment;
    return context.locks.run(environment.name, async () => {
      const plan = context.plans.get<ApprovePlanData>(call.args.planId, { environment: environment.name, sessionId: call.sessionId, kind: APPROVE_PLAN_KIND });
      const { key, count } = plan.data;
      const what = describeGroup(key, plan.data.systemName);
      if (call.args.confirmCount !== count) {
        throw new RefusedError(`Refused: confirmCount ${call.args.confirmCount} is not the planned count of ${what} (${count}). Nothing was approved.`);
      }
      const group = (await readBlockedGroups(environment, call.signal)).find(isGroup(key));
      if (!group) throw new RefusedError(`Refused: ${what} is no longer blocked; plan again if needed.`);
      if (group.processing === true) throw new RefusedError(processingRefusal(what));
      const details = await readBlockedDetails(environment, key, call.signal);
      context.plans.verify(plan, approveItems(group, details));
      context.plans.markApplied(plan);
      const path = ACTION_PATHS.processBlocked(key.systemId, key.type, key.operation);
      await environment.client.gateway({ method: 'POST', path, body: {}, signal: call.signal });
      const after = (await readBlockedGroups(environment, call.signal).catch(() => [] as BlockedGroup[])).find(isGroup(key)) ?? null;
      call.recordChanges([{ item: `blocked group ${what} (${key.systemId}/${key.type}/${key.operation})`, before: { group, approved: details }, after: { group: after } }]);
      return {
        summary: `Approved ${count} blocked ${what}: HelloID processes them now. helloid_list_blocked shows when it is done.`,
        structured: { group, approved: count, approveRequest: `POST ${path} {}`, after },
      };
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Enforcement

export const ENFORCE_PLAN_KIND = 'enforcement';
/** How long helloid_apply_enforcement waits for the run at most (an enforcement takes longer than an evaluation). */
export const ENFORCEMENT_WAIT_MS = 4 * 60 * 60 * 1000;

const reportGroup = z.object({
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  entitlementType: z.string().nullable().describe('Account, AccountAccess or Permission'),
  entitlementTypeLabel: z.string().nullable(),
  operation: z.number().nullable().describe('0 Grant, 1 Revoke, 2 Update'),
  operationLabel: z.string().nullable(),
  count: z.number(),
});
const counts = z.record(z.string(), z.number());
const reportOutput = z.object({
  actions: z.number(),
  groups: z.array(reportGroup).describe('The actions per system, entitlement type and operation'),
  bySystem: counts,
  byEntitlementType: counts,
  byOperation: counts.describe('Per operation label (Grant, Revoke, Update)'),
});

/** A report summary with labels: the actions per system, type and operation, and the counts. */
export function labeledReport(rows: ReportRow[]): z.infer<typeof reportOutput> {
  const summary = summarizeReport(rows);
  const groups = new Map<string, z.infer<typeof reportGroup>>();
  for (const row of rows) {
    const key = `${row.systemId}|${row.entitlementType}|${row.operation}`;
    const found = groups.get(key);
    if (found) {
      found.count++;
      continue;
    }
    groups.set(key, {
      systemId: row.systemId,
      systemName: row.systemName,
      entitlementType: row.entitlementType,
      entitlementTypeLabel: entitlementTypeOf(row.entitlementType)?.label ?? null,
      operation: row.operation,
      operationLabel: row.operation === null ? null : (OPERATION_LABELS[row.operation] ?? null),
      count: 1,
    });
  }
  const byOperation = Object.fromEntries(Object.entries(summary.byOperation).map(([code, n]) => [OPERATION_LABELS[Number(code)] ?? code, n]));
  const byEntitlementType = Object.fromEntries(
    Object.entries(summary.byEntitlementType).map(([type, n]) => [entitlementTypeOf(type)?.label ?? type, n]),
  );
  return { actions: summary.actions, groups: [...groups.values()], bySystem: summary.bySystem, byEntitlementType, byOperation };
}

const reportText = (report: z.infer<typeof reportOutput>) =>
  report.groups.length
    ? report.groups.map((g) => `${g.count} ${g.entitlementTypeLabel ?? g.entitlementType} ${g.operationLabel ?? g.operation} on "${g.systemName ?? g.systemId}"`).join('; ')
    : 'no actions';

interface EnforcePlanData {
  evaluationRunId: string;
  expected: z.infer<typeof reportOutput>;
}

async function refuseWhileRunning(environment: ResolvedEnvironment, signal: AbortSignal) {
  const busy = await runsInProgress(environment, signal);
  if (busy.length) {
    throw new RefusedError(
      `Refused: an evaluation or enforcement run is in progress in '${environment.name}' (${busy.map((r: Any) => r.id).join(', ')}); ` +
        'wait until it is done (helloid_list_evaluation_runs).',
    );
  }
}

/** The ID of the newest run (null when there is none). */
async function latestRunId(environment: ResolvedEnvironment, signal: AbortSignal): Promise<string | null> {
  const run = rowsOf(await readRuns(environment, 1, signal))[0];
  return typeof run?.id === 'string' ? run.id : null;
}

export const planEnforcement = defineTool({
  name: 'helloid_plan_enforcement',
  title: 'Plan an enforcement',
  description:
    'Plans a full enforcement of the business rules. Runs an evaluation WITHOUT enforcement (enforce=false: nothing is ' +
    'granted or revoked), waits for it (up to 30 minutes, sending progress) and returns its report summary (the actions ' +
    'per system, entitlement type and operation, with labels) as what the enforcement is expected to do, and a plan ID ' +
    'for helloid_apply_enforcement (valid 30 minutes, this MCP session only), which needs confirmEnvironment. Refused ' +
    'while an evaluation or enforcement run is in progress. Needs mode "write", allowEnforce and allowEvaluate true for ' +
    'the environment.',
  access: 'enforce',
  environment: true,
  input: {},
  output: {
    planId: z.string().describe('The plan for helloid_apply_enforcement'),
    expiresAt: z.string(),
    evaluationRun: runRow.describe('The evaluation run (without enforcement) of the plan'),
    expected: reportOutput.describe('What the enforcement is expected to do: the report of the evaluation'),
  },
  annotations: planAnnotations,
  async handler(call, context) {
    const environment = call.environment;
    if (!environment.config.allowEvaluate) {
      throw new RefusedError(`Refused: environments.${environment.name}.allowEvaluate is false in config.json (the plan runs an evaluation).`);
    }
    await refuseWhileRunning(environment, call.signal);
    const runId = await startRun(environment, false, call.signal);
    const { finished, run } = await waitForRun(environment, runId, {
      maxMs: EVALUATION_WAIT_MS,
      pollMs: context.evaluationPollMs,
      now: context.now,
      signal: call.signal,
      progress: (poll) => call.progress(poll, `Evaluation run ${runId} (without enforcement) is running`),
    });
    if (!finished) {
      throw new Error(
        `The evaluation run ${runId} of the plan is still running after 30 minutes; no plan was made. Plan again when it is done ` +
          '(helloid_list_evaluation_runs).',
      );
    }
    const expected = labeledReport(await readReportRows(environment, runId, call.signal));
    const plan = context.plans.create<EnforcePlanData>({
      environment: environment.name,
      sessionId: call.sessionId,
      kind: ENFORCE_PLAN_KIND,
      // apply refuses when another run started since the plan's evaluation
      items: { latestRun: runId },
      data: { evaluationRunId: runId, expected },
    });
    return {
      summary:
        `Plan ${plan.id} (valid 30 minutes): the evaluation (not enforced, run ${runId}) found ${expected.actions} action(s): ` +
        `${reportText(expected)}. An enforcement is expected to do these. Run it with helloid_apply_enforcement, with ` +
        `confirmEnvironment "${environment.name}".`,
      structured: { planId: plan.id, expiresAt: new Date(plan.expiresAt).toISOString(), evaluationRun: toRunRow(run), expected },
    };
  },
});

export const applyEnforcement = defineTool({
  name: 'helloid_apply_enforcement',
  title: 'Enforce (apply an enforcement plan)',
  description:
    'Starts a full ENFORCEMENT in HelloID (evaluation with enforce=true): HelloID grants, revokes and updates entitlements ' +
    'in the target systems as the business rules say. Runs a plan of helloid_plan_enforcement: refuses unless ' +
    'confirmEnvironment is the environment\'s name, refuses while an evaluation or enforcement run is in progress or when ' +
    'another run started since the plan, then starts the run. An enforcement takes long: without wait (the default) it ' +
    'returns the run ID at once (follow it with helloid_list_evaluation_runs and helloid_get_evaluation_report); with ' +
    `wait it waits up to ${ENFORCEMENT_WAIT_MS / 3600000} hours (sending progress) and returns the run and its report summary. A plan runs at most ` +
    'once, only in the MCP session that made it, within 30 minutes. Written to the audit log. Needs mode "write" and ' +
    'allowEnforce true for the environment.',
  access: 'enforce',
  environment: true,
  input: {
    planId: z.string().min(1).describe('The plan ID from helloid_plan_enforcement'),
    confirmEnvironment: z.string().describe('The environment\'s name, exactly; anything else is refused'),
    wait: z.boolean().default(false).describe(`Wait for the run to finish (up to ${ENFORCEMENT_WAIT_MS / 3600000} hours) and summarise its report`),
  },
  output: {
    runId: z.string(),
    finished: z.boolean().describe('Whether the run finished while waiting (false without wait)'),
    run: runRow.nullable().describe('The run, as last seen'),
    expected: reportOutput.describe('What the plan\'s evaluation expected'),
    report: reportOutput.nullable().describe('A summary of the enforcement run\'s report, once finished'),
  },
  annotations: applyAnnotations,
  async handler(call, context) {
    const environment = call.environment;
    const { runId, plan } = await context.locks.run(environment.name, async () => {
      const plan = context.plans.get<EnforcePlanData>(call.args.planId, { environment: environment.name, sessionId: call.sessionId, kind: ENFORCE_PLAN_KIND });
      if (call.args.confirmEnvironment !== environment.name) {
        throw new RefusedError(
          `Refused: confirmEnvironment ${JSON.stringify(call.args.confirmEnvironment)} is not exactly the environment's name ` +
            `(${JSON.stringify(environment.name)}). Nothing was started.`,
        );
      }
      await refuseWhileRunning(environment, call.signal);
      context.plans.verify(plan, { latestRun: await latestRunId(environment, call.signal) });
      context.plans.markApplied(plan);
      return { plan, runId: await startRun(environment, true, call.signal) };
    });
    const { expected, evaluationRunId } = plan.data;
    const item = `enforcement run ${runId} (planned with evaluation run ${evaluationRunId})`;
    if (!call.args.wait) {
      call.recordChanges([{ item, before: { expected }, after: { runId, started: true } }]);
      return {
        summary:
          `Started enforcement run ${runId}. It takes a while: helloid_list_evaluation_runs shows when it is done and ` +
          'helloid_get_evaluation_report what it did.',
        structured: { runId, finished: false, run: null, expected, report: null },
      };
    }
    const { finished, run } = await waitForRun(environment, runId, {
      maxMs: ENFORCEMENT_WAIT_MS,
      pollMs: context.evaluationPollMs,
      now: context.now,
      signal: call.signal,
      progress: (poll) => call.progress(poll, `Enforcement run ${runId} is running`),
    });
    const report = finished ? labeledReport(await readReportRows(environment, runId, call.signal)) : null;
    call.recordChanges([{ item, before: { expected }, after: { runId, run: run ? toRunRow(run) : null, report } }]);
    if (!finished) {
      return {
        summary: `Enforcement run ${runId} is still running after ${ENFORCEMENT_WAIT_MS / 3600000} hours; helloid_list_evaluation_runs shows when it is done.`,
        structured: { runId, finished: false, run: run ? toRunRow(run) : null, expected, report: null },
      };
    }
    return {
      summary: `Enforcement run ${runId} finished${run.stageFailed ? ' with a failed stage' : ''}: ${report!.actions} action(s): ${reportText(report!)}.`,
      structured: { runId, finished: true, run: toRunRow(run), expected, report },
    };
  },
});

export const actionChangeTools: ToolGroup = [
  planRetryAction,
  applyRetryAction,
  planApproveBlocked,
  applyApproveBlocked,
  planEnforcement,
  applyEnforcement,
];
