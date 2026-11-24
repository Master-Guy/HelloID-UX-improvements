// Read tools for target systems and source systems. The get tools return the system as the
// userscript's export collects it, with secrets masked.

import { z } from 'zod';
import { cachebust, GATEWAY } from '../helloid/endpoints.ts';
import { rowsOf } from '../helloid/exports.ts';
import { entitlementTypeRow, entitlementTypesFor, readEntitlementTypes } from './actions.ts';
import {
  bool,
  defineTool,
  exporterFor,
  page,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  str,
  type ToolGroup,
} from './helpers.ts';

const exportObject = z.record(z.string(), z.unknown());

const targetSystemRow = z.object({
  systemId: z.string().nullable(),
  displayName: z.string().nullable(),
  templateIdentifier: z.string().nullable().describe('The type, e.g. powershell-target (PowerShell v2), powershell-onpremise (v1), azuread, activedirectory'),
  isDisabled: z.boolean().nullable(),
  isReferenceSystem: z.boolean().nullable(),
  entitlementTypes: z
    .array(entitlementTypeRow)
    .nullable()
    .describe('The entitlement types the system has (1 Account, 2 Account Access, 3 Permission); null when HelloID\'s answer could not be read'),
});

export const listTargetSystems = defineTool({
  name: 'helloid_list_target_systems',
  title: 'List target systems',
  description:
    'Lists the target systems of an environment (ID, name, type, disabled, reference system, entitlement types), in pages. ' +
    'helloid_get_target_system gives one system in full. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(targetSystemRow, 'The target systems'),
  annotations: readAnnotations,
  async handler(call, context) {
    const [systems, types] = await Promise.all([exporterFor(call, context).fetchSystems(), readEntitlementTypes(call.environment, call.signal)]);
    const rows = systems.map((s) => ({
      systemId: str(s?.systemId),
      displayName: str(s?.displayName),
      templateIdentifier: str(s?.templateIdentifier),
      isDisabled: bool(s?.isDisabled),
      isReferenceSystem: bool(s?.isReferenceSystem),
      entitlementTypes: entitlementTypesFor(types, s?.systemId),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'target system(s)'), structured: result };
  },
});

export const getTargetSystem = defineTool({
  name: 'helloid_get_target_system',
  title: 'Get a target system',
  description:
    'Gets one target system in full, as the userscript\'s export collects it: the configuration (mapping, correlation, ' +
    'permissions, scripts of a PowerShell system), the default scripts and resources, the agent selection, the systems it ' +
    'depends on (with names), the other systems that use it (usedBy), its notifications, its business rules, and the ' +
    'systems depending on it (HelloID\'s own check), and its entitlement types. Secrets are masked as "***". Reads many items, so it can take a while. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { systemId: z.string().min(1).describe('The target system ID (helloid_list_target_systems)') },
  output: {
    system: exportObject.describe('The export file of the system, as the userscript makes it (secrets masked)'),
    systemsDependingOn: z.unknown().describe('HelloID\'s answer of get-systems-depending-on; null when it could not be read'),
    entitlementTypes: z
      .array(entitlementTypeRow)
      .nullable()
      .describe('The entitlement types the system has (1 Account, 2 Account Access, 3 Permission); null when HelloID\'s answer could not be read'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context, true);
    const [system, systemsDependingOn, types] = await Promise.all([
      exporter.targetSystem(call.args.systemId),
      call.environment.client
        .gatewayJson({ path: GATEWAY.systemsDependingOn, query: { systemId: call.args.systemId, cachebust: cachebust(context.now) }, signal: call.signal })
        .catch(() => null),
      readEntitlementTypes(call.environment, call.signal),
    ]);
    const entitlementTypes = entitlementTypesFor(types, call.args.systemId);
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    const missing = Array.isArray(system.couldNotRead) && system.couldNotRead.length ? ` Not read: ${system.couldNotRead.join(', ')}.` : '';
    return {
      summary:
        `Target system "${system.displayName}" (${system.templateIdentifier}): ${count(system.rules)} rule(s), ` +
        `${count(system.notifications)} notification(s), used by ${count(system.usedBy)} other system(s)` +
        `${entitlementTypes ? `; entitlement types: ${entitlementTypes.map((t) => t.label ?? t.code).join(', ') || 'none'}` : ''}. ` +
        `Secrets are masked.${missing}`,
      structured: { system, systemsDependingOn, entitlementTypes },
    };
  },
});

const sourceSystemRow = z.object({
  systemId: z.string().nullable(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  executeOnPremises: z.boolean().nullable(),
});

export const listSourceSystems = defineTool({
  name: 'helloid_list_source_systems',
  title: 'List source systems',
  description:
    'Lists the source systems of an environment (ID, name, description, on-premises), in pages. helloid_get_source_system ' +
    'gives one in full. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(sourceSystemRow, 'The source systems'),
  annotations: readAnnotations,
  async handler(call) {
    const rows = rowsOf(await call.environment.client.gatewayJson({ path: GATEWAY.sourceSystems, signal: call.signal })).map((s) => ({
      systemId: str(s?.systemId),
      displayName: str(s?.displayName),
      description: str(s?.description),
      executeOnPremises: bool(s?.executeOnPremises),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'source system(s)'), structured: result };
  },
});

export const getSourceSystem = defineTool({
  name: 'helloid_get_source_system',
  title: 'Get a source system',
  description:
    'Gets one source system in full, as the userscript\'s export collects it: its configuration and scripts, its template ' +
    '(with the catalog ID, without the README) and its agent selection. Secrets of the configuration are masked as "***". ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { systemId: z.string().min(1).describe('The source system ID (helloid_list_source_systems)') },
  output: { system: exportObject.describe('The export file of the source system, as the userscript makes it (secrets masked)') },
  annotations: readAnnotations,
  async handler(call, context) {
    const system = await exporterFor(call, context).sourceSystem(call.args.systemId);
    return { summary: `Source system "${system.displayName}". Secrets are masked.`, structured: { system } };
  },
});

export const systemTools: ToolGroup = [listTargetSystems, getTargetSystem, listSourceSystems, getSourceSystem];
