// The import of export files, as the userscript's "Import HelloID export files…" with "Overwrite
// all" does it: importFiles (which files are taken, backups split into their parts, notification
// files merged), overwriteAll (what this run makes, target systems that others depend on first, the
// planners per kind in IMPORT_ORDER, the run in the order of the overview, what needs a failed item
// is not done) and PLANNERS (singlePlanner, itemsPlanner, settingPlanner).
//
// Not ported: the dialogs (their questions are answers, see Batch.decide), the backup the userscript
// downloads before it writes (the user makes daily exports), and the page reload.

import { IMPORT_PATHS } from '../helloid/endpoints.ts';
import { maskFormValues, maskNotificationSystem, maskSourceSystem, maskTargetConfiguration } from '../safety.ts';
import {
  type Answers,
  type Any,
  type Batch,
  type Decision,
  type DecisionSpec,
  FETCH_ALL_TAKE,
  fetchSystems,
  type ImportFile,
  isPlainObject,
  KIND_LABELS,
  makeAuto,
  type OverviewEntry,
  overviewEntry,
  type Pending,
  type Planner,
  type PlannerEnv,
  rowsOf,
  sameText,
  type Touch,
  withoutMarks,
} from './common.ts';
import { itemsPlanner, itemTypes } from './items.ts';
import { notificationImports } from './notifications.ts';
import { settingPlanner, settingTypes } from './settings.ts';
import { sourceSystemImport } from './source-systems.ts';
import { CONNECTOR_EXPORTS, targetSystemImport } from './target-systems.ts';

/** What a file is: its "contents", or a target system export (which has none); null for anything else. */
export function importKind(data: Any): string | null {
  if (!isPlainObject(data)) return null;
  if (!data.contents && isPlainObject(data.configuration) && typeof data.templateIdentifier === 'string') return 'targetSystem';
  return typeof data.contents === 'string' ? data.contents : null;
}

/** The order in which a batch imports: what others point at comes first. */
export const IMPORT_ORDER = [
  'targetSystem',
  'sourceSystem',
  'notificationSystem',
  'customEvent',
  'notifications',
  'businessRule',
  'toxicPolicy',
  'schedule',
  'sourceConfiguration',
  'aggregationConfiguration',
  'personLifecycle',
  'excludedPersons',
  'reconciliationConfiguration',
];

/** Whether a file of those has what its import needs. */
const SINGLE_VALID: Record<string, (data: Any) => boolean> = {
  targetSystem: () => true,
  sourceSystem: (data) => isPlainObject(data.system) && typeof data.system.displayName === 'string',
  notificationSystem: (data) => isPlainObject(data.system) && typeof data.system.displayName === 'string',
  notifications: (data) => Array.isArray(data.notifications),
};

/** Notification files (Export everything has one per notification) as one import. */
export function mergeNotificationFiles(files: ImportFile[]): ImportFile[] {
  const ofKind = files.filter((f) => f.kind === 'notifications');
  if (ofKind.length < 2) return files;
  const merged = {
    ...ofKind[0]!.data,
    secretsIncluded: ofKind.some((f) => f.data.secretsIncluded === true),
    notifications: ofKind.flatMap((f) => f.data.notifications),
  };
  const first = files.indexOf(ofKind[0]!);
  const rest = files.filter((f) => f.kind !== 'notifications');
  rest.splice(first, 0, { name: `${ofKind.length} notification files`, data: merged, kind: 'notifications' });
  return rest;
}

export interface InputFile {
  name: string;
  /** The file's JSON, or its text. */
  content: unknown;
}

