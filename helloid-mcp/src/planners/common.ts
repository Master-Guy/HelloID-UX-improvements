// What every planner shares: the requests (the userscript's fetchFromGateway and sendToGateway),
// the small helpers of the userscript's import, makeAuto (what an import gets instead of its
// dialogs) and overviewEntry (a line of the overview). Ported from HelloID-UX-improvements.user.js;
// names and texts are the userscript's, so the behaviour can be compared with it line by line.
//
// The data is HelloID's own JSON, of many shapes; it is handled as `any`, as the userscript does.

import { randomUUID } from 'node:crypto';
import { HelloIdHttpError, type HelloIdClient, redactTokens } from '../helloid/client.ts';
import { IMPORT_PATHS, TAKE_ALL } from '../helloid/endpoints.ts';
import { isPlainObject, SECRET_MASK, settingSecretKeys } from '../safety.ts';

export type Any = any;
export { isPlainObject, settingSecretKeys };

/** "***": a secret the file left out (EXPORT_MASK in the userscript). */
export const EXPORT_MASK = SECRET_MASK;
/** take of HelloID's lists (SETTINGS.fetchAllTake in the userscript). */
export const FETCH_ALL_TAKE = TAKE_ALL;
/** The empty ID: in a rule condition, "no source system" (as HelloID itself has it). */
export const EMPTY_ID = '00000000-0000-0000-0000-000000000000';
export const POWERSHELL_V1 = 'powershell-onpremise';
export const POWERSHELL_V2 = 'powershell-target';

// ---------------------------------------------------------------------------------------------
// Requests

/** What the planners send their requests with. */
export interface PlannerGateway {
  /** GET; the answer as JSON (fetchFromGateway). Throws "HelloID answered <status> for <path>". */
  fetch(path: string): Promise<Any>;
  /** Any method; the answer as JSON, or as text (sendToGateway). */
  send(path: string, method: string, body?: unknown): Promise<Any>;
}

/** (not in the userscript) an item an apply made, with the ID HelloID gave it (or the server made for it). */
export interface CreatedItem {
  /** The kind, as the import names it: targetSystem, sourceSystem, notificationSystem, notification, businessRule, toxicPolicy, customEvent, schedule. */
  kind: string;
  id: string;
  name: string | null;
}

