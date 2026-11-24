// The userscript's exports, ported: what HelloID knows about each item, collected and masked the way
// the Export buttons and "Export everything" of HelloID-UX-improvements.user.js do it
// (collectSystemExport, collectSourceSystemExport, collectNotificationSystemExport,
// collectNotificationsExport, the backup() of ITEM_IMPORTS, the load() of SETTING_IMPORTS,
// everythingParts and exportEverything). Secrets are always masked (exportSecrets: false). The
// structure of every file is the userscript's, so its "Import HelloID export files" reads them.
//
// The data is HelloID's own JSON, of many shapes; it is handled as `any` here, as the userscript does.

import { randomUUID } from 'node:crypto';
import {
  isPlainObject,
  listTargetSecrets,
  maskFormValues,
  maskNotificationSystem,
  maskSourceSystem,
  maskTargetConfiguration,
} from '../safety.ts';
import type { HelloIdClient } from './client.ts';
import { GATEWAY, type QueryValue, TAKE_ALL, withQuery } from './endpoints.ts';

type Any = any;

/** Items read at the same time (USED_BY_BATCH in the userscript). */
export const BATCH = 6;
/** The entitlements-overview flags of a rule that grants on the system (FILTERS in the userscript). */
export const RULE_ENTITLEMENT_FIELDS = [
  'accountEntitlementForSystem',
  'accountAccessEntitlementForSystem',
  'permissionEntitlementForSystem',
] as const;
/** The empty ID: in a rule condition, "no source system" (as HelloID itself has it). */
export const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
/** HelloID's entitlement types by number (ENTITLEMENT_TYPES in the userscript). */
export const ENTITLEMENT_TYPES: Record<string, string> = { 1: 'Account', 2: 'AccountAccess', 3: 'Permission' };

/** An item that is not in HelloID. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** The rows of a list answer: the array itself, or its pageData. */
export const rowsOf = (answer: Any): Any[] =>
  Array.isArray(answer) ? answer : Array.isArray(answer?.pageData) ? answer.pageData : [];

const byText = (key: string) => (a: Any, b: Any) => String(a?.[key]).localeCompare(String(b?.[key]));

/** Runs work on the items, BATCH at a time; the results in the order of the items. */
export async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>, size = BATCH): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return results;
}

/**
 * Reads from the gateway. With memo, a GET of the same path and query is done once (Export
 * everything reads the same lists for every item, as the userscript does; this keeps that to one
 * request each).
 */
export class GatewayReader {
  readonly client: HelloIdClient;
  readonly signal: AbortSignal | undefined;
  private readonly memo: Map<string, Promise<unknown>> | undefined;

  constructor(client: HelloIdClient, options: { signal?: AbortSignal; memo?: boolean } = {}) {
    this.client = client;
    this.signal = options.signal;
    this.memo = options.memo ? new Map() : undefined;
  }

  get<T = Any>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const key = withQuery(path, query ?? {});
    const hit = this.memo?.get(key);
    if (hit) return hit as Promise<T>;
    const promise = this.client.gatewayJson<T>({ path, query, signal: this.signal });
    if (this.memo) {
      this.memo.set(key, promise);
      promise.catch(() => this.memo?.delete(key));
    }
    return promise;
  }

  post<T = Any>(path: string, body: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.client.gatewayJson<T>({ method: 'POST', path, query, body, signal: this.signal });
  }

  /** Throws when the caller cancelled. */
  checkAborted(): void {
    this.signal?.throwIfAborted();
  }
}

/** Target and source systems; find(id, name): by ID, else by name (systemDirectory in the userscript). */
export interface SystemDirectory {
  all: Any[];
  targets: Any[];
  find(id: unknown, name?: unknown): Any | undefined;
  nameOf(id: unknown): string | null;
}

const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();