/** The files to import, as importFiles takes them (a backup: the files in it), and what is skipped. */
export function classifyFiles(input: InputFile[], env: PlannerEnv): { files: ImportFile[]; skipped: string[]; kinds: string[] } {
  const { items, settings } = typesOf(env);
  let files: ImportFile[] = [];
  const skipped: string[] = [];
  for (const { name, content } of input) {
    let data: Any;
    if (typeof content === 'string') {
      try {
        data = JSON.parse(content);
      } catch {
        skipped.push(`${name}: not a valid JSON file`);
        continue;
      }
    } else {
      data = content;
    }
    const backup = data?.contents === 'backups' && Array.isArray(data.files);
    const entries: Array<[string, Any]> = backup ? (data.files as Any[]).map((d, i) => [`${name} (${i + 1})`, d]) : [[name, data]];
    for (const [entryName, entry] of entries) {
      const kind = importKind(entry);
      const known = kind && IMPORT_ORDER.includes(kind);
      const itemType = items.find((t) => t.contents === kind);
      const settingType = settings.find((t) => t.contents === kind);
      const valid = itemType ? itemType.valid(entry) : settingType ? settingType.valid(entry) : SINGLE_VALID[kind ?? '']?.(entry);
      if (!known) skipped.push(`${entryName}: not an export file this script knows`);
      else if (!valid) skipped.push(`${entryName}: the file is incomplete`);
      else files.push({ name: entryName, data: entry, kind: kind! });
    }
  }
  files = mergeNotificationFiles(files);
  const kinds = IMPORT_ORDER.filter((k) => files.some((f) => f.kind === k));
  return { files, skipped, kinds };
}

function typesOf(env: PlannerEnv) {
  return { items: itemTypes(env), settings: settingTypes(env) };
}

// ---------------------------------------------------------------------------------------------
// What an entry touches (not in the userscript): read for the fingerprints and the audit

const touch = (key: string, label: string, read: (env: PlannerEnv) => Promise<unknown>, mask?: (value: Any) => unknown): Touch => ({
  key,
  label,
  read,
  ...(mask ? { mask } : {}),
});

const maskTarget = (value: Any) => (value ? { ...value, configuration: maskTargetConfiguration(value.configuration) } : value);

/** The notifications with the secrets of their template data masked (the password fields of their template). */
async function maskNotifications(env: PlannerEnv, notifications: Any[]): Promise<Any[]> {
  const systems = new Map<string, Promise<Any>>();
  return Promise.all(
    notifications.map(async (n) => {
      if (!isPlainObject(n) || !(n as Any).notificationSystemId) return n;
      const id = (n as Any).notificationSystemId as string;
      if (!systems.has(id)) systems.set(id, env.gw.fetch(IMPORT_PATHS.notificationSystem(id)).catch(() => null));
      const template = (((await systems.get(id))?.notificationTemplates ?? []) as Any[]).find((t) => t?.templateId === (n as Any).notificationTemplateId);
      return { ...n, notificationTemplateData: maskFormValues((n as Any).notificationTemplateData, template?.fields) };
    }),
  );
}

/** A target system as it is: list entry, configuration of its type, resources, agents (and its notifications). */
function targetTouches(planned: Any, fileName: string): Touch[] {
  const name = String(planned?.name ?? fileName).trim();
  const id: string | null = planned?.systemId ?? null;
  const findSystem = async (env: PlannerEnv) => {
    const systems = await fetchSystems(env);
    return systems.find((s) => id && s.systemId === id) ?? systems.find((s) => sameText(s.displayName, name));
  };
  const touches: Touch[] = [
    touch(
      `targetSystem:${id ?? name}`,
      `target system "${name}"`,
      async (env) => {
        const system = await findSystem(env);
        if (!system) return null;
        const encoded = encodeURIComponent(system.systemId);
        const paths = CONNECTOR_EXPORTS[system.templateIdentifier]?.(encoded);
        return {
          listEntry: system,
          configuration: paths ? await env.gw.fetch(paths.configuration) : null,
          resources: paths?.resources ? await env.gw.fetch(paths.resources).catch(() => null) : null,
          agentSelection: await env.gw.fetch(IMPORT_PATHS.agentSelection(encoded)).catch(() => null),
        };
      },
      maskTarget,
    ),
  ];
  if (planned?.notifications) {
    touches.push(
      touch(`targetSystemNotifications:${id ?? name}`, `notifications of target system "${name}"`, async (env) => {
        const system = await findSystem(env);
        if (!system) return [];
        const rows = rowsOf(await env.gw.fetch(IMPORT_PATHS.allNotifications(FETCH_ALL_TAKE))).filter((n) => n?.systemId === system.systemId);
        const read = await Promise.all(rows.map((n) => env.gw.fetch(IMPORT_PATHS.notification(n.identifier))));
        return maskNotifications(env, read.sort((a, b) => String(a?.identifier).localeCompare(String(b?.identifier))));
      }),
    );
  }
  for (const ruleId of (planned?.ruleIds ?? []) as string[]) {
    touches.push(touch(`businessRule:${ruleId}::`, `business rule ${ruleId}`, (env) => env.gw.fetch(IMPORT_PATHS.rule(ruleId)).catch(() => null)));
  }
  return touches;
}

