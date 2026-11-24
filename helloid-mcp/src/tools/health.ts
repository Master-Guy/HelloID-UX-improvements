// helloid_check_health: a quick look at one environment, or at every logged-in one: blocked actions,
// orphaned entitlements, the reference cleaner, the latest snapshots of the target systems, the
// latest evaluation run and the number of failed actions in the history. Each check is read on its
// own: one that fails is reported as failed, the others still answer.

import { z } from 'zod';
import { ACTION_PATHS, GATEWAY } from '../helloid/endpoints.ts';
import { rowsOf } from '../helloid/exports.ts';
import { errorMessage } from '../log.ts';
import { requireAccess } from '../safety.ts';
import { readHistory, readTargetSystems } from './actions.ts';
import type { AppContext } from './context.ts';
import { bool, defineTool, num, readAnnotations, type ResolvedEnvironment, resolveEnvironment, str, type ToolGroup } from './helpers.ts';

type Any = any;

/** One check: ok with its value, or failed with the reason. */
const check = <T extends z.ZodType>(value: T, describe: string) =>
  z
    .object({
      ok: z.boolean().describe('false: the check could not be read (see error)'),
      error: z.string().nullable(),
      value: value.nullable(),
    })
    .describe(describe);

interface Check<T> {
  ok: boolean;
  error: string | null;
  value: T | null;
}

async function run<T>(work: () => Promise<T>): Promise<Check<T>> {
  try {
    return { ok: true, error: null, value: await work() };
  } catch (error) {
    return { ok: false, error: errorMessage(error), value: null };
  }
}

const snapshotRow = z.object({
  systemId: z.string(),
  systemName: z.string().nullable(),
  status: z.number().nullable().describe('HelloID\'s status code of the snapshot'),
  succeeded: z.boolean().nullable(),
  errorMessage: z.string().nullable(),
  startedOn: z.string().nullable(),
  completedOn: z.string().nullable(),
  lastSuccessfulOn: z.string().nullable().describe('The latest successful snapshot of the system'),
});

const runInfo = z.object({
  id: z.string().nullable(),
  startDateUtc: z.string().nullable(),
  endDateUtc: z.string().nullable().describe('null while the run is busy'),
  state: z.number().nullable().describe('HelloID\'s state code of the run'),
  enforce: z.boolean().nullable(),
  stageFailed: z.boolean().nullable(),
});

const failedActions = z.object({
  count: z.number().nullable().describe('The number of actions with result Error in the history'),
  exceededTotalRowCountLimit: z.boolean().nullable().describe('true: HelloID counts at most 5000, there are more'),
});

const environmentHealth = z.object({
  environment: z.string(),
  loggedIn: z.boolean(),
  sessionState: z.enum(['logged-out', 'logged-in', 'expired']),
  checks: z
    .object({
      blockedAny: check(z.boolean(), 'Whether entitlement actions are blocked (helloid_list_blocked)'),
      orphanedEntitlementsAny: check(z.boolean(), 'Whether there are orphaned entitlements'),
      referenceCleanerActive: check(z.boolean(), 'Whether HelloID\'s reference cleaner is active'),
      snapshots: check(z.array(snapshotRow), 'The latest snapshot of each target system'),
      latestEvaluationRun: check(runInfo, 'The latest evaluation (or enforcement) run; value null when there is none'),
      failedActions: check(failedActions, 'The actions with result Error in the history (helloid_list_action_history)'),
    })
    .nullable()
    .describe('null when not logged in'),
  problems: z.array(z.string()).describe('What needs attention, in short'),
});
type EnvironmentHealth = z.infer<typeof environmentHealth>;