// What else to read per type of target system (CONNECTOR_EXPORTS); "configuration" replaces the
// system's entry of the list. Parts in OPTIONAL_EXPORTS may fail without stopping the export.
const powershellExport = (id: string) => ({
  configuration: GATEWAY.powershellConfiguration(id),
  defaultScripts: GATEWAY.powershellDefaultScripts(id),
  resources: GATEWAY.powershellResources(id),
});
const CONNECTOR_EXPORTS: Record<string, (id: string) => Record<string, string>> = {
  'powershell-onpremise': powershellExport,
  'powershell-target': powershellExport,
  azuread: (id) => ({ configuration: GATEWAY.azureAdConfiguration(id) }),
  activedirectory: (id) => ({ configuration: GATEWAY.activeDirectoryConfiguration(id) }),
};
const OPTIONAL_EXPORTS = new Set(['resources']);

/** The path of a target system's configuration of its type; undefined for a type without one (its list entry is all). */
export const targetConfigurationPath = (system: Any): string | undefined =>
  CONNECTOR_EXPORTS[system?.templateIdentifier]?.(system.systemId).configuration;

/** How a system's accounts are named in mappings and scripts: _<system ID without dashes>. */
export const accountsReference = (systemId: unknown) => `_${String(systemId).replace(/-/g, '')}`;

/** Where a text is found in a configuration, as paths; list items by their name when they have one. */
export function findText(value: unknown, needle: string, path = ''): string[] {
  if (typeof value === 'string') return value.toLowerCase().includes(needle) ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((v: Any, i) => findText(v, needle, `${path}[${v?.name ?? v?.displayName ?? i}]`));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => findText(v, needle, path ? `${path}.${k}` : k));
  }
  return [];
}

/** A notification with the name of its custom event added. */
const withCustomEventName = (notification: Any, events: Any[]) =>
  !notification?.customEventId
    ? notification
    : { ...notification, customEventName: events.find((e) => e?.customEventId === notification.customEventId)?.name ?? null };

export interface ExportOrigin {
  /** The portal (location.origin in the userscript). */
  exportedFrom: string;
  /** Who made the file. */
  exportedBy: string;
  now?: () => number;
  /** The time zone schedules are read in (the browser's zone in the userscript). */
  timeZone?: string;
}

/** The time zone of this machine, as the userscript takes the browser's. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** A part of Export everything (everythingParts in the userscript). */
interface EverythingPart {
  label: string;
  single?: boolean;
  list(): Promise<Any[]>;
  nameOf(item: Any): string;
  read(item: Any): Promise<Any>;
}

export interface EverythingProgress {
  part: string;
  partIndex: number;
  parts: number;
  done: number;
  total: number;
}

/** The collectors of one environment. */
export class Exporter {
  readonly reader: GatewayReader;
  private readonly origin: Required<ExportOrigin>;

  constructor(reader: GatewayReader, origin: ExportOrigin) {
    this.reader = reader;
    this.origin = { now: Date.now, timeZone: localTimeZone(), ...origin };
  }

  private get = <T = Any>(path: string, query?: Record<string, QueryValue>) => this.reader.get<T>(path, query);

  /** exportHeader in the userscript. */
  header(contents: string) {
    return {
      exportedAt: new Date(this.origin.now()).toISOString(),
      exportedFrom: this.origin.exportedFrom,
      exportedBy: this.origin.exportedBy,
      contents,
    };
  }

  get timeZone(): string {
    return this.origin.timeZone;
  }

  // ------------------------------------------------------------------------------------------
  // Lists

  async fetchSystems(): Promise<Any[]> {
    const systems = await this.get(GATEWAY.targetSystems, { showReferenceSystems: true });
    return Array.isArray(systems) ? systems : [];
  }

  async systemDirectory(): Promise<SystemDirectory> {
    const [targets, sources] = await Promise.all([this.fetchSystems(), this.get(GATEWAY.sourceSystems).catch(() => [])]);
    const all = [...targets, ...rowsOf(sources)].filter((s) => s?.systemId);
    return {
      all,
      targets,
      find: (id, name) => all.find((s) => s.systemId === id) ?? (typeof name === 'string' ? all.find((s) => sameText(s.displayName, name)) : undefined),
      nameOf: (id) => all.find((s) => s.systemId === id)?.displayName ?? null,
    };
  }

