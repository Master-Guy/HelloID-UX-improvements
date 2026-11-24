// Reports: combined reads for questions that would otherwise take many calls.

import { z } from 'zod';
import { GATEWAY, TAKE_ALL } from '../helloid/endpoints.ts';
import { EMPTY_ID, inBatches, NotFoundError, rowsOf, type SystemDirectory } from '../helloid/exports.ts';
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
import { readGranted } from './persons.ts';
import { readRulesOverview, ruleRow, toRuleRow, typeName } from './rules.ts';

export const reportRulesWithoutEntitlements = defineTool({
  name: 'helloid_report_rules_without_entitlements',
  title: 'Report: rules without entitlements',
  description:
    'Lists the business rules whose configured entitlement count is 0 (published and draft), in pages. Changes nothing. ' +
    'Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(ruleRow, 'The rules without entitlements'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await readRulesOverview(call.environment, context.now, call.signal))
      .filter((r) => r?.configuredEntitlementCount === 0)
      .map(toRuleRow);
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'rule(s) without entitlements'), structured: result };
  },
});

export const reportRulesWithoutPersons = defineTool({
  name: 'helloid_report_rules_without_persons',
  title: 'Report: rules without persons',
  description:
    'Lists the business rules that had no persons in the last evaluation (personInRuleLastEvaluationCount 0), in pages. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: pageOutput(ruleRow, 'The rules without persons'),
  annotations: readAnnotations,
  async handler(call, context) {
    const rows = (await readRulesOverview(call.environment, context.now, call.signal))
      .filter((r) => r?.personInRuleLastEvaluationCount === 0)
      .map(toRuleRow);
    const result = page(rows, call.args.offset, call.args.limit);
    return { summary: pageText(result, 'rule(s) without persons in the last evaluation'), structured: result };
  },
});

const entitlementRuleRow = z.object({
  ruleId: z.string().nullable(),
  name: z.string().nullable(),
  published: z.boolean().nullable(),
  hasDraft: z.boolean().nullable(),
  entitlementConfiguredInPublished: z.boolean().nullable(),
  entitlementConfiguredInDraft: z.boolean().nullable(),
});

export const reportRulesForEntitlement = defineTool({
  name: 'helloid_report_rules_for_entitlement',
  title: 'Report: rules of an entitlement',
  description:
    'Lists the business rules linked to an entitlement, published and draft, and whether the entitlement is in the ' +
    'published rule and in its draft, in pages. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { entitlementId: z.string().min(1).describe('The entitlement ID (helloid_list_entitlements)'), ...pagingInput },
  output: pageOutput(entitlementRuleRow, 'The rules of the entitlement'),
  annotations: readAnnotations,
  async handler(call) {
    const { entitlementId, offset, limit } = call.args;
    const answer = await call.environment.client.gatewayJson<any>({
      path: GATEWAY.rulesForEntitlement(entitlementId),
      query: { skip: offset, take: limit, published: true, draft: true },
      signal: call.signal,
    });
    const items = rowsOf(answer).map((r) => ({
      ruleId: str(r?.ruleId),
      name: str(r?.name),
      published: bool(r?.published),
      hasDraft: bool(r?.hasDraft),
      entitlementConfiguredInPublished: bool(r?.entitlementConfiguredInPublished),
      entitlementConfiguredInDraft: bool(r?.entitlementConfiguredInDraft),
    }));
    const result = { total: num(answer?.totalRowCount) ?? offset + items.length, offset, limit, items };
    return { summary: pageText(result, 'rule(s) with this entitlement'), structured: result };
  },
});

// ---------------------------------------------------------------------------------------------
// System access

const systemRule = z.object({
  ruleId: z.string().nullable(),
  ruleName: z.string().nullable(),
});
const accessPerson = z.object({
  personId: z.string().nullable(),
  personName: z.string().nullable(),
  accounts: z.array(z.string()).describe('The account entitlements the person has on the system'),
  rules: z.array(systemRule).describe('Every account-granting rule of the system whose persons (last evaluation) include this person'),
});