/** A source or notification system as it is: by ID (an existing one), else by name. */
function systemTouch(kind: 'sourceSystem' | 'notificationSystem', planned: Any, fileName: string): Touch {
  const name = String(planned?.name ?? fileName).trim();
  const id: string | undefined = planned?.isNew ? undefined : planned?.id;
  const list = kind === 'sourceSystem' ? IMPORT_PATHS.sourceSystems : IMPORT_PATHS.notificationSystems;
  const detail = kind === 'sourceSystem' ? IMPORT_PATHS.sourceSystem : IMPORT_PATHS.notificationSystem;
  return touch(
    `${kind}:${id ?? name}`,
    `${kind === 'sourceSystem' ? 'source' : 'notification'} system "${name}"`,
    async (env) => {
      const rows = rowsOf(await env.gw.fetch(list));
      const found = rows.find((s) => id && s.systemId === id) ?? rows.find((s) => sameText(s.displayName, name));
      if (!found) return null;
      return {
        system: await env.gw.fetch(detail(found.systemId)),
        agentSelection: await env.gw.fetch(IMPORT_PATHS.agentSelection(encodeURIComponent(found.systemId))).catch(() => null),
      };
    },
    (value) => (value ? { ...value, system: kind === 'sourceSystem' ? maskSourceSystem(value.system) : maskNotificationSystem(value.system) } : value),
  );
}