  async readCustomEvents(): Promise<Any[]> {
    const answer = await this.get(GATEWAY.customEvents, { take: TAKE_ALL }).catch(() => null);
    return Array.isArray(answer) ? answer : (answer?.pageData ?? []);
  }

  listSourceSystems = async () => rowsOf(await this.get(GATEWAY.sourceSystems));
  listNotificationSystems = async () => rowsOf(await this.get(GATEWAY.notificationSystems));
  listNotifications = async () =>
    rowsOf(await this.get(GATEWAY.notifications, { skip: 0, take: TAKE_ALL, enabled: false, disabled: false }));
  listRules = async () =>
    rowsOf(await this.reader.post(GATEWAY.rulesOverview, { search: '', skip: 0, take: TAKE_ALL, published: true, draft: true }));
  listToxicPolicies = async () => rowsOf(await this.get(GATEWAY.toxicCombinations, { take: TAKE_ALL }));
  listCustomEvents = async () => rowsOf(await this.get(GATEWAY.customEvents, { take: TAKE_ALL }));
  listSchedules = async () => rowsOf(await this.get(GATEWAY.schedule, { timeZone: this.origin.timeZone }));

  private async sourceCatalog(): Promise<Any[]> {
    const list = await this.get(GATEWAY.sourceCatalog, { take: TAKE_ALL });
    return Array.isArray(list?.pageData) ? list.pageData : Array.isArray(list) ? list : [];
  }

  /** The selected agents and their summary; { couldNotRead: true } when that fails. */
  private async agentSelection(systemId: string): Promise<Any> {
    try {
      const [selected, summary] = await Promise.all([
        this.get(GATEWAY.agentSelection(systemId)),
        this.get(GATEWAY.agentSelectionSummary(systemId)),
      ]);
      return { selected, summary };
    } catch {
      return { couldNotRead: true };
    }
  }

  // ------------------------------------------------------------------------------------------
  // Target systems (collectSystemExport)

  /** The other systems that use this one: they depend on it, or name its accounts. */
  private async collectUsedBy(system: Any, systems: Any[]): Promise<Any[]> {
    const needle = accountsReference(system.systemId).toLowerCase();
    const others = systems.filter((o) => o?.systemId && o.systemId !== system.systemId);
    const usedBy: Any[] = [];
    await inBatches(others, async (other) => {
      const path = CONNECTOR_EXPORTS[other.templateIdentifier]?.(other.systemId).configuration;
      let configuration = other;
      let couldNotRead = false;
      if (path) {
        try {
          configuration = await this.get(path);
        } catch {
          this.reader.checkAborted();
          couldNotRead = true;
        }
      }
      const dependsOnThisSystem = ((configuration?.dependOnSystems ?? other.dependOnSystems ?? []) as Any[]).some(
        (d) => d?.systemId === system.systemId,
      );
      const references = findText(configuration, needle);
      if (!dependsOnThisSystem && !references.length && !couldNotRead) return;
      usedBy.push({
        systemId: other.systemId,
        displayName: other.displayName,
        templateIdentifier: other.templateIdentifier,
        dependsOnThisSystem,
        references,
        ...(couldNotRead ? { couldNotRead } : {}),
      });
    });
    return usedBy.sort(byText('displayName'));
  }

  /** The rules that have an entitlement for the system, in full (of their entitlements, the system's). */
  private collectRules(rows: Any[], system: Any): Promise<Any[]> {
    return inBatches(rows, async (row) => {
      try {
        const { description, categories, published, hasDraft, condition, entitlements } = await this.get(GATEWAY.rule(row.ruleId));
        return {
          ...row,
          description,
          categories,
          published,
          hasDraft,
          condition,
          entitlements: ((entitlements ?? []) as Any[]).filter((e) => e?.systemIdentifier === system.systemId),
        };
      } catch {
        this.reader.checkAborted();
        return { ...row, couldNotRead: true };
      }
    });
  }

