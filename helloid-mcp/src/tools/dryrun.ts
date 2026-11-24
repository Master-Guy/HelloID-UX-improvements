// Target system scripts: the static DryRun check of every script (helloid_check_scripts), and HelloID's
// own previews and dry runs, from recordings of its script editors:
// - helloid_list_dryrun_persons: the persons to pick
// - helloid_preview_field_mapping: the values of the field mapping for a person (no script runs)
// - helloid_dryrun_account_action, helloid_dryrun_permission_action, helloid_dryrun_permission_import,
//   helloid_dryrun_uniqueness: HelloID runs the REAL script against the REAL target system with
//   $actionContext.DryRun = $true. Only the script's own guard keeps it from changing things, so the
//   server first runs the DryRun check on the script that will run and refuses it on any finding.
//
// The dry runs send the system's real configuration values (read from HelloID, in memory only): they
// are never returned, never written to the audit log, and scrubbed from what the script answers.
// The person data HelloID sends the script is not returned or audited either (only its ID and name).
//
// The data is HelloID's own JSON, of many shapes; it is handled as `any`, as the exports are.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  checkDryRun,
  DRYRUN_LIMITATIONS,
  DRYRUN_RULE,
  type DryRunFinding,
  isPowerShellSystem,
  type ScriptVariant,
  targetScripts,
  variantOf,
} from '../changes/dryrun-check.ts';
import { applyChanges, type Changes, type EditSpec } from '../changes/edit.ts';
import { KINDS } from '../changes/kinds.ts';
import { valueAt } from '../changes/paths.ts';
import { cachebust, DRYRUN_PATHS, GATEWAY, TAKE_ALL } from '../helloid/endpoints.ts';
import { inBatches, NotFoundError, rowsOf } from '../helloid/exports.ts';
import { errorMessage } from '../log.ts';
import { isPlainObject, maskTargetConfiguration, RefusedError, SECRET_MASK, SECRET_NAME } from '../safety.ts';
import { codeOf, codeOrLabel, OPERATION_LABELS } from './actions.ts';
import type { AppContext } from './context.ts';
import {
  defineTool,
  environmentWithAccess,
  loggedInEnvironments,
  num,
  type Page,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  type ResolvedEnvironment,
  str,
  type ToolCall,
  type ToolGroup,
} from './helpers.ts';
import { type ImportPlanData, PLAN_KIND } from './import.ts';

type Any = any;

/** The account actions: entitlementAction of an account dry run, and action of the field mapping preview (confirmed by the user). */
export const ACCOUNT_ACTION_LABELS: Record<number, string> = { 1: 'Create', 2: 'Enable', 3: 'Update', 4: 'Disable', 5: 'Delete' };
/** powerShellScriptContext of the dry runs (recorded). */
export const SCRIPT_CONTEXT = { account: 1, permission: 2, permissionImport: 16, uniqueness: 128 } as const;
/** Log messages returned at most, and the length of one. */
const MAX_LOG_MESSAGES = 100;
const MAX_LOG_LENGTH = 2000;

const RULE_TEXT =
  `${DRYRUN_RULE} Before it sends a script, the server runs the static DryRun check on the script that will run and REFUSES it ` +
  'when it finds anything (an empty script, a change of DryRun, a write outside a dry-run check), with the line numbers. A static ' +
  'check can give false positives: then restructure the script into the standard guard pattern ' +
  '`if (-not($actionContext.DryRun -eq $true)) { ... }`.';

const DRYRUN_SECRETS_NOTE =
  'The system\'s real configuration values are sent to HelloID with the script (as HelloID\'s own dry run does) but never returned ' +
  'or written to the audit log; secret values are scrubbed from what the script answers. The person data HelloID gives the script ' +
  'is not returned or audited (only the person\'s ID and name).';

// ---------------------------------------------------------------------------------------------
// Shared

/** A target system with its raw configuration (secrets included: in memory only, never returned). */
interface LoadedSystem {
  systemId: string;
  name: string;
  templateIdentifier: string;
  /** The connector API prefix of its type. */
  api: string;
  variant: ScriptVariant;
  /** HelloID's configuration, with the real values: only ever sent back to HelloID. */
  configuration: Any;
  /** The secret values of the configuration (to scrub them from answers). */
  secrets: string[];
}

/** The values of a configuration that the export masks (password fields, secret names). */
export function secretValuesOf(configuration: Any): string[] {
  const masked = maskTargetConfiguration(configuration);
  const found: string[] = [];
  const walk = (raw: Any, hidden: Any) => {
    if (!isPlainObject(raw) || !isPlainObject(hidden)) return;
    for (const [key, value] of Object.entries(raw)) {
      const other = (hidden as Any)[key];
      if (typeof value === 'string' && value !== SECRET_MASK && other === SECRET_MASK && value.length >= 3) found.push(value);
      else if (isPlainObject(value)) walk(value, other);
    }
  };
  walk(configuration, masked);
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/** A text with the secret values replaced by the mask. */
function scrubText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(SECRET_MASK);
  return out;
}

/** A value with secret values replaced, and values whose name says they are a secret masked. */
function scrub(value: unknown, secrets: string[], key?: string): unknown {
  if (key !== undefined && SECRET_NAME.test(key) && (value === null || typeof value !== 'object')) {
    return value === null || value === '' ? value : SECRET_MASK;
  }
  if (typeof value === 'string') return scrubText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets, k)]));
  return value;
}

async function loadSystem(environment: ResolvedEnvironment, systemId: string, signal: AbortSignal | undefined): Promise<LoadedSystem> {
  const systems = rowsOf(await environment.client.gatewayJson({ path: GATEWAY.targetSystems, query: { showReferenceSystems: true }, signal }));
  const system = systems.find((s) => s?.systemId === systemId);
  if (!system) throw new NotFoundError(`Target system '${systemId}' is not in HelloID's list of target systems (helloid_list_target_systems).`);
  const name = String(system.displayName ?? systemId);
  if (!isPowerShellSystem(system.templateIdentifier)) {
    throw new Error(
      `Target system "${name}" is of type ${system.templateIdentifier}: only PowerShell target systems (powershell-target, powershell-onpremise) have scripts these tools run.`,
    );
  }
  const configuration = await environment.client.gatewayJson<Any>({ path: GATEWAY.powershellConfiguration(systemId), signal });
  return {
    systemId,
    name,
    templateIdentifier: system.templateIdentifier,
    api: DRYRUN_PATHS.connectorApi(system.templateIdentifier),
    variant: variantOf(system.templateIdentifier),
    configuration: isPlainObject(configuration) ? configuration : {},
    secrets: secretValuesOf(configuration),
  };
}

