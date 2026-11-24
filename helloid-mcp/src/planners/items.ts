// Items of a type: business rules, toxic policies, custom events, schedules (RULE_IMPORT,
// TOXIC_IMPORT, CUSTOM_EVENT_IMPORT, SCHEDULE_IMPORT and itemsPlanner of the userscript).
// A type:
//   contents, plural: the files and texts
//   valid(data): is it a file of this type?
//   context(): what all files need (systems, entitlements)
//   list(ctx): the items here
//   item(data): the item in a file; idOf/nameOf(item)
//   prepare(data, match, ctx): { wanted, changes, problems, notes, blocked }
//   write(plan, ctx): saves it

import { IMPORT_PATHS } from '../helloid/endpoints.ts';
import {
  type Any,
  type Batch,
  EMPTY_ID,
  entitlementChanges,
  entitlementDirectory,
  entitlementLabel,
  FETCH_ALL_TAKE,
  fileSystemName,
  idIn,
  type ImportFile,
  isPlainObject,
  KIND_LABELS,
  keyChanges,
  type OverviewEntry,
  overviewEntry,
  type PlannerEnv,
  ruleEntitlement,
  rowsOf,
  sameJson,
  sameText,
  type SystemDirectory,
  systemDirectory,
  type Touch,
} from './common.ts';

/**
 * Titles and departments in a rule's condition are kept by their external ID, with their source
 * system: the one of the same name here. notes: what can't be found. ctx: pending and need.
 */
export function conditionHere(condition: Any, systems: SystemDirectory, notes: string[], ctx: Any = null): Any {
  if (!isPlainObject(condition)) return condition;
  const copy = structuredClone(condition) as Any;
  const here = (entry: Any) => {
    const id = entry?.source?.systemId ?? entry?.sourceSystemId;
    // (no source system: the empty ID, as HelloID itself has it)
    if (!id || id === EMPTY_ID) return entry;
    const name = entry.source?.displayName ?? entry.sourceSystemDisplayName;
    const system = systems.find(id, name);
    if (!system && ctx?.pending?.('system', name)) {
      ctx.need?.(name);
      const note = `the condition is linked to source system "${name}" after it is made`;
      if (!notes.includes(note)) notes.push(note);
      return entry;
    }
    if (!system) {
      notes.push(`"${entry.name ?? entry.displayName ?? entry.externalId}" in the condition is of source system "${name ?? id}", ` + 'which is not in this HelloID environment');
      return entry;
    }
    if (system.systemId === id) return entry;
    return {
      ...entry,
      ...(isPlainObject(entry.source)
        ? {
            source: {
              ...entry.source,
              systemId: system.systemId,
              displayName: system.displayName,
              identificationKey: entry.source.identificationKey === id ? system.systemId : entry.source.identificationKey,
            },
          }
        : {}),
      ...('sourceSystemId' in entry ? { sourceSystemId: system.systemId } : {}),
      ...('sourceSystemDisplayName' in entry ? { sourceSystemDisplayName: system.displayName } : {}),
    };
  };
  if (Array.isArray(copy.titleCondition?.titles)) copy.titleCondition.titles = copy.titleCondition.titles.map(here);
  if (Array.isArray(copy.departmentCondition?.departments)) copy.departmentCondition.departments = copy.departmentCondition.departments.map(here);
  return copy;
}

/** The hour in a time zone at a UTC hour (today), and its offset. */
function hourInZone(zone: string, utcHour: number, now: number) {
  const at = new Date(now);
  at.setUTCHours(utcHour, 0, 0, 0);
  let local = utcHour;
  try {
    local =
      Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(at).find((p) => p.type === 'hour')?.value ?? utcHour) % 24;
  } catch {
    /* unknown zone: UTC */
  }
  return { local, offset: ((local - utcHour + 36) % 24) - 12 };
}

export interface ItemType {
  contents: string;
  plural: string;
  limit?: number;
  valid(data: Any): boolean;
  context(): Promise<Any>;
  list(ctx: Any): Promise<Any[]>;
  item(data: Any): Any;
  idOf(item: Any): Any;
  nameOf(item: Any): Any;
  prepare(data: Any, match: Any, ctx: Any): Promise<Any>;
  write(plan: Any, ctx: Any): Promise<void>;
  /** (not in the userscript) the item as HelloID has it, for the fingerprints and the audit */
  read(match: Any): Promise<Any>;
}

