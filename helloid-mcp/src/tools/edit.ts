// helloid_plan_edit and helloid_plan_copy: plans that helloid_apply_plan runs, made with the import's
// planners (as helloid_plan_import), entirely inside the server.
// - edit: one item exported (secrets masked), the requested partial changes applied to that export,
//   and the result planned as an import of just that item into the same environment
// - copy: items exported from one environment and planned as an import into another

import { z } from 'zod';
import { applyChanges, type ChangeDetail, type Changes } from '../changes/edit.ts';
import { isText, preview, textDiff } from '../changes/diff.ts';
import { changedScriptFindings, DRYRUN_RULE, isPowerShellSystem, scriptWarningLines, variantOf } from '../changes/dryrun-check.ts';
import { canonicalKind, type CanonicalKind, ITEM_KINDS, type ItemKind, ItemReader, KINDS } from '../changes/kinds.ts';
import { formatPath, parsePath, resolvePath } from '../changes/paths.ts';
import { classifyFiles, type InputFile } from '../planners/index.ts';
import { isPlainObject, SECRET_MASK, SECRET_NAME } from '../safety.ts';
import { maskForAudit } from '../audit.ts';
import {
  defineTool,
  environmentWithAccess,
  exporterForEnvironment,
  type ResolvedEnvironment,
  type ToolGroup,
} from './helpers.ts';
import { choiceOutput, entryOutput, planFilesInto, plannerEnv } from './import.ts';

type Any = any;

const kindInput = z
  .enum(ITEM_KINDS)
  .describe(
    'The kind of item: targetSystem, sourceSystem, notificationSystem, notification, customEvent, businessRule, toxicCombination ' +
      '(or toxicPolicy), schedule, or a settings page: sourceConfiguration, aggregationConfiguration, personLifecycle, excludedPersons, ' +
      'reconciliationConfiguration (no id or name)',
  );

const answersInput = z
  .record(z.string(), z.unknown())
  .default({})
  .describe('The choices of the special cases, by key (as helloid_plan_import): the value of one of its options.');

const planOutputBase = {
  planId: z.string().nullable().describe('The plan for helloid_apply_plan (in the target environment); null when choices are open or there is nothing to do'),
  expiresAt: z.string().nullable(),
  entries: z.array(entryOutput).describe('The import planner\'s overview entries'),
  choices: z.array(choiceOutput).describe('Special cases without an answer (then planId is null)'),
  overview: z.string(),
  notes: z.array(z.string()),
};

// ---------------------------------------------------------------------------------------------
// Edit

const textChangeOutput = z.object({
  linesBefore: z.number(),
  linesAfter: z.number(),
  added: z.number(),
  removed: z.number(),
  diff: z.string().describe('A unified diff, cut'),
  truncated: z.boolean(),
});

const changeOutput = z.object({
  change: z.string().describe('set, unset, add, remove or change'),
  path: z.string().describe('The path as given'),
  target: z.string().describe('The path of the value that changed, with list items as [key=value]'),
  newProperty: z.boolean().describe('A set that adds a property the export did not have: check its name'),
  before: z.string().nullable().describe('A preview of the old value (secrets masked)'),
  after: z.string().nullable().describe('A preview of the new value (secrets masked)'),
  text: textChangeOutput.nullable().describe('For texts (scripts): line counts and a unified diff'),
  warnings: z.array(z.string()),
});

const lastKeyOf = (path: string) => {
  try {
    const segments = parsePath(path);
    const last = segments[segments.length - 1];
    return last && 'key' in last ? last.key : undefined;
  } catch {
    return undefined;
  }
};

