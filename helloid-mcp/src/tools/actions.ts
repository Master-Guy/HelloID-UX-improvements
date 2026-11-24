// Entitlement actions (read): the pending actions, the history of the actions and the logging of one,
// the blocked groups and their actions, and the entitlement types per target system. The labels of
// HelloID's codes (operation, entitlement type, history result) were confirmed by the user; origins
// have no known labels and are passed on as numbers. The write tools on top of these reads are in
// action-changes.ts.

import { z } from 'zod';
import { ACTION_PATHS, cachebust, GATEWAY, TAKE_ALL } from '../helloid/endpoints.ts';
import { rowsOf } from '../helloid/exports.ts';
import {
  bool,
  defineTool,
  num,
  page,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  type ResolvedEnvironment,
  str,
  type ToolGroup,
} from './helpers.ts';

type Any = any;

// ---------------------------------------------------------------------------------------------
// Labels

/** HelloID's operation codes. */
export const OPERATION_LABELS: Record<number, string> = { 0: 'Grant', 1: 'Revoke', 2: 'Update' };
/** HelloID's result codes of the action history (the order of the filter on HelloID's page). */
export const RESULT_LABELS: Record<number, string> = { 0: 'Error', 1: 'Success', 2: 'Skipped', 3: 'Canceled' };
/** HelloID's entitlement types: the code (types= of the blocked overview, the entitlement-types map), the name and the label. */
export const ENTITLEMENT_TYPE_INFO: Record<number, { type: string; label: string }> = {
  1: { type: 'Account', label: 'Account' },
  2: { type: 'AccountAccess', label: 'Account Access' },
  3: { type: 'Permission', label: 'Permission' },
};

export const operationLabel = (code: unknown): string | null => (typeof code === 'number' ? (OPERATION_LABELS[code] ?? null) : null);
export const resultLabel = (code: unknown): string | null => (typeof code === 'number' ? (RESULT_LABELS[code] ?? null) : null);

const squash = (text: string) => text.replace(/[\s_-]/g, '').toLowerCase();

/** An entitlement type as code, name and label, from a code (1-3), a name (AccountAccess) or a label (Account Access). */
export function entitlementTypeOf(value: unknown): { code: number; type: string; label: string } | null {
  if (typeof value === 'number' && ENTITLEMENT_TYPE_INFO[value]) return { code: value, ...ENTITLEMENT_TYPE_INFO[value] };
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return entitlementTypeOf(Number(value.trim()));
  for (const [code, info] of Object.entries(ENTITLEMENT_TYPE_INFO)) {
    if (squash(info.type) === squash(value)) return { code: Number(code), ...info };
  }
  return null;
}

/** A code from a code or a label (case-insensitive) of a table; throws with the options when unknown. */
export function codeOf(value: number | string, labels: Record<number, string>, what: string): number {
  const text = String(value).trim();
  if (/^\d+$/.test(text) && labels[Number(text)] !== undefined) return Number(text);
  const found = Object.entries(labels).find(([, label]) => squash(label) === squash(text));
  if (found) return Number(found[0]);
  const options = Object.entries(labels).map(([code, label]) => `${code} ${label}`).join(', ');
  throw new Error(`Unknown ${what} ${JSON.stringify(value)}: use one of ${options} (the code or the label).`);
}

/** An entitlement type input as its code; throws with the options when unknown. */
export function typeCodeOf(value: number | string): number {
  const found = entitlementTypeOf(value);
  if (found) return found.code;
  const options = Object.entries(ENTITLEMENT_TYPE_INFO).map(([code, info]) => `${code} ${info.type}`).join(', ');
  throw new Error(`Unknown entitlement type ${JSON.stringify(value)}: use one of ${options} (the code, the name or "Account Access").`);
}

export const codeOrLabel = z.union([z.number().int(), z.string().min(1)]);
const operationInput = codeOrLabel.describe('The operation: 0 Grant, 1 Revoke, 2 Update (the code or the label)');
const typeInput = codeOrLabel.describe('The entitlement type: 1 Account, 2 AccountAccess (Account Access), 3 Permission (the code, the name or the label)');

// ---------------------------------------------------------------------------------------------
// Shared reads