  /** The notification systems the notifications use, as HelloID gives them (null: could not be read). */
  private async readNotificationSystems(notifications: Any[]): Promise<Map<string, Any>> {
    const ids = [...new Set(notifications.map((n) => n.notificationSystemId).filter(Boolean))] as string[];
    return new Map(
      await Promise.all(ids.map(async (id) => [id, await this.get(GATEWAY.notificationSystem(id)).catch(() => null)] as [string, Any])),
    );
  }

  /**
   * A notification's template data with its secrets masked (the password fields of its template, and
   * secret names), as the userscript's notifications export does.
   */
  private maskTemplateData(notification: Any, systems: Map<string, Any>): Any {
    if (!isPlainObject(notification) || !('notificationTemplateData' in notification)) return notification;
    const template = ((systems.get(notification.notificationSystemId as string)?.notificationTemplates ?? []) as Any[]).find(
      (t) => t?.templateId === notification.notificationTemplateId,
    );
    return { ...notification, notificationTemplateData: maskFormValues(notification.notificationTemplateData, template?.fields) };
  }

  /** The system's notifications in full, and those of other systems that use its data. */
  private async collectNotifications(system: Any): Promise<Any> {
    const rows = rowsOf(await this.get(GATEWAY.notifications, { skip: 0, take: TAKE_ALL, enabled: false, disabled: false }));
    const notifications: Any[] = [];
    const notificationsUsingThisSystem: Any[] = [];
    let events: Promise<Any[]> | undefined;
    const named = async (notification: Any) => {
      if (!notification?.customEventId) return notification;
      events ??= this.readCustomEvents();
      return withCustomEventName(notification, await events);
    };
    await inBatches(rows, async (row) => {
      const own = row.systemId === system.systemId;
      let notification: Any;
      try {
        notification = await this.get(GATEWAY.notification(row.identifier));
      } catch {
        this.reader.checkAborted();
        (own ? notifications : notificationsUsingThisSystem).push({ ...row, couldNotRead: true });
        return;
      }
      if (own) {
        notifications.push(await named(notification));
        return;
      }
      const dataReferences = ((notification.dataReferences ?? []) as Any[]).filter((r) => r?.systemId === system.systemId);
      if (!dataReferences.length) return;
      const { identifier, systemId, event, name, enabled } = notification;
      notificationsUsingThisSystem.push({ identifier, systemId, event, name, enabled, dataReferences });
    });
    const systems = await this.readNotificationSystems(notifications);
    return {
      // (the userscript leaves the template data of these as they are; masked here, as everywhere)
      notifications: notifications.map((n) => this.maskTemplateData(n, systems)).sort(byText('name')),
      notificationSystems: [...systems].map(([systemId, read]) =>
        read ? maskNotificationSystem(read) : { systemId, couldNotRead: true },
      ),
      notificationsUsingThisSystem: notificationsUsingThisSystem.sort(byText('name')),
    };
  }

  private async collectTargetAgents(systemId: string): Promise<Any> {
    const [selected, summary] = await Promise.all([
      this.get(GATEWAY.agentSelection(systemId)),
      this.get(GATEWAY.agentSelectionSummary(systemId)),
    ]);
    const agents: Any = { selected, summary };
    // The agents that selection stands for right now: HelloID answers with all agents, marking the
    // selected ones (a POST, but it only looks them up)
    if (Array.isArray(selected) && selected.length) {
      const all = await this.reader.post(GATEWAY.agents, selected);
      if (Array.isArray(all)) agents.selectedAgents = all.filter((a: Any) => a?.selected === true);
    }
    return agents;
  }