/** The target system a pending helloid_plan_edit plan would write (its export with the changes). */
function plannedSystem(context: AppContext, call: ToolCall<unknown, true>, planId: string, systemId: string): Any {
  const plan = context.plans.get<ImportPlanData>(planId, { environment: call.environment.name, sessionId: call.sessionId, kind: PLAN_KIND });
  const edited = plan.data.edited;
  if (!edited) throw new RefusedError(`Refused: plan '${planId}' is not a plan of helloid_plan_edit, so it has no planned scripts.`);
  if (edited.kind !== 'targetSystem' || edited.id !== systemId) {
    throw new RefusedError(`Refused: plan '${planId}' changes ${edited.kind === 'targetSystem' ? `target system '${edited.id}'` : `a ${edited.kind}`}, not target system '${systemId}'.`);
  }
  return edited.doc;
}

/** The refusal of a script the DryRun check found problems in. */
function refusal(scriptName: string, findings: DryRunFinding[]): RefusedError {
  const lines = findings.map((f) => {
    const text = f.text && !SECRET_NAME.test(f.text) ? ` [${f.text.length > 120 ? `${f.text.slice(0, 117)}...` : f.text}]` : '';
    return `  - line ${f.line}: ${f.kind}: ${f.detail}${text}`;
  });
  return new RefusedError(
    `Refused: the DryRun check found ${findings.length} problem(s) in ${scriptName}, so it is not sent to HelloID. ${DRYRUN_RULE}\n` +
      `${lines.join('\n')}\n` +
      'A static check can give false positives (helloid_check_scripts gives its limitations): then restructure the script into the standard ' +
      'guard pattern `if (-not($actionContext.DryRun -eq $true)) { <the write> }` and try again.',
  );
}

/** Refuses the script when the DryRun check finds anything. */
function requireCleanScript(script: unknown, scriptName: string, variant: ScriptVariant): string {
  const { findings } = checkDryRun(script, { variant });
  if (findings.length) throw refusal(scriptName, findings);
  return script as string;
}

const scriptInput = z
  .string()
  .optional()
  .describe('A script to run instead of the saved one (unsaved text, e.g. a draft). The DryRun check runs on it first.');
const planIdInput = z
  .string()
  .optional()
  .describe('Run the script as a pending helloid_plan_edit plan of this system would save it (same MCP session, before it is applied), instead of the saved one');
const scriptPathInput = z
  .string()
  .optional()
  .describe('With planId: the path of the script in the planned export (e.g. "configuration.scripts.accountUpdate"), when not the one the action uses');
const accountReferenceInput = z
  .unknown()
  .optional()
  .describe('The account reference to send (as the script expects it: a text or an object). Default: what HelloID\'s person preview gives (null when the person has no account in the system)');

interface ScriptSource {
  /** The configuration the script is taken from (the saved one, or the plan's). */
  configuration: Any;
  /** The whole planned export (planId), for scriptPath. */
  doc: Any | null;
  source: 'saved' | 'given' | 'plan';
}

function scriptSource(context: AppContext, call: ToolCall<{ script?: string | undefined; planId?: string | undefined; scriptPath?: string | undefined }, true>, system: LoadedSystem): ScriptSource {
  const { script, planId, scriptPath } = call.args;
  if (script !== undefined && planId) throw new Error('Give script or planId, not both.');
  if (scriptPath && !planId) throw new Error('scriptPath is for a planned script: give planId too (or the script itself in script).');
  if (planId) {
    const doc = plannedSystem(context, call, planId, system.systemId);
    return { configuration: isPlainObject(doc?.configuration) ? doc.configuration : {}, doc, source: 'plan' };
  }
  return { configuration: system.configuration, doc: null, source: script !== undefined ? 'given' : 'saved' };
}

/** The script to run: the given text, the planned script at scriptPath, or `pick` from the source's configuration. */
function chooseScript(call: ToolCall<{ script?: string | undefined; scriptPath?: string | undefined }, true>, source: ScriptSource, pick: (configuration: Any) => unknown): unknown {
  if (source.source === 'given') return call.args.script;
  if (source.doc && call.args.scriptPath) return valueAt(source.doc, call.args.scriptPath);
  return pick(source.configuration);
}

/** HelloID's person preview for a system: { person, accountReference, manager, managerAccountReference }. */
async function personPreview(call: ToolCall<unknown, true>, context: AppContext, systemId: string, personId: string): Promise<Any> {
  const answer = await call.environment.client.gatewayJson<Any>({
    path: DRYRUN_PATHS.personPreview(systemId, personId),
    query: { cachebust: cachebust(context.now) },
    signal: call.signal,
  });
  if (!isPlainObject(answer?.person)) {
    throw new Error(`HelloID gave no person data for person '${personId}' in this system: check the person ID (helloid_list_dryrun_persons).`);
  }
  return answer;
}

/** The account reference to send, and where it came from (with a note when there is none). */
function accountReferenceOf(given: unknown, preview: Any, systemId: string): { value: unknown; source: 'given' | 'helloid' | 'none'; note: string | null } {
  if (given !== undefined) return { value: given, source: 'given', note: null };
  const value = preview.accountReference ?? null;
  if (value !== null) return { value, source: 'helloid', note: null };
  const accounts = preview.person?.accounts;
  const hasData = isPlainObject(accounts) && `_${systemId.replace(/-/g, '')}` in accounts;
  return {
    value: null,
    source: 'none',
    note: hasData
      ? 'HelloID\'s person preview gave no account reference (null), although the person has account data of this system: the script ran without one. ' +
        'Give accountReference to test the action on the existing account.'
      : 'HelloID\'s person preview gave no account reference (null): the person has no known account in this system, so the script ran without one. ' +
        'Give accountReference to test an existing account.',
  };
}

const logRow = z.object({ time: z.string().nullable(), level: z.number().nullable(), message: z.string() });