/** The notifications of HelloID with the identifier or the name of a notification of the file. */
function notificationsTouch(data: Any): Touch {
  const fileNotifications = ((data.notifications ?? []) as Any[]).filter(isPlainObject) as Any[];
  const ids = new Set(fileNotifications.map((n) => n.identifier).filter(Boolean));
  const names = new Set(fileNotifications.map((n) => n.name).filter((n) => typeof n === 'string'));
  return {
    key: `notifications:${[...names].sort().join('|')}`,
    label: `notifications "${[...names].join('", "')}"`,
    async read(env) {
      const rows = rowsOf(await env.gw.fetch(IMPORT_PATHS.allNotifications(FETCH_ALL_TAKE))).filter((n) => ids.has(n?.identifier) || names.has(n?.name));
      const read = await Promise.all(rows.map((n) => env.gw.fetch(IMPORT_PATHS.notification(n.identifier))));
      return maskNotifications(env, read.sort((a, b) => String(a?.identifier).localeCompare(String(b?.identifier))));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The planners

/**
 * The imports that have their own dialogs (one file at a time): planned with auto.plan, then run
 * again with auto (checked again just before it is written).
 */
function singlePlanner(group: string, importer: (data: Any, auto: Any) => Promise<Any>, nameOf: (data: Any) => string, touchesOf: (planned: Any, data: Any) => Touch[]): Planner {
  return async (files, batch) => {
    const entries: OverviewEntry[] = [];
    for (const file of files) {
      const auto = makeAuto({ plan: true, answers: batch.answers, pending: batch.pending });
      let result: Any;
      try {
        result = await importer(file.data, auto);
      } catch (e: Any) {
        result = { error: String(e?.message ?? e) };
      }
      batch.decisions.push(...auto.decisions);
      const planned = result?.planned;
      entries.push(
        overviewEntry(result, {
          group,
          label: `"${nameOf(file.data)}"${planned?.isNew === true ? ' (new)' : planned?.isNew === false ? ' (overwrite)' : ''}`,
          provides: nameOf(file.data),
          needs: [...auto.needs],
          touches: planned ? touchesOf(planned, file.data) : [],
          run: async () => {
            const answer = await importer(file.data, makeAuto({ plan: false, answers: batch.answers }));
            if (answer?.skip) throw new Error(answer.skip);
            return [];
          },
        }),
      );
    }
    return entries;
  };
}

const notificationNames = (data: Any) =>
  ((data.notifications ?? []) as Any[])
    .filter(isPlainObject)
    .map((n: Any) => n.name)
    .join('", "');

export function makePlanners(env: PlannerEnv): Record<string, Planner> {
  const { importData } = targetSystemImport(env);
  const { importSourceSystemData } = sourceSystemImport(env);
  const { importNotificationsData, importNotificationSystemData } = notificationImports(env);
  const { items, settings } = typesOf(env);
  const targetName = (data: Any) => data.displayName ?? data.configuration?.displayName ?? '?';
  return {
    targetSystem: singlePlanner(KIND_LABELS.targetSystem!, (data, auto) => importData(data, { auto }), targetName, (planned, data) =>
      targetTouches(planned, targetName(data)),
    ),
    sourceSystem: singlePlanner(KIND_LABELS.sourceSystem!, (data, auto) => importSourceSystemData(data, { auto }), (data) => data.system?.displayName ?? '?', (planned, data) => [
      systemTouch('sourceSystem', planned, data.system?.displayName ?? '?'),
    ]),
    notificationSystem: singlePlanner(
      KIND_LABELS.notificationSystem!,
      (data, auto) => importNotificationSystemData(data, { auto }),
      (data) => data.system?.displayName ?? '?',
      (planned, data) => [systemTouch('notificationSystem', planned, data.system?.displayName ?? '?')],
    ),
    notifications: singlePlanner(KIND_LABELS.notifications!, (data, auto) => importNotificationsData(data, { auto }), notificationNames, (_planned, data) => [
      notificationsTouch(data),
    ]),
    ...Object.fromEntries(items.map((type) => [type.contents, itemsPlanner(type)])),
    ...Object.fromEntries(settings.map((type) => [type.contents, settingPlanner(env, type)])),
  };
}

// ---------------------------------------------------------------------------------------------
// Overwrite all

export interface ImportPlan {
  entries: OverviewEntry[];
  /** Every special case that was asked (with the answer used: the given one, else the default). */
  decisions: Decision[];
}

/**
 * The planning of overwriteAll: what this run makes (pending), target systems that others of the
 * files depend on first, then each kind's planner. Nothing is written.
 */
export async function planImport(env: PlannerEnv, input: { files: ImportFile[]; kinds: string[] }, answers: Answers): Promise<ImportPlan> {
  let files = input.files;
  const pendingNames: Record<string, Set<string>> = { system: new Set(), customEvent: new Set(), notificationSystem: new Set() };
  const pendingKind: Record<string, string> = { targetSystem: 'system', sourceSystem: 'system', notificationSystem: 'notificationSystem', customEvent: 'customEvent' };
  files.forEach(({ kind, data }) => {
    const name =
      kind === 'targetSystem'
        ? (data.displayName ?? data.configuration?.displayName)
        : ['sourceSystem', 'notificationSystem'].includes(kind)
          ? data.system?.displayName
          : kind === 'customEvent'
            ? data.customEvent?.name
            : null;
    if (typeof name === 'string' && pendingKind[kind]) pendingNames[pendingKind[kind]]!.add(name.trim());
  });
  const targetName = (data: Any) => String(data.displayName ?? data.configuration?.displayName ?? '').trim();
  const targets = files.filter((f) => f.kind === 'targetSystem');
  const ordered: ImportFile[] = [];
  while (targets.length) {
    const ready = targets.findIndex(
      (f) =>
        !((f.data.configuration?.dependOnSystems ?? []) as Any[]).some((d) =>
          targets.some((o) => o !== f && targetName(o.data) === String(d?.displayName ?? '').trim()),
        ),
    );
    ordered.push(...targets.splice(Math.max(ready, 0), 1));
  }
  files = [...ordered, ...files.filter((f) => f.kind !== 'targetSystem')];
  const pending: Pending = (kind, name) => typeof name === 'string' && (pendingNames[kind]?.has(name.trim()) ?? false);

  const planners = makePlanners(env);
  const decisions: Decision[] = [];
  const decide = (key: string, spec: DecisionSpec) => {
    if (!decisions.some((d) => d.key === key)) decisions.push({ key, ...spec });
    return key in answers ? answers[key] : spec.default;
  };
  const batch: Batch = { answers, decisions, decide, pending };
  const entries: OverviewEntry[] = [];
  for (const kind of input.kinds) {
    try {
      entries.push(...(await planners[kind]!(files.filter((f) => f.kind === kind), batch)));
    } catch (e: Any) {
      entries.push(overviewEntry({ error: String(e?.message ?? e) }, { group: KIND_LABELS[kind] ?? kind, label: 'these files', needs: [] }));
    }
  }
  return { entries, decisions };
}

/** The entries that are run: ⏳ and ⚠️. */
export const toDo = (entries: OverviewEntry[]) => entries.filter((e) => ['todo', 'note'].includes(e.status));

/**
 * The run of overwriteAll, in the order of the overview. A failure doesn't stop the others; what
 * needs an item that failed is not done. around(entry, run): runs an entry (for the audit).
 */
export async function runImport(entries: OverviewEntry[], around: (entry: OverviewEntry, run: () => Promise<string[]>) => Promise<string[]> = (_e, run) => run()) {
  const work = toDo(entries);
  const failed = new Set<string>();
  for (const entry of work) {
    const missing = (entry.needs ?? []).filter((name) => failed.has(name));
    if (missing.length) {
      Object.assign(entry, { status: 'failed', details: [`not done: it needs "${missing.join('", "')}", which failed`] });
      if (entry.provides) failed.add(entry.provides);
      continue;
    }
    entry.status = 'running';
    try {
      const notes = (await around(entry, async () => (await entry.run?.()) ?? [])) ?? [];
      Object.assign(entry, notes.length ? { status: 'note', details: notes } : { status: 'done' });
    } catch (e: Any) {
      Object.assign(entry, { status: 'failed', details: [String(e?.message ?? e)] });
      if (entry.provides) failed.add(entry.provides);
    }
  }
  const count = (status: string) => work.filter((e) => e.status === status).length;
  return {
    done: count('done') + count('note'),
    withNote: count('note'),
    failed: count('failed'),
    finish:
      `Import finished: ${count('done') + count('note')} done (${count('note')} with a note), ` +
      `${count('failed')} failed.` +
      (count('failed') ? '\nSee the ❌ lines above.' : '') +
      '\n\nNew items that can be switched on start disabled; business rules are saved as drafts.',
  };
}

const OVERVIEW_ICONS: Record<string, string> = { todo: '⏳', running: '⏳', same: '✅', done: '✅', note: '⚠️', skip: '❌', failed: '❌' };

/** The overview as the userscript's card shows it (showOverview), as plain text. */
export function overviewText(intro: string, entries: OverviewEntry[], closing = ''): string {
  return withoutMarks(
    intro +
      [...new Set(entries.map((e) => e.group))]
        .map(
          (group) =>
            `\n\n${group}\n` +
            entries
              .filter((e) => e.group === group)
              .map((e) => [`${OVERVIEW_ICONS[e.status]} ${e.label}${e.status === 'running' ? ' (busy)' : ''}`, ...e.details.map((detail) => `      ${detail}`)].join('\n'))
              .join('\n'),
        )
        .join('') +
      (closing ? `\n\n${closing}` : ''),
  );
}

/** The intro of the overview (the userscript's, without its backup, which is not ported). */
export const OVERVIEW_INTRO =
  'All changes of this import. ⏳ will be done, ✅ already as in the file, ⚠️ will be done with a note, ' +
  '❌ will not be done. Nothing is written before helloid_apply_plan runs this plan.';