async function checkEnvironment(environment: ResolvedEnvironment, signal: AbortSignal) {
  const get = <T = Any>(path: string, query?: Record<string, number>) => environment.client.gatewayJson<T>({ path, query, signal });
  const yesNo = async (path: string) => {
    const answer = await get(path);
    if (typeof answer !== 'boolean') throw new Error(`HelloID did not answer true or false for ${path}.`);
    return answer;
  };
  const [blockedAny, orphanedEntitlementsAny, referenceCleanerActive, snapshots, latestEvaluationRun, failed] = await Promise.all([
    run(() => yesNo(ACTION_PATHS.blockedAny)),
    run(() => yesNo(ACTION_PATHS.orphanedAny)),
    run(() => yesNo(ACTION_PATHS.referenceCleanerActive)),
    run(async () => {
      const [latest, successful, systems] = await Promise.all([
        get(ACTION_PATHS.latestSnapshots),
        get(ACTION_PATHS.latestSuccessfulSnapshotTimes).catch(() => null),
        readTargetSystems(environment, signal).catch(() => []),
      ]);
      if (!latest || typeof latest !== 'object' || Array.isArray(latest)) throw new Error('HelloID\'s answer of the latest snapshots is not a map per system.');
      return Object.entries(latest as Record<string, Any>).map(([systemId, s]) => ({
        systemId,
        systemName: str(systems.find((t: Any) => t?.systemId === systemId)?.displayName),
        status: num(s?.status),
        succeeded: bool(s?.succeeded),
        errorMessage: str(s?.errorMessage),
        startedOn: str(s?.startedOn),
        completedOn: str(s?.completedOn),
        lastSuccessfulOn: str((successful as Any)?.[systemId]),
      }));
    }),
    run(async () => {
      const r = rowsOf(await get(GATEWAY.evaluationRuns, { take: 1 }))[0];
      return r
        ? { id: str(r.id), startDateUtc: str(r.startDateUtc), endDateUtc: str(r.endDateUtc), state: num(r.state), enforce: bool(r.enforce), stageFailed: bool(r.stageFailed) }
        : null;
    }),
    run(async () => {
      const answer = await readHistory(environment, { take: 1, results: [0] }, signal);
      return { count: num(answer?.totalRowCount), exceededTotalRowCountLimit: bool(answer?.exceededTotalRowCountLimit) };
    }),
  ]);
  const checks = { blockedAny, orphanedEntitlementsAny, referenceCleanerActive, snapshots, latestEvaluationRun, failedActions: failed };

  const problems: string[] = [];
  for (const [name, result] of Object.entries(checks)) if (!result.ok) problems.push(`check ${name} failed: ${result.error}`);
  if (blockedAny.value === true) problems.push('entitlement actions are blocked, waiting for approval (helloid_list_blocked)');
  if (orphanedEntitlementsAny.value === true) problems.push('there are orphaned entitlements');
  if (referenceCleanerActive.value === true) problems.push('the reference cleaner is active');
  for (const s of snapshots.value ?? []) {
    if (s.succeeded === false) problems.push(`the latest snapshot of "${s.systemName ?? s.systemId}" failed${s.errorMessage ? `: ${s.errorMessage}` : ''}`);
  }
  const lastRun = latestEvaluationRun.value;
  if (lastRun?.stageFailed === true) problems.push(`the latest ${lastRun.enforce ? 'enforcement' : 'evaluation'} run (${lastRun.id}) has a failed stage`);
  const count = failed.value?.count ?? 0;
  if (count > 0) {
    problems.push(
      `${count}${failed.value?.exceededTotalRowCountLimit ? '+' : ''} failed (Error) action(s) in the history (helloid_list_action_history with results ["Error"])`,
    );
  }
  return { checks, problems };
}

export const checkHealth = defineTool({
  name: 'helloid_check_health',
  title: 'Check the health of environments',
  description:
    'Checks one environment, or (without environment) every environment the server is logged in to: whether entitlement ' +
    'actions are blocked, orphaned entitlements, whether the reference cleaner is active, the latest snapshot of each ' +
    'target system, the latest evaluation run (time, state, enforced), and the number of failed (Error) actions in the ' +
    'history, with a short list of problems. Each check is read on its own: one that fails is reported as failed, the ' +
    'others still answer. Environments that are not logged in are listed as such. Changes nothing. Works in every mode.',
  access: 'none',
  environment: false,
  input: {
    environment: z
      .string()
      .min(1)
      .optional()
      .describe('One environment, as in config.json; leave it out for every environment the server is logged in to'),
  },
  output: { environments: z.array(environmentHealth) },
  annotations: readAnnotations,
  async handler(call, context: AppContext) {
    const names = call.args.environment ? [call.args.environment] : Object.keys(context.config.environments);
    const environments: EnvironmentHealth[] = await Promise.all(
      names.map(async (name) => {
        const environment = resolveEnvironment(context, name);
        requireAccess(context.config, name, environment.config, 'read');
        const state = environment.session.state;
        if (state !== 'logged-in') {
          return { environment: name, loggedIn: false, sessionState: state, checks: null, problems: [] };
        }
        return { environment: name, loggedIn: true, sessionState: state, ...(await checkEnvironment(environment, call.signal)) };
      }),
    );
    const lines = environments.map((e) =>
      !e.loggedIn
        ? `${e.environment}: ${e.sessionState === 'expired' ? 'session expired' : 'not logged in'} (helloid_login), not checked.`
        : e.problems.length
          ? `${e.environment}: ${e.problems.length} problem(s): ${e.problems.join('; ')}.`
          : `${e.environment}: no problems found.`,
    );
    return { summary: lines.join('\n'), structured: { environments } };
  },
});

export const healthTools: ToolGroup = [checkHealth];