/** The target systems as HelloID's Entitlements pages read them (no query); [] when they cannot be read. */
export async function readTargetSystems(environment: ResolvedEnvironment, signal?: AbortSignal): Promise<Any[]> {
  const systems = await environment.client.gatewayJson<Any>({ path: GATEWAY.targetSystems, signal });
  return Array.isArray(systems) ? systems : [];
}

/** systemId -> displayName of the target systems; empty when they cannot be read (names are a convenience). */
export async function systemNames(environment: ResolvedEnvironment, signal?: AbortSignal): Promise<Map<string, string>> {
  const systems = await readTargetSystems(environment, signal).catch(() => []);
  return new Map(systems.filter((s) => typeof s?.systemId === 'string').map((s) => [s.systemId as string, String(s.displayName ?? '')]));
}

/** The entitlement types per target system ({ systemId: [codes] }); null when HelloID's answer cannot be read. */
export async function readEntitlementTypes(environment: ResolvedEnvironment, signal?: AbortSignal): Promise<Record<string, number[]> | null> {
  try {
    const answer = await environment.client.gatewayJson<Any>({ path: ACTION_PATHS.entitlementTypes, signal });
    return answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : null;
  } catch {
    return null;
  }
}

export const entitlementTypeRow = z.object({
  code: z.number().describe('HelloID\'s code: 1 Account, 2 Account Access, 3 Permission'),
  type: z.string().nullable().describe('Account, AccountAccess or Permission'),
  label: z.string().nullable(),
});

/** The entitlement types of one system from the map, with labels; null when the map could not be read. */
export function entitlementTypesFor(map: Record<string, number[]> | null, systemId: unknown) {
  if (!map) return null;
  const codes = typeof systemId === 'string' && Array.isArray(map[systemId]) ? map[systemId]! : [];
  return codes
    .filter((code) => typeof code === 'number')
    .map((code) => ({ code, type: ENTITLEMENT_TYPE_INFO[code]?.type ?? null, label: ENTITLEMENT_TYPE_INFO[code]?.label ?? null }));
}

// ---------------------------------------------------------------------------------------------
// Rows

const actionFields = {
  actionId: z.string().nullable(),
  personId: z.string().nullable(),
  personName: z.string().nullable(),
  entitlementId: z.string().nullable(),
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  entitlementType: z.string().nullable().describe('Account, AccountAccess or Permission'),
  entitlementTypeLabel: z.string().nullable().describe('Account, Account Access or Permission'),
  entitlementName: z.string().nullable(),
  permissionDefinitionDisplayName: z.string().nullable(),
  operation: z.number().nullable().describe('HelloID\'s operation code: 0 Grant, 1 Revoke, 2 Update'),
  operationLabel: z.string().nullable(),
  origins: z.array(z.number()).describe('HelloID\'s origin codes (no labels known)'),
  createdOn: z.string().nullable(),
};

const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function baseRow(r: Any, names: Map<string, string>) {
  const systemId = str(r?.entitlement?.systemIdentifier);
  const type = entitlementTypeOf(r?.entitlement?.type);
  return {
    actionId: str(r?.actionId),
    personId: str(r?.personRef?.personId),
    personName: str(r?.personRef?.displayName),
    entitlementId: str(r?.entitlement?.entitlementId),
    systemId,
    systemName: systemId ? (names.get(systemId) ?? null) : null,
    entitlementType: type?.type ?? str(r?.entitlement?.type),
    entitlementTypeLabel: type?.label ?? null,
    entitlementName: str(r?.entitlement?.displayName),
    permissionDefinitionDisplayName: str(r?.entitlement?.permissionDefinitionDisplayName),
    operation: num(r?.operation),
    operationLabel: operationLabel(r?.operation),
    origins: numbers(r?.origins),
    createdOn: str(r?.createdOn),
  };
}

const pendingRow = z.object({
  ...actionFields,
  actionInitiated: z.boolean().nullable(),
  waitingReasons: z.array(z.string()).describe('Why the action waits, as HelloID says it'),
});
const toPendingRow = (r: Any, names: Map<string, string>) => ({
  ...baseRow(r, names),
  actionInitiated: bool(r?.actionInitiated),
  waitingReasons: strings(r?.waitingReasons),
});

