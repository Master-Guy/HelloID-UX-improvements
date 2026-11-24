// Read tools for business rules, entitlements and toxic combinations (toxic policies).

import { z } from 'zod';
import { cachebust, GATEWAY, TAKE_ALL } from '../helloid/endpoints.ts';
import { ENTITLEMENT_TYPES, NotFoundError, rowsOf } from '../helloid/exports.ts';
import {
  bool,
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
import type { ResolvedEnvironment } from './helpers.ts';

/** The rules overview, all rules (published and draft), as HelloID's Business rules page reads it. */
export async function readRulesOverview(environment: ResolvedEnvironment, now: () => number, signal?: AbortSignal): Promise<any[]> {
  return rowsOf(
    await environment.client.gatewayJson({
      method: 'POST',
      path: GATEWAY.rulesOverview,
      query: { cachebust: cachebust(now) },
      body: { search: '', skip: 0, take: TAKE_ALL, published: true, draft: true },
      signal,
    }),
  );
}

export const ruleRow = z.object({
  ruleId: z.string().nullable(),
  name: z.string().nullable(),
  published: z.boolean().nullable(),
  hasDraft: z.boolean().nullable(),
  configuredEntitlementCount: z.number().nullable(),
  personInRuleLastEvaluationCount: z.number().nullable(),
  lastChanged: z.string().nullable(),
});

export const toRuleRow = (r: any) => ({
  ruleId: str(r?.ruleId),
  name: str(r?.name),
  published: bool(r?.published),
  hasDraft: bool(r?.hasDraft),
  configuredEntitlementCount: num(r?.configuredEntitlementCount),
  personInRuleLastEvaluationCount: num(r?.personInRuleLastEvaluationCount),
  lastChanged: str(r?.lastChanged),
});

export const listBusinessRules = defineTool({
  name: 'helloid_list_business_rules',
  title: 'List business rules',
  description:
    'Lists the business rules (published and draft) with their number of configured entitlements and of persons in the ' +
    'last evaluation, in pages. helloid_get_business_rule gives one rule with its conditions and entitlements. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(ruleRow, 'The business rules'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await readRulesOverview(call.environment, context.now, call.signal)).map(toRuleRow);
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'business rule(s)'), structured: result };
  },
});

export const getBusinessRule = defineTool({
  name: 'helloid_get_business_rule',
  title: 'Get a business rule',
  description:
    'Gets one business rule: its conditions and entitlements (and its draft, when it has one), with HelloID\'s condition ' +
    'summary of the published rule. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ruleId: z.string().min(1).describe('The rule ID (helloid_list_business_rules)') },
  output: {
    rule: z.record(z.string(), z.unknown()).describe('The rule as HelloID gives it'),
    conditionSummary: z.unknown().describe('HelloID\'s condition summary (draft=false); null when it could not be read'),
  },
  annotations: readAnnotations,
  async handler(call) {
    const { client } = call.environment;
    const [rule, conditionSummary] = await Promise.all([
      client.gatewayJson<any>({ path: GATEWAY.rule(call.args.ruleId), signal: call.signal }),
      client
        .gatewayJson({ path: GATEWAY.ruleConditionSummary(call.args.ruleId), query: { draft: false }, signal: call.signal })
        .catch(() => null),
    ]);
    const entitlements = Array.isArray(rule?.entitlements) ? rule.entitlements.length : 0;
    const state = rule?.published ? (rule?.hasDraft ? 'published, with a draft' : 'published') : 'draft only';
    return {
      summary: `Business rule "${rule?.name}" (${state}): ${entitlements} entitlement(s).`,
      structured: { rule, conditionSummary: conditionSummary ?? null },
    };
  },
});

/** An entitlement type as a name (HelloID gives a number in some answers). */
export const typeName = (type: unknown): string | null =>
  type === null || type === undefined ? null : (ENTITLEMENT_TYPES[String(type)] ?? String(type));