/** A change as the plan shows it: previews (secrets masked), and a diff for texts. */
function changeRow(detail: ChangeDetail) {
  const key = lastKeyOf(detail.target);
  const secret = key !== undefined && SECRET_NAME.test(key);
  const show = (value: unknown) => (value === null && detail.change !== 'set' ? null : secret && value !== '' && value !== null ? JSON.stringify(SECRET_MASK) : preview(value, key));
  const text =
    !secret && (isText(detail.before) || isText(detail.after)) && (typeof detail.before === 'string' || detail.before === null) && (typeof detail.after === 'string' || detail.after === null)
      ? textDiff(detail.before as string | null, detail.after as string | null)
      : null;
  return {
    change: detail.change,
    path: detail.path,
    target: detail.target,
    newProperty: detail.newProperty,
    before: detail.change === 'add' ? null : show(detail.before),
    after: detail.change === 'remove' || detail.change === 'unset' ? null : show(detail.after),
    text,
    warnings: detail.warnings,
  };
}

/**
 * The DryRun check of the scripts a target system edit sets or changes: the findings go into the
 * warnings of the change that made the script (the most specific one whose path holds it). Returns
 * the warnings no change could be found for (they go into the notes).
 */
function addScriptWarnings(before: Any, after: Any, details: ChangeDetail[]): string[] {
  if (!isPowerShellSystem(after?.templateIdentifier)) return [];
  const concreteOf = (target: string) => {
    try {
      return formatPath(resolvePath(after, target).concrete);
    } catch {
      return null;
    }
  };
  const targets = details.map((d) => concreteOf(d.target));
  const left: string[] = [];
  for (const warning of changedScriptFindings(before, after, variantOf(after.templateIdentifier))) {
    const lines = scriptWarningLines(warning);
    const path = warning.ref.concrete;
    let best = -1;
    targets.forEach((c, n) => {
      if (c === null || !(path === c || path.startsWith(`${c}.`) || path.startsWith(`${c}[`))) return;
      if (best < 0 || c.length > targets[best]!.length) best = n;
    });
    if (best >= 0) details[best]!.warnings.push(...lines);
    else left.push(...lines);
  }
  return left;
}

/** The values of the changes in the audit: masked where the path says it is a secret (and large ones hashed). */
function auditEdit(args: Record<string, unknown>): unknown {
  const changes = (isPlainObject(args.changes) ? args.changes : {}) as Any;
  const maskValue = (path: unknown, value: unknown) => {
    const key = typeof path === 'string' ? lastKeyOf(path) : undefined;
    return key !== undefined && SECRET_NAME.test(key) ? (value === '' || value === null ? value : SECRET_MASK) : maskForAudit(value);
  };
  return {
    ...args,
    changes: {
      ...changes,
      ...(Array.isArray(changes.set) ? { set: changes.set.map((s: Any) => ({ ...s, value: maskValue(s?.path, s?.value) })) } : {}),
      ...(Array.isArray(changes.lists) ? { lists: changes.lists.map((l: Any) => ({ ...l, value: maskForAudit(l?.value) })) } : {}),
    },
  };
}

const setInput = z.object({
  path: z.string().min(1).describe('The path in the export format of the helloid_get_* tools, e.g. "configuration.scripts.accountCreate", "policy.enabled", "configuration.mappingConfiguration.fields[name=mail].description"'),
  value: z.unknown().describe('The new value (JSON)'),
  replaceList: z.boolean().optional().describe('Needed to replace a whole list (or a value with lists in it) with a set; without it that is refused'),
});

const listInput = z.object({
  path: z.string().min(1).describe('The path of the list, e.g. "rule.entitlements", "configuration.mappingConfiguration.fields"'),
  op: z.enum(['add', 'remove', 'change']).describe('add: a new item at the end (refused when match finds one); remove / change: the one item match finds (refused when none or several)'),
  match: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The item: every key given must have that value, e.g. {"name": "mail"}, {"entitlementId": "..."}; {"$value": "x"} for lists of texts. For add, made from the new item when left out'),
  value: z.unknown().optional().describe('add: the new item; change: the keys to change (an object item keeps its other keys; a text item is replaced)'),
  replaceList: z.boolean().optional().describe('change: needed when value replaces a list inside the item'),
});

