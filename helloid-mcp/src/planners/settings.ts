// The settings pages: source configuration, aggregation, person lifecycle, excluded persons,
// reconciliation (SETTING_IMPORTS and settingPlanner of the userscript). Their opt-in parts are
// special cases (answers).
// A type: contents, label, valid(data), load(ctx): the page as it is here,
//   plan(data, current, ctx): { parts: [{ key, label, changes, optIn }], notes, steps(chosen) }

import { IMPORT_PATHS } from '../helloid/endpoints.ts';
import {
  type Any,
  type Batch,
  FETCH_ALL_TAKE,
  fileSystemName,
  type ImportFile,
  isPlainObject,
  KIND_LABELS,
  keyChanges,
  type OverviewEntry,
  overviewEntry,
  type PlannerEnv,
  rowsOf,
  sameJson,
  systemDirectory,
} from './common.ts';

export interface SettingType {
  contents: string;
  label: string;
  valid(data: Any): boolean;
  load(ctx: Any): Promise<Any>;
  plan(data: Any, current: Any, ctx: Any): Any;
}

const LAYER_PARTS = [
  { key: 'primaryContractConfiguration', label: 'Primary contract' },
  { key: 'primaryManagerConfiguration', label: 'Primary manager' },
  { key: 'displayNameConfiguration', label: 'Display name' },
];
const RECONCILIATION_SCHEDULE_KEYS = ['enabled', 'scheduledOnDay', 'scheduledOnHour'];