export const historyRow = z.object({
  ...actionFields,
  runId: z.string().nullable(),
  fromRules: z.array(z.string()).describe('The IDs of the business rules the action came from'),
  matchingContracts: z.array(z.string()),
  finishedOn: z.string().nullable(),
  result: z.number().nullable().describe('HelloID\'s result code: 0 Error, 1 Success, 2 Skipped, 3 Canceled'),
  resultLabel: z.string().nullable(),
});
export type HistoryRow = z.infer<typeof historyRow>;
export const toHistoryRow = (r: Any, names: Map<string, string>): HistoryRow => ({
  ...baseRow(r, names),
  runId: str(r?.runId),
  fromRules: strings(r?.fromRules),
  matchingContracts: strings(r?.matchingContracts),
  finishedOn: str(r?.finishedOn),
  result: num(r?.result),
  resultLabel: resultLabel(r?.result),
});

// ---------------------------------------------------------------------------------------------
// Pending actions

export const listEntitlementActions = defineTool({
  name: 'helloid_list_entitlement_actions',
  title: 'List pending entitlement actions',
  description:
    'Lists the pending (open) entitlement actions, as HelloID\'s Entitlements > Actions page: per action the person, the ' +
    'entitlement (system, type, name), the operation (0 Grant, 1 Revoke, 2 Update, with its label), the origins (codes), ' +
    'when it was created, whether it was initiated and why it waits. search is HelloID\'s own search (e.g. a person\'s ' +
    'name); systemId keeps the actions of one target system (filtered here: HelloID\'s page has no such filter). Changes ' +
    'nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    search: z.string().optional().describe('Text to search for, as in HelloID\'s page (e.g. a person\'s name)'),
    systemId: z.string().min(1).optional().describe('Only the actions on this target system'),
    ...pagingInput,
  },
  output: pageOutput(pendingRow, 'The pending actions'),
  annotations: readAnnotations,
  async handler(call) {
    const { search, systemId, offset, limit } = call.args;
    const environment = call.environment;
    const [answer, names] = await Promise.all([
      environment.client.gatewayJson<Any>({
        path: ACTION_PATHS.pending,
        query: { take: systemId ? TAKE_ALL : offset + limit, search: search || undefined },
        signal: call.signal,
      }),
      systemNames(environment, call.signal),
    ]);
    const rows = rowsOf(answer).map((r) => toPendingRow(r, names));
    const result = systemId
      ? page(rows.filter((r) => r.systemId === systemId), offset, limit)
      : { total: num(answer?.totalRowCount) ?? rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
    return { summary: pageText(result, `pending action(s)${search ? ` matching "${search}"` : ''}`), structured: result };
  },
});

// ---------------------------------------------------------------------------------------------
// History

export interface HistoryQuery {
  take: number;
  search?: string;
  results?: number[];
  operations?: number[];
  types?: number[];
  systems?: string[];
}

/** The action history as HelloID gives it (rows, totalRowCount, exceededTotalRowCountLimit). */
export async function readHistory(environment: ResolvedEnvironment, query: HistoryQuery, signal?: AbortSignal): Promise<Any> {
  return environment.client.gatewayJson<Any>({
    path: ACTION_PATHS.history,
    query: {
      take: query.take,
      search: query.search || undefined,
      results: query.results?.length ? query.results : undefined,
      operations: query.operations?.length ? query.operations : undefined,
      types: query.types?.length ? query.types : undefined,
      systems: query.systems?.length ? query.systems : undefined,
    },
    signal,
  });
}

/** One action of the history (raw), or undefined; search narrows HelloID's list (e.g. the person's name). */
export async function findHistoryAction(
  environment: ResolvedEnvironment,
  actionId: string,
  options: { search?: string; results?: number[]; signal?: AbortSignal },
): Promise<Any | undefined> {
  const answer = await readHistory(environment, { take: TAKE_ALL, search: options.search, results: options.results }, options.signal);
  return rowsOf(answer).find((r) => r?.actionId === actionId);
}