/** The display names in the persons of a rule in the last evaluation (strings, or rows with displayName). */
const personNames = (answer: unknown): string[] =>
  rowsOf(answer)
    .map((p) => (typeof p === 'string' ? p : str(p?.displayName)))
    .filter((p): p is string => typeof p === 'string');

export const reportSystemAccess = defineTool({
  name: 'helloid_report_system_access',
  title: 'Report: access to a target system',
  description:
    'For one target system: the persons with an account on it (granted entitlements of type Account), and the business ' +
    'rules that grant an account, account access and permissions on it (published, from the system\'s entitlements overview). ' +
    'Per person, every account-granting rule whose persons in the last evaluation include the person\'s display name ' +
    '(no single rule is picked); persons that match no account-granting rule are listed apart. Persons in pages. ' +
    'Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { systemId: z.string().min(1).describe('The target system ID (helloid_list_target_systems)'), ...pagingInput },
  output: {
    system: z.object({ systemId: z.string(), displayName: z.string().nullable() }),
    rules: z.object({
      account: z.array(systemRule.extend({ personCount: z.number().describe('Persons in the last evaluation') })),
      accountAccess: z.array(systemRule),
      permissions: z.array(systemRule),
    }),
    offset: z.number(),
    limit: z.number(),
    matchedTotal: z.number().describe('Persons with an account that match at least one account-granting rule'),
    matched: z.array(accessPerson),
    unmatchedTotal: z.number().describe('Persons with an account that match no account-granting rule'),
    unmatched: z.array(accessPerson),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const { systemId, offset, limit } = call.args;
    const { client } = call.environment;
    const exporter = exporterFor(call, context);
    const [systems, overview, granted] = await Promise.all([
      exporter.fetchSystems(),
      client.gatewayJson({ path: GATEWAY.entitlementsOverview(systemId), query: { skip: 0, take: TAKE_ALL }, signal: call.signal }),
      readGranted(call.environment, undefined, call.signal),
    ]);
    const system = systems.find((s) => s?.systemId === systemId);
    if (!system) throw new NotFoundError(`There is no target system '${systemId}' in '${call.environment.name}'.`);

    const rows = rowsOf(overview);
    const ruleOf = (r: any) => ({ ruleId: str(r?.ruleId), ruleName: str(r?.ruleName) });
    const accountRules = rows.filter((r) => r?.accountEntitlementForSystem === true);
    // The persons of every account-granting rule in the last evaluation (display names)
    const ruleNames = await inBatches(accountRules, async (r) =>
      personNames(
        await client.gatewayJson({ path: GATEWAY.ruleResultPersons(r.ruleId), query: { skip: 0, take: TAKE_ALL }, signal: call.signal }),
      ),
    );
    const ruleSets = accountRules.map((r, i) => ({ rule: ruleOf(r), names: new Set(ruleNames[i]) }));

    // The persons with an account on the system, with their account entitlements
    const persons = new Map<string, { personId: string | null; personName: string | null; accounts: string[] }>();
    for (const row of rowsOf(granted)) {
      if (row?.systemId !== systemId || typeName(row?.entitlement?.type) !== 'Account') continue;
      const personId = str(row?.personEntitlementId?.personId);
      const key = personId ?? `name:${row?.personName}`;
      if (!persons.has(key)) persons.set(key, { personId, personName: str(row?.personName), accounts: [] });
      persons.get(key)!.accounts.push(str(row?.entitlement?.displayName ?? row?.entitlementName) ?? '?');
    }
    const all = [...persons.values()]
      .map((p) => ({ ...p, rules: ruleSets.filter((s) => p.personName !== null && s.names.has(p.personName)).map((s) => s.rule) }))
      .sort((a, b) => String(a.personName).localeCompare(String(b.personName)));
    const matched = all.filter((p) => p.rules.length);
    const unmatched = all.filter((p) => !p.rules.length);

    const result = {
      system: { systemId, displayName: str(system.displayName) },
      rules: {
        account: ruleSets.map((s) => ({ ...s.rule, personCount: s.names.size })),
        accountAccess: rows.filter((r) => r?.accountAccessEntitlementForSystem === true).map(ruleOf),
        permissions: rows.filter((r) => r?.permissionEntitlementForSystem === true).map(ruleOf),
      },
      offset,
      limit,
      matchedTotal: matched.length,
      matched: matched.slice(offset, offset + limit),
      unmatchedTotal: unmatched.length,
      unmatched: unmatched.slice(offset, offset + limit),
    };
    return {
      summary:
        `"${system.displayName}": ${all.length} person(s) with an account; ${matched.length} match an account-granting rule, ` +
        `${unmatched.length} match none. Rules granting: account ${result.rules.account.length}, account access ` +
        `${result.rules.accountAccess.length}, permissions ${result.rules.permissions.length}.`,
      structured: result,
    };
  },
});