export const planEdit = defineTool({
  name: 'helloid_plan_edit',
  title: 'Plan a partial change of one item',
  description:
    'Plans a partial change of one item: a target system, source system, notification system, notification, custom event, business ' +
    'rule, toxic combination, schedule or a settings page. The server exports the item (as the helloid_get_* tools give it, secrets ' +
    'masked: a masked value keeps the value it has in HelloID), applies only the changes listed (everything else stays as it is), ' +
    'and plans the import of that one item with the same planner as helloid_plan_import. changes: set [{path, value}] (a path ' +
    'that is not there yet is a new property: flagged in the plan), unset [path], and list operations [{path, op: add | remove | ' +
    'change, match, value}] so a list is never replaced by accident (replacing a whole list with set needs replaceList: true). ' +
    'Applied in that order: list operations, set, unset. Paths that do not exist, IDs (the item\'s own, and the IDs HelloID gives ' +
    'list items) and parts the import does not read are refused. Returns each change with its old and new value (texts such as ' +
    'scripts: line counts and a unified diff), the planner\'s overview and a plan ID for helloid_apply_plan (valid 30 minutes, ' +
    'this MCP session only). Business rules are saved as drafts: publish them with helloid_plan_publish_rule. ' +
    `PowerShell scripts of a target system that a change sets or changes get the DryRun check: its findings (with line numbers) are ` +
    `in that change's warnings; a warning only, never a refusal. ${DRYRUN_RULE} Test a planned script before applying it with the ` +
    'dry-run tools (helloid_dryrun_account_action, helloid_dryrun_permission_action, helloid_dryrun_permission_import, ' +
    'helloid_dryrun_uniqueness, helloid_preview_field_mapping) and planId: they run what this plan would save. Writes nothing. ' +
    'Needs mode "plan" or "write".',
  access: 'plan',
  environment: true,
  input: {
    kind: kindInput,
    id: z.string().optional().describe('The item\'s ID (systemId, identifier, ruleId, ...); not for settings pages'),
    name: z.string().optional().describe('The item\'s name, instead of id (refused when several items have it)'),
    changes: z
      .object({
        set: z.array(setInput).optional(),
        unset: z.array(z.string().min(1)).optional().describe('Paths to remove (not list items: use op "remove")'),
        lists: z.array(listInput).optional(),
      })
      .describe('What to change; only these, everything else stays'),
    answers: answersInput,
  },
  output: {
    ...planOutputBase,
    kind: z.string(),
    id: z.string().nullable(),
    name: z.string().nullable(),
    changes: z.array(changeOutput).describe('Every requested change, with the old and new value'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  auditArguments: auditEdit,
  async handler(call, context) {
    const environment = call.environment;
    const kind = canonicalKind(call.args.kind);
    const def = KINDS[kind];
    const changes = call.args.changes as Changes;
    if (!changes.set?.length && !changes.unset?.length && !changes.lists?.length) throw new Error('changes is empty: give set, unset or lists.');
    if (def.single && (call.args.id || call.args.name)) throw new Error(`${def.label} is a settings page: leave out id and name.`);
    const reader = new ItemReader(exporterForEnvironment(environment, context, call.signal, true));
    const item = await reader.find(kind, { id: call.args.id, name: call.args.name });
    let doc = await reader.read(kind, item);
    const notes: string[] = [];
    if (kind === 'businessRule') {
      const rule = doc.rule ?? {};
      if (rule.hasDraft === true && isPlainObject(rule.draft)) {
        // Edited as it is now: its draft (the import saves a draft)
        doc = { ...doc, rule: { ...rule, condition: rule.draft.condition ?? rule.condition, entitlements: rule.draft.entitlements ?? rule.entitlements } };
        notes.push('The rule has an unpublished draft: the changes are made to the draft\'s conditions and entitlements.');
      }
      notes.push(
        'Business rules are saved as drafts (the condition and entitlements; the name, description and categories take effect right away): ' +
          'publish the draft with helloid_plan_publish_rule and helloid_apply_publish_rule.',
      );
    }
    const { doc: changed, details } = applyChanges(doc, changes, def.spec);
    if (kind === 'targetSystem') {
      const left = addScriptWarnings(doc, changed, details);
      if (left.length) notes.push(...left);
    }
    const holder = { signal: call.signal as AbortSignal | undefined };
    const env = plannerEnv(environment, context, holder);
    const input: InputFile[] = [{ name: `${def.label} "${item.name ?? def.label}"`, content: def.file(changed) }];
    const { files, skipped, kinds } = classifyFiles(input, env);
    if (!files.length) throw new Error(`The changed ${def.label} is not a file the import takes: ${skipped.join('; ')}`);
    const outcome = await planFilesInto({
      environment,
      sessionId: call.sessionId,
      context,
      env,
      holder,
      files,
      kinds,
      answers: call.args.answers ?? {},
      // (the scripts are checked per change above)
      checkScripts: false,
      edited: { kind, id: item.id, doc: changed },
    });
    const rows = details.map(changeRow);
    const newProperties = rows.filter((r) => r.newProperty).map((r) => r.target);
    if (newProperties.length) notes.push(`New properties (not in the export; check their names): ${newProperties.join(', ')}.`);
    const changeText = rows
      .map((r) => {
        const line = `- ${r.change} ${r.target}: ${r.before ?? '(none)'} -> ${r.after ?? '(none)'}${r.newProperty ? ' (NEW property)' : ''}`;
        const warnings = r.warnings.length ? `\n${r.warnings.map((w) => `    ⚠️ ${w}`).join('\n')}` : '';
        return (r.text ? `${line}\n${r.text.diff.split('\n').map((l) => `    ${l}`).join('\n')}` : line) + warnings;
      })
      .join('\n');
    const overview = `Requested changes of ${def.label} "${item.name ?? def.label}":\n${changeText}\n\n${outcome.overview}${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
    const structured = {
      planId: outcome.planId,
      expiresAt: outcome.expiresAt,
      kind,
      id: item.id,
      name: item.name,
      changes: rows,
      entries: outcome.entries,
      choices: outcome.choices,
      overview,
      notes,
    };
    const content = [{ type: 'text' as const, text: overview }];
    const what = `${rows.length} change(s) of ${def.label} "${item.name ?? def.label}"`;
    if (outcome.open.length) {
      return {
        summary: `${what}: ${outcome.open.length} special case(s) need a choice before the plan (see choices). Ask the user, or pass the defaults in answers, and plan again.`,
        structured,
        content,
      };
    }
    if (!outcome.planId) return { summary: `${what}: nothing to do (the item is already so, or the import will not do it; see the overview).`, structured, content };
    return { summary: `Plan ${outcome.planId} (valid 30 minutes): ${what}. Run it with helloid_apply_plan.`, structured, content };
  },
});

// ---------------------------------------------------------------------------------------------
// Copy between environments

const copyItemInput = z.object({
  kind: kindInput,
  id: z.string().optional().describe('The item\'s ID in the source environment'),
  name: z.string().optional().describe('The item\'s name in the source environment, instead of id'),
});

export const planCopy = defineTool({
  name: 'helloid_plan_copy',
  title: 'Plan copying items to another environment',
  description:
    'Plans copying items from one environment to another, entirely inside the server: reads the items\' exports in the source ' +
    '(as helloid_get_* gives them, secrets masked) and plans their import into the target with the planner of helloid_plan_import ' +
    '("Overwrite all": what matches by ID, else by name, is overwritten; the rest is made new, disabled where it can be switched on; ' +
    'business rules as drafts). A target system is copied with its notifications (they are in its export). Secrets are never ' +
    'copied: items that exist in the target keep their secrets, new items get empty secrets (set them in the target). Returns the ' +
    'overview and a plan ID for helloid_apply_plan with environment = the target (valid 30 minutes, this MCP session only). Writes ' +
    'nothing. Needs mode "read" for the source and mode "plan" for the target (applying needs "write"), logged in to both.',
  access: 'none',
  environment: false,
  input: {
    sourceEnvironment: z.string().min(1).describe('The environment to copy from'),
    targetEnvironment: z.string().min(1).describe('The environment to copy to'),
    items: z.array(copyItemInput).min(1).describe('The items to copy (several allowed)'),
    answers: answersInput,
  },
  output: {
    ...planOutputBase,
    sourceEnvironment: z.string(),
    targetEnvironment: z.string().describe('Apply the plan with helloid_apply_plan in this environment'),
    items: z.array(z.object({ kind: z.string(), id: z.string().nullable(), name: z.string().nullable() })).describe('What was read in the source'),
    skipped: z.array(z.string()),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const { sourceEnvironment, targetEnvironment } = call.args;
    if (sourceEnvironment === targetEnvironment) throw new Error('sourceEnvironment and targetEnvironment are the same: use helloid_plan_edit to change an item.');
    const source = environmentWithAccess(context, sourceEnvironment, 'read');
    const target: ResolvedEnvironment = environmentWithAccess(context, targetEnvironment, 'plan');
    const reader = new ItemReader(exporterForEnvironment(source, context, call.signal, true));
    const input: InputFile[] = [];
    const items: Array<{ kind: CanonicalKind; id: string | null; name: string | null }> = [];
    const notes: string[] = [
      'Secrets are masked in the exports: items that exist in the target keep their own secrets; new items get empty secrets (set them in the target).',
    ];
    for (const [n, wanted] of call.args.items.entries()) {
      const kind = canonicalKind(wanted.kind as ItemKind);
      const def = KINDS[kind];
      const item = await reader.find(kind, { id: wanted.id, name: wanted.name });
      const doc = await reader.read(kind, item);
      items.push({ kind, id: item.id, name: item.name });
      input.push({ name: `${def.label} "${item.name ?? def.label}" (item ${n + 1})`, content: def.file(doc) });
      if (kind === 'businessRule' && doc?.rule?.hasDraft === true) {
        notes.push(`Business rule "${item.name}" has an unpublished draft in '${sourceEnvironment}': its export (as the userscript's) is what is copied.`);
      }
      if (kind === 'targetSystem') notes.push(`Target system "${item.name}" is copied with its notifications and its business rule links (rules found by ID in the target).`);
    }
    if (items.some((i) => i.kind === 'businessRule')) notes.push('Business rules are saved as drafts in the target: publish them with helloid_plan_publish_rule.');
    const holder = { signal: call.signal as AbortSignal | undefined };
    const env = plannerEnv(target, context, holder);
    const { files, skipped, kinds } = classifyFiles(input, env);
    if (!files.length) throw new Error(`Nothing the import takes: ${skipped.join('; ')}`);
    const closing =
      (skipped.length ? `\n\nSkipped:\n${skipped.map((s) => `  - ${s}`).join('\n')}` : '') + `\n\n${notes.join('\n')}`;
    const outcome = await planFilesInto({
      environment: target,
      sessionId: call.sessionId,
      context,
      env,
      holder,
      files,
      kinds,
      answers: call.args.answers ?? {},
      closing,
      intro: `Copy from '${sourceEnvironment}' to '${targetEnvironment}'. ⏳ will be done, ✅ already as in the source, ⚠️ will be done with a note, ❌ will not be done. Nothing is written before helloid_apply_plan runs this plan in '${targetEnvironment}'.`,
    });
    const structured = {
      planId: outcome.planId,
      expiresAt: outcome.expiresAt,
      sourceEnvironment,
      targetEnvironment,
      items,
      entries: outcome.entries,
      choices: outcome.choices,
      skipped,
      overview: outcome.overview,
      notes,
    };
    const content = [{ type: 'text' as const, text: outcome.overview }];
    const what = `copy ${items.length} item(s) from '${sourceEnvironment}' to '${targetEnvironment}'`;
    if (outcome.open.length) {
      return {
        summary: `To ${what}, ${outcome.open.length} special case(s) need a choice (see choices). Ask the user, or pass the defaults in answers, and plan again.`,
        structured,
        content,
      };
    }
    if (!outcome.planId) return { summary: `Nothing to do to ${what}: the target already has them so, or they will not be done (see the overview).`, structured, content };
    return {
      summary: `Plan ${outcome.planId} (valid 30 minutes): ${what}, ${outcome.toDo} item(s) to do. Run it with helloid_apply_plan with environment '${targetEnvironment}'.`,
      structured,
      content,
    };
  },
});

export const editTools: ToolGroup = [planEdit, planCopy];

