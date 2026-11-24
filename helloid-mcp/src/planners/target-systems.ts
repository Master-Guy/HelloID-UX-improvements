// The import of a target system export: importData of the userscript, with everything it calls
// (the import steps per type, permission sets, the AD field mapping, notifications, the business
// rule links, secrets, changedParts). Ported for "Overwrite all" (auto): the userscript's dialogs of
// the one-by-one import are never reached with auto, and are left out. With auto, a migration to
// PowerShell v2 is skipped (as the userscript does), so its checklist steps never run either.

import { IMPORT_PATHS } from '../helloid/endpoints.ts';
import {
  type Any,
  type Auto,
  EXPORT_MASK,
  error,
  entitlementLabel,
  FETCH_ALL_TAKE,
  fetchSystems,
  isPlainObject,
  mergeSettings,
  type PlannerEnv,
  POWERSHELL_V1,
  POWERSHELL_V2,
  readCustomEvents,
  customEventHere,
  restoreValues,
  RULE_ENTITLEMENT_FIELDS,
  ruleEntitlement,
  sameAgentSelection,
  settingSecretKeys,
  warn,
} from './common.ts';

// Parts of a configuration that more steps point at
const CORRELATION = 'correlationConfiguration';
const UNIQUENESS = 'mappingConfiguration.uniquenessConfiguration';
const MAPPING_FIELDS = 'mappingConfiguration.fields';
const MAPPING_FIELD = 'mapping field ';
const PERMISSION_SET = 'permission set ';
const RESOURCE = 'resource ';

/** What to read per type of target system (CONNECTOR_EXPORTS); "configuration" replaces the list entry. */
export const CONNECTOR_EXPORTS: Record<string, (id: string) => { configuration: string; resources?: string }> = {
  'powershell-onpremise': (id) => ({ configuration: IMPORT_PATHS.powershellConfiguration(id), resources: IMPORT_PATHS.powershellResources(id) }),
  'powershell-target': (id) => ({ configuration: IMPORT_PATHS.powershellConfiguration(id), resources: IMPORT_PATHS.powershellResources(id) }),
  azuread: (id) => ({ configuration: IMPORT_PATHS.azureAdConfiguration(id) }),
  activedirectory: (id) => ({ configuration: IMPORT_PATHS.activeDirectoryConfiguration(id) }),
};

/** A file that says "partial": true: its mapping fields are merged by name, its values key by key. */
function mergeByField(configuration: Any, current: Any, file: Any): Any {
  const result: Any = { ...configuration };
  if (isPlainObject(file.scriptConfiguration)) {
    result.scriptConfiguration = mergeSettings(isPlainObject(current.scriptConfiguration) ? current.scriptConfiguration : {}, file.scriptConfiguration);
  }
  const currentFields: Any[] = current.mappingConfiguration?.fields ?? [];
  const fileFields: Any[] | null = Array.isArray(file.mappingConfiguration?.fields) ? file.mappingConfiguration.fields : null;
  const fields = !fileFields
    ? currentFields
    : [
        ...currentFields.map((field) => {
          const mine = fileFields.find((f) => f.name === field.name);
          return mine ? { ...mine, identifier: field.identifier } : field;
        }),
        ...fileFields.filter((f) => !currentFields.some((c) => c.name === f.name)).map((f) => ({ ...f, identifier: f.identifier ?? `new:${f.name}` })),
      ];
  const idOf = (ref: Any) => {
    if (ref === null || ref === undefined) return ref;
    const name = fileFields?.find((f) => f.identifier === ref)?.name ?? currentFields.find((f) => f.identifier === ref)?.name ?? ref;
    return fields.find((f) => f.name === name)?.identifier ?? ref;
  };
  result.mappingConfiguration = { ...result.mappingConfiguration, fields };
  const unique = result.mappingConfiguration.uniquenessConfiguration;
  if (Array.isArray(unique?.selectedUniqueFields)) {
    result.mappingConfiguration.uniquenessConfiguration = { ...unique, selectedUniqueFields: unique.selectedUniqueFields.map(idOf) };
  }
  if (isPlainObject(result.correlationConfiguration)) {
    const correlation: Any = result.correlationConfiguration;
    result.correlationConfiguration = { ...correlation, accountFieldId: idOf(correlation.accountFieldId) };
    if (correlation.enabled === true && !fields.some((f) => f.identifier === result.correlationConfiguration.accountFieldId)) {
      throw new Error(`Correlation is on, but its field (${correlation.accountFieldId}) is not in the file's ` + "mapping nor in the system's. Nothing was imported.");
    }
  }
  return result;
}

const GENERAL_FIELDS = ['displayName', 'description', 'icon', 'isDisabled', 'executeOnPremises', 'limitConcurrentActionsConfiguration'];

/** A system the file's system depends on, as it is here: by its ID, or by its name (unless matchByName is false). */
const findDependency = (dependency: Any, systems: Any[]) =>
  systems.find((s) => s.systemId === dependency.systemId) ??
  systems.find(
    (s) =>
      dependency.matchByName !== false &&
      typeof dependency.displayName === 'string' &&
      typeof s.displayName === 'string' &&
      s.displayName.trim() === dependency.displayName.trim(),
  );

/** The file's dependencies with the IDs they have here, without the ones that aren't here. */
const resolveDependencies = (configuration: Any, systems: Any[]) =>
  ((configuration.dependOnSystems ?? []) as Any[])
    .filter((d) => findDependency(d, systems))
    .map(({ displayName, matchByName, ...d }: Any) => ({ ...d, systemId: findDependency({ displayName, ...d }, systems).systemId }));

/** For the user: the dependencies that are left out, if any. */
function missingDependencies(configuration: Any, systems: Any[]): string {
  const missing = ((configuration.dependOnSystems ?? []) as Any[]).filter((d) => !findDependency(d, systems));
  if (!missing.length) return '';
  return warn(
    '\n\nThe system depends on systems whose ID is not in this HelloID environment. They are ' +
      'left out of "Depends on systems"; add them by hand when needed:\n' +
      missing.map((d) => `  - ${d.displayName ?? '?'} (ID ${d.systemId})`).join('\n'),
  );
}

const matchingResource = (resource: Any, resources: Any[]) =>
  resources.find((o) => o.resourceDefinitionId === resource.resourceDefinitionId) ?? resources.find((o) => o.displayName === resource.displayName);

/** Name of the mapping field with this ID. */
const mappingFieldName = (configuration: Any, identifier: Any) =>
  ((configuration.mappingConfiguration?.fields ?? []) as Any[]).find((f) => f.identifier === identifier)?.name ?? identifier;

const MAPPING_TYPES: Record<string, string> = { 1: 'Text', 2: 'Array' };
const MAPPING_MODES: Record<string, string> = { 0: 'None', 1: 'Fixed', 2: 'Field', 3: 'Complex' };
const MAPPING_ACTIONS: Record<string, string> = { 1: 'Create', 2: 'Enable', 3: 'Update', 4: 'Disable', 5: 'Delete' };

function mappingName(names: Record<string, string>, number: Any, what: string, field: Any): string {
  if (!(number in names)) throw new Error(`Mapping field "${field.name}" has ${what} ${number}, which this script doesn't know.`);
  return names[number]!;
}

