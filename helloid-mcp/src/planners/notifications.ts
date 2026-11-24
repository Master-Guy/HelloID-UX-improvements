// The import of notification configurations (importNotificationsData) and of notification systems
// (importNotificationSystemData) of the userscript, for "Overwrite all" (auto): what its dialogs
// would ask is answered as auto does (overwrite what matches, everything chosen).

import { IMPORT_PATHS } from '../helloid/endpoints.ts';
import {
  type Any,
  type Auto,
  byIdOrName,
  customEventHere,
  dataReferenceKey,
  FETCH_ALL_TAKE,
  fetchSystems,
  isPlainObject,
  type PlannerEnv,
  readCustomEvents,
  restoreValues,
  sameAgentSelection,
  sameJson,
  valuesOrDefaults,
} from './common.ts';
import { sameNotification } from './target-systems.ts';

/** What the export adds to a notification, for another environment; left out again on import. */
const NOTIFICATION_NAMES = ['systemName', 'notificationSystemName', 'notificationSystemBuiltin', 'notificationTemplateName', 'customEventName'];
const NOTIFICATION_GENERAL_FIELDS = ['description', 'displayName', 'icon', 'executeOnPremise'];

export function notificationImports(env: PlannerEnv) {
  const fetchFromGateway = (path: string) => env.gw.fetch(path);
  const sendToGateway = (path: string, method: string, body?: unknown) => env.gw.send(path, method, body);

  /**
   * Each notification of the file goes to the one it was exported from (same ID), or else to the one
   * with the same event and name, or else it is made: disabled, with an ID of its own.
   */
  async function importNotificationsData(data: Any, { auto }: { auto: Auto }): Promise<Any> {
    if (data?.contents !== 'notifications' || !Array.isArray(data.notifications)) {
      throw new Error('The file is not an export of notification configurations.');
    }
    const [senders, targets, list] = await Promise.all([
      fetchFromGateway(IMPORT_PATHS.notificationSystems),
      fetchSystems(env),
      fetchFromGateway(IMPORT_PATHS.allNotifications(FETCH_ALL_TAKE)),
    ]);
    const here: Any[] = list.pageData ?? [];
    const details = new Map<string, Any>();
    const detailOf = async (id: string) => {
      if (!details.has(id)) details.set(id, await fetchFromGateway(IMPORT_PATHS.notificationSystem(id)));
      return details.get(id);
    };

    const entries: Any[] = [];
    const work: Any[] = [];
    const same: string[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    const taken = new Set();
    const fileIds = new Set((data.notifications as Any[]).map((n) => n?.identifier).filter(Boolean));
    let events: Any[] | null = null;
    for (const notification of (data.notifications as Any[]).filter(isPlainObject)) {
      const label = `"${notification.name}" (${notification.event ?? notification.action ?? '?'})`;
      const problems: string[] = [];
      let sender: Any =
        byIdOrName(senders, notification.notificationSystemId, notification.notificationSystemName) ??
        (notification.notificationSystemBuiltin ? (senders as Any[]).find((s) => s.isBuiltin) : undefined);
      if (!sender && auto.pending('notificationSystem', notification.notificationSystemName)) {
        auto.need(notification.notificationSystemName);
        notes.push(`${label}: after notification system "${notification.notificationSystemName}" is made`);
        sender = { systemId: `pending:${notification.notificationSystemName}`, pending: true };
      }
      if (!sender) problems.push(`its notification system "${notification.notificationSystemName ?? notification.notificationSystemId}" is not in this HelloID environment`);
      let templateId = null;
      if (sender && !sender.pending && notification.notificationTemplateId) {
        const templates: Any[] = (await detailOf(sender.systemId)).notificationTemplates ?? [];
        const template =
          templates.find((t) => t.templateId === notification.notificationTemplateId) ??
          templates.find((t) => t.displayName === notification.notificationTemplateName);
        if (template) templateId = template.templateId;
        else {
          problems.push(
            `its template "${notification.notificationTemplateName ?? notification.notificationTemplateId}" is not in notification system "${sender.displayName}"`,
          );
        }
      }
      let systemId = null;
      if (notification.systemId) {
        const system = byIdOrName(targets, notification.systemId, notification.systemName);
        if (system) systemId = system.systemId;
        else if (auto.pending('system', notification.systemName)) {
          auto.need(notification.systemName);
          notes.push(`${label}: after target system "${notification.systemName}" is made`);
        } else problems.push(`its target system "${notification.systemName ?? notification.systemId}" is not in this HelloID environment`);
      }
      let customEventId = notification.customEventId ?? null;
      if (customEventId) {
        events ??= await readCustomEvents(env);
        const event = customEventHere(notification, events);
        if (event) customEventId = event.customEventId;
        else if (auto.pending('customEvent', notification.customEventName)) {
          auto.need(notification.customEventName);
          notes.push(`${label}: after custom event "${notification.customEventName}" is made`);
        } else {
          problems.push(
            `its custom event "${notification.customEventName ?? notification.customEventId}" is not in ` + 'this HelloID environment (import the custom events first)',
          );
        }
      }
      if (problems.length) {
        skipped.push(`${label}: ${problems.join('; ')}`);
        continue;
      }
      const later: string[] = [];
      const references = ((notification.dataReferences ?? []) as Any[]).map((reference) => {
        const system = byIdOrName(targets, reference.systemId, reference.displayName);
        if (!system && auto.pending('system', reference.displayName)) {
          auto.need(reference.displayName);
          later.push(`"${reference.displayName}"`);
          return { key: dataReferenceKey(reference.displayName), type: reference.type, systemId: `pending:${reference.displayName}` };
        }
        if (!system) return null;
        return { key: system.systemId === reference.systemId ? reference.key : dataReferenceKey(system.displayName), type: reference.type, systemId: system.systemId };
      });
      if (later.length) notes.push(`${label}: the data of ${later.join(', ')} is linked after it is made`);
      const missing = ((notification.dataReferences ?? []) as Any[]).filter((_r, i) => !references[i]);
      if (missing.length) {
        notes.push(`${label}: left out the data of target systems that are not here: ` + missing.map((r) => r.displayName ?? r.key).join(', '));
      }

      const byName = here.filter(
        (n) => !taken.has(n) && !fileIds.has(n.identifier) && n.event === notification.event && n.name === notification.name,
      );
      const match =
        here.find((n) => !taken.has(n) && n.identifier === notification.identifier) ?? byName.find((n) => (n.systemId ?? null) === systemId) ?? byName[0];
      if (match) taken.add(match);
      const current = match ? await fetchFromGateway(IMPORT_PATHS.notification(match.identifier)) : null;
      const rest: Any = Object.fromEntries(
        Object.entries(notification).filter(([key]) => !NOTIFICATION_NAMES.includes(key) && key !== 'lastChange' && key !== 'couldNotRead'),
      );
      const body = {
        ...rest,
        identifier: match?.identifier ?? env.uuid(),
        systemId,
        customEventId,
        notificationSystemId: sender.systemId,
        notificationTemplateId: templateId,
        notificationTemplateData: restoreValues(rest.notificationTemplateData, current?.notificationTemplateData),
        dataReferences: references.filter(Boolean),
        tenantUrl: env.origin,
        enabled: match ? rest.enabled === true : false,
      };
      entries.push({ label, body, isNew: !match, identifier: match?.identifier, same: Boolean(current && sameNotification(body, current)), overwrites: match?.name });
    }

    // auto: overwrite what matches, every notification, with their data references
    entries.forEach((e) => {
      if (e.same) same.push(e.label);
      else work.push(e);
    });

    const added = work.filter((w) => w.isNew);
    const changed = work.filter((w) => !w.isNew);
    if (!work.length) return skipped.length ? auto.skip(skipped.join('; ')) : auto.same();
    if (auto.plan) {
      return auto.planned({
        ids: changed.map((w) => w.identifier),
        lines: [...added.map((w) => `${w.label}: new, DISABLED`), ...changed.map((w) => `${w.label}: overwrite`)],
        notes: [...skipped.map((text) => `not imported: ${text}`), ...notes],
      });
    }
    for (const w of work) {
      await sendToGateway(IMPORT_PATHS.notifications, 'POST', w.body);
      // (not in the userscript) a new notification: the identifier made for it here, which HelloID keeps
      if (w.isNew) env.onCreated?.({ kind: 'notification', id: w.body.identifier, name: w.body.name ?? null });
    }
    return true;
  }

  /**
   * Into the notification system it was exported from (same ID), or else the one with the same name
   * (the built-in one: the built-in one here), or else a new one.
   */
  async function importNotificationSystemData(data: Any, { auto }: { auto: Auto }): Promise<Any> {
    const file = data.system;
    const senders: Any[] = await fetchFromGateway(IMPORT_PATHS.notificationSystems);
    const found =
      senders.find((s) => s.systemId === file.systemId) ??
      (file.isBuiltin ? senders.find((s) => s.isBuiltin) : senders.find((s) => !s.isBuiltin && s.displayName?.trim() === file.displayName?.trim()));
    const created = !found;
    if (created && file.isBuiltin) {
      throw new Error('The file is of the built-in notification system, and this HelloID environment has none to import it into.');
    }

    const readCurrent = async (id: string) => ({
      ...(await fetchFromGateway(IMPORT_PATHS.notificationSystem(id))),
      agentSelection: await fetchFromGateway(IMPORT_PATHS.agentSelection(encodeURIComponent(id))).catch(() => []),
    });
    const current: Any = created ? null : await readCurrent(found.systemId);
    const fileAgents = Array.isArray(data.agents?.selected) ? data.agents.selected : null;

    const scriptFields = ({ scriptId, displayName, script }: Any) => ({ scriptId, displayName, script });
    const scriptsFor = (system: Any) => {
      const theirs: Any[] = system?.notificationScripts ?? [];
      const match = (s: Any) => theirs.find((o) => o.scriptId === s.scriptId) ?? theirs.find((o) => o.displayName === s.displayName);
      const mine = ((file.notificationScripts ?? []) as Any[]).map((s) => ({ ...scriptFields(s), scriptId: match(s)?.scriptId ?? s.scriptId ?? env.uuid() }));
      return [...theirs.filter((t) => !mine.some((m) => m.scriptId === t.scriptId)).map(scriptFields), ...mine];
    };
    const withScripts = (system: Any) => ({ ...system, notificationScripts: scriptsFor(system) });
    const templatesFor = (system: Any) => {
      const scripts: Any[] = system?.notificationScripts ?? [];
      const fileScripts: Any[] = file.notificationScripts ?? [];
      const problems: string[] = [];
      const templates = ((file.notificationTemplates ?? []) as Any[]).map((template) => {
        const fileScript = fileScripts.find((s) => s.scriptId === template.scriptId);
        const script = scripts.find((s) => s.scriptId === template.scriptId) ?? scripts.find((s) => s.displayName === fileScript?.displayName);
        if (!script) problems.push(`template "${template.displayName}": its script "${fileScript?.displayName ?? template.scriptId}" is not in the system`);
        return { ...template, scriptId: script?.scriptId ?? template.scriptId };
      });
      const match = (t: Any, list: Any[]) => list.find((o) => o.templateId === t.templateId) ?? list.find((o) => o.displayName === t.displayName);
      const kept = ((system?.notificationTemplates ?? []) as Any[]).filter((t) => !match(t, templates));
      const merged = [...kept, ...templates.map((t) => ({ ...t, templateId: match(t, system?.notificationTemplates ?? [])?.templateId ?? t.templateId }))];
      return { merged, problems };
    };

    const fileConfig = isPlainObject(file.systemConfiguration) ? (file.systemConfiguration as Any) : null;
    const currentConfig = current?.systemConfiguration;
    const configValues = (config: Any) => restoreValues(fileConfig?.data, config?.data) ?? {};
    const templateWork = current ? templatesFor(withScripts(current)) : null;
    const names = (items: Any[]) => items.map((item) => `"${item.displayName}"`).join(', ');
    const differs: Record<string, boolean> = {
      general: created || NOTIFICATION_GENERAL_FIELDS.some((f) => !sameJson(file[f], current[f])),
      agents: Boolean(fileAgents) && !sameAgentSelection(fileAgents, current?.agentSelection),
      form: Boolean(fileConfig) && Array.isArray(fileConfig.fields) && (created || !sameJson(fileConfig.fields, currentConfig?.fields)),
      values: Boolean(fileConfig) && isPlainObject(fileConfig.data) && (created || !sameJson(configValues(currentConfig), currentConfig?.data)),
      scripts:
        (file.notificationScripts ?? []).length > 0 &&
        (created || !sameJson(scriptsFor(current), ((current.notificationScripts ?? []) as Any[]).map(scriptFields))),
      templates: (file.notificationTemplates ?? []).length > 0 && (created || !sameJson(templateWork!.merged, current.notificationTemplates)),
    };
    const PARTS = [
      { key: 'general', label: 'General settings', detail: 'name, description, icon, execute on-premises' },
      { key: 'form', label: 'Configuration form' },
      { key: 'values', label: 'Configuration values' },
      { key: 'scripts', label: 'Scripts', detail: `${names(file.notificationScripts ?? [])}; the system's other scripts stay` },
      { key: 'templates', label: 'Templates', detail: `${names(file.notificationTemplates ?? [])}; the system's other templates stay` },
    ];
    const anyDiffers = Object.values(differs).some(Boolean);
    if (!anyDiffers && file.isBuiltin) return auto.same();
    if (!created && !anyDiffers) return auto.same();
    // auto: overwrite, everything chosen
    const name = created ? file.displayName : file.displayName;
    const general = { ...Object.fromEntries(NOTIFICATION_GENERAL_FIELDS.map((f) => [f, file[f]])), displayName: name };
    if (!Object.values(differs).some(Boolean)) return auto.same();
    if (
      (created || (differs.general && found.displayName !== name)) &&
      (await fetchFromGateway(IMPORT_PATHS.notificationSystemNameExists(name))) === true
    ) {
      throw new Error(`Another notification system is already named "${name}". Nothing was imported.`);
    }

    const problemsNow = differs.templates && !created ? templatesFor(differs.scripts ? withScripts(current) : current).problems : [];
    const chosenParts = [...PARTS, { key: 'agents', label: 'Agents for on-premises execution' } as Any]
      .filter((part) => differs[part.key])
      .map((part) => part.label + (part.detail ? ` (${part.detail})` : ''));
    if (auto.plan) {
      return auto.planned({
        isNew: created,
        id: found?.systemId,
        name: found?.displayName ?? name,
        lines: [created ? 'a new notification system, with:' : 'overwrites:', ...chosenParts.map((label) => `  - ${label}`)],
        notes: problemsNow,
      });
    }

    let id = found?.systemId;
    if (created) {
      // (a PUT without a body, unlike the other requests)
      id = await sendToGateway(`${IMPORT_PATHS.notificationSystems}/add`, 'PUT');
      if (typeof id !== 'string' || !id) throw new Error('HelloID did not return the ID of the new notification system.');
      env.onCreated?.({ kind: 'notificationSystem', id, name: typeof name === 'string' ? name : null });
    }
    const systemPath = IMPORT_PATHS.notificationSystem(id);
    if (differs.general) await sendToGateway(`${systemPath}/general`, 'POST', general);
    if (differs.agents) await sendToGateway(IMPORT_PATHS.agentSelection(encodeURIComponent(id)), 'POST', fileAgents);
    if (differs.form) await sendToGateway(`${systemPath}/configuration/form`, 'POST', fileConfig.fields);
    if (differs.values) await sendToGateway(`${systemPath}/configuration/data`, 'POST', configValues(currentConfig));
    const target = created ? await readCurrent(id) : current;
    if (differs.form && !differs.values) {
      const values = valuesOrDefaults(fileConfig.fields, target.systemConfiguration?.data);
      if (!sameJson(values, target.systemConfiguration?.data ?? {})) await sendToGateway(`${systemPath}/configuration/data`, 'POST', values);
    }
    if (differs.scripts) await sendToGateway(`${systemPath}/scripts`, 'POST', { scripts: scriptsFor(target) });
    if (differs.templates) {
      const { merged } = templatesFor(differs.scripts ? withScripts(target) : target);
      await sendToGateway(`${systemPath}/templates`, 'POST', { templates: merged });
    }
    return true;
  }

  return { importNotificationsData, importNotificationSystemData };
}