/** What the userscript takes from the browser: the page's origin, its time zone, IDs, timers. */
export interface PlannerEnv {
  gw: PlannerGateway;
  /** location.origin: the portal (tenantUrl of notifications). */
  origin: string;
  /** The browser's time zone (schedules, reconciliation). */
  timeZone: string;
  uuid(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** (not in the userscript) told about every item an apply makes, with its new ID (set by helloid_apply_plan) */
  onCreated?: (item: CreatedItem) => void;
}

/**
 * The planners' gateway on an environment's client. The signal is read at every request, so a plan
 * made in one call can run in another (apply) with that call's signal.
 */
export function clientGateway(client: HelloIdClient, signal: () => AbortSignal | undefined): PlannerGateway {
  return {
    async fetch(path) {
      try {
        const response = await client.gateway({ path, signal: signal() });
        return JSON.parse(response.text);
      } catch (e) {
        if (e instanceof HelloIdHttpError) throw new Error(`HelloID answered ${e.status} for ${path}`);
        throw e;
      }
    },
    async send(path, method, body) {
      let text: string;
      try {
        text = (await client.gateway({ method, path, body, signal: signal() })).text;
      } catch (e) {
        if (e instanceof HelloIdHttpError) {
          const detail = redactTokens(e.body).slice(0, 300);
          throw new Error(`HelloID answered ${e.status} for ${method} ${path}` + (detail ? `\n${detail}` : ''));
        }
        throw e;
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

/** A PlannerEnv with Node's IDs and timers. */
export function makeEnv(gw: PlannerGateway, origin: string, timeZone: string, overrides: Partial<PlannerEnv> = {}): PlannerEnv {
  return {
    gw,
    origin,
    timeZone,
    uuid: randomUUID,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Marks: the userscript marks errors, warnings and what has to stand out in its texts. The overview
// leaves them out (withoutMarks); they are kept here so the texts are built as the userscript's.

const ERROR_START = '\u0005';
const WARNING_START = '\u0002';
const STRONG_START = '\u0004';
const MARK_END = '\u0003';
export const withoutMarks = (text: string) =>
  [ERROR_START, WARNING_START, STRONG_START, MARK_END].reduce((result, mark) => result.replaceAll(mark, ''), text);
const marked = (start: string) => (text: string) => (text ? `${start}${withoutMarks(text)}${MARK_END}` : '');
export const error = marked(ERROR_START);
export const warn = marked(WARNING_START);
export const strong = marked(STRONG_START);

// ---------------------------------------------------------------------------------------------
// Small helpers

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
export const rowsOf = (answer: Any): Any[] =>
  Array.isArray(answer) ? answer : Array.isArray(answer?.pageData) ? answer.pageData : [];
/** An ID in an answer: the text itself, or an object with one of these. */
export const idIn = (answer: Any, ...keys: string[]): string | null =>
  typeof answer === 'string' && answer ? answer : (keys.map((k) => answer?.[k]).find((v) => typeof v === 'string' && v) ?? null);
export const uniqueBy = <T>(arr: T[], key: (x: T) => unknown): T[] => [...new Map(arr.map((x) => [key(x), x])).values()];

/** The keys whose values differ, as lines: 'name: "a" -> "b"', or only the key for what is not a short value. */
export function keyChanges(wanted: Any, current: Any, keys: string[]): string[] {
  const short = (v: Any) => (v === null || ['string', 'number', 'boolean'].includes(typeof v)) && String(v).length <= 60;
  return keys
    .filter((k) => !sameJson(wanted[k], current?.[k]))
    .map((k) => (short(wanted[k]) && short(current?.[k]) ? `${k}: ${JSON.stringify(current?.[k] ?? null)} -> ${JSON.stringify(wanted[k])}` : k));
}

/** Defaults + overrides; nested objects are merged too. */
export function mergeSettings(defaults: Any, overrides: Any): Any {
  const result: Any = { ...defaults };
  for (const [key, value] of Object.entries(overrides || {})) {
    result[key] = isPlainObject(defaults[key]) && isPlainObject(value) ? mergeSettings(defaults[key], value) : value;
  }
  return result;
}

export function setPath(obj: Any, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let o = obj;
  for (const k of keys) {
    if (!isPlainObject(o[k])) o[k] = {};
    o = o[k];
  }
  o[last] = value;
}

/** Values in nested objects, by a dotted key ("text.required"), as HelloID's forms name them. */
export const getIn = (obj: Any, path: string): Any => path.split('.').reduce((o: Any, k) => (isPlainObject(o) ? o[k] : undefined), obj);

/** The default values of a configuration form (its fields, or an object with them), by their keys. */
export function formDefaults(form: Any): Any {
  const values = {};
  const walk = (fields: Any) =>
    (Array.isArray(fields) ? fields : []).forEach((field: Any) => {
      if (!isPlainObject(field)) return;
      const f = field as Any;
      if (f.key && f.defaultValue !== undefined) setPath(values, String(f.key), structuredClone(f.defaultValue));
      walk(f.fieldGroup);
    });
  walk(Array.isArray(form) ? form : form?.fields);
  return values;
}

/** Values for a form that are not imported: what the system has, and the form's default where it has nothing. */
export const valuesOrDefaults = (form: Any, values: Any) => mergeSettings(formDefaults(form), isPlainObject(values) ? values : {});

/** Two selections of agents with the same tags and pools? */
export const sameAgentSelection = (a: Any, b: Any) => {
  const keys = (selection: Any) => ((selection ?? []) as Any[]).map((s) => `${s?.type}:${s?.value}`).sort().join();
  return keys(a) === keys(b);
};

/** Values the file left out ("***") get the value they have here, or else an empty one. */
export function restoreValues(values: Any, current: Any): Any {
  if (!isPlainObject(values)) return values;
  const copy = structuredClone(values) as Any;
  const walk = (o: Any, path: string) =>
    Object.keys(o).forEach((key) => {
      const at = path ? `${path}.${key}` : key;
      if (isPlainObject(o[key])) walk(o[key], at);
      else if (o[key] === EXPORT_MASK) o[key] = getIn(current, at) ?? '';
    });
  walk(copy, '');
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Systems, custom events, entitlements

/** HelloID's list of target systems (fetchSystems). */
export async function fetchSystems(env: PlannerEnv): Promise<Any[]> {
  const systems = await env.gw.fetch(IMPORT_PATHS.systems);
  return Array.isArray(systems) ? systems : [];
}

export interface SystemDirectory {
  all: Any[];
  find(id: unknown, name?: unknown): Any | undefined;
  nameOf(id: unknown): string | null;
}

/** Target and source systems here; find(id, name): the one for a system of the file. */
export async function systemDirectory(env: PlannerEnv): Promise<SystemDirectory> {
  const [targets, sources] = await Promise.all([fetchSystems(env), env.gw.fetch(IMPORT_PATHS.sourceSystems).catch(() => [])]);
  const all = [...targets, ...rowsOf(sources)].filter((s) => s?.systemId);
  return {
    all,
    find: (id, name) => all.find((s) => s.systemId === id) ?? (typeof name === 'string' ? all.find((s) => sameText(s.displayName, name)) : undefined),
    nameOf: (id) => all.find((s) => s.systemId === id)?.displayName ?? null,
  };
}

/** The name a file gives a system ID (its list "systems"). */
export const fileSystemName = (data: Any, id: unknown): string | null =>
  ((Array.isArray(data?.systems) ? data.systems : []) as Any[]).find((s) => s?.systemId === id)?.displayName ?? null;

/** By ID, or else (another environment) by name. */
export const byIdOrName = (items: Any[], id: unknown, name: unknown) =>
  items.find((i) => i?.systemId === id) ?? (typeof name === 'string' ? items.find((i) => i?.displayName?.trim() === name.trim()) : undefined);

/** The custom events (of the notifications); [] when they can't be read. */
export async function readCustomEvents(env: PlannerEnv): Promise<Any[]> {
  const answer = await env.gw.fetch(IMPORT_PATHS.customEventList(FETCH_ALL_TAKE)).catch(() => null);
  return Array.isArray(answer) ? answer : (answer?.pageData ?? []);
}

/** The custom event here for a notification of a file, or undefined. */
export const customEventHere = (notification: Any, events: Any[]) =>
  events.find((e) => e?.customEventId === notification.customEventId) ??
  (typeof notification.customEventName === 'string'
    ? events.find((e) => typeof e?.name === 'string' && e.name.trim() === notification.customEventName.trim())
    : undefined);

/** The key HelloID gives a target system in a notification's data references: its name, letters and digits only. */
export const dataReferenceKey = (name: unknown) => String(name).replace(/[^A-Za-z0-9]/g, '');

export const ENTITLEMENT_TYPES: Record<string, string> = { 1: 'Account', 2: 'AccountAccess', 3: 'Permission' };
/** The entitlements-overview flags of a rule that grants on a system. */
export const RULE_ENTITLEMENT_FIELDS = ['accountEntitlementForSystem', 'accountAccessEntitlementForSystem', 'permissionEntitlementForSystem'];

/** An entitlement as rules have it, from a row of the list of entitlements (which has the type as a number). */
export function ruleEntitlement(row: Any, system: Any): Any {
  const entitlement = isPlainObject(row?.entitlement) ? { ...row, ...row.entitlement } : (row ?? {});
  const type = entitlement.type ?? entitlement.entitlementType;
  return {
    entitlementId: entitlement.entitlementId ?? entitlement.id,
    systemIdentifier: entitlement.systemIdentifier ?? entitlement.systemId,
    type: ENTITLEMENT_TYPES[type] ?? type,
    displayName: entitlement.displayName ?? entitlement.entitlementName ?? entitlement.name,
    permissionDefinitionDisplayName: entitlement.permissionDefinitionDisplayName ?? null,
    systemName: system.displayName,
  };
}

export const entitlementLabel = (e: Any) =>
  e.type === 'Permission'
    ? `permission "${e.displayName}"${e.permissionDefinitionDisplayName ? ` (${e.permissionDefinitionDisplayName})` : ''}`
    : e.type === 'AccountAccess'
      ? 'account access'
      : e.type === 'Account'
        ? 'account'
        : `${e.type} "${e.displayName}"`;

/**
 * All entitlements that rules and policies can have; the result finds the one here for an
 * entitlement of a file (by ID, else by its system, type and name), or null.
 */
export async function entitlementDirectory(env: PlannerEnv, systems: SystemDirectory) {
  const all = rowsOf(await env.gw.fetch(IMPORT_PATHS.ruleEntitlements(FETCH_ALL_TAKE)))
    .filter((row) => row?.inTargetSystem !== false)
    .map((row) => ruleEntitlement(row, {}));
  return (entitlement: Any, systemName: unknown): Any => {
    const e = ruleEntitlement(entitlement, {});
    const same = all.find((a) => a.entitlementId === e.entitlementId);
    if (same) return same;
    const system = systems.find(e.systemIdentifier, systemName);
    if (!system) return null;
    const named = all.filter((a) => a.systemIdentifier === system.systemId && a.type === e.type && a.displayName === e.displayName);
    return (
      named.find((a) => (a.permissionDefinitionDisplayName ?? null) === (e.permissionDefinitionDisplayName ?? null)) ??
      (named.length === 1 ? named[0] : null)
    );
  };
}

export const entitlementKey = (e: Any) => `${e.systemIdentifier}|${e.type}|${e.displayName}|${e.permissionDefinitionDisplayName ?? ''}`;

/** Entitlements added and removed, as lines. */
export function entitlementChanges(wanted: Any, current: Any, systems: SystemDirectory): string[] {
  const label = (e: Any) => `${entitlementLabel(e)} of "${systems.nameOf(e.systemIdentifier) ?? e.systemIdentifier}"`;
  const mine = ((wanted ?? []) as Any[]).map((e) => ruleEntitlement(e, {}));
  const theirs = ((current ?? []) as Any[]).map((e) => ruleEntitlement(e, {}));
  return [
    ...mine.filter((e) => !theirs.some((t) => entitlementKey(t) === entitlementKey(e))).map((e) => `+ ${label(e)}`),
    ...theirs.filter((t) => !mine.some((e) => entitlementKey(t) === entitlementKey(e))).map((t) => `- ${label(t)}`),
  ];
}

// ---------------------------------------------------------------------------------------------
// Auto: what the imports get instead of their dialogs (makeAuto in the userscript)
//   plan: only work out what would change (nothing is written)
//   decide(key, spec): the answer to a special case; spec: section, item, detail, options
//       [{ value, label, description }], default. Each one is collected for the open choices.
//   pending(kind, name): is it made earlier in this run (kind: system, customEvent,
//       notificationSystem)? need(name): this item needs it
//   skip(reason), same(), planned({ lines, notes, isNew, name, id, ids }): what an import answers
//       instead of doing it

export interface DecisionOption {
  value: unknown;
  label: string;
  description?: string;
}

export interface Decision {
  key: string;
  section: string;
  item: string;
  detail?: string;
  options: DecisionOption[];
  default: unknown;
}

export type DecisionSpec = Omit<Decision, 'key'>;
export type Answers = Record<string, unknown>;
export type Pending = (kind: string, name: unknown) => boolean;

export interface Auto {
  plan: boolean;
  decisions: Decision[];
  needs: Set<string>;
  decide(key: string, spec: DecisionSpec): unknown;
  pending(kind: string, name: unknown): boolean;
  need(name: unknown): void;
  skip(reason: string): Any;
  same(): Any;
  planned(result: Any): Any;
}

export function makeAuto({ plan, answers = {}, pending = () => false }: { plan: boolean; answers?: Answers; pending?: Pending }): Auto {
  const auto: Auto = {
    plan,
    decisions: [],
    needs: new Set(),
    decide(key, spec) {
      if (!auto.decisions.some((d) => d.key === key)) auto.decisions.push({ key, ...spec });
      return key in answers ? answers[key] : spec.default;
    },
    pending: (kind, name) => plan && pending(kind, name),
    need: (name) => {
      if (name) auto.needs.add(name as string);
    },
    skip: (reason) => ({ skip: reason }),
    same: () => ({ same: true }),
    planned: (result) => ({ planned: result }),
  };
  return auto;
}

// ---------------------------------------------------------------------------------------------
// The overview

/** todo: will be done; same: already as in the file; note: will be done, with a note; skip: will not be done. */
export type EntryStatus = 'todo' | 'same' | 'note' | 'skip';
/** After apply: done, note (done with a note), failed; entries that did not run keep their planned status. */
export type RunStatus = EntryStatus | 'done' | 'failed' | 'running';

/** What an entry touches in HelloID: read for the fingerprint and for the audit's before and after. */
export interface Touch {
  /** A key for the fingerprint, unique per item. */
  key: string;
  /** For the audit line, e.g. "target system "Alpha"". */
  label: string;
  read(env: PlannerEnv): Promise<unknown>;
  /** The item with its secrets masked, for the audit (default: as read). */
  mask?: (value: Any) => unknown;
}

export interface OverviewEntry {
  group: string;
  label: string;
  status: RunStatus;
  details: string[];
  provides?: string;
  needs: string[];
  run?: (() => Promise<string[]>) | null;
  /** (not in the userscript) what it touches, for the fingerprints and the audit */
  touches?: Touch[];
  /** (not in the userscript) after apply: the items it made, with their new IDs */
  created?: CreatedItem[];
  /** (not in the userscript) warnings of the server's own checks, e.g. the DryRun check of planned scripts */
  warnings?: string[];
}

const detailLines = (texts: unknown[] | undefined) =>
  (texts ?? [])
    .flatMap((text) => withoutMarks(String(text)).split('\n'))
    .map((text) => text.trimEnd())
    .filter((text) => text.trim());

/** A line of the overview, from what an import answered (see makeAuto). */
export function overviewEntry(result: Any, base: Omit<OverviewEntry, 'status' | 'details'>): OverviewEntry {
  if (result?.error) return { ...base, status: 'skip', details: detailLines([result.error]) };
  if (result?.skip) return { ...base, status: 'skip', details: detailLines([result.skip]) };
  if (result?.same || !result?.planned) return { ...base, status: 'same', details: ['already as in the file'], run: null };
  const notes = detailLines(result.planned.notes);
  return { ...base, status: notes.length ? 'note' : 'todo', details: [...detailLines(result.planned.lines), ...notes] };
}

/** What to call a type of file in the overview. */
export const KIND_LABELS: Record<string, string> = {
  targetSystem: 'Target systems',
  sourceSystem: 'Source systems',
  notificationSystem: 'Notification systems',
  customEvent: 'Custom events',
  notifications: 'Notifications',
  businessRule: 'Business rules',
  toxicPolicy: 'Toxic policies',
  schedule: 'Schedules',
  sourceConfiguration: 'Source configuration',
  aggregationConfiguration: 'Aggregation configuration',
  personLifecycle: 'Person lifecycle',
  excludedPersons: 'Excluded persons',
  reconciliationConfiguration: 'Reconciliation configuration',
};

/** The batch a planner works in (overwriteAll's planAll). */
export interface Batch {
  answers: Answers;
  decisions: Decision[];
  decide(key: string, spec: DecisionSpec): unknown;
  pending: Pending;
}

export interface ImportFile {
  name: string;
  data: Any;
  kind: string;
}

export type Planner = (files: ImportFile[], batch: Batch) => Promise<OverviewEntry[]>;
