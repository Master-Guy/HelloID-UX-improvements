// The kinds of items the edit, copy, compare and search tools work on: how to list them, read one
// as its export file (the userscript's export, secrets masked: what the helloid_get_* tools give),
// turn that into a file the import takes, and what of it can be changed.
//
// The data is HelloID's own JSON, of many shapes; it is handled as `any`, as the exports are.

import { type Exporter, NotFoundError, type SystemDirectory } from '../helloid/exports.ts';
import type { EditSpec } from './edit.ts';

type Any = any;

export const ITEM_KINDS = [
  'targetSystem',
  'sourceSystem',
  'notificationSystem',
  'notification',
  'customEvent',
  'businessRule',
  'toxicCombination',
  'toxicPolicy',
  'schedule',
  'sourceConfiguration',
  'aggregationConfiguration',
  'personLifecycle',
  'excludedPersons',
  'reconciliationConfiguration',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** toxicPolicy is another name of toxicCombination. */
export type CanonicalKind = Exclude<ItemKind, 'toxicPolicy'>;
export const canonicalKind = (kind: ItemKind): CanonicalKind => (kind === 'toxicPolicy' ? 'toxicCombination' : kind);
/** Every kind once (the search's default). */
export const CANONICAL_KINDS = ITEM_KINDS.filter((k): k is CanonicalKind => k !== 'toxicPolicy');

/** One item of a kind in an environment. */
export interface ItemRef {
  /** Its ID; null for a settings page (there is one). */
  id: string | null;
  name: string | null;
  /** The row of HelloID's list. */
  row: Any;
}

/** Reads items of an environment with one exporter (lists read once). */
export class ItemReader {
  readonly exporter: Exporter;
  private directory: Promise<SystemDirectory> | undefined;

  constructor(exporter: Exporter) {
    this.exporter = exporter;
  }

  systems(): Promise<SystemDirectory> {
    this.directory ??= this.exporter.systemDirectory();
    return this.directory;
  }

  /** The items of a kind. */
  list(kind: CanonicalKind): Promise<ItemRef[]> {
    return KINDS[kind].list(this);
  }

  /** One item, by ID, else by name (refused when the name is not unique). */
  async find(kind: CanonicalKind, by: { id?: string | undefined; name?: string | undefined }): Promise<ItemRef> {
    const def = KINDS[kind];
    const items = await this.list(kind);
    if (def.single) return items[0]!;
    if (by.id) {
      const found = items.find((i) => i.id === by.id);
      if (!found) throw new NotFoundError(`There is no ${def.label} with ID '${by.id}'.`);
      return found;
    }
    if (by.name === undefined) throw new Error(`Give the id or the name of the ${def.label}.`);
    const name = by.name.trim();
    const named = items.filter((i) => typeof i.name === 'string' && i.name.trim() === name);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) {
      throw new Error(`${named.length} ${def.label}s are named "${name}": give the id (${named.map((i) => `${i.id}${def.describe ? ` ${def.describe(i.row)}` : ''}`).join(', ')}).`);
    }
    throw new NotFoundError(`There is no ${def.label} named "${name}".`);
  }

  /** The item as its export file (what the helloid_get_* tool gives; for a notification: the notification). */
  read(kind: CanonicalKind, ref: ItemRef): Promise<Any> {
    return KINDS[kind].read(this, ref);
  }
}

export interface KindDef {
  /** "target system" */
  label: string;
  /** The import's name of the file ("contents"). */
  importKind: string;
  /** A settings page: one per environment, no ID. */
  single?: boolean;
  list(reader: ItemReader): Promise<ItemRef[]>;
  read(reader: ItemReader, ref: ItemRef): Promise<Any>;
  /** The file the import takes, from what read() gives (changed or not). */
  file(doc: Any): Any;
  /** More about an item, to tell items of the same name apart. */
  describe?(row: Any): string;
  spec: EditSpec;
}

const agentsList = { 'agents.selected': { matchKeys: ['type', 'value'], matchAll: true } };
const ref = (id: unknown, name: unknown, row: Any): ItemRef => ({ id: typeof id === 'string' ? id : null, name: typeof name === 'string' ? name : null, row });
const asIs = (doc: Any) => doc;
const setting = (label: string, importKind: string, read: (reader: ItemReader) => Promise<Any>, spec: EditSpec): KindDef => ({
  label,
  importKind,
  single: true,
  list: async () => [{ id: null, name: label, row: null }],
  read: (reader) => read(reader),
  file: asIs,
  spec,
});