export function settingTypes(env: PlannerEnv): SettingType[] {
  const fetchFromGateway = (path: string) => env.gw.fetch(path);
  const sendToGateway = (path: string, method: string, body?: unknown) => env.gw.send(path, method, body);
  // (the export header of the userscript's load(); left out by the fingerprints and the audit)
  const exportHeader = (contents: string) => ({ exportedAt: new Date(env.now()).toISOString(), exportedFrom: env.origin, contents });

  const SOURCE_CONFIGURATION_IMPORT: SettingType = {
    contents: 'sourceConfiguration',
    label: 'Source configuration',
    valid: (data) => isPlainObject(data.calculatedLayers) || Array.isArray(data.customFields),
    load: async () => ({
      ...exportHeader('sourceConfiguration'),
      calculatedLayers: await fetchFromGateway(`${IMPORT_PATHS.calculatedLayers}/config`),
      customFields: await fetchFromGateway(IMPORT_PATHS.customFields),
    }),
    plan(data, current) {
      const layers: Any = isPlainObject(data.calculatedLayers) ? data.calculatedLayers : {};
      const fileFields = ((Array.isArray(data.customFields) ? data.customFields : []) as Any[]).filter((f) => f?.name);
      const hereFields: Any[] = Array.isArray(current.customFields) ? current.customFields : [];
      const inFile = (field: Any) => fileFields.find((f) => f.name === field.name);
      const fields = (update: boolean, remove: boolean) => [
        ...hereFields
          .filter((field) => !remove || inFile(field))
          .map((field) => ({ ...field, ...(update && inFile(field) ? { displayName: inFile(field).displayName, type: inFile(field).type } : {}), selected: false })),
        ...(!update
          ? []
          : fileFields
              .filter((f) => !hereFields.some((h) => h.name === f.name))
              .map((f) => ({ customFieldIdentifier: env.uuid(), type: f.type, name: f.name, displayName: f.displayName, selected: false }))),
      ];
      const fieldChanges = fileFields.flatMap((f) => {
        const field = hereFields.find((h) => h.name === f.name);
        if (!field) return [`custom field "${f.name}" (new)`];
        return keyChanges(f, field, ['displayName', 'type']).map((c) => `custom field "${f.name}": ${c}`);
      });
      const onlyHere = hereFields.filter((h) => !fileFields.some((f) => f.name === h.name));
      return {
        parts: [
          ...LAYER_PARTS.filter((p) => p.key in layers).map((p) => ({
            ...p,
            changes: sameJson(layers[p.key], current.calculatedLayers?.[p.key]) ? [] : [p.label.toLowerCase()],
          })),
          { key: 'customFields', label: 'Custom fields', changes: fieldChanges },
          {
            key: 'removeFields',
            label: 'Delete the custom fields that the file does not have',
            changes: onlyHere.map((h) => `delete custom field "${h.name}" (its values are lost)`),
            optIn: {
              section: 'Custom fields that only this environment has',
              options: [
                { value: true, label: 'Delete them', description: 'The fields are deleted, and their values are lost.' },
                { value: false, label: 'Keep them', description: 'The fields stay as they are.' },
              ],
            },
          },
        ],
        notes: [],
        steps: (chosen: Set<string>) => [
          ...(LAYER_PARTS.some((p) => chosen.has(p.key))
            ? [
                {
                  name: LAYER_PARTS.filter((p) => chosen.has(p.key)).map((p) => p.label).join(', '),
                  run: () =>
                    sendToGateway(
                      IMPORT_PATHS.calculatedLayers,
                      'POST',
                      Object.fromEntries(LAYER_PARTS.map((p) => [p.key, chosen.has(p.key) ? layers[p.key] : current.calculatedLayers?.[p.key]])),
                    ),
                },
              ]
            : []),
          ...(chosen.has('customFields') || chosen.has('removeFields')
            ? [{ name: 'Custom fields', run: () => sendToGateway(IMPORT_PATHS.customFields, 'POST', fields(chosen.has('customFields'), chosen.has('removeFields'))) }]
            : []),
        ],
      };
    },
  };

  const AGGREGATION_IMPORT: SettingType = {
    contents: 'aggregationConfiguration',
    label: 'Aggregation configuration',
    valid: (data) => isPlainObject(data.configuration?.configuration),
    load: async () => ({ ...exportHeader('aggregationConfiguration'), configuration: await fetchFromGateway(IMPORT_PATHS.aggregation) }),
    plan(data, current) {
      const wanted = data.configuration.configuration;
      const here = current.configuration?.configuration ?? {};
      return {
        parts: [{ key: 'aggregation', label: 'Automatic aggregation and suggestions', changes: keyChanges(wanted, here, Object.keys(wanted)) }],
        notes: [],
        steps: () => [
          {
            name: 'Automatic aggregation and suggestions',
            run: () =>
              sendToGateway(IMPORT_PATHS.aggregation, 'POST', {
                configuration: wanted,
                redetermineSuggestionsStatus: current.configuration?.redetermineSuggestionsStatus ?? null,
              }),
          },
        ],
      };
    },
  };

  const LIFECYCLE_IMPORT: SettingType = {
    contents: 'personLifecycle',
    label: 'Person lifecycle',
    valid: (data) => Array.isArray(data.configuration),
    load: async () => ({ ...exportHeader('personLifecycle'), configuration: await fetchFromGateway(IMPORT_PATHS.personLifecycle) }),
    plan(data, current) {
      const wanted = (data.configuration as Any[]).filter(isPlainObject) as Any[];
      const here: Any[] = Array.isArray(current.configuration) ? current.configuration : [];
      const changes = [...new Set([...wanted, ...here].map((c) => c.eventType))].flatMap((type) => {
        const mine = wanted.find((c) => c.eventType === type);
        const theirs = here.find((c) => c.eventType === type);
        return sameJson(mine?.daysBefore, theirs?.daysBefore) ? [] : [`event ${type}: days before ${theirs?.daysBefore ?? '-'} -> ${mine?.daysBefore ?? '-'}`];
      });
      return {
        parts: [{ key: 'lifecycle', label: 'Days before the events', changes }],
        notes: [],
        steps: () => [{ name: 'Person lifecycle', run: () => sendToGateway(IMPORT_PATHS.personLifecycle, 'POST', { configurations: wanted }) }],
      };
    },
  };

  const EXCLUDED_PERSONS_IMPORT: SettingType = {
    contents: 'excludedPersons',
    label: 'Excluded persons',
    valid: (data) => Array.isArray(data.persons),
    load: async () => ({ ...exportHeader('excludedPersons'), persons: rowsOf(await fetchFromGateway(IMPORT_PATHS.vaultPersons(false, FETCH_ALL_TAKE))) }),
    async plan(data, current) {
      const excluded: Any[] = current.persons;
      const included = rowsOf(await fetchFromGateway(IMPORT_PATHS.vaultPersons(true, FETCH_ALL_TAKE)));
      const matches = (a: Any, b: Any) => a.personId === b.personId || (a.externalId && a.externalId === b.externalId);
      const label = (p: Any) => `${p.displayName ?? '?'}${p.externalId && !String(p.displayName).includes(p.externalId) ? ` (${p.externalId})` : ''}`;
      const fileOnes = (data.persons as Any[]).filter(isPlainObject) as Any[];
      const toExclude: Any[] = [];
      const notHere: string[] = [];
      fileOnes.forEach((p) => {
        if (excluded.some((e) => matches(e, p))) return;
        const found = included.find((i) => i.personId === p.personId) ?? included.find((i) => p.externalId && i.externalId === p.externalId);
        if (found) toExclude.push(found);
        else notHere.push(label(p));
      });
      const toInclude = excluded.filter((e) => !fileOnes.some((p) => matches(e, p)));
      return {
        parts: [
          { key: 'exclude', label: 'Exclude the persons of the file', changes: toExclude.map((p) => `exclude ${label(p)}`) },
          { key: 'include', label: 'Include again the persons excluded here that the file does not have', changes: toInclude.map((p) => `include ${label(p)}`) },
        ],
        notes: notHere.length ? [`not in this HelloID environment, so not excluded: ${notHere.join(', ')}`] : [],
        steps: (chosen: Set<string>) => [
          ...(chosen.has('exclude')
            ? toExclude.map((p) => ({ name: `Exclude ${label(p)}`, run: () => sendToGateway(IMPORT_PATHS.person('exclude', p.personId), 'PUT', {}) }))
            : []),
          ...(chosen.has('include')
            ? toInclude.map((p) => ({ name: `Include ${label(p)}`, run: () => sendToGateway(IMPORT_PATHS.person('include', p.personId), 'PUT', {}) }))
            : []),
        ],
      };
    },
  };

  const RECONCILIATION_IMPORT: SettingType = {
    contents: 'reconciliationConfiguration',
    label: 'Reconciliation configuration',
    valid: (data) => isPlainObject(data.schedule) || Array.isArray(data.systemConfiguration),
    load: async (ctx) => {
      const [schedule, systemConfiguration, exclusions] = await Promise.all([
        fetchFromGateway(IMPORT_PATHS.reconciliationSchedule),
        fetchFromGateway(IMPORT_PATHS.reconciliationSystems),
        sendToGateway(IMPORT_PATHS.reconciliationExclusions, 'POST', { search: '', filters: [], skip: 0, take: FETCH_ALL_TAKE }).catch(() => null),
      ]);
      const ids = rowsOf(systemConfiguration).map((s) => s.systemId);
      return {
        ...exportHeader('reconciliationConfiguration'),
        schedule,
        systemConfiguration,
        exclusions,
        systems: ids.map((id) => ({ systemId: id, displayName: ctx.systems.nameOf(id) })),
      };
    },
    plan(data, current, ctx) {
      const notes: string[] = [];
      const schedule = isPlainObject(data.schedule) ? (data.schedule as Any) : null;
      const here = rowsOf(current.systemConfiguration);
      const wanted: Any[] = [];
      const later: string[] = [];
      ((Array.isArray(data.systemConfiguration) ? data.systemConfiguration : []) as Any[]).filter(isPlainObject).forEach((entry: Any) => {
        const name = fileSystemName(data, entry.systemId);
        const system = ctx.systems.find(entry.systemId, name);
        if (!system && ctx.pending?.('system', name)) {
          ctx.need?.(name);
          later.push(`"${name}" (new, after it is made)`);
        } else if (!system) notes.push(`"${name ?? entry.systemId}" is not in this HelloID environment: left out`);
        else wanted.push({ ...entry, systemId: system.systemId });
      });
      const nameOf = (id: Any) => `"${ctx.systems.nameOf(id) ?? id}"`;
      const actions = ['automaticAccountCreate', 'automaticAccountEnable', 'automaticPermissionAdd'];
      const systemChanges = [
        ...later,
        ...wanted.flatMap((w) => {
          const h = here.find((x) => x.systemId === w.systemId);
          return !h ? [`${nameOf(w.systemId)} (new)`] : keyChanges(w, h, actions).map((c) => `${nameOf(w.systemId)}: ${c}`);
        }),
        ...here.filter((h) => !wanted.some((w) => w.systemId === h.systemId)).map((h) => `${nameOf(h.systemId)} (removed)`),
      ];
      const exclusions = rowsOf(data.exclusions);
      if (exclusions.length) notes.push(`the ${exclusions.length} exclusion(s) of the file can't be imported: HelloID makes them from the reports`);
      return {
        parts: [
          ...(schedule ? [{ key: 'schedule', label: 'Schedule', changes: keyChanges(schedule, current.schedule, RECONCILIATION_SCHEDULE_KEYS) }] : []),
          ...(Array.isArray(data.systemConfiguration) ? [{ key: 'systems', label: 'Systems and their automatic actions', changes: systemChanges }] : []),
        ],
        notes,
        steps: (chosen: Set<string>) => {
          const source = chosen.has('schedule') ? schedule : current.schedule;
          const systems = chosen.has('systems') ? wanted : here;
          return [
            ...(chosen.has('systems')
              ? here
                  .filter((h) => !wanted.some((w) => w.systemId === h.systemId))
                  .map((h) => ({
                    name: `Remove ${nameOf(h.systemId)}`,
                    run: () => sendToGateway(`${IMPORT_PATHS.reconciliationSystems}/${encodeURIComponent(h.systemId)}`, 'DELETE'),
                  }))
              : []),
            {
              name: 'Schedule and systems',
              run: () =>
                sendToGateway(IMPORT_PATHS.reconciliationSchedule, 'POST', {
                  ...Object.fromEntries(RECONCILIATION_SCHEDULE_KEYS.map((k) => [k, source?.[k] ?? null])),
                  enabled: source?.enabled === true,
                  clientTimeZone: env.timeZone,
                  scheduleStatus: null,
                  scheduledOn: null,
                  selectedSystems: systems.map((s: Any) => s.systemId),
                }),
            },
            ...(chosen.has('systems')
              ? [
                  {
                    name: 'Automatic actions per system',
                    run: () =>
                      sendToGateway(
                        IMPORT_PATHS.reconciliationSystems,
                        'POST',
                        wanted.map((w) => ({ systemId: w.systemId, ...Object.fromEntries(actions.map((a) => [a, w[a] === true])) })),
                      ),
                  },
                ]
              : []),
          ];
        },
      };
    },
  };

  return [SOURCE_CONFIGURATION_IMPORT, AGGREGATION_IMPORT, LIFECYCLE_IMPORT, EXCLUDED_PERSONS_IMPORT, RECONCILIATION_IMPORT];
}