export const listActionHistory = defineTool({
  name: 'helloid_list_action_history',
  title: 'List the entitlement action history',
  description:
    'Lists the history of the entitlement actions (newest first), as HelloID\'s Entitlements > History page: per action ' +
    'the person, the entitlement (system, type, name), the operation (0 Grant, 1 Revoke, 2 Update), the result (0 Error, ' +
    '1 Success, 2 Skipped, 3 Canceled), with labels, the run, the rules it came from, and when it was created and ' +
    'finished. Filters: search (HelloID\'s own search, e.g. a person\'s name), results, operations, types, systemIds ' +
    '(codes or labels). HelloID counts at most 5000 rows (then exceededTotalRowCountLimit is true). ' +
    'helloid_get_action_logging gives the log messages of one action. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    search: z.string().optional().describe('Text to search for, as in HelloID\'s page (e.g. a person\'s name)'),
    results: z.array(codeOrLabel).optional().describe('Only these results: 0 Error, 1 Success, 2 Skipped, 3 Canceled (codes or labels)'),
    operations: z.array(codeOrLabel).optional().describe('Only these operations: 0 Grant, 1 Revoke, 2 Update (codes or labels)'),
    types: z.array(codeOrLabel).optional().describe('Only these entitlement types: 1 Account, 2 AccountAccess, 3 Permission'),
    systemIds: z.array(z.string().min(1)).optional().describe('Only actions on these target systems'),
    ...pagingInput,
  },
  output: {
    ...pageOutput(historyRow, 'The actions of the history'),
    exceededTotalRowCountLimit: z.boolean().nullable().describe('HelloID\'s own flag: true when there are more rows than it counts (5000)'),
    warnings: z.array(z.string()).describe('Filters HelloID did not apply to the rows it answered'),
  },
  annotations: readAnnotations,
  async handler(call) {
    const { search, offset, limit } = call.args;
    const results = (call.args.results ?? []).map((v) => codeOf(v, RESULT_LABELS, 'result'));
    const operations = (call.args.operations ?? []).map((v) => codeOf(v, OPERATION_LABELS, 'operation'));
    const types = (call.args.types ?? []).map(typeCodeOf);
    const systems = call.args.systemIds ?? [];
    const environment = call.environment;
    const [answer, names] = await Promise.all([
      readHistory(environment, { take: offset + limit, search, results, operations, types, systems }, call.signal),
      systemNames(environment, call.signal),
    ]);
    const rows = rowsOf(answer).map((r) => toHistoryRow(r, names));
    // The operations, types and systems filters were not recorded on HelloID's page (see DESIGN.md's
    // Unknowns): say so when HelloID answered rows that do not match them
    const warnings: string[] = [];
    const check = (name: string, wanted: unknown[], value: (row: HistoryRow) => unknown) => {
      if (wanted.length && rows.some((row) => !wanted.includes(value(row)))) {
        warnings.push(`HelloID answered rows that do not match the ${name} filter: it may not support it.`);
      }
    };
    check('results', results, (r) => r.result);
    check('operations', operations, (r) => r.operation);
    check('types', types, (r) => entitlementTypeOf(r.entitlementType)?.code);
    check('systemIds', systems, (r) => r.systemId);
    const result = {
      total: num(answer?.totalRowCount) ?? rows.length,
      offset,
      limit,
      items: rows.slice(offset, offset + limit),
      exceededTotalRowCountLimit: bool(answer?.exceededTotalRowCountLimit),
      warnings,
    };
    const more = result.exceededTotalRowCountLimit ? ' HelloID counts at most 5000: there are more.' : '';
    return { summary: `${pageText(result, 'action(s) in the history')}${more}${warnings.length ? ` ${warnings.join(' ')}` : ''}`, structured: result };
  },
});

export const logMessageRow = z.object({
  message: z.string().nullable(),
  messageTimeUtc: z.string().nullable(),
  level: z.number().nullable().describe('HelloID\'s level code'),
  scopeId: z.string().nullable().describe('The run'),
  objectId: z.string().nullable().describe('<personId>.<entitlementId>'),
});