// ---------------------------------------------------------------------------------------------
// References to things that do not exist

const finding = z.object({
  kind: z.string().describe('What has the reference: target system, business rule, notification, custom event, toxic policy, schedule, reconciliation'),
  id: z.string().nullable(),
  name: z.string().nullable(),
  problem: z.string(),
});
type Finding = z.infer<typeof finding>;

/** A text for an entitlement (entitlementLabel in the userscript). */
const entitlementLabel = (e: any) => {
  const type = typeName(e?.type);
  return type === 'Permission'
    ? `permission "${e?.displayName}"${e?.permissionDefinitionDisplayName ? ` (${e.permissionDefinitionDisplayName})` : ''}`
    : type === 'AccountAccess'
      ? 'account access'
      : type === 'Account'
        ? 'account'
        : `${type} "${e?.displayName}"`;
};

/** The problems of a rule condition: titles and departments of source systems that are not here (conditionHere). */
function conditionProblems(condition: any, systems: SystemDirectory, where: string): string[] {
  if (!condition || typeof condition !== 'object') return [];
  const entries = [
    ...(Array.isArray(condition.titleCondition?.titles) ? condition.titleCondition.titles : []),
    ...(Array.isArray(condition.departmentCondition?.departments) ? condition.departmentCondition.departments : []),
  ];
  const problems: string[] = [];
  for (const entry of entries) {
    const id = entry?.source?.systemId ?? entry?.sourceSystemId;
    // (no source system: the empty ID, as HelloID itself has it; intended)
    if (!id || id === EMPTY_ID) continue;
    if (systems.all.some((s) => s.systemId === id)) continue;
    const name = entry?.source?.displayName ?? entry?.sourceSystemDisplayName;
    const sameName = typeof name === 'string' && systems.find(undefined, name);
    problems.push(
      `${where}: "${entry?.name ?? entry?.displayName ?? entry?.externalId}" is of source system "${name ?? id}" (${id}), ` +
        'which is not in this HelloID environment' +
        (sameName ? ` (a system of that name exists, with ID ${sameName.systemId})` : ''),
    );
  }
  return problems;
}

