// helloid_plan_import and helloid_apply_plan: the userscript's "Import HelloID export files…" with
// "Overwrite all", in two steps. The plan reads and compares everything (nothing is written) and
// keeps the overview's entries, with what each entry runs, in the plan store; apply runs them, in
// the userscript's order, after checking that HelloID did not change since the plan.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuditChange } from '../audit.ts';
import { changedScriptFindings, isPowerShellSystem, scriptWarningLines, variantOf } from '../changes/dryrun-check.ts';
import { localTimeZone } from '../helloid/exports.ts';
import { errorMessage } from '../log.ts';
import {
  type Answers,
  clientGateway,
  type CreatedItem,
  type Decision,
  fetchSystems,
  type ImportFile,
  KIND_LABELS,
  makeEnv,
  type OverviewEntry,
  type PlannerEnv,
  sameJson,
  sameText,
  type Touch,
} from '../planners/common.ts';
import { classifyFiles, type InputFile, OVERVIEW_INTRO, overviewText, planImport, runImport, toDo } from '../planners/index.ts';
import { CONNECTOR_EXPORTS } from '../planners/target-systems.ts';
import { fingerprint } from '../safety.ts';
import type { AppContext } from './context.ts';
import { defineTool, type ResolvedEnvironment, type ToolGroup } from './helpers.ts';

export const PLAN_KIND = 'import';

/** What an import plan keeps for its apply (also made by helloid_plan_edit and helloid_plan_copy). */
export interface ImportPlanData {
  env: PlannerEnv;
  /** The signal of the call that runs the plan (read by every request). */
  holder: { signal: AbortSignal | undefined };
  entries: OverviewEntry[];
  /**
   * helloid_plan_edit: the item as the plan will write it (its export with the changes, secrets
   * masked), so the dry-run tools can run a planned script before it is applied.
   */
  edited?: { kind: string; id: string | null; doc: unknown };
}

/** A PlannerEnv on an environment's client; the signal comes from the holder. */
export function plannerEnv(environment: ResolvedEnvironment, context: AppContext, holder: { signal: AbortSignal | undefined }, overrides: Partial<PlannerEnv> = {}) {
  return makeEnv(clientGateway(environment.client, () => holder.signal), environment.config.baseUrl, localTimeZone(), { now: context.now, ...overrides });
}

const createdOutput = z.object({
  kind: z.string().describe('targetSystem, sourceSystem, notificationSystem, notification, businessRule, toxicPolicy, customEvent or schedule'),
  id: z.string().describe('The ID of the new item'),
  name: z.string().nullable(),
});

export const entryOutput = z.object({
  group: z.string().describe('The type, as the overview groups them'),
  label: z.string().describe('The item, with (new), (overwrite) or (replaces ...)'),
  status: z
    .string()
    .describe(
      'Plan: todo (will be done), note (will be done, with a note), same (already as in the file), skip (will not be done: refused, with the reason). ' +
        'Apply: done, note (done, with a note), failed; entries that were not run keep their planned status.',
    ),
  details: z.array(z.string()).describe('The changes, notes and reasons, as the userscript\'s overview shows them'),
  needs: z.array(z.string()).describe('Items made earlier in this run that this one is linked to after they are made'),
  createdId: z
    .string()
    .nullable()
    .describe('Apply: the ID of the item this entry made (the first item it made); null when it made nothing new, and always null in a plan'),
  created: z
    .array(createdOutput)
    .describe('Apply: every item this entry made, with its new ID (e.g. a new target system and its new notifications); [] in a plan'),
  warnings: z
    .array(z.string())
    .describe("Warnings of the server's own checks (not the userscript's), e.g. the DryRun check of the scripts a target system gets; they do not stop the plan"),
});

export const entryRow = (e: OverviewEntry) => ({
  group: e.group,
  label: e.label,
  status: e.status,
  details: e.details,
  needs: e.needs ?? [],
  createdId: e.created?.[0]?.id ?? null,
  created: e.created ?? [],
  warnings: e.warnings ?? [],
});

export const choiceOutput = z.object({
  key: z.string().describe('The key to use in answers'),
  section: z.string(),
  item: z.string(),
  detail: z.string().nullable(),
  options: z.array(z.object({ value: z.unknown(), label: z.string(), description: z.string().nullable() })),
  default: z.unknown(),
});