const runOutput = {
  systemId: z.string(),
  systemName: z.string(),
  script: z.string().describe('Which script ran'),
  scriptSource: z.enum(['saved', 'given', 'plan']).describe('saved: the script in HelloID; given: the script of the call; plan: as the pending plan would save it'),
  person: z.object({ personId: z.string(), displayName: z.string().nullable() }).nullable(),
  success: z.boolean().nullable().describe('HelloID\'s scriptExecutionSuccessful'),
  errorMessage: z.string().nullable(),
  resultData: z.unknown().describe('What the script returned (secret-looking values masked)'),
  resultDataCount: z.number().nullable(),
  dataLimited: z.boolean().nullable().describe('HelloID returned only part of the result data'),
  logMessages: z.array(logRow).describe(`The script's log messages (at most ${MAX_LOG_MESSAGES}, each cut at ${MAX_LOG_LENGTH} characters)`),
  logMessagesTruncated: z.boolean(),
  accountReference: z
    .object({ value: z.unknown(), source: z.enum(['given', 'helloid', 'none']) })
    .nullable()
    .describe('The account reference that was sent and where it came from; null when the run sends none'),
  notes: z.array(z.string()),
};

interface RunResult {
  success: boolean | null;
  errorMessage: string | null;
  resultData: unknown;
  resultDataCount: number | null;
  dataLimited: boolean | null;
  logMessages: Array<{ time: string | null; level: number | null; message: string }>;
  logMessagesTruncated: boolean;
}

/** POSTs a dry run; HelloID's answer with secrets scrubbed (an error message too). */
async function runPreview(call: ToolCall<unknown, true>, system: LoadedSystem, path: string, body: unknown): Promise<RunResult> {
  let answer: Any;
  try {
    answer = await call.environment.client.gatewayJson<Any>({ method: 'POST', path, body, signal: call.signal });
  } catch (error) {
    throw new Error(scrubText(errorMessage(error), system.secrets));
  }
  const logs: Any[] = Array.isArray(answer?.logMessages) ? answer.logMessages : [];
  return {
    success: typeof answer?.scriptExecutionSuccessful === 'boolean' ? answer.scriptExecutionSuccessful : null,
    errorMessage: answer?.errorMessage === null || answer?.errorMessage === undefined ? null : scrubText(String(answer.errorMessage), system.secrets),
    resultData: scrub(answer?.resultData ?? null, system.secrets),
    resultDataCount: num(answer?.resultDataCount),
    dataLimited: typeof answer?.dataLimited === 'boolean' ? answer.dataLimited : null,
    logMessages: logs.slice(0, MAX_LOG_MESSAGES).map((m) => {
      const message = scrubText(String(m?.message ?? ''), system.secrets);
      return { time: str(m?.messageTimeUtc), level: num(m?.level), message: message.length > MAX_LOG_LENGTH ? `${message.slice(0, MAX_LOG_LENGTH - 3)}...` : message };
    }),
    logMessagesTruncated: logs.length > MAX_LOG_MESSAGES || logs.some((m) => String(m?.message ?? '').length > MAX_LOG_LENGTH),
  };
}