export function itemTypes(env: PlannerEnv): ItemType[] {
  const fetchFromGateway = (path: string) => env.gw.fetch(path);
  const sendToGateway = (path: string, method: string, body?: unknown) => env.gw.send(path, method, body);

  const ruleContext = async () => {
    const systems = await systemDirectory(env);
    return { systems, entitlement: await entitlementDirectory(env, systems) };
  };

  // Business rules: condition and entitlements as a DRAFT; name, description and categories right away
  const RULE_IMPORT: ItemType = {
    contents: 'businessRule',
    plural: 'Business rules',
    valid: (data) => isPlainObject(data.rule) && typeof data.rule.name === 'string',
    context: ruleContext,
    list: async () => rowsOf(await sendToGateway(`${IMPORT_PATHS.rules}/overview`, 'POST', { search: '', skip: 0, take: FETCH_ALL_TAKE, published: true, draft: true })),
    item: (data) => data.rule,
    idOf: (rule) => rule?.ruleId,
    nameOf: (rule) => rule?.name,
    async prepare(data, match, ctx) {
      const rule = data.rule;
      const problems: string[] = [];
      const notes: string[] = [];
      const entitlements: Any[] = [];
      for (const e of (rule.entitlements ?? []) as Any[]) {
        const systemName = fileSystemName(data, e.systemIdentifier);
        const found = ctx.entitlement(e, systemName);
        if (found) {
          const { systemName: _, ...entitlement } = found;
          if (!entitlements.some((x) => x.entitlementId === entitlement.entitlementId)) entitlements.push(entitlement);
        } else if (ctx.pending?.('system', systemName)) {
          ctx.need?.(systemName);
          const note = `the entitlements of "${systemName}" are linked after it is made`;
          if (!notes.includes(note)) notes.push(note);
        } else {
          problems.push(`${entitlementLabel(ruleEntitlement(e, {}))} of "${systemName ?? e.systemIdentifier}": not an entitlement here`);
        }
      }
      const condition = conditionHere(rule.condition ?? null, ctx.systems, notes, ctx);
      const wanted = { name: rule.name, description: rule.description ?? '', categories: rule.categories ?? [], condition, entitlements };
      const current = match ? await fetchFromGateway(IMPORT_PATHS.rule(match.ruleId)) : null;
      const latest =
        current?.hasDraft && isPlainObject(current.draft)
          ? { condition: current.draft.condition ?? current.condition, entitlements: current.draft.entitlements ?? current.entitlements }
          : current;
      const draftChanges = !current ? [] : [...keyChanges(wanted, latest, ['condition']), ...entitlementChanges(entitlements, latest.entitlements, ctx.systems)];
      if (current?.hasDraft && draftChanges.length) notes.push('the rule has an unpublished draft: the import replaces it');
      const changes = !current
        ? ['a new rule, saved as a draft']
        : [...keyChanges(wanted, current, ['name', 'description', 'categories']).map((c) => `${c} (takes effect right away, not as a draft)`), ...draftChanges];
      return { wanted, current, changes, problems, notes };
    },
    async write(plan) {
      let ruleId = plan.current?.ruleId;
      if (!ruleId) {
        ruleId = idIn(await sendToGateway(`${IMPORT_PATHS.rules}/add`, 'PUT', {}), 'ruleId', 'id');
        if (!ruleId) throw new Error('HelloID did not say which rule it made.');
        env.onCreated?.({ kind: 'businessRule', id: ruleId, name: plan.wanted.name ?? null });
      }
      let rule = await fetchFromGateway(IMPORT_PATHS.rule(ruleId));
      const general = ['name', 'description', 'categories'];
      if (!plan.current || !sameJson(general.map((k) => rule[k]), general.map((k) => plan.wanted[k]))) {
        await sendToGateway(`${IMPORT_PATHS.rules}/${encodeURIComponent(ruleId)}/general`, 'PUT', { ...rule, ...plan.wanted });
        rule = await fetchFromGateway(IMPORT_PATHS.rule(ruleId));
      }
      await sendToGateway(IMPORT_PATHS.rules, 'POST', { ...rule, ...plan.wanted });
    },
    read: (match) => fetchFromGateway(IMPORT_PATHS.rule(match.ruleId)),
  };

  // Toxic policies: the entitlements by their system, type and name
  const TOXIC_IMPORT: ItemType = {
    contents: 'toxicPolicy',
    plural: 'Toxic policies',
    valid: (data) => isPlainObject(data.policy) && typeof data.policy.name === 'string',
    context: ruleContext,
    list: async () => rowsOf(await fetchFromGateway(`${IMPORT_PATHS.toxic}?take=${FETCH_ALL_TAKE}`)),
    item: (data) => data.policy,
    idOf: (policy) => policy?.toxicCombinationId,
    nameOf: (policy) => policy?.name,
    async prepare(data, match, ctx) {
      const policy = data.policy;
      const problems: string[] = [];
      const notes: string[] = [];
      const map = (ids: Any) =>
        ((ids ?? []) as Any[])
          .map((id) => {
            const e = ((data.entitlements ?? []) as Any[]).find((x) => x?.entitlementId === id) ?? { entitlementId: id };
            const systemName = fileSystemName(data, e.systemIdentifier);
            const found = ctx.entitlement(e, systemName);
            if (!found && ctx.pending?.('system', systemName)) {
              ctx.need?.(systemName);
              const note = `the entitlements of "${systemName}" are linked after it is made`;
              if (!notes.includes(note)) notes.push(note);
            } else if (!found) {
              problems.push(`${e.displayName ? entitlementLabel(ruleEntitlement(e, {})) : `entitlement ${id}`}` + `${systemName ? ` of "${systemName}"` : ''}: not an entitlement here`);
            }
            return found?.entitlementId ?? null;
          })
          .filter(Boolean);
      const wanted = {
        name: policy.name,
        description: policy.description ?? '',
        enabled: match ? policy.enabled === true : false,
        type: policy.type,
        inputObjectIds: map(policy.inputObjectIds),
        outputObjectIds: map(policy.outputObjectIds),
      };
      const changes = !match ? ['a new toxic policy, disabled'] : keyChanges(wanted, match, ['name', 'description', 'enabled', 'type', 'inputObjectIds', 'outputObjectIds']);
      return { wanted, changes, problems, notes };
    },
    async write(plan) {
      const id = plan.match?.toxicCombinationId ?? idIn(await sendToGateway(IMPORT_PATHS.toxic, 'PUT', {}), 'toxicCombinationId', 'id');
      if (!id) throw new Error('HelloID did not say which toxic policy it made.');
      if (!plan.match) env.onCreated?.({ kind: 'toxicPolicy', id, name: plan.wanted.name ?? null });
      await sendToGateway(`${IMPORT_PATHS.toxic}/configuration`, 'POST', { toxicCombinationId: id, ...plan.wanted });
    },
    read: async (match) => match,
  };

  // Custom events of the notifications: their system by ID or name
  const CUSTOM_EVENT_IMPORT: ItemType = {
    contents: 'customEvent',
    plural: 'Custom events',
    valid: (data) => isPlainObject(data.customEvent) && typeof data.customEvent.name === 'string',
    context: async () => ({ systems: await systemDirectory(env) }),
    list: async () => rowsOf(await fetchFromGateway(`${IMPORT_PATHS.customEvents}?take=${FETCH_ALL_TAKE}`)),
    item: (data) => data.customEvent,
    idOf: (event) => event?.customEventId,
    nameOf: (event) => event?.name,
    async prepare(data, match, ctx) {
      const event = data.customEvent;
      const system = event.systemId ? ctx.systems.find(event.systemId, data.systemName) : null;
      const notes: string[] = [];
      if (event.systemId && !system) {
        if (!ctx.pending?.('system', data.systemName)) return { blocked: `its system "${data.systemName ?? event.systemId}" is not in this HelloID environment` };
        ctx.need?.(data.systemName);
        notes.push(`after system "${data.systemName}" is made`);
      }
      const wanted = { name: event.name, systemId: system?.systemId ?? null, action: event.action, conditions: event.conditions ?? [] };
      const changes = !match ? ['a new custom event'] : keyChanges(wanted, match, ['name', 'systemId', 'action', 'conditions']);
      return { wanted, changes, problems: [], notes };
    },
    async write(plan) {
      const id = plan.match?.customEventId ?? idIn(await sendToGateway(IMPORT_PATHS.customEvents, 'POST', {}), 'customEventId', 'id');
      if (!id) throw new Error('HelloID did not say which custom event it made.');
      if (!plan.match) env.onCreated?.({ kind: 'customEvent', id, name: plan.wanted.name ?? null });
      await sendToGateway(IMPORT_PATHS.customEvent(id), 'POST', { customEventId: id, ...plan.wanted, isValid: null });
    },
    read: async (match) => match,
  };

  // Schedules of the snapshots: the hour in UTC, as in the file; their tasks' systems by ID or name
  const SCHEDULE_IMPORT: ItemType = {
    contents: 'schedule',
    plural: 'Schedules',
    limit: 3,
    valid: (data) => isPlainObject(data.schedule) && typeof data.schedule.name === 'string',
    context: async () => ({ systems: await systemDirectory(env) }),
    list: async () => rowsOf(await fetchFromGateway(`${IMPORT_PATHS.schedule}?timeZone=${encodeURIComponent(env.timeZone)}`)),
    item: (data) => data.schedule,
    idOf: (schedule) => schedule?.scheduleId,
    nameOf: (schedule) => schedule?.name,
    async prepare(data, match, ctx) {
      const schedule = data.schedule;
      const problems: string[] = [];
      const notes: string[] = [];
      const tasks = ((schedule.tasks ?? []) as Any[])
        .filter(isPlainObject)
        .map((task: Any) => {
          if (!task.systemId) return { type: task.type };
          const name = fileSystemName(data, task.systemId);
          const system = ctx.systems.find(task.systemId, name);
          if (!system && ctx.pending?.('system', name)) {
            ctx.need?.(name);
            notes.push(`the task for "${name}" is set after that system is made`);
            return null;
          }
          if (!system) problems.push(`the task for "${name ?? task.systemId}": that system is not in this HelloID environment`);
          return system ? { type: task.type, systemId: system.systemId } : null;
        })
        .filter(Boolean);
      const wanted = {
        name: schedule.name,
        enabled: match ? schedule.enabled === true : false,
        useSpecificTimeZone: schedule.useSpecificTimeZone === true,
        selectedTimeZone: schedule.selectedTimeZone ?? null,
        observeDst: schedule.observeDst === true,
        hourOfDayUtc: schedule.hourOfDayUtc,
        tasks,
      };
      const current = match && { ...match, tasks: ((match.tasks ?? []) as Any[]).map((t) => (t.systemId ? { type: t.type, systemId: t.systemId } : { type: t.type })) };
      const changes = !match
        ? ['a new schedule, disabled']
        : keyChanges(wanted, current, ['name', 'enabled', 'useSpecificTimeZone', 'selectedTimeZone', 'observeDst', 'hourOfDayUtc', 'tasks']);
      return { wanted, changes, problems, notes };
    },
    async write(plan) {
      const zone = plan.wanted.useSpecificTimeZone && plan.wanted.selectedTimeZone ? plan.wanted.selectedTimeZone : env.timeZone;
      const { local, offset } = hourInZone(zone, plan.wanted.hourOfDayUtc, env.now());
      const scheduleId = plan.match?.scheduleId ?? env.uuid();
      await sendToGateway(IMPORT_PATHS.schedule, 'POST', {
        scheduleId,
        ...plan.wanted,
        lastRunTime: plan.match?.lastRunTime ?? null,
        hourOfDayLocal: local,
        timezoneOffsetHours: offset,
      });
      // (not in the userscript) a new schedule: the ID made for it here
      if (!plan.match) env.onCreated?.({ kind: 'schedule', id: scheduleId, name: plan.wanted.name ?? null });
    },
    read: async (match) => match,
  };

  return [RULE_IMPORT, TOXIC_IMPORT, CUSTOM_EVENT_IMPORT, SCHEDULE_IMPORT];
}