const entitlementRow = z.object({
  entitlementId: z.string().nullable(),
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  type: z.string().nullable().describe('Account, AccountAccess or Permission'),
  displayName: z.string().nullable(),
  permissionDefinitionDisplayName: z.string().nullable(),
  inTargetSystem: z.boolean().nullable(),
  ruleCount: z.number().nullable(),
});

export const listEntitlements = defineTool({
  name: 'helloid_list_entitlements',
  title: 'List entitlements',
  description:
    'Lists all entitlements business rules can have (/service/rules/api/entitlements): ID, target system, type, name, ' +
    'whether it is still in the target system, and the number of rules, in pages. helloid_report_rules_for_entitlement ' +
    'gives the rules of one. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(entitlementRow, 'The entitlements'),
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context);
    const [answer, systems] = await Promise.all([
      exporter.reader.get(GATEWAY.entitlements, { skip: 0, take: TAKE_ALL }),
      exporter.fetchSystems().catch(() => []),
    ]);
    const rows = rowsOf(answer).map((e) => ({
      entitlementId: str(e?.entitlementId),
      systemId: str(e?.systemIdentifier),
      systemName: str(systems.find((s) => s?.systemId === e?.systemIdentifier)?.displayName),
      type: typeName(e?.type),
      displayName: str(e?.displayName),
      permissionDefinitionDisplayName: str(e?.permissionDefinitionDisplayName),
      inTargetSystem: bool(e?.inTargetSystem),
      ruleCount: num(e?.ruleCount),
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'entitlement(s)'), structured: result };
  },
});

const toxicRow = z.object({
  toxicCombinationId: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean().nullable(),
  type: z.number().nullable(),
  inputCount: z.number().describe('Number of input entitlements'),
  outputCount: z.number().describe('Number of output entitlements'),
});

export const listToxicCombinations = defineTool({
  name: 'helloid_list_toxic_combinations',
  title: 'List toxic combinations',
  description:
    'Lists the toxic combinations (toxic policies): ID, name, enabled, type and the number of input and output ' +
    'entitlements, in pages. helloid_get_toxic_combination gives one with its entitlements. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(toxicRow, 'The toxic combinations'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await exporterFor(call, context).listToxicPolicies()).map((p) => ({
      toxicCombinationId: str(p?.toxicCombinationId),
      name: str(p?.name),
      description: str(p?.description),
      enabled: bool(p?.enabled),
      type: num(p?.type),
      inputCount: Array.isArray(p?.inputObjectIds) ? p.inputObjectIds.length : 0,
      outputCount: Array.isArray(p?.outputObjectIds) ? p.outputObjectIds.length : 0,
    }));
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'toxic combination(s)'), structured: result };
  },
});

export const getToxicCombination = defineTool({
  name: 'helloid_get_toxic_combination',
  title: 'Get a toxic combination',
  description:
    'Gets one toxic combination (toxic policy) as the userscript\'s export makes it: the policy, its entitlements, and the ' +
    'names of their target systems. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { toxicCombinationId: z.string().min(1).describe('The toxic combination ID (helloid_list_toxic_combinations)') },
  output: { toxicCombination: z.record(z.string(), z.unknown()).describe('The export file of the toxic policy') },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context);
    const [policies, systems] = await Promise.all([exporter.listToxicPolicies(), exporter.systemDirectory()]);
    const policy = policies.find((p) => p?.toxicCombinationId === call.args.toxicCombinationId);
    if (!policy) throw new NotFoundError(`There is no toxic combination '${call.args.toxicCombinationId}' in '${call.environment.name}'.`);
    const toxicCombination = await exporter.toxicPolicy(policy, systems);
    return {
      summary: `Toxic combination "${policy.name}" (${policy.enabled ? 'enabled' : 'disabled'}): ${toxicCombination.entitlements.length} entitlement(s).`,
      structured: { toxicCombination },
    };
  },
});

export const ruleTools: ToolGroup = [listBusinessRules, getBusinessRule, listEntitlements, listToxicCombinations, getToxicCombination];