export const checkReferences = defineTool({
  name: 'helloid_check_references',
  title: 'Check references',
  description:
    'Finds references to things that do not exist in the environment, as the userscript\'s import notes find them: target ' +
    'systems depending on missing systems; business rule conditions (titles, departments) of missing source systems and ' +
    'entitlements of missing target systems or that are no entitlement (published and draft); notifications with a missing ' +
    'notification system, template, target system, custom event or data of a missing system; custom events, schedules and ' +
    'reconciliation of missing systems; toxic policies with missing entitlements. The source system ' +
    '00000000-0000-0000-0000-000000000000 in rule conditions is intended and not reported. Reads every rule and notification, ' +
    'so it can take a while. Findings in pages. Changes nothing. Works in every mode.',
  access: 'read',
  environment: true,
  input: { ...pagingInput },
  output: {
    ...pageOutput(finding, 'The references to things that do not exist'),
    checked: z.record(z.string(), z.number()).describe('The number of items checked per kind'),
    couldNotCheck: z.array(z.string()).describe('Parts that could not be read, so were not checked'),
  },
  annotations: readAnnotations,
  async handler(call, context) {
    const exporter = exporterFor(call, context, true);
    const { reader } = exporter;
    const findings: Finding[] = [];
    const checked: Record<string, number> = {};
    const couldNotCheck: string[] = [];
    const add = (kind: string, id: unknown, name: unknown, problem: string) => findings.push({ kind, id: str(id), name: str(name), problem });
    const part = async (label: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (e) {
        reader.checkAborted();
        couldNotCheck.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const systems = await exporter.systemDirectory();
    const targetIds = new Set(systems.targets.map((s) => s?.systemId));
    const systemIds = new Set(systems.all.map((s) => s.systemId));
    const missingSystem = (id: unknown, name?: unknown) => `"${name ?? id}" (${id}), which is not in this HelloID environment`;
    let entitlementIds: Set<string> | undefined;
    const entitlements = async () => {
      entitlementIds ??= new Set(
        rowsOf(await reader.get(GATEWAY.entitlements, { skip: 0, take: TAKE_ALL }))
          .filter((e) => e?.inTargetSystem !== false)
          .map((e) => e.entitlementId),
      );
      return entitlementIds;
    };

    // Target systems: the systems they depend on (missingDependencies)
    checked.targetSystem = systems.targets.length;
    for (const s of systems.targets) {
      for (const d of Array.isArray(s?.dependOnSystems) ? s.dependOnSystems : []) {
        if (!targetIds.has(d?.systemId)) add('target system', s.systemId, s.displayName, `depends on system ${missingSystem(d?.systemId, d?.displayName)}`);
      }
    }

    await part('Business rules', async () => {
      const ids = await entitlements();
      const rules = await exporter.listRules();
      checked.businessRule = rules.length;
      const read = await inBatches(rules, (r) => reader.get(GATEWAY.rule(r.ruleId)).catch(() => null));
      read.forEach((rule, i) => {
        const row = rules[i];
        if (!rule) {
          reader.checkAborted();
          couldNotCheck.push(`Business rules: "${row?.name}" could not be read`);
          return;
        }
        const versions: Array<[string, any]> = [['published', rule]];
        if (rule.hasDraft && rule.draft && typeof rule.draft === 'object') versions.push(['draft', rule.draft]);
        if (!rule.published) versions[0]![0] = 'rule';
        for (const [where, version] of versions) {
          for (const problem of conditionProblems(version.condition, systems, `${where} condition`)) add('business rule', rule.ruleId, rule.name, problem);
          for (const e of Array.isArray(version.entitlements) ? version.entitlements : []) {
            if (!targetIds.has(e?.systemIdentifier)) {
              add('business rule', rule.ruleId, rule.name, `${where} entitlement ${entitlementLabel(e)} is of target system ${missingSystem(e?.systemIdentifier, e?.systemName)}`);
            } else if (!ids.has(e?.entitlementId)) {
              add('business rule', rule.ruleId, rule.name, `${where} entitlement ${entitlementLabel(e)} of "${systems.nameOf(e.systemIdentifier)}": not an entitlement here`);
            }
          }
        }
      });
    });

    await part('Notifications', async () => {
      const [rows, senders, events] = await Promise.all([
        exporter.listNotifications(),
        exporter.listNotificationSystems(),
        reader.get(GATEWAY.customEvents, { take: TAKE_ALL }).then(rowsOf),
      ]);
      checked.notification = rows.length;
      const details = new Map<string, any>();
      const detailOf = async (id: string) => {
        if (!details.has(id)) details.set(id, await reader.get(GATEWAY.notificationSystem(id)).catch(() => null));
        return details.get(id);
      };
      const read = await inBatches(rows, (n) => reader.get(GATEWAY.notification(n.identifier)).catch(() => null));
      for (const [i, n] of read.entries()) {
        const row = rows[i];
        if (!n) {
          reader.checkAborted();
          couldNotCheck.push(`Notifications: "${row?.name}" could not be read`);
          continue;
        }
        const problem = (text: string) => add('notification', n.identifier, n.name, text);
        const sender = senders.find((s) => s?.systemId === n.notificationSystemId);
        if (n.notificationSystemId && !sender) problem(`its notification system ${n.notificationSystemId} is not in this HelloID environment`);
        if (sender && n.notificationTemplateId) {
          const detail = await detailOf(sender.systemId);
          const templates = Array.isArray(detail?.notificationTemplates) ? detail.notificationTemplates : null;
          if (templates && !templates.some((t: any) => t?.templateId === n.notificationTemplateId)) {
            problem(`its template ${n.notificationTemplateId} is not in notification system "${sender.displayName}"`);
          }
        }
        if (n.systemId && !targetIds.has(n.systemId)) problem(`its target system ${n.systemId} is not in this HelloID environment`);
        if (n.customEventId && !events.some((e) => e?.customEventId === n.customEventId)) {
          problem(`its custom event ${n.customEventId} is not in this HelloID environment`);
        }
        for (const r of Array.isArray(n.dataReferences) ? n.dataReferences : []) {
          if (!targetIds.has(r?.systemId)) problem(`it uses the data of target system ${missingSystem(r?.systemId, r?.key)}`);
        }
      }
    });

    await part('Custom events', async () => {
      const events = await exporter.listCustomEvents();
      checked.customEvent = events.length;
      for (const e of events) {
        if (e?.systemId && !systemIds.has(e.systemId)) add('custom event', e.customEventId, e.name, `its system ${e.systemId} is not in this HelloID environment`);
      }
    });

    await part('Toxic policies', async () => {
      const ids = await entitlements();
      const policies = await exporter.listToxicPolicies();
      checked.toxicPolicy = policies.length;
      for (const p of policies) {
        const missing = [...new Set([...(p?.inputObjectIds ?? []), ...(p?.outputObjectIds ?? [])])].filter((id) => !ids.has(id as string));
        for (const id of missing) add('toxic policy', p.toxicCombinationId, p.name, `entitlement ${id}: not an entitlement here`);
      }
    });

    await part('Schedules', async () => {
      const schedules = await exporter.listSchedules();
      checked.schedule = schedules.length;
      for (const s of schedules) {
        for (const t of Array.isArray(s?.tasks) ? s.tasks : []) {
          if (t?.systemId && !systemIds.has(t.systemId)) add('schedule', s.scheduleId, s.name, `the task for system ${t.systemId}: that system is not in this HelloID environment`);
        }
      }
    });

    await part('Reconciliation', async () => {
      const rows = rowsOf(await reader.get(GATEWAY.reconciliationSystems));
      checked.reconciliation = rows.length;
      for (const r of rows) {
        if (r?.systemId && !systemIds.has(r.systemId)) add('reconciliation', r.systemId, null, `system ${r.systemId} is not in this HelloID environment`);
      }
    });

    const result = { ...page(findings, call.args.offset, call.args.limit), checked, couldNotCheck };
    return {
      summary:
        (findings.length ? pageText(result, 'reference(s) to things that do not exist') : 'No references to things that do not exist.') +
        (couldNotCheck.length ? ` Not checked: ${couldNotCheck.join('; ')}.` : ''),
      structured: result,
    };
  },
});

export const reportTools: ToolGroup = [
  reportRulesWithoutEntitlements,
  reportRulesWithoutPersons,
  reportRulesForEntitlement,
  reportSystemAccess,
  checkReferences,
];