/** The item of a type as it is in HelloID now, found as the planner finds it (by ID, else by name). */
function itemTouch(type: ItemType, find: { id: Any; name: Any }): Touch {
  return {
    key: `${type.contents}:${find.id ?? ''}:${find.name ?? ''}`,
    label: `${KIND_LABELS[type.contents]!.replace(/s$/, '').replace(/ie$/, 'y').toLowerCase()} "${find.name ?? find.id}"`,
    async read() {
      const here = await type.list(await type.context());
      const match =
        here.find((h) => find.id && type.idOf(h) === find.id) ?? (find.name !== undefined ? here.find((h) => sameText(type.nameOf(h), find.name)) : undefined);
      return match ? type.read(match) : null;
    },
  };
}

/** Rules, toxic policies, custom events, schedules: all files of a type together. */
export function itemsPlanner(type: ItemType) {
  return async (files: ImportFile[], batch: Batch): Promise<OverviewEntry[]> => {
    const ctx: Any = { ...(await type.context()), pending: batch.pending };
    const here = await type.list(ctx);
    const plans: Any[] = [];
    for (const { data } of files) {
      const item = type.item(data);
      const match = here.find((h) => type.idOf(h) && type.idOf(h) === type.idOf(item)) ?? here.find((h) => sameText(type.nameOf(h), type.nameOf(item))) ?? null;
      const needs: string[] = [];
      ctx.need = (name: Any) => {
        if (name && !needs.includes(name)) needs.push(name);
      };
      plans.push({ data, item, match, needs, label: `"${type.nameOf(item)}"`, ...(await type.prepare(data, match, ctx)) });
    }
    // A type HelloID allows only so many of: a choice for each new one that has no room
    if (type.limit) {
      const newOnes = plans.filter((p) => !p.blocked && !p.match);
      let room = type.limit - here.length;
      if (newOnes.length > room) {
        const taken = new Set();
        for (const plan of newOnes) {
          const options = [
            ...(room > 0 ? [{ value: 'add', label: 'Add it', description: `${room} place(s) left of ${type.limit}.` }] : []),
            ...here.map((h) => ({
              value: `replace:${type.idOf(h)}`,
              label: `Replace "${type.nameOf(h)}"`,
              description: `"${type.nameOf(h)}" is overwritten with the one of the file.`,
            })),
            { value: 'skip', label: 'Skip it', description: 'It is not imported.' },
          ];
          const answer = batch.decide(`limit:${type.contents}:${type.idOf(plan.item) ?? type.nameOf(plan.item)}`, {
            section: `More than ${type.limit} ${type.plural.toLowerCase()} (the most HelloID allows)`,
            item: `${plan.label} from the file`,
            options,
            default: options[0]!.value === 'add' ? 'add' : 'skip',
          });
          if (answer === 'add' && room > 0) {
            room--;
          } else if (typeof answer === 'string' && answer.startsWith('replace:') && !taken.has(answer)) {
            taken.add(answer);
            const replaced = here.find((h) => `replace:${type.idOf(h)}` === answer);
            ctx.need = (name: Any) => {
              if (name && !plan.needs.includes(name)) plan.needs.push(name);
            };
            Object.assign(plan, { match: replaced, replaces: type.nameOf(replaced) }, await type.prepare(plan.data, replaced, ctx));
          } else {
            plan.blocked = answer === 'add' ? `no room: HelloID allows at most ${type.limit}` : 'skipped';
          }
        }
      }
    }
    // At run time: the context again (systems made earlier in this run are there by then), the item
    // here again, and its changes
    let runCtx: Promise<Any> | null = null;
    const freshCtx = () => (runCtx ??= type.context());
    return plans.map((plan) => {
      const how = plan.replaces ? `replaces "${plan.replaces}"` : plan.match ? 'overwrite' : 'new';
      const result = plan.blocked
        ? { skip: plan.blocked }
        : plan.match && !plan.changes.length && !plan.problems.length && !plan.needs.length
          ? { same: true }
          : { planned: { lines: plan.changes, notes: [...plan.problems.map((text: string) => `left out: ${text}`), ...plan.notes] } };
      const find = plan.replaces
        ? { id: type.idOf(plan.match), name: undefined }
        : { id: type.idOf(plan.item), name: type.nameOf(plan.item) };
      return overviewEntry(result, {
        group: KIND_LABELS[type.contents]!,
        label: `${plan.label} (${how})`,
        provides: type.nameOf(plan.item),
        needs: plan.needs,
        touches: [itemTouch(type, find)],
        run: async () => {
          const fresh = await freshCtx();
          const hereNow = await type.list(fresh);
          const matchNow = plan.replaces
            ? hereNow.find((h) => type.idOf(h) === type.idOf(plan.match))
            : (hereNow.find((h) => type.idOf(h) && type.idOf(h) === type.idOf(plan.item)) ?? hereNow.find((h) => sameText(type.nameOf(h), type.nameOf(plan.item))) ?? null);
          const now = await type.prepare(plan.data, matchNow, fresh);
          if (now.blocked) throw new Error(now.blocked);
          if (matchNow && !now.changes.length) return [];
          await type.write({ ...now, match: matchNow }, fresh);
          return [...now.problems.map((text: string) => `left out: ${text}`), ...now.notes];
        },
      });
    });
  };
}