export const KINDS: Record<CanonicalKind, KindDef> = {
  targetSystem: {
    label: 'target system',
    importKind: 'targetSystem',
    list: async (r) => (await r.exporter.fetchSystems()).filter((s) => s?.systemId).map((s) => ref(s.systemId, s.displayName, s)),
    read: (r, item) => r.exporter.targetSystem(item.id!),
    file: asIs,
    spec: {
      roots: ['configuration', 'resources', 'agents', 'notifications', 'rules'],
      identity: ['systemId', 'templateIdentifier', 'configuration.systemId', 'configuration.templateIdentifier'],
      required: ['configuration.displayName'],
      lists: {
        'configuration.mappingConfiguration.fields': { idKey: 'identifier', matchKeys: ['name', 'identifier'] },
        'configuration.mappingConfiguration.fields[].mappingActions': { idKey: 'mappingActionId', matchKeys: ['mappingActionId'] },
        'configuration.mappingConfiguration.uniquenessConfiguration.selectedUniqueFields': { matchKeys: [], primitive: true },
        'configuration.permissions': { idKey: 'identification', matchKeys: ['displayName', 'identification'] },
        'configuration.dependOnSystems': { matchKeys: ['systemId', 'displayName'] },
        'configuration.scriptConfigurationForm.fields': { matchKeys: ['key'] },
        resources: { idKey: 'resourceDefinitionId', matchKeys: ['displayName', 'resourceDefinitionId'] },
        notifications: { idKey: 'identifier', matchKeys: ['identifier', 'name'] },
        'notifications[].dataReferences': { matchKeys: ['systemId', 'key'] },
        rules: { matchKeys: ['ruleId', 'ruleName'] },
        'rules[].entitlements': { matchKeys: ['entitlementId'] },
        ...agentsList,
      },
    },
  },
  sourceSystem: {
    label: 'source system',
    importKind: 'sourceSystem',
    list: async (r) => (await r.exporter.listSourceSystems()).map((s) => ref(s.systemId, s.displayName, s)),
    read: (r, item) => r.exporter.sourceSystem(item.id!),
    file: asIs,
    spec: {
      roots: ['system', 'agents'],
      identity: ['systemId', 'system.systemId'],
      required: ['system.displayName'],
      jsonText: ['system.scriptConfiguration', 'system.scriptConfigurationForm'],
      lists: { 'system.scriptConfigurationForm': { matchKeys: ['key'] }, ...agentsList },
    },
  },
  notificationSystem: {
    label: 'notification system',
    importKind: 'notificationSystem',
    list: async (r) => (await r.exporter.listNotificationSystems()).map((s) => ref(s.systemId, s.displayName, s)),
    read: (r, item) => r.exporter.notificationSystem(item.id!),
    file: asIs,
    spec: {
      roots: ['system', 'agents'],
      identity: ['systemId', 'system.systemId', 'system.isBuiltin'],
      required: ['system.displayName'],
      lists: {
        'system.notificationScripts': { idKey: 'scriptId', matchKeys: ['displayName', 'scriptId'] },
        'system.notificationTemplates': { idKey: 'templateId', matchKeys: ['displayName', 'templateId'] },
        'system.notificationTemplates[].fields': { matchKeys: ['key'] },
        'system.systemConfiguration.fields': { matchKeys: ['key'] },
        ...agentsList,
      },
    },
  },
  notification: {
    label: 'notification',
    importKind: 'notifications',
    list: async (r) => (await r.exporter.listNotifications()).map((n) => ref(n.identifier, n.name, n)),
    read: async (r, item) => {
      const file = await r.exporter.notifications([item.id!]);
      return file.notifications[0];
    },
    file: (doc) => ({ contents: 'notifications', secretsIncluded: false, notifications: [doc] }),
    describe: (row) => `(${row?.event ?? '?'})`,
    spec: {
      roots: '*',
      // (what the export adds, for another environment: the import finds by the IDs first)
      readOnly: ['systemName', 'notificationSystemName', 'notificationSystemBuiltin', 'notificationTemplateName', 'customEventName', 'lastChange'],
      identity: ['identifier'],
      required: ['name', 'event'],
      lists: { dataReferences: { matchKeys: ['systemId', 'key'] } },
    },
  },
  customEvent: {
    label: 'custom event',
    importKind: 'customEvent',
    list: async (r) => (await r.exporter.listCustomEvents()).map((e) => ref(e.customEventId, e.name, e)),
    read: async (r, item) => r.exporter.customEvent(item.row, await r.systems()),
    file: asIs,
    spec: {
      roots: ['customEvent', 'systemName'],
      identity: ['customEventId', 'customEvent.customEventId'],
      required: ['customEvent.name'],
      lists: {},
    },
  },
  businessRule: {
    label: 'business rule',
    importKind: 'businessRule',
    list: async (r) => (await r.exporter.listRules()).map((rule) => ref(rule.ruleId, rule.name, rule)),
    read: async (r, item) => r.exporter.businessRule(item.row, await r.systems()),
    file: asIs,
    spec: {
      roots: ['rule'],
      identity: ['ruleId', 'rule.ruleId'],
      required: ['rule.name'],
      lists: {
        'rule.entitlements': { matchKeys: ['entitlementId', 'displayName'] },
        'rule.categories': { matchKeys: [], primitive: true },
        'rule.condition.titleCondition.titles': { matchKeys: ['externalId', 'name'] },
        'rule.condition.departmentCondition.departments': { matchKeys: ['externalId', 'displayName'] },
        'rule.condition.personConditions': { matchKeys: ['field', 'mode', 'invert', 'values'], matchAll: true },
        'rule.condition.contractConditions': { matchKeys: ['field', 'mode', 'invert', 'values'], matchAll: true },
      },
    },
  },
  toxicCombination: {
    label: 'toxic combination',
    importKind: 'toxicPolicy',
    list: async (r) => (await r.exporter.listToxicPolicies()).map((p) => ref(p.toxicCombinationId, p.name, p)),
    read: async (r, item) => r.exporter.toxicPolicy(item.row, await r.systems()),
    file: asIs,
    spec: {
      roots: ['policy'],
      identity: ['toxicCombinationId', 'policy.toxicCombinationId'],
      required: ['policy.name'],
      lists: {
        'policy.inputObjectIds': { matchKeys: [], primitive: true },
        'policy.outputObjectIds': { matchKeys: [], primitive: true },
      },
    },
  },
  schedule: {
    label: 'schedule',
    importKind: 'schedule',
    list: async (r) => (await r.exporter.listSchedules()).map((s) => ref(s.scheduleId, s.name, s)),
    read: async (r, item) => r.exporter.schedule(item.row, await r.systems()),
    file: asIs,
    spec: {
      roots: ['schedule'],
      identity: ['scheduleId', 'schedule.scheduleId'],
      required: ['schedule.name'],
      lists: { 'schedule.tasks': { matchKeys: ['type', 'systemId'], matchAll: true } },
    },
  },
  sourceConfiguration: setting('Source configuration', 'sourceConfiguration', (r) => r.exporter.sourceConfiguration(), {
    roots: ['calculatedLayers', 'customFields'],
    identity: [],
    required: [],
    lists: { customFields: { idKey: 'customFieldIdentifier', matchKeys: ['name'] } },
  }),
  aggregationConfiguration: setting('Aggregation configuration', 'aggregationConfiguration', (r) => r.exporter.aggregationConfiguration(), {
    roots: ['configuration'],
    identity: [],
    required: [],
    lists: {},
  }),
  personLifecycle: setting('Person lifecycle', 'personLifecycle', (r) => r.exporter.personLifecycle(), {
    roots: ['configuration'],
    identity: [],
    required: [],
    lists: { configuration: { matchKeys: ['eventType'] } },
  }),
  excludedPersons: setting('Excluded persons', 'excludedPersons', (r) => r.exporter.excludedPersons(), {
    roots: ['persons'],
    identity: [],
    required: [],
    lists: { persons: { matchKeys: ['personId', 'externalId'] } },
  }),
  reconciliationConfiguration: setting('Reconciliation configuration', 'reconciliationConfiguration', async (r) => r.exporter.reconciliationConfiguration(await r.systems()), {
    roots: ['schedule', 'systemConfiguration'],
    identity: [],
    required: [],
    lists: { systemConfiguration: { matchKeys: ['systemId'] } },
  }),
};