/** The log messages of one action of the history, as HelloID's page reads them. */
export async function readActionLogging(environment: ResolvedEnvironment, actionId: string, now: () => number, signal?: AbortSignal) {
  const answer = await environment.client.gatewayJson<Any>({
    path: ACTION_PATHS.historyLogging(actionId),
    query: { cachebust: cachebust(now) },
    signal,
  });
  const messages = (Array.isArray(answer?.logMessages) ? answer.logMessages : []).map((m: Any) => ({
    message: str(m?.message),
    messageTimeUtc: str(m?.messageTimeUtc),
    level: num(m?.level),
    scopeId: str(m?.scopeId),
    objectId: str(m?.objectId),
  }));
  return { messages: messages as Array<z.infer<typeof logMessageRow>>, moreDataAvailable: bool(answer?.moreDataAvailable) };
}

export const getActionLogging = defineTool({
  name: 'helloid_get_action_logging',
  title: 'Get the logging of an entitlement action',
  description:
    'Gets the log messages of one action of the entitlement action history (helloid_list_action_history gives the action ' +
    'ID), as HelloID\'s History page shows them: message, time, level, run. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { actionId: z.string().min(1).describe('The action ID (helloid_list_action_history)') },
  output: {
    actionId: z.string(),
    messages: z.array(logMessageRow),
    moreDataAvailable: z.boolean().nullable().describe('true: HelloID has more messages'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const { actionId } = call.args;
    const { messages, moreDataAvailable } = await readActionLogging(call.environment, actionId, context.now, call.signal);
    return {
      summary: `${messages.length} log message(s) of action ${actionId}${moreDataAvailable ? '; HelloID has more' : ''}.`,
      structured: { actionId, messages, moreDataAvailable },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Blocked

export const blockedGroupRow = z.object({
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  templateIdentifier: z.string().nullable(),
  entitlementType: z.string().nullable().describe('Account, AccountAccess or Permission'),
  entitlementTypeCode: z.number().nullable().describe('1 Account, 2 Account Access, 3 Permission'),
  entitlementTypeLabel: z.string().nullable(),
  operation: z.number().nullable().describe('0 Grant, 1 Revoke, 2 Update'),
  operationLabel: z.string().nullable(),
  configuration: z.string().nullable().describe('The threshold that blocks them, as HelloID says it (e.g. "Blocking when at least 5")'),
  count: z.number().nullable().describe('The number of blocked actions'),
  processing: z.boolean().nullable().describe('true: HelloID is processing the group (approved already)'),
});
export type BlockedGroup = z.infer<typeof blockedGroupRow>;

const toBlockedGroup = (g: Any): BlockedGroup => {
  const type = entitlementTypeOf(g?.entitlementType);
  return {
    systemId: str(g?.system?.systemId),
    systemName: str(g?.system?.displayName),
    templateIdentifier: str(g?.system?.templateIdentifier),
    entitlementType: type?.type ?? str(g?.entitlementType),
    entitlementTypeCode: type?.code ?? null,
    entitlementTypeLabel: type?.label ?? null,
    operation: num(g?.operation),
    operationLabel: operationLabel(g?.operation),
    configuration: str(g?.configuration),
    count: num(g?.count),
    processing: bool(g?.processing),
  };
};

/** The blocked groups, as HelloID's Blocked page asks for them: every target system, every type and operation. */
export async function readBlockedGroups(environment: ResolvedEnvironment, signal?: AbortSignal): Promise<BlockedGroup[]> {
  const systems = (await readTargetSystems(environment, signal)).map((s) => s?.systemId).filter((s): s is string => typeof s === 'string');
  if (systems.length === 0) return [];
  const answer = await environment.client.gatewayJson<Any>({
    path: ACTION_PATHS.blockedOverview,
    query: { take: TAKE_ALL, systems, types: [1, 2, 3], operations: [0, 1, 2] },
    signal,
  });
  return rowsOf(answer).map(toBlockedGroup);
}

export const blockedDetailRow = z.object({
  personDisplayName: z.string().nullable(),
  entitlementName: z.string().nullable(),
  permissionDefinitionDisplayName: z.string().nullable(),
});
export type BlockedDetail = z.infer<typeof blockedDetailRow>;

/** Every blocked action of one group (system, type name, operation code). */
export async function readBlockedDetails(
  environment: ResolvedEnvironment,
  group: { systemId: string; type: string; operation: number },
  signal?: AbortSignal,
): Promise<BlockedDetail[]> {
  const answer = await environment.client.gatewayJson<Any>({
    path: ACTION_PATHS.blockedDetails,
    query: { take: TAKE_ALL, system: group.systemId, type: group.type, operation: group.operation },
    signal,
  });
  return rowsOf(answer).map((d) => ({
    personDisplayName: str(d?.personDisplayName),
    entitlementName: str(d?.entitlementName),
    permissionDefinitionDisplayName: str(d?.permissionDefinitionDisplayName),
  }));
}

/** The group of the input (systemId, type, operation), normalised: type as code and name, operation as code. */
export function blockedGroupKey(args: { systemId: string; type: number | string; operation: number | string }) {
  const code = typeCodeOf(args.type);
  const operation = codeOf(args.operation, OPERATION_LABELS, 'operation');
  return { systemId: args.systemId, typeCode: code, type: ENTITLEMENT_TYPE_INFO[code]!.type, operation };
}

export const isGroup = (key: { systemId: string; typeCode: number; operation: number }) => (g: BlockedGroup) =>
  g.systemId === key.systemId && g.entitlementTypeCode === key.typeCode && g.operation === key.operation;

export const describeGroup = (key: { typeCode: number; operation: number; systemId: string }, systemName: string | null = null) =>
  `${ENTITLEMENT_TYPE_INFO[key.typeCode]!.label} ${OPERATION_LABELS[key.operation]} on "${systemName ?? key.systemId}"`;

export const groupInput = {
  systemId: z.string().min(1).describe('The target system of the group (helloid_list_blocked)'),
  type: typeInput,
  operation: operationInput,
};

export const listBlocked = defineTool({
  name: 'helloid_list_blocked',
  title: 'List blocked entitlement actions',
  description:
    'Lists the blocked entitlement actions, as HelloID\'s Entitlements > Blocked page: per group (target system, ' +
    'entitlement type, operation, with labels) the threshold that blocks them, the number of actions, and whether HelloID ' +
    'is processing the group. helloid_get_blocked_details gives the persons and entitlements of one group. Changes ' +
    'nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(blockedGroupRow, 'The blocked groups'),
  annotations: readAnnotations,
  async handler(call) {
    const groups = await readBlockedGroups(call.environment, call.signal);
    const result = page(groups, call.args.offset, call.args.limit);
    const actions = groups.reduce((sum, g) => sum + (g.count ?? 0), 0);
    return {
      summary: groups.length ? `${pageText(result, 'blocked group(s)')} ${actions} blocked action(s) in all.` : 'No blocked entitlement actions.',
      structured: result,
    };
  },
});

export const getBlockedDetails = defineTool({
  name: 'helloid_get_blocked_details',
  title: 'Get the actions of a blocked group',
  description:
    'Lists the blocked actions of one group (target system, entitlement type, operation; helloid_list_blocked lists ' +
    'the groups): per action the person and the entitlement, in pages. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...groupInput, ...pagingInput },
  output: {
    systemId: z.string(),
    entitlementType: z.string(),
    entitlementTypeLabel: z.string(),
    operation: z.number(),
    operationLabel: z.string(),
    ...pageOutput(blockedDetailRow, 'The blocked actions of the group'),
  },
  annotations: readAnnotations,
  async handler(call) {
    const key = blockedGroupKey(call.args);
    const details = await readBlockedDetails(call.environment, key, call.signal);
    const result = {
      systemId: key.systemId,
      entitlementType: key.type,
      entitlementTypeLabel: ENTITLEMENT_TYPE_INFO[key.typeCode]!.label,
      operation: key.operation,
      operationLabel: OPERATION_LABELS[key.operation]!,
      ...page(details, call.args.offset, call.args.limit),
    };
    return { summary: `${describeGroup(key)}:${pageText(result, 'blocked action(s)')}`, structured: result };
  },
});

export const actionTools: ToolGroup = [
  listEntitlementActions,
  listActionHistory,
  getActionLogging,
  listBlocked,
  getBlockedDetails,
];