/** A settings page as HelloID has it now, without the export header (for the fingerprints and the audit). */
async function loadSetting(env: PlannerEnv, type: SettingType): Promise<Any> {
  const { exportedAt, exportedFrom, contents, ...rest } = await type.load({ systems: await systemDirectory(env) });
  return rest;
}

/** The settings pages: their opt-in parts are special cases. */
export function settingPlanner(env: PlannerEnv, type: SettingType) {
  return async (files: ImportFile[], batch: Batch): Promise<OverviewEntry[]> => {
    const entries: OverviewEntry[] = [];
    for (const { data } of files) {
      try {
        const needs: string[] = [];
        const ctx = {
          systems: await systemDirectory(env),
          pending: batch.pending,
          need: (name: Any) => {
            if (name && !needs.includes(name)) needs.push(name);
          },
        };
        const current = await type.load(ctx);
        const plan = await type.plan(data, current, ctx);
        const chosen = (plan.parts as Any[])
          .filter((part) => part.changes.length)
          .filter(
            (part) =>
              !part.optIn ||
              batch.decide(`${type.contents}:${part.key}`, {
                section: part.optIn.section,
                item: part.changes.join('\n'),
                options: part.optIn.options,
                default: true,
              }) === true,
          );
        const keys = new Set<string>(chosen.map((part) => part.key));
        const result = !chosen.length
          ? plan.notes.length
            ? { planned: { lines: [], notes: plan.notes } }
            : { same: true }
          : { planned: { lines: chosen.flatMap((part) => [`${part.label}:`, ...part.changes.map((c: string) => `  - ${c}`)]), notes: plan.notes } };
        entries.push(
          overviewEntry(result, {
            group: KIND_LABELS[type.contents]!,
            label: type.label,
            needs,
            touches: [{ key: `setting:${type.contents}`, label: type.label.toLowerCase(), read: () => loadSetting(env, type) }],
            run: chosen.length
              ? async () => {
                  // (as it is now, with the parts chosen in the overview)
                  const ctxNow = { systems: await systemDirectory(env) };
                  const planNow = await type.plan(data, await type.load(ctxNow), ctxNow);
                  for (const step of planNow.steps(keys)) await step.run();
                  return [];
                }
              : null,
          }),
        );
      } catch (e: Any) {
        entries.push(overviewEntry({ error: String(e?.message ?? e) }, { group: KIND_LABELS[type.contents]!, label: type.label, needs: [] }));
      }
    }
    return entries;
  };
}