export const choiceRow = (d: Decision) => ({
  key: d.key,
  section: d.section,
  item: d.item,
  detail: d.detail ?? null,
  options: d.options.map((o) => ({ value: o.value, label: o.label, description: o.description ?? null })),
  default: d.default,
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A file's content in the audit: its size and SHA-256, never the content itself. */
function auditFiles(args: Record<string, unknown>): unknown {
  const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
  return {
    ...args,
    files: files.map((file) => {
      const text = typeof file?.content === 'string' ? file.content : JSON.stringify(file?.content ?? null);
      return { name: file?.name ?? null, size: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) };
    }),
  };
}

/** Reads what entries touch, once per key. */
export async function readTouches(env: PlannerEnv, touches: Touch[]): Promise<Record<string, unknown>> {
  const items: Record<string, unknown> = {};
  for (const touch of touches) {
    if (touch.key in items) continue;
    items[touch.key] = await touch.read(env);
  }
  return items;
}

export const touchesOf = (entries: OverviewEntry[]) => toDo(entries).flatMap((e) => e.touches ?? []);

type Any = any;

/**
 * The DryRun check of the PowerShell scripts that planned target systems get: the scripts of the file
 * that are new or differ from the system's in HelloID (every script for a new system). Findings go
 * into the entry's warnings (never a refusal). Returns the lines for the overview.
 */
async function addScriptWarnings(env: PlannerEnv, files: ImportFile[], entries: OverviewEntry[]): Promise<string[]> {
  const lines: string[] = [];
  const targets = files.filter((f) => f.kind === 'targetSystem' && isPowerShellSystem(f.data?.templateIdentifier));
  let systems: Any[] | undefined;
  for (const file of targets) {
    const name = file.data.displayName ?? file.data.configuration?.displayName ?? '?';
    const entry = entries.find((e) => e.group === KIND_LABELS.targetSystem && e.provides === name && ['todo', 'note'].includes(e.status));
    if (!entry) continue;
    const warnings: string[] = [];
    let current: Any = null;
    try {
      systems ??= await fetchSystems(env);
      const system = systems.find((s) => file.data.systemId && s.systemId === file.data.systemId) ?? systems.find((s) => sameText(s.displayName, String(name)));
      if (system) {
        const paths = CONNECTOR_EXPORTS[system.templateIdentifier]?.(encodeURIComponent(system.systemId));
        current = {
          configuration: paths ? await env.gw.fetch(paths.configuration) : system,
          resources: paths?.resources ? await env.gw.fetch(paths.resources).catch(() => null) : null,
        };
      }
    } catch (error) {
      warnings.push(`DryRun check: the scripts the system has now could not be read (${errorMessage(error)}); every script of the file was checked.`);
      current = null;
    }
    const found = changedScriptFindings(current, { configuration: file.data.configuration, resources: file.data.resources }, variantOf(file.data.templateIdentifier));
    for (const warning of found) warnings.push(...scriptWarningLines(warning));
    if (!warnings.length) continue;
    entry.warnings = [...(entry.warnings ?? []), ...warnings];
    lines.push(`${entry.label}:`, ...warnings.map((w) => `  - ${w}`));
  }
  return lines;
}

/** The outcome of planning files into an environment (helloid_plan_import, helloid_plan_edit, helloid_plan_copy). */
export interface ImportPlanOutcome {
  planId: string | null;
  expiresAt: string | null;
  entries: ReturnType<typeof entryRow>[];
  choices: ReturnType<typeof choiceRow>[];
  overview: string;
  /** The number of entries that will be run. */
  toDo: number;
  /** The special cases without an answer (then no plan). */
  open: Decision[];
}

/**
 * Plans files into an environment with the import's planners, checks the answers, and stores the
 * plan (kind "import", applied by helloid_apply_plan) when nothing is open and there is something
 * to do. Nothing is written.
 */
export async function planFilesInto(options: {
  environment: ResolvedEnvironment;
  sessionId: string | undefined;
  context: AppContext;
  env: PlannerEnv;
  holder: { signal: AbortSignal | undefined };
  files: ImportFile[];
  kinds: string[];
  answers: Answers;
  /** Text after the overview (e.g. the files that were skipped). */
  closing?: string;
  intro?: string;
  /** The DryRun check of the scripts of planned target systems (default true; helloid_plan_edit checks per change). */
  checkScripts?: boolean;
  /** helloid_plan_edit: the changed item, kept with the plan for the dry-run tools. */
  edited?: ImportPlanData['edited'];
}): Promise<ImportPlanOutcome> {
  const { environment, context, env, holder, answers } = options;
  const { entries, decisions } = await planImport(env, { files: options.files, kinds: options.kinds }, answers);
  const scriptLines = options.checkScripts === false ? [] : await addScriptWarnings(env, options.files, entries);
  // An answer must be one of its options
  for (const decision of decisions) {
    if (!(decision.key in answers)) continue;
    if (!decision.options.some((o) => sameJson(o.value, answers[decision.key]))) {
      throw new Error(
        `The answer for "${decision.key}" is ${JSON.stringify(answers[decision.key])}, which is not one of its options: ` +
          decision.options.map((o) => JSON.stringify(o.value)).join(', '),
      );
    }
  }
  const open = decisions.filter((d, i) => !(d.key in answers) && decisions.findIndex((o) => o.key === d.key) === i);
  const overview =
    overviewText(options.intro ?? OVERVIEW_INTRO, entries) +
    (scriptLines.length ? `\n\nDryRun check of the planned scripts (warnings only, the plan is not refused):\n${scriptLines.join('\n')}` : '') +
    (options.closing ?? '');
  const base = { entries: entries.map(entryRow), choices: open.map(choiceRow), overview, toDo: toDo(entries).length, open };
  if (open.length || !toDo(entries).length) return { planId: null, expiresAt: null, ...base };
  const items = await readTouches(env, touchesOf(entries));
  holder.signal = undefined;
  const plan = context.plans.create<ImportPlanData>({
    environment: environment.name,
    sessionId: options.sessionId,
    kind: PLAN_KIND,
    items,
    data: { env, holder, entries, ...(options.edited ? { edited: options.edited } : {}) },
  });
  return { planId: plan.id, expiresAt: new Date(plan.expiresAt).toISOString(), ...base };
}

export const planImportTool = defineTool({
  name: 'helloid_plan_import',
  title: 'Plan an import',
  description:
    'Plans the import of export files (the userscript\'s export formats: single exports of target systems, source systems, ' +
    'notification systems, notifications, business rules, toxic policies, custom events, schedules and the settings pages, ' +
    'partial target system files, and the full "Export everything" backup) as the userscript\'s "Overwrite all" does: ' +
    'what matches (by ID, else by name) is overwritten, the rest is made new (disabled where it can be switched on; ' +
    'business rules as drafts). Reads and compares only: nothing is written. Returns the overview (per item: todo, note, ' +
    'same or skip, with the changes, notes and reasons) and a plan ID for helloid_apply_plan (valid 30 minutes, this MCP ' +
    'session only). When the import has special cases that need a choice and answers does not have them all, it returns ' +
    'those choices (key, options, default) and no plan ID: ask the user, or pass the defaults explicitly, and plan again. ' +
    'Needs mode "plan" or "write".',
  access: 'plan',
  environment: true,
  input: {
    files: z
      .array(
        z.object({
          name: z.string().optional().describe('The file name (for messages)'),
          content: z.unknown().describe('The export file: its JSON, or its text'),
        }),
      )
      .min(1)
      .describe('The export files to import. A backup file is split into its parts.'),
    answers: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('The choices of the special cases, by key (from an earlier answer of this tool): the value of one of its options.'),
  },
  output: {
    planId: z.string().nullable().describe('The plan for helloid_apply_plan; null when choices are open or there is nothing to do'),
    expiresAt: z.string().nullable(),
    entries: z.array(entryOutput),
    choices: z.array(choiceOutput).describe('Special cases without an answer (then planId is null; the entries use the defaults)'),
    skipped: z.array(z.string()).describe('Files (or parts of a backup) that are not imported, with the reason'),
    overview: z.string().describe('The overview as text, as the userscript shows it'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  auditArguments: auditFiles,
  async handler(call, context) {
    const holder = { signal: call.signal as AbortSignal | undefined };
    const env = plannerEnv(call.environment, context, holder);
    const input: InputFile[] = call.args.files.map((f, i) => ({ name: f.name ?? `file ${i + 1}`, content: f.content }));
    const { files, skipped, kinds } = classifyFiles(input, env);
    if (!files.length) {
      const overview = 'Nothing to import.' + (skipped.length ? `\n\nSkipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}` : '');
      return {
        summary: `Nothing to import (${skipped.length} file(s) skipped).`,
        structured: { planId: null, expiresAt: null, entries: [], choices: [], skipped, overview },
        content: [{ type: 'text', text: overview }],
      };
    }
    const answers: Answers = call.args.answers ?? {};
    await call.progress(0, 'reading what is here (nothing is changed)');
    const skippedText = skipped.length ? `\n\nSkipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}` : '';
    const outcome = await planFilesInto({
      environment: call.environment,
      sessionId: call.sessionId,
      context,
      env,
      holder,
      files,
      kinds,
      answers,
      closing: skippedText,
    });
    const structured = {
      planId: outcome.planId,
      expiresAt: outcome.expiresAt,
      entries: outcome.entries,
      choices: outcome.choices,
      skipped,
      overview: outcome.overview,
    };
    // (the summary is short, as it goes to the audit log; the overview follows it)
    const content = [{ type: 'text' as const, text: outcome.overview }];
    if (outcome.open.length) {
      return {
        summary:
          `${outcome.open.length} special case(s) need a choice before the plan (see choices; the overview uses their defaults). ` +
          'Ask the user, or pass the defaults explicitly in answers, and plan again.',
        structured,
        content,
      };
    }
    if (!outcome.planId) {
      return { summary: 'Nothing to do: everything is already as in the files, or will not be done.', structured, content };
    }
    return {
      summary: `Plan ${outcome.planId} (valid 30 minutes): ${outcome.toDo} item(s) to do. Run it with helloid_apply_plan.`,
      structured,
      content,
    };
  },
});

export const applyPlanTool = defineTool({
  name: 'helloid_apply_plan',
  title: 'Apply an import plan',
  description:
    'Runs a plan of helloid_plan_import: WRITES to HelloID. First reads the items the plan touches again and refuses when ' +
    'any changed since the plan ("plan again"). Then runs the items in the userscript\'s order; a failure does not stop ' +
    'the others, but what needs an item that failed is not done. A plan runs at most once, only in the MCP session that ' +
    'made it, within 30 minutes. Returns per item what was done. Every changed item is written to the audit log as it ' +
    'was before and after (secrets masked). Needs mode "write".',
  access: 'write',
  environment: true,
  input: { planId: z.string().min(1).describe('The plan ID from helloid_plan_import') },
  output: {
    entries: z.array(entryOutput),
    done: z.number(),
    failed: z.number(),
    overview: z.string().describe('The overview after the run, as the userscript shows it'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const environment = call.environment;
    return context.locks.run(environment.name, async () => {
      const plan = context.plans.get<ImportPlanData>(call.args.planId, { environment: environment.name, sessionId: call.sessionId, kind: PLAN_KIND });
      const { env, holder, entries } = plan.data;
      holder.signal = call.signal;
      try {
        context.plans.verify(plan, await readTouches(env, touchesOf(entries)));
        context.plans.markApplied(plan);
        const result = await runImport(entries, async (entry, run) => {
          // (the items the entry makes, with their new IDs)
          const created: CreatedItem[] = [];
          env.onCreated = (item) => created.push(item);
          const keepCreated = () => {
            if (created.length) entry.created = created;
          };
          const touches = entry.touches ?? [];
          const before = await Promise.all(touches.map((t) => t.read(env).catch(() => undefined)));
          const record = async () => {
            const changes: AuditChange[] = [];
            for (const [i, t] of touches.entries()) {
              const after = await t.read(env).catch(() => undefined);
              if (fingerprint(before[i]) === fingerprint(after)) continue;
              const mask = t.mask ?? ((value: unknown) => value);
              changes.push({ item: t.label, before: before[i] === undefined ? null : mask(before[i]), after: after === undefined ? null : mask(after) });
            }
            call.recordChanges(changes);
          };
          try {
            const notes = await run();
            keepCreated();
            await record();
            return notes;
          } catch (e) {
            keepCreated();
            await record();
            throw e;
          }
        });
        env.onCreated = undefined;
        // The new IDs on the entries' lines and in the summary, so they can be used right away
        const made = entries.flatMap((e) => e.created ?? []);
        for (const entry of entries) {
          for (const item of entry.created ?? []) entry.details.push(`new ${item.kind}${item.name ? ` "${item.name}"` : ''}: ID ${item.id}`);
        }
        const madeText = made.length ? ` New IDs: ${made.map((m) => `${m.kind} ${m.name ? `"${m.name}" ` : ''}${m.id}`).join(', ')}.` : '';
        const overview = overviewText(OVERVIEW_INTRO, entries, result.finish);
        return {
          summary: result.finish.split('\n')[0]! + madeText,
          content: [{ type: 'text', text: overview }],
          structured: { entries: entries.map(entryRow), done: result.done, failed: result.failed, overview },
        };
      } finally {
        holder.signal = undefined;
        env.onCreated = undefined;
      }
    });
  },
});

export const importTools: ToolGroup = [planImportTool, applyPlanTool];