/** The details of a run as text (not in the audit: the summary is). */
function runText(result: RunResult, notes: string[]): string {
  const data = JSON.stringify(result.resultData, null, 2) ?? 'null';
  return [
    `Success: ${result.success}${result.errorMessage ? `; error: ${result.errorMessage}` : ''}`,
    `Result data${result.dataLimited ? ' (limited by HelloID)' : ''}:\n${data.length > 4000 ? `${data.slice(0, 3997)}...` : data}`,
    `Log messages (${result.logMessages.length}${result.logMessagesTruncated ? ', cut' : ''}):`,
    ...result.logMessages.map((m) => `  [${m.level ?? '?'}] ${m.time ?? ''} ${m.message}`),
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n');
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The arguments in the audit: a given script as its size and SHA-256 (never the text). */
function auditDryRun(args: Record<string, unknown>): unknown {
  const { script, ...rest } = args;
  return typeof script === 'string' ? { ...rest, script: { size: Buffer.byteLength(script, 'utf8'), sha256: sha256(script) } } : rest;
}

const runSummary = (what: string, system: LoadedSystem, person: { personId: string; displayName: string | null } | null, result: RunResult) =>
  `Dry run of ${what} of "${system.name}"${person ? ` for person "${person.displayName ?? '?'}" (${person.personId})` : ''}: ` +
  `${result.success === true ? 'the script ran successfully' : result.success === false ? 'the script FAILED (see errorMessage and the log messages)' : 'HelloID did not say whether it succeeded'}; ` +
  `${result.logMessages.length} log message(s). Nothing was changed when the script follows the dry-run rule.`;

const dryRunAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

// ---------------------------------------------------------------------------------------------
// helloid_check_scripts

const findingOutput = z.object({
  line: z.number(),
  kind: z.enum(['dryrun-override', 'unguarded-write', 'empty-script']),
  text: z.string().describe('The line of the script'),
  detail: z.string(),
});

const checkedSystemOutput = z.object({
  systemId: z.string(),
  displayName: z.string().nullable(),
  templateIdentifier: z.string().nullable(),
  checked: z.number().describe('Scripts checked (not empty)'),
  notSet: z.array(z.string()).describe('Script slots that are not set (empty, e.g. an unused updatePermissionScript): not checked and not a problem'),
  scripts: z
    .array(
      z.object({
        name: z.string(),
        path: z.string().describe('The path in the export (helloid_plan_edit\'s format)'),
        unused: z.boolean().describe('Not used by HelloID with the system\'s settings (e.g. grantPermissionScript of a set with one script for every action)'),
        findings: z.array(findingOutput),
      }),
    )
    .describe('Only the scripts with findings'),
  couldNotRead: z.string().nullable(),
});

export const checkScripts = defineTool({
  name: 'helloid_check_scripts',
  title: 'Check target system scripts for the dry-run rule',
  description:
    `Runs the static DryRun check on every PowerShell script of the target systems: account scripts, permission scripts (retrieve, grant, ` +
    `revoke, update, sub-permission, import), resource scripts and the uniqueness script. ${DRYRUN_RULE} Lists the findings per ` +
    'environment, system and script with line numbers. Empty script slots (e.g. an unused updatePermissionScript or uniqueness ' +
    'script) are listed as notSet: not a problem, not counted (only the dry-run tools refuse to run an empty script). ' +
    'dryrun-override (the script changes DryRun, or a variable that stands for it), unguarded-write (a writing call outside a dry-run ' +
    'check), plus the limitations of a static check (it can miss dynamic code and flag writes that are guarded in an unusual way). ' +
    'environments: default every logged-in one; systemId: one system. Reads the scripts only; never returns configuration values. ' +
    'Changes nothing. Works in every mode.',
  access: 'none',
  environment: false,
  input: {
    environments: z.array(z.string().min(1)).optional().describe('The environments to check (default: every logged-in one)'),
    systemId: z.string().optional().describe('Only this target system'),
  },
  output: {
    environments: z.array(z.object({ environment: z.string(), systems: z.array(checkedSystemOutput) })),
    unavailable: z.array(z.object({ environment: z.string(), reason: z.string() })).describe('Environments that could not be read'),
    findings: z.number().describe('The number of findings in all'),
    rule: z.string(),
    limitations: z.string(),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const names = call.args.environments?.length ? [...new Set(call.args.environments)] : loggedInEnvironments(context);
    if (!names.length) throw new Error('Not logged in to any environment: call helloid_login, or name the environments.');
    const unavailable: Array<{ environment: string; reason: string }> = [];
    const results: Array<{ environment: string; systems: Array<z.infer<typeof checkedSystemOutput>> }> = [];
    for (const name of names) {
      let environment: ResolvedEnvironment;
      try {
        environment = environmentWithAccess(context, name, 'read');
        const state = environment.session.state;
        if (state !== 'logged-in') {
          unavailable.push({ environment: name, reason: state === 'expired' ? 'the session has expired: helloid_login' : 'not logged in: helloid_login' });
          continue;
        }
        const client = environment.client;
        const systems = rowsOf(await client.gatewayJson({ path: GATEWAY.targetSystems, query: { showReferenceSystems: true }, signal: call.signal })).filter(
          (s) => s?.systemId && isPowerShellSystem(s.templateIdentifier) && (!call.args.systemId || s.systemId === call.args.systemId),
        );
        const checked = await inBatches(systems, async (system) => {
          const row = { systemId: String(system.systemId), displayName: str(system.displayName), templateIdentifier: str(system.templateIdentifier) };
          try {
            const [configuration, resources] = await Promise.all([
              client.gatewayJson<Any>({ path: GATEWAY.powershellConfiguration(system.systemId), signal: call.signal }),
              client.gatewayJson<Any>({ path: GATEWAY.powershellResources(system.systemId), signal: call.signal }).catch(() => null),
            ]);
            const refs = targetScripts({ configuration, resources });
            const filled = refs.filter((r) => typeof r.script === 'string' && r.script.trim());
            const variant = variantOf(system.templateIdentifier);
            const scripts = filled
              .map((r) => ({ name: r.name, path: r.path, unused: r.unused, findings: checkDryRun(r.script, { variant }).findings }))
              .filter((r) => r.findings.length);
            return { ...row, checked: filled.length, notSet: refs.filter((r) => !filled.includes(r)).map((r) => r.name), scripts, couldNotRead: null };
          } catch (error) {
            call.signal.throwIfAborted();
            return { ...row, checked: 0, notSet: [], scripts: [], couldNotRead: errorMessage(error) };
          }
        });
        results.push({ environment: name, systems: checked });
      } catch (error) {
        unavailable.push({ environment: name, reason: errorMessage(error) });
      }
    }
    if (call.args.systemId && results.length && !results.some((r) => r.systems.length)) {
      throw new NotFoundError(`There is no PowerShell target system with ID '${call.args.systemId}' in ${results.map((r) => r.environment).join(', ')}.`);
    }
    const findings = results.flatMap((r) => r.systems.flatMap((s) => s.scripts.flatMap((x) => x.findings))).length;
    const withFindings = results.flatMap((r) => r.systems.flatMap((s) => s.scripts.map((x) => `${r.environment}: "${s.displayName}" ${x.name}`)));
    const systemCount = results.reduce((n, r) => n + r.systems.length, 0);
    return {
      summary:
        `${findings} finding(s) in ${withFindings.length} script(s) of ${systemCount} PowerShell target system(s) in ${results.map((r) => r.environment).join(', ') || 'no environment'}` +
        `${unavailable.length ? `; not read: ${unavailable.map((u) => u.environment).join(', ')}` : ''}.` +
        (withFindings.length ? ` Scripts with findings: ${withFindings.slice(0, 20).join('; ')}${withFindings.length > 20 ? '; ...' : ''}.` : ''),
      structured: { environments: results, unavailable, findings, rule: DRYRUN_RULE, limitations: DRYRUN_LIMITATIONS },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// helloid_list_dryrun_persons

export const listDryRunPersons = defineTool({
  name: 'helloid_list_dryrun_persons',
  title: 'List persons for a dry run',
  description:
    'Lists the persons that can be picked for a dry run or a field mapping preview (ID and display name), with HelloID\'s own ' +
    'search and paging, as the script editors\' person picker does. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    search: z.string().default('').describe('Text to search for (empty: all persons)'),
    ...pagingInput,
  },
  output: pageOutput(z.object({ personId: z.string().nullable(), displayName: z.string().nullable() }), 'The persons'),
  annotations: readAnnotations,
  async handler(call) {
    const { offset, limit, search } = call.args;
    const answer = await call.environment.client.gatewayJson<Any>({
      path: DRYRUN_PATHS.selectionPersons,
      query: { skip: offset, take: limit, search },
      signal: call.signal,
    });
    const items = rowsOf(answer).map((p) => ({ personId: str(p?.personId), displayName: str(p?.displayName) }));
    const result: Page<(typeof items)[number]> = { total: num(answer?.totalRowCount) ?? offset + items.length, offset, limit, items };
    return { summary: pageText(result, `person(s)${search ? ` matching "${search}"` : ''}`), structured: result };
  },
});

// ---------------------------------------------------------------------------------------------
// helloid_preview_field_mapping

/** What can be changed in the field mapping of a preview: helloid_plan_edit's paths and lists of the mapping fields. */
const MAPPING_SPEC: EditSpec = {
  roots: ['configuration'],
  identity: [],
  required: [],
  lists: Object.fromEntries(Object.entries(KINDS.targetSystem.spec.lists).filter(([pattern]) => pattern.startsWith('configuration.mappingConfiguration.fields'))),
};
const MAPPING_FIELDS_PATH = 'configuration.mappingConfiguration.fields';

/** A mapping field as HelloID's script editor sends it to the preview (with the action lists it shows). */
export function previewField(field: Any): Any {
  const actions: Any[] = Array.isArray(field?.mappingActions) ? field.mappingActions : [];
  const codes = (pick: (a: Any) => boolean) => [...new Set(actions.filter(pick).flatMap((a) => (Array.isArray(a?.entitlementActions) ? a.entitlementActions : [])))];
  const labels = (pick: (a: Any) => boolean) =>
    codes(pick)
      .sort((a, b) => Number(a) - Number(b))
      .map((c) => ACCOUNT_ACTION_LABELS[Number(c)] ?? String(c))
      .join(', ');
  return {
    type: field?.type,
    mappingActions: actions.map((a) => (isPlainObject(a) && !(a as Any).mappingActionId ? { mappingActionId: randomUUID(), ...a } : a)),
    configuredForActions: codes(() => true),
    identifier: field?.identifier ?? randomUUID(),
    name: field?.name,
    description: field?.description ?? '',
    useInNotificationsForActions: labels((a) => a?.usedInNotifications === true),
    storeInAccountDataForActions: labels((a) => a?.storeInAccountData === true),
  };
}

const changesInput = z
  .object({
    set: z.array(z.object({ path: z.string().min(1), value: z.unknown(), replaceList: z.boolean().optional() })).optional(),
    unset: z.array(z.string().min(1)).optional(),
    lists: z
      .array(
        z.object({
          path: z.string().min(1),
          op: z.enum(['add', 'remove', 'change']),
          match: z.record(z.string(), z.unknown()).optional(),
          value: z.unknown().optional(),
          replaceList: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .optional()
  .describe(
    'Partial changes of the mapping in helloid_plan_edit\'s format, with paths from configuration.mappingConfiguration.fields, e.g. ' +
      '{"set": [{"path": "configuration.mappingConfiguration.fields[name=mail].mappingActions[0].value", "value": "..."}]}; applied on top of ' +
      'fields, the plan\'s mapping, or the saved one',
  );

export const previewFieldMapping = defineTool({
  name: 'helloid_preview_field_mapping',
  title: 'Preview the field mapping for a person',
  description:
    'Shows the value of every field of a PowerShell target system\'s field mapping for one person and one account action, as the ' +
    'field mapping editor\'s preview does (HelloID computes the values; no script runs and nothing is changed). By default the ' +
    'saved mapping; or fields (a whole mapping, e.g. configuration.mappingConfiguration.fields of a planned export), planId (the mapping ' +
    'a pending helloid_plan_edit plan of this system would save), and/or changes (partial changes in helloid_plan_edit\'s format). ' +
    'Per field: value, hasError, error; fields not configured for the action are listed apart. The values are the person\'s data: ' +
    'they are returned, never audited. action: 1 Create, 2 Enable, 3 Update, 4 Disable, 5 Delete (code or label). Works in every mode.',
  access: 'read',
  environment: true,
  input: {
    systemId: z.string().min(1).describe('The target system ID (helloid_list_target_systems)'),
    personId: z.string().min(1).describe('The person (helloid_list_dryrun_persons)'),
    action: codeOrLabel.describe('The account action: 1 Create, 2 Enable, 3 Update, 4 Disable, 5 Delete (code or label)'),
    fields: z.array(z.record(z.string(), z.unknown())).optional().describe('A whole field mapping to preview instead of the saved one (the fields as the export has them)'),
    planId: planIdInput,
    changes: changesInput,
  },
  output: {
    systemId: z.string(),
    systemName: z.string(),
    action: z.number(),
    actionLabel: z.string(),
    personId: z.string(),
    fieldsSource: z.enum(['saved', 'given', 'plan']),
    changed: z.boolean().describe('Partial changes were applied'),
    fields: z.array(
      z.object({ name: z.string().nullable(), identifier: z.string().nullable(), value: z.unknown(), hasError: z.boolean().nullable(), error: z.unknown() }),
    ),
    notForAction: z.array(z.string()).describe('Fields HelloID gave no value for (not configured for this action)'),
    notes: z.array(z.string()),
  },
  annotations: readAnnotations,
  auditArguments: (args) => ({ ...args, fields: Array.isArray(args.fields) ? { count: args.fields.length } : undefined }),
  async handler(call, context) {
    const { systemId, personId, planId } = call.args;
    const action = codeOf(call.args.action, ACCOUNT_ACTION_LABELS, 'action');
    if (call.args.fields && planId) throw new Error('Give fields or planId, not both.');
    const environment = call.environment;
    const systems = rowsOf(await environment.client.gatewayJson({ path: GATEWAY.targetSystems, query: { showReferenceSystems: true }, signal: call.signal }));
    const system = systems.find((s) => s?.systemId === systemId);
    if (!system) throw new NotFoundError(`Target system '${systemId}' is not in HelloID's list of target systems (helloid_list_target_systems).`);
    if (!isPowerShellSystem(system.templateIdentifier)) throw new Error(`Target system "${system.displayName}" is of type ${system.templateIdentifier}: only PowerShell target systems have this field mapping preview.`);
    const api = DRYRUN_PATHS.connectorApi(system.templateIdentifier);
    const notes: string[] = [];
    let fields: Any[];
    let fieldsSource: 'saved' | 'given' | 'plan' = 'saved';
    if (call.args.fields) {
      fields = call.args.fields;
      fieldsSource = 'given';
    } else if (planId) {
      const doc = plannedSystem(context, call, planId, systemId);
      fields = valueAt(doc, MAPPING_FIELDS_PATH) ?? [];
      fieldsSource = 'plan';
    } else {
      const mapping = await environment.client.gatewayJson<Any>({
        path: DRYRUN_PATHS.mapping(api, systemId),
        query: { cachebust: cachebust(context.now), usedInNotificationOption: true, storedInAccountDataOption: true, noOption: true },
        signal: call.signal,
      });
      fields = Array.isArray(mapping?.fields) ? mapping.fields : [];
    }
    const changes = call.args.changes as Changes | undefined;
    const changed = Boolean(changes && (changes.set?.length || changes.unset?.length || changes.lists?.length));
    if (changed) {
      const { doc } = applyChanges({ configuration: { mappingConfiguration: { fields } } }, changes!, MAPPING_SPEC);
      fields = valueAt(doc, MAPPING_FIELDS_PATH) ?? [];
    }
    const sent = fields.map(previewField);
    if (fields.some((f) => !f?.identifier)) notes.push('Fields without an identifier (new ones) got a temporary one for this preview.');
    const answer = await environment.client.gatewayJson<Any>({
      method: 'POST',
      path: DRYRUN_PATHS.mappingPreview(api, systemId),
      body: { personId, fields: sent, action },
      signal: call.signal,
    });
    const values = isPlainObject(answer) ? (answer as Any) : {};
    const rows = sent
      .filter((f: Any) => f.identifier in values)
      .map((f: Any) => {
        const v = values[f.identifier];
        return { name: str(v?.field?.name ?? f.name), identifier: str(f.identifier), value: v?.value ?? null, hasError: typeof v?.hasError === 'boolean' ? v.hasError : null, error: v?.error ?? null };
      });
    const notForAction = sent.filter((f: Any) => !(f.identifier in values)).map((f: Any) => String(f.name ?? f.identifier));
    const errors = rows.filter((r) => r.hasError).length;
    return {
      summary:
        `Field mapping preview of "${system.displayName}" (${fieldsSource} mapping${changed ? ' with changes' : ''}) for person ${personId}, action ` +
        `${ACCOUNT_ACTION_LABELS[action]}: ${rows.length} field(s) with a value, ${errors} with an error; ${notForAction.length} not configured for this action.`,
      structured: {
        systemId,
        systemName: String(system.displayName ?? systemId),
        action,
        actionLabel: ACCOUNT_ACTION_LABELS[action]!,
        personId,
        fieldsSource,
        changed,
        fields: rows,
        notForAction,
        notes,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// helloid_dryrun_account_action

export const dryRunAccountAction = defineTool({
  name: 'helloid_dryrun_account_action',
  title: 'Dry-run an account script',
  description:
    'Runs an account script of a PowerShell target system (create, enable, update, disable, delete) for one person as HelloID\'s ' +
    `script editor does (Dry run). ${RULE_TEXT} By default the saved script; script runs unsaved text instead; planId (+ scriptPath) ` +
    'runs the script as a pending helloid_plan_edit plan of this system would save it. The person is sent as HelloID\'s person preview ' +
    'gives it, with its account reference (accountReference overrides it; when HelloID has none, the output says so). Returns success, ' +
    'errorMessage, the result data (secret-looking values masked), the log messages and dataLimited. ' +
    `${DRYRUN_SECRETS_NOTE} Needs allowDryRun for the environment (any mode).`,
  access: 'dryRun',
  environment: true,
  input: {
    systemId: z.string().min(1).describe('The target system ID'),
    personId: z.string().min(1).describe('The person (helloid_list_dryrun_persons)'),
    action: codeOrLabel.describe('The account action: 1 Create, 2 Enable, 3 Update, 4 Disable, 5 Delete (code or label)'),
    script: scriptInput,
    planId: planIdInput,
    scriptPath: scriptPathInput,
    accountReference: accountReferenceInput,
  },
  output: runOutput,
  annotations: dryRunAnnotations,
  auditArguments: auditDryRun,
  async handler(call, context) {
    const action = codeOf(call.args.action, ACCOUNT_ACTION_LABELS, 'action');
    const label = ACCOUNT_ACTION_LABELS[action]!;
    const system = await loadSystem(call.environment, call.args.systemId, call.signal);
    const source = scriptSource(context, call, system);
    const key = `account${label}`;
    const scriptName = source.source === 'given' ? `the given ${key} script` : call.args.scriptPath && source.doc ? `the planned script at ${call.args.scriptPath}` : `${source.source === 'plan' ? 'the planned ' : ''}${key} script`;
    const script = requireCleanScript(chooseScript(call, source, (c) => c?.scripts?.[key]), scriptName, system.variant);
    const preview = await personPreview(call, context, system.systemId, call.args.personId);
    const reference = accountReferenceOf(call.args.accountReference, preview, system.systemId);
    const body = {
      script,
      scriptConfiguration: system.configuration.scriptConfiguration ?? {},
      executeOnPremises: system.configuration.executeOnPremises === true,
      systemId: system.systemId,
      // (recorded with operation 0 for Create, Enable and Update; Disable and Delete were not recorded)
      operation: 0,
      entitlementAction: action,
      person: preview.person,
      accountReference: reference.value,
      manager: preview.manager ?? null,
      managerAccountReference: preview.managerAccountReference ?? null,
      powerShellScriptContext: SCRIPT_CONTEXT.account,
    };
    const result = await runPreview(call, system, DRYRUN_PATHS.previewEntitlementAction(system.api), body);
    const person = { personId: call.args.personId, displayName: str(preview.person?.displayName) };
    const notes = [...(reference.note ? [reference.note] : [])];
    return {
      summary: runSummary(`${key} (${label})`, system, person, result),
      content: [{ type: 'text', text: runText(result, notes) }],
      structured: {
        systemId: system.systemId,
        systemName: system.name,
        script: key,
        scriptSource: source.source,
        person,
        ...result,
        accountReference: { value: scrub(reference.value, system.secrets), source: reference.source },
        notes,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// helloid_dryrun_permission_action

const PERMISSION_SCRIPTS: Record<number, string> = { 0: 'grantPermissionScript', 1: 'revokePermissionScript', 2: 'updatePermissionScript' };
const sameName = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The permission sets of the configuration (all, or the one named by identification or displayName). */
function permissionSets(configuration: Any, wanted: string | undefined): Any[] {
  const sets: Any[] = (Array.isArray(configuration?.permissions) ? configuration.permissions : []).filter(isPlainObject);
  if (!wanted) return sets;
  const found = sets.filter((s) => s.identification === wanted || sameName(s.displayName, wanted));
  if (!found.length) {
    throw new NotFoundError(`The system has no permission set "${wanted}". Its sets: ${sets.map((s) => `"${s.displayName}" (${s.identification})`).join(', ') || 'none'}.`);
  }
  return found;
}

export const dryRunPermissionAction = defineTool({
  name: 'helloid_dryrun_permission_action',
  title: 'Dry-run a permission script',
  description:
    'Runs a permission script of a PowerShell target system (grant, revoke or update) for one person and one permission as ' +
    `HelloID's script editor does (Dry run). ${RULE_TEXT} The permission is found by its entitlementId or display name in the ` +
    'system\'s permission sets (permissionDefinition narrows it to one set). The script is the set\'s grantPermissionScript, ' +
    'revokePermissionScript or updatePermissionScript (a set with one script for every action: its permissionActionScript); script ' +
    'runs unsaved text instead; planId (+ scriptPath) runs it as a pending helloid_plan_edit plan would save it. Sent with ' +
    'entitlementAction 0 and operation 0, as recorded for every permission dry run (the script decides what runs; to be verified). ' +
    `Returns success, errorMessage, the result data, the log messages. ${DRYRUN_SECRETS_NOTE} Needs allowDryRun for the environment (any mode).`,
  access: 'dryRun',
  environment: true,
  input: {
    systemId: z.string().min(1).describe('The target system ID'),
    personId: z.string().min(1).describe('The person (helloid_list_dryrun_persons)'),
    permission: z.string().min(1).describe('The permission: its entitlementId, or its display name'),
    permissionDefinition: z.string().optional().describe('The permission set: its identification or display name (when the permission is in several sets)'),
    action: codeOrLabel.describe('Which script: 0 Grant, 1 Revoke, 2 Update (code or label)'),
    script: scriptInput,
    planId: planIdInput,
    scriptPath: scriptPathInput,
    accountReference: accountReferenceInput,
  },
  output: {
    ...runOutput,
    permission: z.object({ displayName: z.string().nullable(), entitlementId: z.string().nullable(), permissionDefinition: z.string().nullable(), permissionDefinitionName: z.string().nullable() }),
  },
  annotations: dryRunAnnotations,
  auditArguments: auditDryRun,
  async handler(call, context) {
    const operation = codeOf(call.args.action, OPERATION_LABELS, 'action');
    const system = await loadSystem(call.environment, call.args.systemId, call.signal);
    const source = scriptSource(context, call, system);
    // The permission, in the saved permission sets (HelloID's list of each set's permissions)
    const sets = permissionSets(system.configuration, call.args.permissionDefinition);
    const matches: Array<{ set: Any; row: Any }> = [];
    const seen: string[] = [];
    for (const set of sets) {
      if (!set.identification) continue;
      const rows = rowsOf(
        await call.environment.client.gatewayJson({
          path: DRYRUN_PATHS.permissions(system.api, system.systemId, set.identification),
          query: { skip: 0, take: TAKE_ALL },
          signal: call.signal,
        }),
      );
      const byId = rows.filter((r) => r?.entitlementId === call.args.permission);
      const found = byId.length ? byId : rows.filter((r) => sameName(r?.displayName, call.args.permission));
      matches.push(...found.map((row) => ({ set, row })));
      seen.push(`"${set.displayName}": ${rows.slice(0, 20).map((r) => `"${r?.displayName}"`).join(', ')}${rows.length > 20 ? `, ... (${rows.length})` : ''}`);
    }
    if (!matches.length) throw new NotFoundError(`No permission "${call.args.permission}" in the permission sets of "${system.name}". ${seen.join('; ') || 'The system has no permission sets.'}`);
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} permissions match "${call.args.permission}": ${matches.map((m) => `"${m.row.displayName}" (${m.row.entitlementId}) in set "${m.set.displayName}"`).join(', ')}. Give the entitlementId, or permissionDefinition.`,
      );
    }
    const { set, row } = matches[0]!;
    // The script: of the set as saved, or as planned
    const scriptSet = source.source === 'plan' ? permissionSets(source.configuration, undefined).find((s) => s.identification === set.identification) : set;
    if (source.source === 'plan' && !scriptSet && !call.args.scriptPath) throw new Error(`The plan has no permission set "${set.displayName}" (${set.identification}).`);
    const separate = (scriptSet ?? set).useSeparateScriptForEachAction !== false;
    const key = separate ? PERMISSION_SCRIPTS[operation]! : 'permissionActionScript';
    const notes: string[] = [];
    if (!separate) notes.push(`The set "${set.displayName}" uses one script for every action: permissionActionScript ran (the action does not choose the script).`);
    const scriptName = source.source === 'given' ? 'the given script' : call.args.scriptPath && source.doc ? `the planned script at ${call.args.scriptPath}` : `${source.source === 'plan' ? 'the planned ' : ''}${key} of permission set "${set.displayName}"`;
    const script = requireCleanScript(chooseScript(call, source, () => scriptSet?.[key]), scriptName, system.variant);
    const preview = await personPreview(call, context, system.systemId, call.args.personId);
    const reference = accountReferenceOf(call.args.accountReference, preview, system.systemId);
    if (reference.note) notes.push(reference.note);
    const body = {
      script,
      scriptConfiguration: system.configuration.scriptConfiguration ?? {},
      executeOnPremises: system.configuration.executeOnPremises === true,
      permissionDefinitionIdentifier: set.identification,
      permission: { displayName: row.displayName ?? null, entitlementId: row.entitlementId ?? null, reference: row.reference ?? null },
      systemId: system.systemId,
      // (recorded: 0 and 0 for every permission dry run; the script decides what runs)
      operation: 0,
      hasSubPermissions: set.hasSubPermissions === true,
      entitlementAction: 0,
      person: preview.person,
      accountReference: reference.value,
      manager: preview.manager ?? null,
      managerAccountReference: preview.managerAccountReference ?? null,
      powerShellScriptContext: SCRIPT_CONTEXT.permission,
    };
    const result = await runPreview(call, system, DRYRUN_PATHS.previewEntitlementAction(system.api), body);
    const person = { personId: call.args.personId, displayName: str(preview.person?.displayName) };
    return {
      summary: runSummary(`${key} (${OPERATION_LABELS[operation]}) of permission "${row.displayName}"`, system, person, result),
      content: [{ type: 'text', text: runText(result, notes) }],
      structured: {
        systemId: system.systemId,
        systemName: system.name,
        script: key,
        scriptSource: source.source,
        person,
        ...result,
        accountReference: { value: scrub(reference.value, system.secrets), source: reference.source },
        notes,
        permission: { displayName: str(row.displayName), entitlementId: str(row.entitlementId), permissionDefinition: str(set.identification), permissionDefinitionName: str(set.displayName) },
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// helloid_dryrun_permission_import

export const dryRunPermissionImport = defineTool({
  name: 'helloid_dryrun_permission_import',
  title: 'Dry-run an import permissions script',
  description:
    'Runs the import permissions script of a permission set of a PowerShell target system as HelloID\'s script editor does (Dry run), ' +
    `and lists the permissions it finds (display name and permission reference), in pages. ${RULE_TEXT} permissionDefinition: the set ` +
    '(identification or display name), needed when several sets have an import script. script runs unsaved text instead; planId ' +
    '(+ scriptPath) runs it as a pending helloid_plan_edit plan would save it. HelloID returns only part of a long list (dataLimited, ' +
    `with resultDataCount the number found). No person is needed. ${DRYRUN_SECRETS_NOTE} Needs allowDryRun for the environment (any mode).`,
  access: 'dryRun',
  environment: true,
  input: {
    systemId: z.string().min(1).describe('The target system ID'),
    permissionDefinition: z.string().optional().describe('The permission set whose import script runs: its identification or display name'),
    script: scriptInput,
    planId: planIdInput,
    scriptPath: scriptPathInput,
    ...pagingInput,
  },
  output: {
    ...runOutput,
    permissionDefinition: z.string().nullable(),
    permissionDefinitionName: z.string().nullable(),
    permissions: z
      .object(pageOutput(z.object({ displayName: z.string().nullable(), permissionReference: z.unknown() }), 'The permissions the script found (as HelloID returned them)'))
      .describe('The permissions, in pages'),
  },
  annotations: dryRunAnnotations,
  auditArguments: auditDryRun,
  async handler(call, context) {
    const system = await loadSystem(call.environment, call.args.systemId, call.signal);
    const source = scriptSource(context, call, system);
    let set: Any = null;
    if (source.source !== 'given' || call.args.permissionDefinition) {
      const sets = permissionSets(source.configuration, call.args.permissionDefinition);
      const withScript = call.args.permissionDefinition ? sets : sets.filter((s) => typeof s.permissionImportScript === 'string' && s.permissionImportScript.trim());
      if (!withScript.length && !call.args.scriptPath) throw new Error(`No permission set of "${system.name}" has an import permissions script (permissionImportScript).`);
      if (withScript.length > 1) {
        throw new Error(`Several permission sets have an import script: ${withScript.map((s) => `"${s.displayName}" (${s.identification})`).join(', ')}. Give permissionDefinition.`);
      }
      set = withScript[0] ?? null;
    }
    const scriptName = source.source === 'given' ? 'the given script' : call.args.scriptPath && source.doc ? `the planned script at ${call.args.scriptPath}` : `${source.source === 'plan' ? 'the planned ' : ''}permissionImportScript of permission set "${set?.displayName}"`;
    const script = requireCleanScript(chooseScript(call, source, () => set?.permissionImportScript), scriptName, system.variant);
    const body = { script, systemId: system.systemId, executeOnPremises: system.configuration.executeOnPremises === true };
    const result = await runPreview(call, system, DRYRUN_PATHS.previewPermissionImport(system.api), body);
    const rows = (Array.isArray(result.resultData) ? result.resultData : []).map((r: Any) => ({ displayName: str(r?.displayName), permissionReference: r?.permissionReference ?? null }));
    const { offset, limit } = call.args;
    const permissions = { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
    const notes = result.dataLimited ? [`HelloID returned ${rows.length} of the ${result.resultDataCount ?? '?'} permissions the script found (dataLimited).`] : [];
    return {
      summary:
        runSummary(`permissionImportScript${set ? ` of permission set "${set.displayName}"` : ''}`, system, null, result) +
        ` ${pageText(permissions, 'permission(s) returned')}${result.dataLimited ? ` HelloID found ${result.resultDataCount ?? '?'} in all (dataLimited).` : ''}`,
      content: [{ type: 'text', text: runText({ ...result, resultData: permissions.items }, notes) }],
      structured: {
        systemId: system.systemId,
        systemName: system.name,
        script: 'permissionImportScript',
        scriptSource: source.source,
        person: null,
        ...result,
        resultData: null,
        accountReference: null,
        notes,
        permissionDefinition: str(set?.identification),
        permissionDefinitionName: str(set?.displayName),
        permissions,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// helloid_dryrun_uniqueness

export const dryRunUniqueness = defineTool({
  name: 'helloid_dryrun_uniqueness',
  title: 'Dry-run the uniqueness check',
  description:
    'Runs the uniqueness script of a PowerShell target system for one person as HelloID\'s uniqueness check editor does (for a ' +
    `Create), and returns whether the values are unique (Success, NonUniqueFields, Iteration) and the log messages. ${RULE_TEXT} ` +
    'By default the saved uniqueness script; script runs unsaved text instead; planId (+ scriptPath) runs it as a pending ' +
    `helloid_plan_edit plan would save it. ${DRYRUN_SECRETS_NOTE} Needs allowDryRun for the environment (any mode).`,
  access: 'dryRun',
  environment: true,
  input: {
    systemId: z.string().min(1).describe('The target system ID'),
    personId: z.string().min(1).describe('The person (helloid_list_dryrun_persons)'),
    script: scriptInput,
    planId: planIdInput,
    scriptPath: scriptPathInput,
    accountReference: accountReferenceInput,
  },
  output: runOutput,
  annotations: dryRunAnnotations,
  auditArguments: auditDryRun,
  async handler(call, context) {
    const system = await loadSystem(call.environment, call.args.systemId, call.signal);
    const source = scriptSource(context, call, system);
    let saved: unknown;
    if (source.source === 'saved') {
      const uniqueness = await call.environment.client.gatewayJson<Any>({ path: DRYRUN_PATHS.uniqueness(system.api, system.systemId), signal: call.signal });
      saved = uniqueness?.script ?? null;
    }
    const scriptName = source.source === 'given' ? 'the given uniqueness script' : call.args.scriptPath && source.doc ? `the planned script at ${call.args.scriptPath}` : `${source.source === 'plan' ? 'the planned ' : 'the '}uniqueness script`;
    const script = requireCleanScript(
      chooseScript(call, source, (c) => (source.source === 'saved' ? saved : c?.mappingConfiguration?.uniquenessConfiguration?.script)),
      scriptName,
      system.variant,
    );
    const preview = await personPreview(call, context, system.systemId, call.args.personId);
    const reference = accountReferenceOf(call.args.accountReference, preview, system.systemId);
    const person = { personId: call.args.personId, displayName: str(preview.person?.displayName) };
    const body = {
      script,
      selectedPerson: { personId: call.args.personId, displayName: person.displayName },
      person: preview.person,
      accountReference: reference.value,
      manager: preview.manager ?? null,
      managerAccountReference: preview.managerAccountReference ?? null,
      entitlementAction: 'Create',
      systemId: system.systemId,
      powerShellScriptContext: SCRIPT_CONTEXT.uniqueness,
    };
    const result = await runPreview(call, system, DRYRUN_PATHS.previewUniquenessCheck(system.api), body);
    const data = isPlainObject(result.resultData) ? (result.resultData as Any) : {};
    const notes: string[] = [];
    const unique = data.Success === true ? 'unique' : data.Success === false ? `NOT unique (${Array.isArray(data.NonUniqueFields) ? data.NonUniqueFields.join(', ') : '?'})` : 'no answer';
    return {
      summary: `${runSummary('the uniqueness script', system, person, result)} Uniqueness: ${unique}.`,
      content: [{ type: 'text', text: runText(result, notes) }],
      structured: {
        systemId: system.systemId,
        systemName: system.name,
        script: 'uniqueness',
        scriptSource: source.source,
        person,
        ...result,
        accountReference: { value: scrub(reference.value, system.secrets), source: reference.source },
        notes,
      },
    };
  },
});

export const dryRunTools: ToolGroup = [
  checkScripts,
  listDryRunPersons,
  previewFieldMapping,
  dryRunAccountAction,
  dryRunPermissionAction,
  dryRunPermissionImport,
  dryRunUniqueness,
];