  /** The export file of one target system (by ID). */
  async targetSystem(systemId: string, known?: Any[]): Promise<Any> {
    const systems = known ?? (await this.fetchSystems());
    const system = systems.find((s) => s?.systemId === systemId);
    if (!system) throw new NotFoundError(`Target system '${systemId}' is not in HelloID's list of target systems.`);

    const paths = CONNECTOR_EXPORTS[system.templateIdentifier]?.(system.systemId) ?? {};
    const names = Object.keys(paths);
    const couldNotRead: string[] = [];
    const [agents, notifications, rules, usedBy, answers] = await Promise.all([
      this.collectTargetAgents(system.systemId).catch(() => ({ couldNotRead: true })),
      this.collectNotifications(system).catch(() => {
        this.reader.checkAborted();
        couldNotRead.push('notifications');
        return {};
      }),
      // Only the rules that have an entitlement for this system
      this.get(GATEWAY.entitlementsOverview(system.systemId), { skip: 0, take: TAKE_ALL }).then((overview) =>
        this.collectRules(
          rowsOf(overview).filter((r) => RULE_ENTITLEMENT_FIELDS.some((f) => r[f] === true)),
          system,
        ),
      ),
      this.collectUsedBy(system, systems),
      Promise.all(
        names.map((n) =>
          this.get(paths[n]!).catch((e: unknown) => {
            if (!OPTIONAL_EXPORTS.has(n)) throw e;
            couldNotRead.push(n);
            return undefined;
          }),
        ),
      ),
    ]);
    const parts: Any = Object.fromEntries(names.map((n, i) => [n, answers[i]]));
    const { configuration: readConfiguration, ...others } = parts;
    const read = readConfiguration ?? system;
    // The systems it depends on, with their names (HelloID only gives their IDs)
    const configuration = !Array.isArray(read.dependOnSystems)
      ? read
      : {
          ...read,
          dependOnSystems: read.dependOnSystems.map((d: Any) => {
            const displayName = systems.find((o) => o?.systemId === d.systemId)?.displayName;
            return displayName === undefined ? d : { ...d, displayName };
          }),
        };
    // What the list of systems has about it that the configuration of its type doesn't
    const listEntry = Object.fromEntries(Object.entries(system).filter(([key]) => !(key in read)));

    return {
      exportedAt: new Date(this.origin.now()).toISOString(),
      exportedFrom: this.origin.exportedFrom,
      exportedBy: this.origin.exportedBy,
      secretsIncluded: false,
      systemId: system.systemId,
      displayName: system.displayName,
      templateIdentifier: system.templateIdentifier,
      configuration: maskTargetConfiguration(configuration),
      secrets: listTargetSecrets(configuration),
      ...(Object.keys(listEntry).length ? { listEntry } : {}),
      agents,
      ...others,
      accountsReference: `Person.Accounts.${accountsReference(system.systemId)}`,
      usedBy,
      ...notifications,
      ...(couldNotRead.length ? { couldNotRead } : {}),
      rules,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Source systems, notification systems, notifications

  /** The export file of one source system (collectSourceSystemExport). */
  async sourceSystem(systemId: string): Promise<Any> {
    const { repositoryMetaData, ...read } = await this.get(GATEWAY.sourceSystem(systemId));
    // The template: without its README, with its catalog ID
    let template: Any = null;
    if (isPlainObject(repositoryMetaData)) {
      const { readmeHtml: _readme, ...rest } = repositoryMetaData as Any;
      const entry = (await this.sourceCatalog().catch(() => [])).find((c) => c?.name === rest.name);
      template = { ...rest, repositoryId: entry?.id ?? null };
    }
    const agents = await this.agentSelection(systemId);
    return {
      ...this.header('sourceSystem'),
      secretsIncluded: false,
      systemId: read.systemId,
      displayName: read.displayName,
      system: maskSourceSystem({ ...read, repositoryMetaData: template }),
      agents,
    };
  }

  /** The export file of one notification system (collectNotificationSystemExport). */
  async notificationSystem(systemId: string): Promise<Any> {
    const read = await this.get(GATEWAY.notificationSystem(systemId));
    const agents = await this.agentSelection(systemId);
    return {
      ...this.header('notificationSystem'),
      secretsIncluded: false,
      systemId: read.systemId,
      displayName: read.displayName,
      system: maskNotificationSystem(read),
      agents,
    };
  }

  /** The export file of notifications (collectNotificationsExport); identifiers null: all of them. */
  async notifications(identifiers: string[] | null): Promise<Any> {
    const [senders, targets, ids] = await Promise.all([
      this.get(GATEWAY.notificationSystems).then(rowsOf),
      this.fetchSystems(),
      identifiers ?? this.listNotifications().then((rows) => rows.map((n) => n.identifier)),
    ]);
    const read = await inBatches(ids, (id: string) => this.get(GATEWAY.notification(id)));
    const events = read.some((n) => n?.customEventId) ? await this.readCustomEvents() : [];
    // The notification systems they use: for the names of the templates, and their password fields
    const details = await this.readNotificationSystems(read);
    const notifications = read
      .map((n) => {
        const sender = senders.find((s) => s.systemId === n.notificationSystemId);
        const template = ((details.get(n.notificationSystemId)?.notificationTemplates ?? []) as Any[]).find(
          (t) => t.templateId === n.notificationTemplateId,
        );
        return {
          ...withCustomEventName(n, events),
          notificationTemplateData: maskFormValues(n.notificationTemplateData, template?.fields),
          dataReferences: ((n.dataReferences ?? []) as Any[]).map((r) => ({
            ...r,
            displayName: targets.find((s) => s.systemId === r.systemId)?.displayName ?? null,
          })),
          systemName: targets.find((s) => s.systemId === n.systemId)?.displayName ?? null,
          notificationSystemName: sender?.displayName ?? null,
          notificationSystemBuiltin: sender?.isBuiltin === true,
          notificationTemplateName: template?.displayName ?? null,
        };
      })
      .sort(byText('name'));
    return { ...this.header('notifications'), secretsIncluded: false, notifications };
  }

  // ------------------------------------------------------------------------------------------
  // Items (the backup() of ITEM_IMPORTS)

  private systemsOf(ids: unknown[], systems: SystemDirectory) {
    return [...new Set(ids)].map((id) => ({ systemId: id, displayName: systems.nameOf(id) }));
  }

  async businessRule(match: Any, systems: SystemDirectory): Promise<Any> {
    const rule = await this.get(GATEWAY.rule(match.ruleId));
    const ids = ((rule.entitlements ?? []) as Any[]).map((e) => e.systemIdentifier);
    return { ...this.header('businessRule'), ruleId: rule.ruleId, name: rule.name, rule, systems: this.systemsOf(ids, systems) };
  }

  /** The entitlements of a toxic policy (by their IDs); [] when they cannot be read. */
  async toxicEntitlements(policy: Any): Promise<Any[]> {
    const ids = [...new Set([...(policy.inputObjectIds ?? []), ...(policy.outputObjectIds ?? [])])] as string[];
    if (!ids.length) return [];
    return rowsOf(await this.get(GATEWAY.toxicEntitlementsByIds, { entitlementIds: ids }).catch(() => []));
  }

  async toxicPolicy(match: Any, systems: SystemDirectory): Promise<Any> {
    const entitlements = await this.toxicEntitlements(match);
    return {
      ...this.header('toxicPolicy'),
      toxicCombinationId: match.toxicCombinationId,
      name: match.name,
      policy: match,
      entitlements,
      systems: this.systemsOf(entitlements.map((e) => e.systemIdentifier), systems),
    };
  }

  customEvent(match: Any, systems: SystemDirectory): Any {
    return {
      ...this.header('customEvent'),
      customEventId: match.customEventId,
      name: match.name,
      systemName: systems.nameOf(match.systemId),
      customEvent: match,
    };
  }

  schedule(match: Any, systems: SystemDirectory): Any {
    return {
      ...this.header('schedule'),
      scheduleId: match.scheduleId,
      name: match.name,
      timeZone: this.origin.timeZone,
      schedule: match,
      systems: this.systemsOf(((match.tasks ?? []) as Any[]).map((t) => t.systemId).filter(Boolean), systems),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Settings pages (the load() of SETTING_IMPORTS)

  async sourceConfiguration(): Promise<Any> {
    return {
      ...this.header('sourceConfiguration'),
      calculatedLayers: await this.get(GATEWAY.calculatedLayers),
      customFields: await this.get(GATEWAY.customFields),
    };
  }

  async aggregationConfiguration(): Promise<Any> {
    return { ...this.header('aggregationConfiguration'), configuration: await this.get(GATEWAY.aggregation) };
  }

  async personLifecycle(): Promise<Any> {
    return { ...this.header('personLifecycle'), configuration: await this.get(GATEWAY.personLifecycle) };
  }

  /** The persons of the vault: included (true) or excluded (false) ones. */
  async vaultPersons(included: boolean): Promise<Any[]> {
    return rowsOf(
      await this.get(GATEWAY.vaultPersons, { skip: 0, take: TAKE_ALL, search: '', includedOnly: included, excludedOnly: !included }),
    );
  }

  async excludedPersons(): Promise<Any> {
    return { ...this.header('excludedPersons'), persons: await this.vaultPersons(false) };
  }

  async reconciliationConfiguration(systems: SystemDirectory): Promise<Any> {
    const [schedule, systemConfiguration, exclusions] = await Promise.all([
      this.get(GATEWAY.reconciliationSchedule),
      this.get(GATEWAY.reconciliationSystems),
      this.reader
        .post(GATEWAY.reconciliationExclusions, { search: '', filters: [], skip: 0, take: TAKE_ALL }, { forBulkActions: false })
        .catch(() => null),
    ]);
    const ids = rowsOf(systemConfiguration).map((s) => s.systemId);
    return {
      ...this.header('reconciliationConfiguration'),
      schedule,
      systemConfiguration,
      exclusions,
      systems: ids.map((id) => ({ systemId: id, displayName: systems.nameOf(id) })),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Export everything

  /** The parts of the backup, in the order of the import (everythingParts). */
  private everythingParts(): EverythingPart[] {
    const directory = () => this.systemDirectory();
    const item = (label: string, list: () => Promise<Any[]>, read: (item: Any, systems: SystemDirectory) => Promise<Any> | Any) => {
      let systems: SystemDirectory | undefined;
      return {
        label,
        list: async () => {
          systems = await directory();
          return list();
        },
        nameOf: (i: Any) => i?.name,
        read: async (i: Any) => read(i, systems!),
      };
    };
    const setting = (label: string, load: (systems: SystemDirectory) => Promise<Any>): EverythingPart => ({
      label,
      single: true,
      list: async () => [label],
      nameOf: () => label,
      read: async () => load(await directory()),
    });
    let targets: Any[] = [];
    return [
      {
        label: 'Target systems',
        list: async () => {
          targets = (await this.fetchSystems()).filter((s) => typeof s?.displayName === 'string');
          return targets;
        },
        nameOf: (s) => s.displayName,
        read: (s) => this.targetSystem(s.systemId, targets),
      },
      { label: 'Source systems', list: this.listSourceSystems, nameOf: (s) => s.displayName, read: (s) => this.sourceSystem(s.systemId) },
      {
        label: 'Notification systems',
        list: this.listNotificationSystems,
        nameOf: (s) => s.displayName,
        read: (s) => this.notificationSystem(s.systemId),
      },
      // (one notification per file, as Export-HelloID.ps1 does)
      { label: 'Notifications', list: this.listNotifications, nameOf: (n) => n.name, read: (n) => this.notifications([n.identifier]) },
      item('Business rules', this.listRules, (r, s) => this.businessRule(r, s)),
      item('Toxic policies', this.listToxicPolicies, (p, s) => this.toxicPolicy(p, s)),
      item('Custom events', this.listCustomEvents, (e, s) => this.customEvent(e, s)),
      item('Schedules', this.listSchedules, (e, s) => this.schedule(e, s)),
      setting('Source configuration', () => this.sourceConfiguration()),
      setting('Aggregation configuration', () => this.aggregationConfiguration()),
      setting('Person lifecycle', () => this.personLifecycle()),
      setting('Excluded persons', () => this.excludedPersons()),
      setting('Reconciliation configuration', (systems) => this.reconciliationConfiguration(systems)),
    ];
  }

  /**
   * The full backup (exportEverything): every item of every type as the export file of its own
   * export, in one file with contents "backups". An item that can't be read doesn't stop the rest:
   * the file then says which ones are missing (couldNotRead).
   */
  async everything(onProgress: (progress: EverythingProgress) => void = () => {}): Promise<Any> {
    const parts = this.everythingParts();
    const files: Any[] = [];
    const failed: string[] = [];
    const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
    for (const [partIndex, part] of parts.entries()) {
      this.reader.checkAborted();
      let list: Any[];
      try {
        list = await part.list();
      } catch (e) {
        this.reader.checkAborted();
        failed.push(`${part.label}: the list could not be read (${message(e)})`);
        continue;
      }
      for (const [i, item] of list.entries()) {
        this.reader.checkAborted();
        onProgress({ part: part.label, partIndex, parts: parts.length, done: i, total: list.length });
        try {
          const file = await part.read(item);
          if (file) files.push(file);
        } catch (e) {
          this.reader.checkAborted();
          failed.push(`${part.label}: "${part.nameOf(item)}" (${message(e)})`);
        }
      }
    }
    return {
      ...this.header('backups'),
      secretsIncluded: false,
      complete: !failed.length,
      ...(failed.length ? { couldNotRead: failed } : {}),
      files,
    };
  }
}

/** The kind of an export file: its contents, or "targetSystem" (importKind in the userscript). */
export function exportKind(file: Any): string | null {
  if (!isPlainObject(file)) return null;
  if (!file.contents && isPlainObject(file.configuration) && typeof file.templateIdentifier === 'string') return 'targetSystem';
  return typeof file.contents === 'string' ? file.contents : null;
}

// ---------------------------------------------------------------------------------------------
// Exports kept for reading as an MCP resource

export const EXPORT_URI_SCHEME = 'helloid-export';
export const EXPORT_TTL_MS = 30 * 60 * 1000;

export interface StoredExport {
  id: string;
  uri: string;
  environment: string;
  /** The MCP session that made it; only that session can read it. */
  sessionId: string | undefined;
  fileName: string;
  text: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
}

/** Exports in memory, readable as a resource by the MCP session that made them, for 30 minutes. */
export class ExportStore {
  private readonly exports = new Map<string, StoredExport>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? EXPORT_TTL_MS;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, stored] of this.exports) if (stored.expiresAt <= now) this.exports.delete(id);
  }

  add(entry: { environment: string; sessionId: string | undefined; fileName: string; text: string }): StoredExport {
    this.prune();
    const id = randomUUID();
    const createdAt = this.now();
    const stored: StoredExport = {
      id,
      uri: `${EXPORT_URI_SCHEME}://${id}`,
      ...entry,
      sizeBytes: Buffer.byteLength(entry.text, 'utf8'),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.exports.set(id, stored);
    return stored;
  }

  /** The export, when it exists, has not expired and belongs to the session. */
  get(id: string, sessionId: string | undefined): StoredExport | undefined {
    this.prune();
    const stored = this.exports.get(id);
    return stored && stored.sessionId === sessionId ? stored : undefined;
  }

  /** The exports of a session. */
  list(sessionId: string | undefined): StoredExport[] {
    this.prune();
    return [...this.exports.values()].filter((e) => e.sessionId === sessionId);
  }
}
