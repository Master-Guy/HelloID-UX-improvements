// Read tools for the settings the userscript exports: schedules, reconciliation configuration,
// aggregation, person lifecycle, calculated layers, custom fields and excluded persons.

import { z } from 'zod';
import { GATEWAY } from '../helloid/endpoints.ts';
import { rowsOf } from '../helloid/exports.ts';
import {
  defineTool,
  exporterFor,
  num,
  page,
  pageOutput,
  pageText,
  pagingInput,
  readAnnotations,
  str,
  type ToolGroup,
} from './helpers.ts';

const exportObject = z.record(z.string(), z.unknown());

export const listSchedules = defineTool({
  name: 'helloid_list_schedules',
  title: 'List schedules',
  description:
    'Lists the schedules of the snapshots (HelloID allows at most 3) in full: name, enabled, hour, time zone and tasks, ' +
    'read in the time zone of this machine. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {},
  output: {
    timeZone: z.string().describe('The time zone the schedules were read in'),
    schedules: z.array(exportObject).describe('The schedules as HelloID gives them'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context);
    const schedules = await exporter.listSchedules();
    return {
      summary: schedules.length
        ? `${schedules.length} schedule(s): ${schedules.map((s) => `"${s?.name}" (${s?.enabled ? 'enabled' : 'disabled'})`).join(', ')}.`
        : 'No schedules.',
      structured: { timeZone: exporter.timeZone, schedules },
    };
  },
});

export const getReconciliationConfiguration = defineTool({
  name: 'helloid_get_reconciliation_configuration',
  title: 'Get the reconciliation configuration',
  description:
    'Gets the reconciliation configuration as the userscript\'s export makes it: the schedule, the automatic actions per ' +
    'system (with system names) and the exclusions. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {},
  output: { configuration: exportObject.describe('The export file of the reconciliation configuration') },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context);
    const configuration = await exporter.reconciliationConfiguration(await exporter.systemDirectory());
    return {
      summary: `Reconciliation: schedule ${configuration.schedule?.enabled ? 'enabled' : 'disabled'}, ${configuration.systems.length} system(s).`,
      structured: { configuration },
    };
  },
});

export const getAggregationConfiguration = defineTool({
  name: 'helloid_get_aggregation_configuration',
  title: 'Get the aggregation configuration',
  description:
    'Gets the settings of automatic aggregation and suggestions (Source > Aggregation > Configuration). Changes nothing. ' +
    'Works in every mode.',
  access: 'read',
  environment: true,
  input: {},
  output: { configuration: exportObject.describe('The export file of the aggregation configuration') },
  annotations: readAnnotations,
  async handler(call, context) {
    const configuration = await exporterFor(call, context).aggregationConfiguration();
    return { summary: 'The aggregation configuration.', structured: { configuration } };
  },
});

export const getPersonLifecycle = defineTool({
  name: 'helloid_get_person_lifecycle',
  title: 'Get the person lifecycle',
  description: 'Gets the person lifecycle: the days before each event. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {},
  output: { configuration: exportObject.describe('The export file of the person lifecycle') },
  annotations: readAnnotations,
  async handler(call, context) {
    const configuration = await exporterFor(call, context).personLifecycle();
    const events = Array.isArray(configuration.configuration) ? configuration.configuration.length : 0;
    return { summary: `The person lifecycle: ${events} event(s).`, structured: { configuration } };
  },
});

export const getCalculatedLayers = defineTool({
  name: 'helloid_get_calculated_layers',
  title: 'Get the calculated layers',
  description:
    'Gets the calculated layers of the source configuration: primary contract, primary manager and display name. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: {},
  output: { calculatedLayers: z.unknown().describe('HelloID\'s calculated layers configuration') },
  annotations: readAnnotations,
  async handler(call) {
    const calculatedLayers = await call.environment.client.gatewayJson({ path: GATEWAY.calculatedLayers, signal: call.signal });
    return { summary: 'The calculated layers (primary contract, primary manager, display name).', structured: { calculatedLayers } };
  },
});

const customFieldRow = z.object({
  customFieldIdentifier: z.string().nullable(),
  name: z.string().nullable(),
  displayName: z.string().nullable(),
  type: z.number().nullable(),
});

export const listCustomFields = defineTool({
  name: 'helloid_list_custom_fields',
  title: 'List custom fields',
  description: 'Lists the custom person fields of the source configuration, in pages. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(customFieldRow, 'The custom fields'),
  annotations: readAnnotations,
  async handler(call) {
    const rows = rowsOf(await call.environment.client.gatewayJson({ path: GATEWAY.customFields, signal: call.signal })).map((f) => ({
      customFieldIdentifier: str(f?.customFieldIdentifier),
      name: str(f?.name),
      displayName: str(f?.displayName),
      type: num(f?.type),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'custom field(s)'), structured: result };
  },
});

const excludedPersonRow = z.object({
  personId: z.string().nullable(),
  displayName: z.string().nullable(),
  externalId: z.string().nullable(),
});

export const listExcludedPersons = defineTool({
  name: 'helloid_list_excluded_persons',
  title: 'List excluded persons',
  description:
    'Lists the persons excluded from provisioning (ID, name, external ID), in pages. helloid_get_person gives one person ' +
    'in full. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(excludedPersonRow, 'The excluded persons'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await exporterFor(call, context).vaultPersons(false)).map((p) => ({
      personId: str(p?.personId),
      displayName: str(p?.displayName),
      externalId: str(p?.externalId),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'excluded person(s)'), structured: result };
  },
});

export const settingTools: ToolGroup = [
  listSchedules,
  getReconciliationConfiguration,
  getAggregationConfiguration,
  getPersonLifecycle,
  getCalculatedLayers,
  listCustomFields,
  listExcludedPersons,
];
