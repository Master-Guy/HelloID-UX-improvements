// The import of a source system export (importSourceSystemData of the userscript), for "Overwrite
// all" (auto): overwrite what matches, every part chosen.

import { IMPORT_PATHS } from '../helloid/endpoints.ts';
import {
  type Any,
  type Auto,
  byIdOrName,
  FETCH_ALL_TAKE,
  isPlainObject,
  type PlannerEnv,
  restoreValues,
  sameAgentSelection,
  uniqueBy,
  valuesOrDefaults,
} from './common.ts';

const SOURCE_TEMPLATE = { name: 'HelloID-Conn-Prov-Source-Template', id: 670931336 };

/** The configuration form and values are JSON in a text. */
const parseJsonText = (text: Any, fallback: Any) => {
  try {
    return typeof text === 'string' && text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const formFields = (system: Any): Any[] => {
  const form = parseJsonText(system?.scriptConfigurationForm, []);
  return Array.isArray(form) ? form : [];
};

/** The parts of a source system, each as written: key, label, what HelloID has of it, and the request. */
const SOURCE_PARTS: Any[] = [
  {
    key: 'general',
    label: 'General settings',
    detail: 'name, icon, description',
    of: (s: Any) => ({ friendlyName: s.displayName, icon: s.icon, description: s.description }),
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/general`,
  },
  {
    key: 'form',
    label: 'Configuration form',
    of: (s: Any) => ({ form: s.scriptConfigurationForm }),
    same: (a: Any, b: Any) => JSON.stringify(parseJsonText(a.form, null)) === JSON.stringify(parseJsonText(b.form, null)),
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/custom-configuration-form`,
  },
  {
    key: 'values',
    label: 'Configuration values',
    of: (s: Any) => ({ config: s.scriptConfiguration }),
    same: (a: Any, b: Any) => JSON.stringify(parseJsonText(a.config, null)) === JSON.stringify(parseJsonText(b.config, null)),
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/custom-configuration`,
  },
  {
    key: 'scripts',
    label: 'Scripts',
    detail: 'persons, departments, execute on-premises',
    of: (s: Any) => ({ executeOnPremises: s.executeOnPremises, personsScript: s.personsScript, departmentsScript: s.departmentsScript }),
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/powershell`,
  },
  {
    key: 'persons',
    label: 'Person mapping',
    mapping: true,
    of: (s: Any) => s.mappingConfiguration?.personMappings ?? [],
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/mapping/persons`,
  },
  {
    key: 'contracts',
    label: 'Contract mapping',
    mapping: true,
    of: (s: Any) => s.mappingConfiguration?.contractMappings ?? [],
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/mapping/contracts`,
  },
  {
    key: 'thresholds',
    label: 'Thresholds',
    of: (s: Any) => s.thresholds ?? null,
    path: (id: string) => `${IMPORT_PATHS.sourceSystem(id)}/thresholds`,
  },
];

/** The catalog template for a new system: the file's by name, else its catalog ID, else "Source Template". */
function sourceTemplateCandidates(meta: Any, catalog: Any[]) {
  const byName = (name: Any) => catalog.find((c) => c?.name === name);
  const candidates: Any[] = [];
  const own = meta?.name && byName(meta.name);
  if (own) candidates.push({ id: own.id, label: `${own.displayName ?? own.name} (the template of the file, latest release)` });
  if (meta?.repositoryId && meta.repositoryId !== own?.id) candidates.push({ id: meta.repositoryId, label: `catalog ID ${meta.repositoryId} (from the file)` });
  const fallback = byName(SOURCE_TEMPLATE.name);
  candidates.push({ id: fallback?.id ?? SOURCE_TEMPLATE.id, label: 'Source Template (latest release)' });
  return uniqueBy(candidates, (c) => String(c.id));
}

export function sourceSystemImport(env: PlannerEnv) {
  const fetchFromGateway = (path: string) => env.gw.fetch(path);
  const sendToGateway = (path: string, method: string, body?: unknown) => env.gw.send(path, method, body);
  const sourceCatalog = async (): Promise<Any[]> => {
    const list = await fetchFromGateway(IMPORT_PATHS.sourceCatalog(FETCH_ALL_TAKE));
    return Array.isArray(list?.pageData) ? list.pageData : Array.isArray(list) ? list : [];
  };

  async function importSourceSystemData(data: Any, { auto }: { auto: Auto }): Promise<Any> {
    const file = data.system;
    const systems = await fetchFromGateway(IMPORT_PATHS.sourceSystems);
    const list: Any[] = Array.isArray(systems) ? systems : [];
    const found = byIdOrName(list, file.systemId, file.displayName);
    const created = !found;
    const current: Any = created ? null : await fetchFromGateway(IMPORT_PATHS.sourceSystem(found.systemId));
    const fileAgents = Array.isArray(data.agents?.selected) ? data.agents.selected : null;
    const currentAgents = created ? [] : await fetchFromGateway(IMPORT_PATHS.agentSelection(encodeURIComponent(found.systemId))).catch(() => []);

    const fileValues = parseJsonText(file.scriptConfiguration, null);
    const restored = isPlainObject(fileValues)
      ? { ...file, scriptConfiguration: JSON.stringify(restoreValues(fileValues, parseJsonText(current?.scriptConfiguration, {}))) }
      : file;
    const sameBody = (part: Any, a: Any, b: Any) => (part.same ? part.same(a, b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
    const differs: Record<string, boolean> = Object.fromEntries(
      SOURCE_PARTS.map((part) => [part.key, created || !sameBody(part, part.of(restored), part.of(current))]),
    );
    differs.agents = Boolean(fileAgents) && !sameAgentSelection(fileAgents, currentAgents);
    const anyDiffers = Object.values(differs).some(Boolean);

    if (!created && !anyDiffers) return auto.same();
    const catalog = created ? await sourceCatalog().catch(() => []) : [];
    const candidates = created ? sourceTemplateCandidates(file.repositoryMetaData, catalog) : [];
    // auto: overwrite, everything chosen
    const name = file.displayName;
    const source = { ...restored, displayName: differs.general || created ? name : current.displayName };
    if ((created || (differs.general && name !== found.displayName)) && list.some((s) => s?.displayName?.trim() === name.trim() && s.systemId !== found?.systemId)) {
      throw new Error(`Another source system is already named "${name}". Nothing was imported.`);
    }
    const parts = SOURCE_PARTS.filter((part) => differs[part.key] && !(created && part.mapping));
    if (!parts.length && !differs.agents && !created) return auto.same();

    const chosenLabels = [...SOURCE_PARTS, { key: 'agents', label: 'Agents for on-premises execution' }]
      .filter((part) => differs[part.key])
      .map((part) => part.label + (part.detail ? ` (${part.detail})` : ''));
    if (auto.plan) {
      return auto.planned({
        isNew: created,
        id: found?.systemId,
        name: found?.displayName ?? name,
        lines: [created ? 'a new source system, with:' : 'overwrites:', ...chosenLabels.map((label) => `  - ${label}`)],
      });
    }

    let id = found?.systemId;
    if (created) {
      // The template candidates in turn, until HelloID makes it
      for (const [i, candidate] of candidates.entries()) {
        try {
          id = await sendToGateway(`${IMPORT_PATHS.sourceSystems}/new`, 'POST', {
            repositoryId: candidate.id,
            personMapping: SOURCE_PARTS.find((p) => p.key === 'persons').of(source),
            contractMapping: SOURCE_PARTS.find((p) => p.key === 'contracts').of(source),
          });
          if (typeof id !== 'string' || !id) throw new Error('HelloID did not return the ID of the new source system.');
          env.onCreated?.({ kind: 'sourceSystem', id, name: typeof name === 'string' ? name : null });
          break;
        } catch (e) {
          if (i === candidates.length - 1) throw e;
        }
      }
    }
    for (const part of parts) await sendToGateway(part.path(id), 'POST', part.of(source));
    if (differs.form && !differs.values) {
      const had = parseJsonText((created ? await fetchFromGateway(IMPORT_PATHS.sourceSystem(id)) : current).scriptConfiguration, {});
      const values = valuesOrDefaults(formFields(source), had);
      if (JSON.stringify(values) !== JSON.stringify(isPlainObject(had) ? had : {})) {
        await sendToGateway(`${IMPORT_PATHS.sourceSystem(id)}/custom-configuration`, 'POST', { config: JSON.stringify(values) });
      }
    }
    if (differs.agents) await sendToGateway(IMPORT_PATHS.agentSelection(encodeURIComponent(id)), 'POST', fileAgents);
    return true;
  }

  return { importSourceSystemData };
}