/** Names of the parts of a configuration (or of a step's body) that differ from the system's current one. */
export function changedParts(body: Any, currentBody: Any): string[] {
  const same = (a: Any, b: Any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const keysOf = (...objects: Any[]) => [...new Set(objects.flatMap((o) => Object.keys(o ?? {})))];
  return keysOf(body, currentBody).flatMap((key): string[] => {
    if (key === 'mappingConfiguration') {
      const withoutIds = ({ identifier, mappingActions, ...field }: Any) => ({
        ...field,
        mappingActions: ((mappingActions ?? []) as Any[]).map(({ mappingActionId, ...action }: Any) => ({ ...action, value: action.value ?? '' })),
      });
      const fieldsOf = (c: Any) => new Map<string, Any>(((c.mappingConfiguration?.fields ?? []) as Any[]).map((f) => [f.name, withoutIds(f)]));
      const mine = fieldsOf(body);
      const theirs = fieldsOf(currentBody);
      const restOf = (c: Any) => {
        const { fields, ...rest } = c.mappingConfiguration ?? {};
        const unique = rest.uniquenessConfiguration;
        return !unique
          ? rest
          : {
              ...rest,
              uniquenessConfiguration: {
                ...unique,
                selectedUniqueFields: ((unique.selectedUniqueFields ?? []) as Any[]).map((id) => mappingFieldName(c, id)).sort(),
              },
            };
      };
      const rest = restOf(body);
      const currentRest = restOf(currentBody);
      return [
        ...[...mine.values()]
          .filter((f) => !same(f, theirs.get(f.name)))
          .map((f) => `${MAPPING_FIELD}"${f.name}"${theirs.has(f.name) ? '' : ' (not in the system)'}`),
        ...[...theirs.values()].filter((f) => !mine.has(f.name)).map((f) => `${MAPPING_FIELD}"${f.name}" (not in the file)`),
        ...changedParts(rest, currentRest).map((c) => `mappingConfiguration.${c}`),
      ];
    }
    if (key === 'resources') {
      if (!Array.isArray(body.resources) || !Array.isArray(currentBody.resources)) return [];
      const mine: Any[] = body.resources;
      const theirs: Any[] = currentBody.resources;
      const withoutIds = ({ systemId, resourceDefinitionId, ...resource }: Any) => resource;
      return [
        ...mine.filter((r) => !matchingResource(r, theirs)).map((r) => `${RESOURCE}"${r.displayName}" (not in the system)`),
        ...mine
          .filter((r) => matchingResource(r, theirs) && !same(withoutIds(r), withoutIds(matchingResource(r, theirs))))
          .map((r) => `${RESOURCE}"${r.displayName}"`),
        ...theirs.filter((r) => !matchingResource(r, mine)).map((r) => `${RESOURCE}"${r.displayName}" (not in the file)`),
      ];
    }
    if (key === 'permissions') {
      const mine: Any[] = body.permissions ?? [];
      const theirs: Any[] = currentBody.permissions ?? [];
      const match = (set: Any, sets: Any[]) => sets.find((o) => o.identification === set.identification) ?? sets.find((o) => o.displayName === set.displayName);
      const withoutId = ({ identification, ...set }: Any) => set;
      return [
        ...mine.filter((set) => !match(set, theirs)).map((set) => `${PERMISSION_SET}"${set.displayName}" (not in the system)`),
        ...mine.filter((set) => match(set, theirs) && !same(withoutId(set), withoutId(match(set, theirs)))).map((set) => `${PERMISSION_SET}"${set.displayName}"`),
        ...theirs.filter((set) => !match(set, mine)).map((set) => `${PERMISSION_SET}"${set.displayName}" (not in the file)`),
      ];
    }
    if (key === CORRELATION) {
      const named = (c: Any) => c[CORRELATION] && { ...c[CORRELATION], accountFieldId: mappingFieldName(c, c[CORRELATION].accountFieldId) };
      return same(named(body), named(currentBody)) ? [] : [key];
    }
    if (key === 'dependOnSystems') {
      const ids = (c: Any) => ((c.dependOnSystems ?? []) as Any[]).map((d) => d.systemId).sort().join();
      return ids(body) === ids(currentBody) ? [] : [key];
    }
    if (key === 'scripts') {
      return keysOf(body.scripts, currentBody.scripts)
        .filter((s) => !same(body.scripts?.[s], currentBody.scripts?.[s]))
        .map((s) => `scripts.${s}`);
    }
    return same(body[key], currentBody[key]) ? [] : [key];
  });
}

/** Secrets that were left out of the file ("***") keep the value the system has now. */
function restoreSecrets(configuration: Any, current: Any): Any {
  const restored: Any = { ...configuration };
  settingSecretKeys(configuration).forEach(([group, key]) => {
    if (group) {
      if (restored[group][key] !== EXPORT_MASK) return;
      restored[group] = { ...restored[group], [key]: current[group]?.[key] ?? null };
    } else if (restored[key] === EXPORT_MASK) {
      restored[key] = current[key] ?? null;
    }
  });
  if (!isPlainObject(configuration.scriptConfiguration)) return restored;
  const values: Any = { ...configuration.scriptConfiguration };
  Object.keys(values).forEach((key) => {
    if (values[key] === EXPORT_MASK) values[key] = current.scriptConfiguration?.[key] ?? null;
  });
  return { ...restored, scriptConfiguration: values };
}

/** Two notifications with the same content? Not counting when they were changed and what HelloID fills in itself. */
export function sameNotification(a: Any, b: Any): boolean {
  const content = ({ lastChange, tenantUrl, configuration, ...rest }: Any) => {
    const { verifiedDomains, ...mail } = configuration ?? {};
    return { ...rest, configuration: mail };
  };
  const ordered = (value: Any): Any =>
    Array.isArray(value)
      ? value.map(ordered)
      : isPlainObject(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .filter((k) => value[k] !== null && value[k] !== undefined)
              .map((k) => [k, ordered(value[k])]),
          )
        : (value ?? null);
  return JSON.stringify(ordered(content(a))) === JSON.stringify(ordered(content(b)));
}

/** The import of target systems of one environment. */
export function targetSystemImport(env: PlannerEnv) {
  const { gw } = env;
  const fetchFromGateway = (path: string) => gw.fetch(path);
  const sendToGateway = (path: string, method: string, body?: unknown) => gw.send(path, method, body);

  // For every type: these are stored apart from the type's configuration
  const SHARED_IMPORT_STEPS: Any[] = [
    {
      name: 'Depends on systems',
      keys: ['dependOnSystems'],
      path: (id: string) => IMPORT_PATHS.dependOnSystems(id),
      method: 'POST',
      body: (configuration: Any, _current: Any, systems: Any[]) => ({
        dependOnSystems: ((configuration.dependOnSystems ?? []) as Any[])
          .map((dependency) => findDependency(dependency, systems))
          .filter(Boolean)
          .map((system: Any) => ({
            systemId: system.systemId,
            displayName: system.displayName,
            internalSystemReferenceName: system.internalSystemReferenceName,
            templateIdentifier: system.templateIdentifier,
          })),
      }),
      changes: (configuration: Any, current: Any) => {
        const ids = (c: Any) => ((c.dependOnSystems ?? []) as Any[]).map((d) => d.systemId).sort().join();
        return ids(configuration) === ids(current) ? [] : ['dependOnSystems'];
      },
    },
    {
      name: 'Agents for on-premises execution',
      keys: ['agentSelection'],
      path: (id: string) => IMPORT_PATHS.agentSelection(id),
      method: 'POST',
      body: (configuration: Any) => configuration.agentSelection ?? [],
      changes: (configuration: Any, current: Any) =>
        sameAgentSelection(configuration.agentSelection, current.agentSelection) ? [] : ['agentSelection'],
    },
  ];

  // The requests that make the system's permission sets those of the file: one per set to add,
  // one per set to delete, and a last one for what changed in the sets that stay
  const PERMISSIONS_PATH = (id: string) => IMPORT_PATHS.powershellPart(id, 'permissions');
  function permissionRequests(configuration: Any, current: Any): Any[] {
    const match = (set: Any, sets: Any[]) => sets.find((o) => o.identification === set.identification) ?? sets.find((o) => o.displayName === set.displayName);
    const withoutId = ({ identification, ...set }: Any) => JSON.stringify(set);
    const fileSets: Any[] = configuration.permissions ?? [];
    const currentSets: Any[] = current.permissions ?? [];
    const read = async (id: string): Promise<Any[]> => (await fetchFromGateway(IMPORT_PATHS.powershellConfiguration(id))).permissions ?? [];
    const send = (id: string, permissions: Any[]) => sendToGateway(PERMISSIONS_PATH(id), 'POST', { permissions });
    const changed = fileSets.some((set) => match(set, currentSets) && withoutId(set) !== withoutId(match(set, currentSets)));
    return [
      ...fileSets
        .filter((set) => !match(set, currentSets))
        .map((set) => ({ name: `Permission set "${set.displayName}" (new)`, run: async (id: string) => send(id, [...(await read(id)), set]) })),
      ...currentSets
        .filter((set) => !match(set, fileSets))
        .map((set) => ({
          name: `Permission set "${set.displayName}" (delete)`,
          run: async (id: string) => {
            const now = await read(id);
            const gone = match(set, now);
            if (gone) await send(id, now.filter((o) => o !== gone));
          },
        })),
      ...(!changed
        ? []
        : [
            {
              name: 'Permission sets (changes)',
              run: async (id: string) => {
                const now = await read(id);
                await send(id, fileSets.map((set) => ({ ...set, identification: match(set, now)?.identification ?? set.identification })));
              },
            },
          ]),
    ];
  }

  const POWERSHELL_IMPORT_STEPS: Any[] = [
    {
      name: 'General settings',
      keys: GENERAL_FIELDS,
      path: (id: string) => IMPORT_PATHS.powershellPart(id, 'general'),
      method: 'POST',
      body: (configuration: Any) => Object.fromEntries(GENERAL_FIELDS.map((f) => [f, configuration[f]])),
    },
    ...SHARED_IMPORT_STEPS,
    {
      name: 'Configuration values',
      keys: ['scriptConfiguration'],
      path: (id: string) => IMPORT_PATHS.powershellPart(id, 'script-configuration'),
      method: 'POST',
      body: (configuration: Any) => ({ scriptConfiguration: configuration.scriptConfiguration }),
    },
    {
      name: 'Account scripts and configuration form',
      keys: ['scripts', 'scriptConfigurationForm'],
      path: (id: string) => IMPORT_PATHS.powershellPart(id, 'account'),
      method: 'POST',
      body: (configuration: Any) => ({
        scripts: Object.fromEntries(Object.entries(configuration.scripts ?? {}).filter(([key]) => key.startsWith('account'))),
        scriptConfigurationForm: configuration.scriptConfigurationForm,
        scriptConfiguration: configuration.scriptConfiguration,
      }),
    },
    {
      name: 'Thresholds',
      keys: ['thresholds'],
      path: (id: string) => IMPORT_PATHS.powershellPart(id, 'thresholds'),
      method: 'POST',
      body: (configuration: Any) => configuration.thresholds ?? [],
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c === 'thresholds'),
    },
    {
      name: 'Resources',
      keys: ['resources'],
      path: (id: string) => IMPORT_PATHS.powershellResources(id),
      method: 'POST',
      body: (configuration: Any, current: Any) =>
        ((configuration.resources ?? []) as Any[]).map((resource) => ({
          ...resource,
          systemId: current.systemId,
          resourceDefinitionId:
            matchingResource(resource, current.resources ?? [])?.resourceDefinitionId ?? (current.isNew ? env.uuid() : resource.resourceDefinitionId),
        })),
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c.startsWith(RESOURCE)),
    },
    {
      name: 'Permissions',
      keys: ['permissions'],
      note: 'set by set: adds the new ones, deletes the ones that are not in the file, then changes the others',
      requests: permissionRequests,
      path: PERMISSIONS_PATH,
      method: 'POST',
      body: (configuration: Any) => ({ permissions: configuration.permissions ?? [] }),
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c.startsWith(PERMISSION_SET)),
    },
    {
      name: 'Mapping (all fields)',
      keys: [MAPPING_FIELDS],
      resetsFieldIds: true,
      note: 'replaces the whole mapping: turns correlation off, deletes all fields, then adds those of the file',
      before: [
        {
          name: 'Turn correlation off',
          when: (current: Any) => current.correlationConfiguration?.enabled === true,
          path: (id: string) => IMPORT_PATHS.powershellPart(id, 'correlation-configuration'),
          method: 'POST',
          body: (_configuration: Any, current: Any) => ({ ...current.correlationConfiguration, enabled: false }),
        },
        {
          name: 'Delete all mapping fields',
          path: (id: string) => IMPORT_PATHS.powershellMapping(id, 'fields'),
          method: 'DELETE',
        },
      ],
      path: (id: string) => IMPORT_PATHS.powershellMapping(id, 'import'),
      method: 'POST',
      body: (configuration: Any) => ({
        Version: 'v1',
        MappingFields: ((configuration.mappingConfiguration?.fields ?? []) as Any[]).map((field) => ({
          Name: field.name,
          Description: field.description,
          Type: mappingName(MAPPING_TYPES, field.type, 'type', field),
          MappingActions: ((field.mappingActions ?? []) as Any[]).map((action) => ({
            MapForActions: ((action.entitlementActions ?? []) as Any[]).map((n) => mappingName(MAPPING_ACTIONS, n, 'action', field)),
            MappingMode: mappingName(MAPPING_MODES, action.mode, 'mode', field),
            Value: JSON.stringify(action.value ?? null),
            UsedInNotifications: action.usedInNotifications === true,
            StoreInAccountData: action.storeInAccountData === true,
          })),
        })),
        UniqueFieldNames: ((configuration.mappingConfiguration?.uniquenessConfiguration?.selectedUniqueFields ?? []) as Any[]).map((id) =>
          mappingFieldName(configuration, id),
        ),
      }),
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c.startsWith(MAPPING_FIELD)),
    },
    {
      name: 'Uniqueness check',
      keys: [UNIQUENESS],
      usesFieldIds: true,
      path: (id: string) => IMPORT_PATHS.powershellMapping(id, 'uniqueness'),
      method: 'POST',
      body: (configuration: Any, current: Any) => {
        const { script, mappingEntitlementActions, selectedUniqueFields } = configuration.mappingConfiguration?.uniquenessConfiguration ?? {};
        const currentFields: Any[] = current.mappingConfiguration?.fields ?? [];
        return {
          script,
          mappingEntitlementActions,
          selectedUniqueFields: ((selectedUniqueFields ?? []) as Any[]).map((id) => {
            const name = mappingFieldName(configuration, id);
            const field = currentFields.find((f) => f.name === name);
            if (!field) throw new Error(`The unique field "${name}" is not in the mapping.`);
            return field.identifier;
          }),
        };
      },
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c === UNIQUENESS),
    },
    {
      name: 'Correlation',
      keys: [CORRELATION],
      usesFieldIds: true,
      applies: (configuration: Any) =>
        configuration.correlationConfiguration?.enabled === true ||
        ((configuration.mappingConfiguration?.fields ?? []) as Any[]).some((f) => f.identifier === configuration.correlationConfiguration?.accountFieldId),
      path: (id: string) => IMPORT_PATHS.powershellPart(id, 'correlation-configuration'),
      method: 'POST',
      body: (configuration: Any, current: Any) => {
        const { enabled, accountFieldId, personPropertyPath } = configuration.correlationConfiguration ?? {};
        const name = mappingFieldName(configuration, accountFieldId);
        const field = ((current.mappingConfiguration?.fields ?? []) as Any[]).find((f) => f.name === name);
        if (enabled && !field) {
          const inFile = ((configuration.mappingConfiguration?.fields ?? []) as Any[]).some((f) => f.identifier === accountFieldId);
          throw new Error(
            inFile
              ? `Correlation is on in the file, but its field ("${name}") is not in the mapping of the system.`
              : 'Correlation is on in the file, but correlationConfiguration.accountFieldId ' +
                  `(${accountFieldId}) is not the identifier of a mapping field in the file. ` +
                  'Set it to the identifier of the field to correlate on.',
          );
        }
        return { enabled: enabled === true, accountFieldId: field?.identifier ?? null, personPropertyPath };
      },
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c === CORRELATION),
    },
  ];

  // Built-in Active Directory
  const AD_GENERAL_FIELDS = ['domain', 'selectedDomainControllers', 'manualDomainControllerSelection', 'description', 'displayName', 'isDisabled'];
  function adFieldRequests(configuration: Any, current: Any): Any[] {
    const fieldPath = (id: string, identifier?: string) =>
      IMPORT_PATHS.activeDirectoryMapping(id, 'field') + (identifier ? `/${encodeURIComponent(identifier)}` : '');
    const withoutIds = ({ identifier, mappingActions, ...field }: Any) =>
      JSON.stringify({ ...field, mappingActions: ((mappingActions ?? []) as Any[]).map(({ mappingActionId, ...action }: Any) => action) });
    const bodyFor = (field: Any, mine: Any) => ({
      type: field.type,
      mappingActions: ((field.mappingActions ?? []) as Any[]).map((action, i) => ({
        ...action,
        mappingActionId: mine.mappingActions?.[i]?.mappingActionId ?? env.uuid(),
      })),
      configuredForActions: [...new Set(((field.mappingActions ?? []) as Any[]).flatMap((a) => a.entitlementActions ?? []))],
      identifier: mine.identifier,
      name: field.name,
      description: field.description,
      useInNotificationsForActions: '',
      storeInAccountDataForActions: '',
    });
    const currentFields: Any[] = current.mappingConfiguration?.fields ?? [];
    const fileFields: Any[] = configuration.mappingConfiguration?.fields ?? [];
    const known = new Set(currentFields.map((f) => f.identifier));

    const makeField = async (id: string): Promise<Any> => {
      await sendToGateway(fieldPath(id), 'POST', {});
      for (let attempt = 0; ; attempt++) {
        const now = await fetchFromGateway(CONNECTOR_EXPORTS.activedirectory!(id).configuration);
        const made = ((now.mappingConfiguration?.fields ?? []) as Any[]).filter((f) => !known.has(f.identifier));
        if (made.length === 1) {
          known.add(made[0].identifier);
          return made[0];
        }
        if (made.length > 1 || attempt >= 9) throw new Error(`A new mapping field was made, but HelloID shows ${made.length} new fields.`);
        await env.sleep(1000);
      }
    };

    const requests: Any[] = fileFields.flatMap((field): Any[] => {
      const mine = currentFields.find((f) => f.name === field.name);
      if (!mine) {
        return [
          {
            name: `Mapping field "${field.name}" (new)`,
            run: async (id: string) => {
              const made = await makeField(id);
              await sendToGateway(fieldPath(id, made.identifier), 'POST', bodyFor(field, made));
            },
          },
        ];
      }
      if (withoutIds(mine) === withoutIds(field)) return [];
      const body = bodyFor(field, mine);
      return [{ name: `Mapping field "${field.name}"`, path: (id: string) => fieldPath(id, mine.identifier), method: 'POST', body: () => body }];
    });
    currentFields
      .filter((f) => !fileFields.some((o) => o.name === f.name))
      .forEach((f) => requests.push({ name: `Mapping field "${f.name}" (delete)`, path: (id: string) => fieldPath(id, f.identifier), method: 'DELETE' }));
    if (requests.length) requests[requests.length - 1].resetsFieldIds = true;
    return requests;
  }

  const AD_ADMINISTRATION_FIELDS = [
    'deleteAccounts',
    'managerSettings',
    'container',
    'containerSelectionType',
    'containerSelectorPowershellScript',
    ...['enable', 'disable', 'update'].flatMap((action) => [
      `${action}Container`,
      `${action}ContainerSelectionType`,
      `${action}ContainerSelectorPowershellScript`,
      `moveOn${action[0]!.toUpperCase()}${action.slice(1)}`,
    ]),
  ];
  const uniqueFieldIds = (configuration: Any, current: Any) =>
    ((configuration.mappingConfiguration?.uniquenessConfiguration?.selectedUniqueFields ?? []) as Any[]).map((id) => {
      const name = mappingFieldName(configuration, id);
      const field = ((current.mappingConfiguration?.fields ?? []) as Any[]).find((f) => f.name === name);
      if (!field) throw new Error(`The unique field "${name}" is not in the mapping of the system.`);
      return field.identifier;
    });
  const ACTIVE_DIRECTORY_IMPORT_STEPS: Any[] = [
    {
      name: 'General settings',
      keys: AD_GENERAL_FIELDS,
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'general'),
      method: 'POST',
      body: (configuration: Any) => Object.fromEntries(AD_GENERAL_FIELDS.map((f) => [f, configuration[f]])),
    },
    ...SHARED_IMPORT_STEPS,
    {
      name: 'Exchange',
      keys: ['exchangeConfiguration'],
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'exchange'),
      method: 'POST',
      body: (configuration: Any) => configuration.exchangeConfiguration,
      changes: (configuration: Any, current: Any) =>
        JSON.stringify(configuration.exchangeConfiguration ?? null) === JSON.stringify(current.exchangeConfiguration ?? null) ? [] : ['exchangeConfiguration'],
    },
    {
      name: 'Directories',
      keys: ['directories'],
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'directories'),
      method: 'POST',
      body: (configuration: Any) => configuration.directories,
      changes: (configuration: Any, current: Any) =>
        JSON.stringify(configuration.directories ?? null) === JSON.stringify(current.directories ?? null) ? [] : ['directories'],
    },
    {
      name: 'Field mapping',
      keys: [MAPPING_FIELDS],
      note: 'field by field: changes them, adds the new ones, deletes the ones that are not in the file',
      resetsFieldIds: true,
      requests: adFieldRequests,
      body: (configuration: Any, current: Any) => adFieldRequests(configuration, current).map((r) => r.body?.()),
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c.startsWith(MAPPING_FIELD)),
    },
    {
      name: 'Administration (delete accounts, manager, containers)',
      keys: AD_ADMINISTRATION_FIELDS,
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'administration'),
      method: 'POST',
      body: (configuration: Any) => {
        const container = (action?: string, move?: string) => ({
          container: configuration[action ? `${action}Container` : 'container'],
          containerSelectionType: configuration[action ? `${action}ContainerSelectionType` : 'containerSelectionType'],
          containerSelectorPowershellScript: configuration[action ? `${action}ContainerSelectorPowershellScript` : 'containerSelectorPowershellScript'],
          ...(action ? { move: configuration[move!] } : {}),
        });
        return {
          deleteAccounts: configuration.deleteAccounts,
          managerSettings: configuration.managerSettings,
          defaultContainer: container(),
          enableContainer: container('enable', 'moveOnEnable'),
          disableContainer: container('disable', 'moveOnDisable'),
          updateContainer: container('update', 'moveOnUpdate'),
        };
      },
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => AD_ADMINISTRATION_FIELDS.includes(c)),
    },
    {
      name: 'Thresholds',
      keys: ['thresholds'],
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'thresholds'),
      method: 'POST',
      body: (configuration: Any) => configuration.thresholds,
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c === 'thresholds'),
    },
    {
      name: 'Uniqueness check',
      keys: [UNIQUENESS],
      usesFieldIds: true,
      path: (id: string) => IMPORT_PATHS.activeDirectoryMapping(id, 'uniqueness'),
      method: 'POST',
      body: (configuration: Any, current: Any) => {
        const { script, mappingEntitlementActions } = configuration.mappingConfiguration?.uniquenessConfiguration ?? {};
        return { script, mappingEntitlementActions, selectedUniqueFields: uniqueFieldIds(configuration, current) };
      },
      changes: (configuration: Any, current: Any) => changedParts(configuration, current).filter((c) => c === UNIQUENESS),
    },
    {
      name: 'Account settings (sync unique fields, configuration form, post-action scripts)',
      keys: ['syncUniqueFields', 'scriptConfigurationForm', 'postActionPowerShellConfiguration'],
      usesFieldIds: true,
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'account'),
      method: 'POST',
      body: (configuration: Any, current: Any, systems: Any[]) => ({
        selectedUniqueFields: uniqueFieldIds(configuration, current),
        syncUniqueFields: configuration.syncUniqueFields,
        ...SHARED_IMPORT_STEPS[0].body(configuration, current, systems),
        scriptConfigurationForm: configuration.scriptConfigurationForm,
        postActionPowerShellConfiguration: configuration.postActionPowerShellConfiguration,
      }),
      changes: (configuration: Any, current: Any) =>
        changedParts(configuration, current).filter((c) => ['syncUniqueFields', 'scriptConfigurationForm', 'postActionPowerShellConfiguration'].includes(c)),
    },
    {
      ...POWERSHELL_IMPORT_STEPS.find((step) => step.name === 'Correlation'),
      path: (id: string) => IMPORT_PATHS.activeDirectoryPart(id, 'correlate'),
    },
  ];

  const IMPORT_STEPS: Record<string, Any[]> = {
    'powershell-onpremise': POWERSHELL_IMPORT_STEPS,
    'powershell-target': POWERSHELL_IMPORT_STEPS,
    activedirectory: ACTIVE_DIRECTORY_IMPORT_STEPS,
  };

  // --- Notifications of the system ---
  function notificationFor(notification: Any, identifier: string, fileSystemId: Any, system: Any): Any {
    const { couldNotRead, customEventName, ...rest } = notification;
    return {
      ...rest,
      identifier,
      systemId: system.systemId,
      tenantUrl: env.origin,
      dataReferences: ((notification.dataReferences ?? []) as Any[]).map((r) => (r?.systemId === fileSystemId ? { ...r, systemId: system.systemId } : r)),
    };
  }

  async function notificationRequests(data: Any, fileSystemId: Any, system: Any): Promise<{ requests: Any[]; skipped: string }> {
    const all = ((Array.isArray(data.notifications) ? data.notifications : []) as Any[]).filter(
      (n) => isPlainObject(n) && !n.couldNotRead && isPlainObject(n.configuration),
    );
    if (!all.length) return { requests: [], skipped: '' };
    const senders: Any[] = await fetchFromGateway(IMPORT_PATHS.notificationSystems);
    const senderHere = (id: Any) => {
      if (!id || senders.some((s) => s?.systemId === id)) return id;
      const name = ((data.notificationSystems ?? []) as Any[]).find((s) => s?.systemId === id)?.displayName;
      return senders.find((s) => typeof name === 'string' && s?.displayName === name)?.systemId;
    };
    const unsendable = all.filter((n) => n.notificationSystemId && !senderHere(n.notificationSystemId));
    let skipped = !unsendable.length
      ? ''
      : warn(
          '\n\nThese notifications of the file are not imported: what sends them (their notification ' +
            'system) is not in this HelloID environment:\n' +
            unsendable.map((n) => `  - ${n.name}`).join('\n'),
        );
    const events = all.some((n) => n.customEventId) ? await readCustomEvents(env) : [];
    const eventless = all.filter((n) => !unsendable.includes(n) && n.customEventId && !customEventHere(n, events));
    if (eventless.length) {
      skipped += warn(
        '\n\nThese notifications of the file are not imported: their custom event is not in this ' +
          'HelloID environment (import the custom events first):\n' +
          eventless.map((n) => `  - ${n.name} (${n.customEventName ?? n.customEventId})`).join('\n'),
      );
    }
    const inFile = all
      .filter((n) => !unsendable.includes(n) && !eventless.includes(n))
      .map((n) => ({
        ...n,
        notificationSystemId: senderHere(n.notificationSystemId),
        ...(n.customEventId ? { customEventId: customEventHere(n, events).customEventId } : {}),
      }));
    const list = await fetchFromGateway(IMPORT_PATHS.allNotifications(FETCH_ALL_TAKE));
    const here = ((list.pageData ?? []) as Any[]).filter((n) => n?.systemId === system.systemId);
    const taken = new Set();
    const requests: Any[] = [];
    for (const notification of inFile) {
      const match =
        here.find((n) => !taken.has(n) && n.identifier === notification.identifier) ??
        here.find((n) => !taken.has(n) && n.event === notification.event && n.name === notification.name);
      if (match) taken.add(match);
      const current = match ? await fetchFromGateway(IMPORT_PATHS.notification(match.identifier)) : null;
      const body = notificationFor(notification, match?.identifier ?? env.uuid(), fileSystemId, system);
      // Secrets the file left out ("***") keep the value they have here
      if (isPlainObject(body.notificationTemplateData)) {
        body.notificationTemplateData = restoreValues(body.notificationTemplateData, current?.notificationTemplateData);
      }
      if (match && sameNotification(body, current)) continue;
      requests.push({
        name: `Notification "${notification.name}" (${match ? 'change' : 'new'})`,
        identifier: match?.identifier,
        newNotification: match ? null : { kind: 'notification', id: body.identifier, name: notification.name ?? null },
        path: () => IMPORT_PATHS.notifications,
        method: 'POST',
        body: () => body,
      });
    }
    return { requests, skipped };
  }

  // --- The business rule links ---
  const RETRIEVE_WAIT_MS = 15000;
  const RETRIEVE_POLL_MS = 3000;

  async function ruleRequests(data: Any, system: Any, created: boolean, auto: Auto): Promise<Any> {
    const requests: Any[] = [];
    const drafts = new Set<string>();
    /** (not in the userscript) the rules it may save, for the fingerprints and the audit */
    const ruleIds = new Set<string>();
    let missing: Any[] = [];
    const notes: string[] = [];
    let retrieving = false;
    const result = {
      requests,
      ruleIds,
      drafts: () => drafts.size,
      get skipped() {
        const lines = [
          ...notes,
          ...missing
            .filter((m) => !(retrieving && m.entitlement.type === 'Permission'))
            .map((m) => `"${m.name}": ${entitlementLabel(m.entitlement)} is not an entitlement of the system`),
        ];
        return !lines.length ? '' : warn(`\n\nNot linked in business rules:\n${lines.map((line) => `  - ${line}`).join('\n')}`);
      },
    };

    const fileRules = ((Array.isArray(data.rules) ? data.rules : []) as Any[]).filter((r) => isPlainObject(r) && r.ruleId && Array.isArray(r.entitlements));
    if (!Array.isArray(data.rules) || !Array.isArray(data.usedBy) || (data.rules.length && !fileRules.length)) return result;

    const readAvailable = async () => {
      const list = await fetchFromGateway(IMPORT_PATHS.ruleEntitlements(FETCH_ALL_TAKE));
      return ((list.pageData ?? list ?? []) as Any[])
        .filter((row) => row?.inTargetSystem !== false)
        .map((row) => ruleEntitlement(row, system))
        .filter((e) => e.entitlementId && e.systemIdentifier === system.systemId);
    };
    let available: Any[];
    try {
      available = await readAvailable();
    } catch (e: Any) {
      notes.push(`no rule was linked: HelloID did not return the list of entitlements (${e?.message ?? e})`);
      return result;
    }
    const sameName = (a: Any, b: Any) => a.type === b.type && a.displayName === b.displayName;
    const here = (entitlement: Any, list: Any[] = available) =>
      list.find((a) => a.entitlementId === entitlement.entitlementId) ??
      list.find((a) => sameName(a, entitlement) && (a.permissionDefinitionDisplayName ?? null) === (entitlement.permissionDefinitionDisplayName ?? null)) ??
      (list.filter((a) => sameName(a, entitlement)).length === 1 ? list.find((a) => sameName(a, entitlement)) : undefined);

    const readRule = (ruleId: string) => fetchFromGateway(IMPORT_PATHS.rule(ruleId));
    const ofSystem = (rule: Any): Any[] => ((rule.entitlements ?? []) as Any[]).filter((e) => e?.systemIdentifier === system.systemId);
    const withEntitlements = (rule: Any, add: Any[], remove: Any[] = []) => ({
      ...rule,
      entitlements: [...((rule.entitlements ?? []) as Any[]).filter((e) => !remove.includes(e)), ...add],
    });

    const plans: Any[] = [];
    for (const fileRule of fileRules) {
      let rule: Any;
      try {
        rule = await readRule(fileRule.ruleId);
      } catch {
        if (fileRule.entitlements.length) notes.push(`"${fileRule.ruleName}": the rule is not in this HelloID environment`);
        continue;
      }
      const wanted: Any[] = [];
      (fileRule.entitlements as Any[]).forEach((entitlement) => {
        const found = here(entitlement);
        if (found) wanted.push(found);
        else missing.push({ ruleId: rule.ruleId, name: rule.name, entitlement });
      });
      const has = ofSystem(rule);
      plans.push({
        rule,
        add: wanted.filter((w) => !has.some((h) => h.entitlementId === w.entitlementId)),
        remove: has.filter(
          (h) =>
            !wanted.some((w) => w.entitlementId === h.entitlementId) &&
            !(fileRule.entitlements as Any[]).some((e) => e.entitlementId === h.entitlementId || sameName(e, h)),
        ),
      });
    }
    if (!created) {
      const overview = await fetchFromGateway(IMPORT_PATHS.entitlementsOverview(system.systemId, FETCH_ALL_TAKE));
      for (const row of (overview.pageData ?? []) as Any[]) {
        if (fileRules.some((r) => r.ruleId === row.ruleId) || !RULE_ENTITLEMENT_FIELDS.some((f) => row[f] === true)) continue;
        const rule = await readRule(row.ruleId);
        if (ofSystem(rule).length) plans.push({ rule, add: [], remove: ofSystem(rule) });
      }
    }

    const describe = (name: string, sign: string, entitlements: Any[]) => entitlements.map((e) => `${sign} "${name}": ${entitlementLabel(e)}`);
    const removals = plans.flatMap((plan) => describe(plan.rule.name, '-', plan.remove));
    let removing = false;
    if (removals.length) {
      const answer = auto.decide(`ruleRemovals:${system.systemId}`, {
        section: 'Business rules with entitlements that the file does not have',
        item: `"${system.displayName}"`,
        detail: removals.map((line) => `  ${line}`).join('\n'),
        options: [
          { value: true, label: 'Keep them', description: 'The rules keep these entitlements.' },
          {
            value: 'alternative',
            label: 'Take them out',
            description: 'The rules are saved as drafts without them; nothing changes until you publish those rules.',
          },
        ],
        default: true,
      });
      if (!answer) return null;
      removing = answer === 'alternative';
    }

    plans
      .filter((plan) => plan.add.length || (removing && plan.remove.length))
      .forEach((plan) => {
        const remove = removing ? plan.remove : [];
        const body = withEntitlements(plan.rule, plan.add, remove);
        ruleIds.add(plan.rule.ruleId);
        requests.push({
          name: `Business rule "${plan.rule.name}" (draft)`,
          changes: [...describe(plan.rule.name, '+', plan.add), ...describe(plan.rule.name, '-', remove)],
          run: async () => {
            await sendToGateway(IMPORT_PATHS.rules, 'POST', body);
            drafts.add(plan.rule.ruleId);
          },
        });
      });

    const missingPermissions = () => missing.filter((m) => m.entitlement.type === 'Permission');
    if (!missingPermissions().length) return result;
    const configuration = data.configuration ?? {};
    const leftOut =
      Object.values(configuration.scriptConfiguration ?? {}).includes(EXPORT_MASK) ||
      settingSecretKeys(configuration).some(([group, key]) => (group ? configuration[group][key] : configuration[key]) === EXPORT_MASK);
    if (created && leftOut) {
      notes.push("the permissions of the new system can't be retrieved before its secrets are set: " + 'set them, then import the file again to link the permissions');
      return result;
    }
    retrieving = true;
    missingPermissions().forEach((m) => ruleIds.add(m.ruleId));
    let retrieved = available;
    let failed = false;
    requests.push({
      name: 'Retrieve the permissions of the system',
      changes: ['lets HelloID retrieve the permissions of the system now (HelloID gives up after 30 seconds)'],
      run: async (id: string) => {
        try {
          await sendToGateway(IMPORT_PATHS.retrievePermissions(id), 'POST', {});
        } catch (e: Any) {
          notes.push(`HelloID could not retrieve the permissions of the system (${e?.message ?? e}): ` + 'check the system, then import the file again');
          failed = true;
          return;
        }
        retrieved = await readAvailable();
        const deadline = env.now() + RETRIEVE_WAIT_MS;
        while (missing.some((m) => !here(m.entitlement, retrieved)) && env.now() < deadline) {
          await env.sleep(RETRIEVE_POLL_MS);
          retrieved = await readAvailable();
        }
      },
    });
    requests.push({
      name: 'Link the retrieved permissions in business rules (drafts)',
      changes: missingPermissions().flatMap((m) => describe(m.name, '+', [m.entitlement])),
      run: async () => {
        retrieving = false;
        const found = missing.filter((m) => here(m.entitlement, retrieved));
        for (const ruleId of new Set<string>(found.map((m) => m.ruleId))) {
          const rule = await readRule(ruleId);
          const has = ofSystem(rule);
          const add = found
            .filter((m) => m.ruleId === ruleId)
            .map((m) => here(m.entitlement, retrieved))
            .filter((w, i, all) => all.indexOf(w) === i && !has.some((h) => h.entitlementId === w.entitlementId));
          if (!add.length) continue;
          await sendToGateway(IMPORT_PATHS.rules, 'POST', withEntitlements(rule, add));
          drafts.add(ruleId);
        }
        missing = missing.filter((m) => !found.includes(m));
        if (!failed && missing.some((m) => m.entitlement.type === 'Permission')) {
          notes.push('HelloID retrieved the permissions of the system, but these were not among them: ' + 'check the permission scripts of the system');
        }
      },
    });
    return result;
  }

  /** Makes a new, empty system for the file. Everything that can be checked is checked first. */
  async function createSystemFor(data: Any, fileName: string, systemId: Any, steps: Any[], systems: Any[]): Promise<Any> {
    const createPath = IMPORT_PATHS.createSystem[data.templateIdentifier];
    if (!createPath) {
      throw new Error(
        `The system of the file ("${fileName}", ID ${systemId}) was not found in this ` +
          `HelloID environment, and systems of type "${data.templateIdentifier}" can't be created.`,
      );
    }
    const name = data.configuration.displayName;
    if (typeof name === 'string' && (await fetchFromGateway(IMPORT_PATHS.targetNameExists(name))) === true) {
      throw new Error(
        `The system of the file (ID ${systemId}) was not found in this HelloID environment, ` +
          `and a new one can't be made: another target system is already named "${name}". ` +
          'Nothing was imported.',
      );
    }
    const configuration = { ...data.configuration, resources: data.resources };
    const empty = { systemId: '', isNew: true, resources: [], mappingConfiguration: configuration.mappingConfiguration };
    steps.forEach((step) => step.body(configuration, empty, systems));
    const newId = await sendToGateway(createPath, 'POST', {});
    if (typeof newId !== 'string' || !newId) throw new Error('HelloID did not return the ID of the new system. Check the list of target systems.');
    env.onCreated?.({ kind: 'targetSystem', id: newId, name: typeof name === 'string' ? name : null });
    return { systemId: newId, displayName: name, templateIdentifier: data.templateIdentifier };
  }

  /** After the mapping is replaced: the system with its new fields (HelloID may need a moment). */
  async function loadImportedFields(loadCurrent: () => Promise<Any>, fileFields: Any[]): Promise<Any> {
    for (let attempt = 0; ; attempt++) {
      const current = await loadCurrent();
      const names = new Set(((current.mappingConfiguration?.fields ?? []) as Any[]).map((f) => f.name));
      if (fileFields.every((f) => names.has(f.name))) return current;
      if (attempt >= 9) throw new Error('The mapping fields were sent, but HelloID does not show them (yet).');
      await env.sleep(1000);
    }
  }

  /**
   * importData with auto: with auto.plan, what would change (auto.planned / same / skip); without,
   * it writes. Throws on what stops the import.
   */
  async function importData(data: Any, { auto }: { auto: Auto }): Promise<Any> {
    if (!isPlainObject(data?.configuration) || typeof data.templateIdentifier !== 'string') {
      throw new Error('The file is not an export of a target system.');
    }
    const steps = IMPORT_STEPS[data.templateIdentifier];
    const byField = data.partial === true;
    const partial = byField;
    if (!steps) throw new Error(`Import is not supported for systems of type "${data.templateIdentifier}".`);
    const systemId = data.systemId ?? data.configuration.systemId;
    const fileName = data.displayName ?? data.configuration.displayName ?? '?';
    if (!systemId) throw new Error('The file has no system ID. Export the system again.');

    const fileFields: Any[] = data.configuration.mappingConfiguration?.fields ?? [];
    const fileCorrelation = data.configuration.correlationConfiguration;
    if (!byField && fileCorrelation?.enabled === true && !fileFields.some((f) => f.identifier === fileCorrelation.accountFieldId)) {
      throw new Error(
        'Correlation is on in the file, but its field (correlationConfiguration.accountFieldId: ' +
          `${fileCorrelation.accountFieldId}) is not in the mapping of the file. ` +
          'Nothing was imported.',
      );
    }

    const systems = await fetchSystems(env);
    const onlyByName = (d: Any) => !systems.some((s) => s.systemId === d.systemId) && findDependency(d, systems);
    const byName = ((data.configuration.dependOnSystems ?? []) as Any[]).filter(onlyByName).map((d) => {
      const found = findDependency(d, systems);
      const type =
        found.templateIdentifier === d.templateIdentifier
          ? `type ${found.templateIdentifier}`
          : `type ${found.templateIdentifier}, NOT the type in the file (${d.templateIdentifier})`;
      return `  - "${found.displayName}": ID in the file ${d.systemId}, ID here ${found.systemId} (${type})`;
    });
    if (byName.length) {
      const answer = auto.decide(`dependsByName:${systemId}`, {
        section: 'Dependencies found only by name',
        item: `"${fileName}"`,
        detail: byName.join('\n'),
        options: [
          { value: true, label: 'Use the system with that name', description: '"Depends on systems" points at the system of the same name here.' },
          { value: 'alternative', label: 'Leave it out', description: 'Left out of "Depends on systems"; add it by hand later when needed.' },
        ],
        default: true,
      });
      if (!answer) return false;
      if (answer === 'alternative') {
        data.configuration = {
          ...data.configuration,
          dependOnSystems: (data.configuration.dependOnSystems as Any[]).map((d) => (onlyByName(d) ? { ...d, matchByName: false } : d)),
        };
      }
    }
    // Systems it depends on that are made earlier in this "Overwrite all": linked then
    const later = ((data.configuration.dependOnSystems ?? []) as Any[]).filter((d) => !findDependency(d, systems) && auto.pending('system', d.displayName));
    later.forEach((d) => auto.need(d.displayName));
    const laterNote = later.length ? `"Depends on systems": ${later.map((d) => `"${d.displayName}"`).join(', ')} is linked after it is made` : '';
    const missing = missingDependencies({ dependOnSystems: ((data.configuration.dependOnSystems ?? []) as Any[]).filter((d) => !later.includes(d)) }, systems);
    let system: Any = systems.find((s) => s?.systemId === systemId);
    const created = !system;
    const fileChecklist = isPlainObject(data.migration?.checklist) ? data.migration.checklist : null;
    // "Overwrite all" leaves migrations to PowerShell v2 alone
    if (fileChecklist) return auto.skip('a file for a migration to PowerShell v2: skipped');
    if (!created && system.templateIdentifier === POWERSHELL_V1 && data.templateIdentifier === POWERSHELL_V2) {
      return auto.skip('a PowerShell v2 file for a PowerShell v1 system: starting its migration is skipped');
    }
    if (created) {
      const name = data.configuration.displayName ?? fileName;
      if (typeof name === 'string' && (await fetchFromGateway(IMPORT_PATHS.targetNameExists(name))) === true) {
        return auto.skip(`a new target system, but another one is already named "${name}"`);
      }
      if (auto.plan) {
        return auto.planned({
          isNew: true,
          name,
          notes: [missing, laterNote].filter(Boolean),
          lines: ['a new target system, DISABLED, with:', ...steps.filter((step) => step.applies?.(data.configuration) ?? true).map((step) => `  - ${step.name}`)],
        });
      }
      system = await createSystemFor(data, data.configuration.displayName ?? fileName, systemId, steps, systems);
    }
    if (system.templateIdentifier !== data.templateIdentifier) {
      throw new Error(`The file is of a system of type "${data.templateIdentifier}", ` + `but "${system.displayName}" is of type "${system.templateIdentifier}".`);
    }

    const id = encodeURIComponent(system.systemId);
    const currentPath = CONNECTOR_EXPORTS[system.templateIdentifier]?.(id).configuration;
    const hasResources = Boolean(CONNECTOR_EXPORTS[system.templateIdentifier]?.(id).resources);
    let resourcesRead = true;
    const loadCurrent = async (): Promise<Any> => ({
      ...(currentPath ? await fetchFromGateway(currentPath) : system),
      systemId: system.systemId,
      isNew: created,
      resources: !hasResources
        ? undefined
        : await fetchFromGateway(IMPORT_PATHS.powershellResources(id)).catch(() => {
            resourcesRead = false;
          }),
      agentSelection: await fetchFromGateway(IMPORT_PATHS.agentSelection(id)).catch(() => []),
    });
    const current = await loadCurrent();
    const fileConfiguration = restoreSecrets(data.configuration, current);
    let configuration: Any = {
      ...(partial ? current : {}),
      ...fileConfiguration,
      ...(partial
        ? {
            scripts: { ...current.scripts, ...fileConfiguration.scripts },
            mappingConfiguration: { ...current.mappingConfiguration, ...fileConfiguration.mappingConfiguration },
          }
        : {}),
      resources: data.resources ?? (partial ? current.resources : undefined),
      agentSelection:
        !Array.isArray(data.agents?.selected) || sameAgentSelection(data.agents.selected, current.agentSelection) ? current.agentSelection : data.agents.selected,
      isNew: created,
      ...(Array.isArray(data.configuration.dependOnSystems) ? { dependOnSystems: resolveDependencies(data.configuration, systems) } : {}),
      ...(created || isPlainObject(current.migrationStatus) ? { isDisabled: true } : {}),
    };
    if (byField) configuration = mergeByField(configuration, current, fileConfiguration);
    const { requests: newNotifications, skipped: notificationsSkipped } = await notificationRequests(data, systemId, system);
    const ruleWork = await ruleRequests(data, system, created, auto);
    if (!ruleWork) return false;
    const ruleDrafts: Any[] = ruleWork.requests;
    const notCompared = !hasResources
      ? null
      : !Array.isArray(data.resources)
        ? 'the file has no resources (export the system again)'
        : !resourcesRead
          ? 'HelloID did not return the resources of the system'
          : null;

    const importable = new Set<string>();
    const applicable = steps.filter((step) => step.applies?.(configuration) ?? true);
    const work = applicable
      .map((step) => {
        const changes = ((step.changes?.(configuration, current) ?? changedParts(step.body(configuration, current, systems), step.body(current, current, systems))) as string[]).filter(
          (c) => !importable.has(c),
        );
        changes.forEach((c) => importable.add(c));
        return { step, changes };
      })
      .filter((w) => w.changes.length);
    const others = changedParts(configuration, current).filter((c) => !importable.has(c) && c !== 'migrationStatus');

    const skipped = () => warn(notCompared ? `\n\nResources were not compared: ${notCompared}.` : '') + missing + notificationsSkipped + ruleWork.skipped;
    const describe = (title: string, changes: string[]) => `${title}:\n` + changes.map((c) => `  - ${c}`).join('\n');
    const unsupported = warn(others.length ? `\n\n${describe('Not importable, left as is', others)}` : '');
    const nothing = () => !work.length && !newNotifications.length && !ruleDrafts.length;
    if (nothing() && !later.length) return auto.same();
    // (the userscript shows "nothing to import" here for a new system with nothing to send: nothing to do)
    if (nothing() && created) return true;

    if (!created && configuration.displayName !== current.displayName && typeof configuration.displayName === 'string' &&
      (await fetchFromGateway(IMPORT_PATHS.targetNameExists(configuration.displayName))) === true) {
      throw new Error(`Another target system is already named "${configuration.displayName}". ` + 'Nothing was imported.');
    }

    const replacesMapping = work.some((w) => w.step.resetsFieldIds);
    const plan = applicable.filter((step) => work.some((w) => w.step === step) || (replacesMapping && step.usesFieldIds));
    const parts = plan.map((step) => {
      const changes = work.find((w) => w.step === step)?.changes;
      const title = step.name + (step.note ? ` (${step.note})` : '');
      return changes ? describe(title, changes) : `${title}:\n  - set again after the mapping is changed`;
    });
    if (newNotifications.length) parts.push(describe('Notifications', newNotifications.map((r) => r.name)));
    if (ruleDrafts.length) {
      parts.push(describe('Business rules (saved as DRAFTS, not published: publish them yourself in HelloID)', ruleDrafts.flatMap((r) => r.changes)));
    }

    const afterMapping = replacesMapping ? { ...current, mappingConfiguration: configuration.mappingConfiguration } : current;
    plan.forEach((step) => step.body(configuration, step.usesFieldIds ? afterMapping : current, systems));

    if (auto.plan) {
      return auto.planned({
        isNew: created,
        name: system.displayName,
        lines: parts,
        notes: [unsupported, skipped(), laterNote].filter(Boolean),
        // (not in the userscript: what else it touches, for the fingerprints and the audit)
        systemId: created ? null : system.systemId,
        ruleIds: [...ruleWork.ruleIds],
        notifications: newNotifications.length > 0,
      });
    }

    const requests: Any[] = [...plan.flatMap((step) => step.requests?.(configuration, current) ?? [...(step.before ?? []), step]), ...newNotifications, ...ruleDrafts];
    let latest = current;
    for (const request of requests) {
      if (request.when && !request.when(latest)) continue;
      if (request.run) await request.run(id);
      else await sendToGateway(request.path(id), request.method, request.body?.(configuration, latest, systems));
      // (not in the userscript) a new notification of the system: the identifier the server made for it
      if (request.newNotification) env.onCreated?.(request.newNotification);
      if (request.resetsFieldIds) latest = await loadImportedFields(loadCurrent, fileFields);
    }
    // (with auto the closing message is not shown, and its errors are not used: error() kept for the texts)
    void error;
    return true;
  }

  return { importData, IMPORT_STEPS };
}
