// The gateway routes of the import (helloid_plan_import, helloid_apply_plan) on the fake HelloID:
// every GET, POST, PUT and DELETE the planners and the apply send. They change the fixture, so what
// is read back after a write shows the write. Synthetic only; the shapes of what HelloID stores are
// simplified to what the import reads again.

import type { FakeHelloId, FakeRequest, FakeResponse } from './fake-helloid.ts';
import type { Fixture } from './fixture-routes.ts';

const ok = (body: unknown = ''): FakeResponse => ({ body });
const ID = '([^/]+)';
const exact = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\(ID\\)', ID)}$`);
const idOf = (request: FakeRequest, pattern: RegExp, group = 1) => decodeURIComponent(pattern.exec(request.path)?.[group] ?? '');

/** Installs the import routes on top of installFixtures (later routes win). */
export function installImportRoutes(fake: FakeHelloId, data: Fixture): Fixture {
  let counter = 0;
  const newId = () => `f0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const route = (method: string, path: string | RegExp, handler: (request: FakeRequest) => FakeResponse) => fake.route(method, path, handler);
  const json = (r: FakeRequest): any => r.json;

  data.powershellConfigurations ??= {};
  data.powershellResources ??= {};
  data.agentSelections ??= {};
  data.agentSummaries ??= {};
  data.activeDirectoryConfigurations ??= {};

  // Target systems
  route('GET', '/service/provisioning-api/api/target-systems/exists', (r) =>
    ok(data.targetSystems.some((s: any) => String(s.displayName).trim() === String(r.query.get('name')).trim())),
  );
  const ps = (r: FakeRequest, pattern: RegExp) => data.powershellConfigurations[idOf(r, pattern)];
  const listEntry = (id: string) => data.targetSystems.find((s: any) => s.systemId === id);
  const psPart = exact('/connector/powershell-target/api/configuration/(ID)/(ID)');
  route('POST', psPart, (r) => {
    const id = idOf(r, psPart);
    const part = idOf(r, psPart, 2);
    const configuration = data.powershellConfigurations[id];
    if (!configuration) return { status: 404, body: { message: 'Not found' } };
    const body = json(r);
    switch (part) {
      case 'general':
        Object.assign(configuration, body);
        Object.assign(listEntry(id), body);
        break;
      case 'script-configuration':
        configuration.scriptConfiguration = body.scriptConfiguration;
        break;
      case 'account':
        configuration.scripts = { ...configuration.scripts, ...body.scripts };
        configuration.scriptConfigurationForm = body.scriptConfigurationForm;
        configuration.scriptConfiguration = body.scriptConfiguration;
        break;
      case 'thresholds':
        configuration.thresholds = body;
        break;
      case 'correlation-configuration':
        configuration.correlationConfiguration = body;
        break;
      case 'permissions':
        configuration.permissions = body.permissions.map((p: any) => ({ ...p, identification: p.identification ?? newId() }));
        break;
      default:
        return { status: 404, body: { message: `Unknown part ${part}` } };
    }
    return ok();
  });
  // (after the route of the parts, so it wins for create/<type>)
  const createPs = exact('/connector/powershell-target/api/configuration/create/(ID)');
  route('POST', createPs, (r) => {
    const id = newId();
    const templateIdentifier = idOf(r, createPs);
    const entry = { systemId: id, displayName: null, templateIdentifier, dependOnSystems: [], isDisabled: true, isReferenceSystem: false };
    data.targetSystems.push(entry);
    data.powershellConfigurations[id] = {
      ...entry,
      scriptConfiguration: {},
      scriptConfigurationForm: { fields: [] },
      scripts: {},
      permissions: [],
      thresholds: [],
      mappingConfiguration: { fields: [] },
    };
    data.powershellResources[id] = [];
    data.agentSelections[id] = [];
    data.agentSummaries[id] = { agents: 0 };
    return ok(id);
  });
  const resources = exact('/connector/powershell-target/api/resources/(ID)');
  route('POST', resources, (r) => {
    data.powershellResources[idOf(r, resources)] = json(r);
    return ok();
  });
  const mappingFields = exact('/connector/powershell-target/api/mapping/(ID)/fields');
  route('DELETE', mappingFields, (r) => {
    ps(r, mappingFields).mappingConfiguration = { ...ps(r, mappingFields).mappingConfiguration, fields: [] };
    return ok();
  });
  const types: Record<string, number> = { Text: 1, Array: 2 };
  const modes: Record<string, number> = { None: 0, Fixed: 1, Field: 2, Complex: 3 };
  const actions: Record<string, number> = { Create: 1, Enable: 2, Update: 3, Disable: 4, Delete: 5 };
  const mappingImport = exact('/connector/powershell-target/api/mapping/(ID)/import');
  route('POST', mappingImport, (r) => {
    const configuration = ps(r, mappingImport);
    const fields = json(r).MappingFields.map((f: any) => ({
      identifier: newId(),
      name: f.Name,
      description: f.Description,
      type: types[f.Type],
      mappingActions: f.MappingActions.map((a: any) => ({
        mappingActionId: newId(),
        entitlementActions: a.MapForActions.map((n: string) => actions[n]),
        mode: modes[a.MappingMode],
        value: JSON.parse(a.Value),
        usedInNotifications: a.UsedInNotifications,
        storeInAccountData: a.StoreInAccountData,
      })),
    }));
    configuration.mappingConfiguration = { ...configuration.mappingConfiguration, fields: [...configuration.mappingConfiguration.fields, ...fields] };
    return ok();
  });
  const uniqueness = exact('/connector/powershell-target/api/mapping/(ID)/uniqueness');
  route('POST', uniqueness, (r) => {
    const configuration = ps(r, uniqueness);
    configuration.mappingConfiguration = { ...configuration.mappingConfiguration, uniquenessConfiguration: json(r) };
    return ok();
  });
  const dependOn = exact('/service/provisioning-api/api/target-systems/(ID)/depend-on-systems');
  route('POST', dependOn, (r) => {
    const id = idOf(r, dependOn);
    const dependOnSystems = json(r).dependOnSystems.map((d: any) => ({ systemId: d.systemId }));
    listEntry(id).dependOnSystems = dependOnSystems;
    if (data.powershellConfigurations[id]) data.powershellConfigurations[id].dependOnSystems = dependOnSystems;
    return ok();
  });
  const agents = exact('/service/agent-repository/api/agents/selected-agents/(ID)');
  route('POST', agents, (r) => {
    data.agentSelections[idOf(r, agents)] = json(r);
    return ok();
  });
  const retrieve = exact('/service/provisioning-api/api/target-systems/snapshots/create/(ID)');
  route('POST', retrieve, () => ok());

  // Notifications
  route('POST', '/service/notifications/api/notifications', (r) => {
    const body = json(r);
    data.notificationDetails[body.identifier] = body;
    const row = {
      identifier: body.identifier,
      systemId: body.systemId,
      event: body.event,
      name: body.name,
      enabled: body.enabled,
      notificationSystemId: body.notificationSystemId,
      notificationTemplateId: body.notificationTemplateId,
    };
    const index = data.notifications.findIndex((n: any) => n.identifier === body.identifier);
    if (index >= 0) data.notifications[index] = row;
    else data.notifications.push(row);
    return ok();
  });
  route('GET', '/service/notifications/api/notification/systems/exists', (r) =>
    ok(data.notificationSystems.some((s: any) => String(s.displayName).trim() === String(r.query.get('name')).trim())),
  );
  route('PUT', '/service/notifications/api/notification/systems/add', () => {
    const id = newId();
    const system = {
      systemId: id,
      displayName: `New system ${counter}`,
      isBuiltin: false,
      systemConfiguration: { fields: [], data: {} },
      notificationScripts: [{ scriptId: 'default-script', displayName: 'Default script', script: '' }],
      notificationTemplates: [],
    };
    data.notificationSystems.push({ systemId: id, displayName: system.displayName, isBuiltin: false });
    data.notificationSystemDetails[id] = system;
    data.agentSelections[id] = [];
    return ok(id);
  });
  const nsPart = /^\/service\/notifications\/api\/notification\/systems\/([^/]+)\/(.+)$/;
  route('POST', nsPart, (r) => {
    const id = idOf(r, nsPart);
    const part = idOf(r, nsPart, 2);
    const system = data.notificationSystemDetails[id];
    const body = json(r);
    if (part === 'general') {
      Object.assign(system, body);
      Object.assign(
        data.notificationSystems.find((s: any) => s.systemId === id),
        { displayName: body.displayName, description: body.description, icon: body.icon },
      );
    } else if (part === 'configuration/form') system.systemConfiguration = { ...system.systemConfiguration, fields: body };
    else if (part === 'configuration/data') system.systemConfiguration = { ...system.systemConfiguration, data: body };
    else if (part === 'scripts') system.notificationScripts = body.scripts;
    else if (part === 'templates') system.notificationTemplates = body.templates;
    else return { status: 404, body: { message: `Unknown part ${part}` } };
    return ok();
  });

  // Source systems
  route('POST', '/service/provisioning-api/api/source-systems/new', (r) => {
    const id = newId();
    const body = json(r);
    data.sourceSystems.push({ systemId: id, displayName: `Source ${counter}`, description: null, executeOnPremises: false });
    data.sourceSystemDetails[id] = {
      systemId: id,
      displayName: `Source ${counter}`,
      scriptConfiguration: '{}',
      scriptConfigurationForm: '[]',
      mappingConfiguration: { personMappings: body.personMapping, contractMappings: body.contractMapping },
      repositoryMetaData: { name: 'template', repositoryId: body.repositoryId },
    };
    data.agentSelections[id] = [];
    return ok(id);
  });
  const sourcePart = /^\/service\/provisioning-api\/api\/source-systems\/([^/]+)\/(.+)$/;
  route('POST', sourcePart, (r) => {
    const id = idOf(r, sourcePart);
    const part = idOf(r, sourcePart, 2);
    const system = data.sourceSystemDetails[id];
    const row = data.sourceSystems.find((s: any) => s.systemId === id);
    const body = json(r);
    if (part === 'general') {
      Object.assign(system, { displayName: body.friendlyName, icon: body.icon, description: body.description });
      Object.assign(row, { displayName: body.friendlyName, description: body.description });
    } else if (part === 'custom-configuration-form') system.scriptConfigurationForm = body.form;
    else if (part === 'custom-configuration') system.scriptConfiguration = body.config;
    else if (part === 'powershell') Object.assign(system, body);
    else if (part === 'mapping/persons') system.mappingConfiguration = { ...system.mappingConfiguration, personMappings: body };
    else if (part === 'mapping/contracts') system.mappingConfiguration = { ...system.mappingConfiguration, contractMappings: body };
    else if (part === 'thresholds') system.thresholds = body;
    else return { status: 404, body: { message: `Unknown part ${part}` } };
    return ok();
  });

  // Business rules
  const overviewRow = (rule: any) => ({
    ruleId: rule.ruleId,
    name: rule.name,
    description: rule.description,
    categories: rule.categories,
    configuredEntitlementCount: (rule.entitlements ?? []).length,
    published: rule.published,
    hasDraft: rule.hasDraft,
    personInRuleLastEvaluationCount: 0,
    lastChanged: '2026-02-01T00:00:00Z',
  });
  const upsertOverview = (rule: any) => {
    const index = data.rulesOverview.findIndex((r: any) => r.ruleId === rule.ruleId);
    if (index >= 0) data.rulesOverview[index] = overviewRow(rule);
    else data.rulesOverview.push(overviewRow(rule));
  };
  route('PUT', '/service/rules/api/rules/add', () => {
    const id = newId();
    data.rules[id] = { ruleId: id, name: 'New rule', description: '', categories: [], published: false, hasDraft: false, draft: null, condition: null, entitlements: [] };
    upsertOverview(data.rules[id]);
    return ok({ ruleId: id });
  });
  const ruleGeneral = exact('/service/rules/api/rules/(ID)/general');
  route('PUT', ruleGeneral, (r) => {
    const rule = data.rules[idOf(r, ruleGeneral)];
    const body = json(r);
    Object.assign(rule, { name: body.name, description: body.description, categories: body.categories });
    upsertOverview(rule);
    return ok();
  });
  route('POST', '/service/rules/api/rules', (r) => {
    const body = json(r);
    // (saved as a draft: the draft is what HelloID gives back)
    const rule = data.rules[body.ruleId];
    rule.hasDraft = true;
    rule.draft = { condition: body.condition, entitlements: body.entitlements };
    upsertOverview(rule);
    return ok();
  });

  // Toxic policies
  route('PUT', '/service/rules/api/toxic-combinations', () => {
    const id = newId();
    data.toxicCombinations.push({ toxicCombinationId: id, name: '', description: '', enabled: false, type: 1, inputObjectIds: [], outputObjectIds: [] });
    return ok(id);
  });
  route('POST', '/service/rules/api/toxic-combinations/configuration', (r) => {
    const body = json(r);
    Object.assign(
      data.toxicCombinations.find((t: any) => t.toxicCombinationId === body.toxicCombinationId),
      body,
    );
    return ok();
  });

  // Custom events
  route('POST', '/service/notifications/api/custom-events', () => {
    const id = newId();
    data.customEvents.push({ customEventId: id, name: '', systemId: null, action: 0, conditions: [] });
    return ok({ customEventId: id });
  });
  const customEvent = exact('/service/notifications/api/custom-events/(ID)');
  route('POST', customEvent, (r) => {
    const { isValid, ...body } = json(r);
    Object.assign(
      data.customEvents.find((e: any) => e.customEventId === idOf(r, customEvent)),
      body,
    );
    return ok();
  });

  // Schedules
  route('POST', '/service/scheduler/api/schedule', (r) => {
    const { hourOfDayLocal, timezoneOffsetHours, lastRunTime, ...body } = json(r);
    const index = data.schedules.findIndex((s: any) => s.scheduleId === body.scheduleId);
    if (index >= 0) data.schedules[index] = body;
    else data.schedules.push(body);
    return ok();
  });

  // Settings pages
  route('POST', '/service/provisioning-integration/api/calculatedlayers', (r) => {
    data.calculatedLayers = json(r);
    return ok();
  });
  route('POST', '/service/provisioning-integration/api/customfields', (r) => {
    data.customFields = json(r);
    return ok();
  });
  route('POST', '/service/provisioning-pipeline/api/aggregation/automatic/configuration', (r) => {
    data.aggregation = json(r);
    return ok();
  });
  route('POST', '/service/provisioning-pipeline/api/person-lifecycle', (r) => {
    data.personLifecycle = json(r).configurations;
    return ok();
  });
  const person = exact('/service/provisioning-integration/api/vault/latest/person/(ID)');
  route('PUT', person, (r) => {
    const id = r.query.get('personId');
    const found = data.persons.find((p: any) => p.personId === id);
    if (idOf(r, person) === 'exclude') {
      found.excluded = true;
      data.excludedPersons.push({ personId: found.personId, displayName: found.displayName, externalId: found.externalId });
    } else {
      data.excludedPersons = data.excludedPersons.filter((p: any) => p.personId !== id);
      const back = data.persons.find((p: any) => p.personId === id);
      if (back) back.excluded = false;
    }
    return ok();
  });
  const reconciliationSystem = exact('/service/reconciliation/api/report/system-configuration/(ID)');
  route('DELETE', reconciliationSystem, (r) => {
    data.reconciliationSystems = data.reconciliationSystems.filter((s: any) => s.systemId !== idOf(r, reconciliationSystem));
    return ok();
  });
  route('POST', '/service/scheduler/api/schedule/reconciliation/configuration', (r) => {
    const body = json(r);
    data.reconciliationSchedule = { enabled: body.enabled, scheduledOnDay: body.scheduledOnDay, scheduledOnHour: body.scheduledOnHour };
    for (const systemId of body.selectedSystems as string[]) {
      if (!data.reconciliationSystems.some((s: any) => s.systemId === systemId)) {
        data.reconciliationSystems.push({ systemId, automaticAccountCreate: false, automaticAccountEnable: false, automaticPermissionAdd: false });
      }
    }
    return ok();
  });
  route('POST', '/service/reconciliation/api/report/system-configuration', (r) => {
    for (const entry of json(r) as any[]) {
      const index = data.reconciliationSystems.findIndex((s: any) => s.systemId === entry.systemId);
      if (index >= 0) data.reconciliationSystems[index] = entry;
      else data.reconciliationSystems.push(entry);
    }
    return ok();
  });
  return data;
}

/** The requests that change something (not the reads, also those sent as POST). */
export const READ_POSTS = ['/service/rules/api/rules/overview', '/service/reconciliation/api/exclusions', '/service/agent-repository/api/agents'];
export function writes(requests: FakeRequest[]): string[] {
  return requests
    .filter((r) => r.method !== 'GET' && !READ_POSTS.includes(r.path))
    .map((r) => `${r.method} ${r.path}${r.query.toString() ? `?${r.query.toString()}` : ''} ${r.body}`);
}
