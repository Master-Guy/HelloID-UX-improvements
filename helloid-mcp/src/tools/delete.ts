// helloid_plan_delete and helloid_apply_delete: deleting one item, in two steps. The plan reads the
// item and the checks HelloID's own pages make before deleting it, and keeps fingerprints of the
// item and of the checks that matter for safety; apply reads them again, refuses when anything
// changed or confirmName is not the item's current name, sends HelloID's delete request and reads
// back that the item is gone. Only the kinds of DESIGN.md's table can be deleted.

import { z } from 'zod';
import { cachebust, DELETE_PATHS, GATEWAY, type QueryValue, TAKE_ALL } from '../helloid/endpoints.ts';
import { type Exporter, NotFoundError, RULE_ENTITLEMENT_FIELDS, rowsOf, targetConfigurationPath } from '../helloid/exports.ts';
import { maskNotificationSystem, maskSourceSystem, maskTargetConfiguration, RefusedError, requireRevokingRuleDelete } from '../safety.ts';
import type { AppContext } from './context.ts';
import { defineTool, exporterFor, type ResolvedEnvironment, type ToolCall, type ToolGroup } from './helpers.ts';
import { readRulesOverview } from './rules.ts';

type Any = any;

export const PLAN_KIND = 'delete';

export const DELETE_KINDS = [
  'targetSystem',
  'sourceSystem',
  'businessRule',
  'notification',
  'notificationSystem',
  'customEvent',
  'toxicCombination',
] as const;
export type DeleteKind = (typeof DELETE_KINDS)[number];

export const RULE_ENTITLEMENTS = ['unmanaged', 'revoke'] as const;
export type RuleEntitlements = (typeof RULE_ENTITLEMENTS)[number];

/** The persons of a rule read for the plan, as HelloID's Business rules page reads them. */
export const RULE_PERSONS_TAKE = 50;

/** What a delete reads with. */
interface Reader {
  environment: ResolvedEnvironment;
  exporter: Exporter;
  now: () => number;
  signal: AbortSignal;
  get<T = Any>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

/** The item as read from HelloID. */
interface ReadItem {
  name: string;
  /** What is fingerprinted: the item as HelloID gives it. */
  raw: unknown;
  /** The item with its secrets masked (the audit's "before"). */
  masked: unknown;
  /** Business rules: published (else draft only) and whether it has a draft. */
  published?: boolean;
  hasDraft?: boolean;
}

interface CheckResult {
  /** What the plan shows. */
  checks: Record<string, unknown>;
  /** The checks that are fingerprinted (apply refuses when they changed). */
  fingerprinted: Record<string, unknown>;
  warnings: string[];
  /** A reason to refuse the delete (built-in system, snapshot running). */
  refusal?: string;
}

interface KindHandler {
  /** "target system", ... */
  label: string;
  /** The item; undefined when it is not in HelloID's list. */
  read(reader: Reader, id: string): Promise<ReadItem | undefined>;
  checks(reader: Reader, id: string, item: ReadItem): Promise<CheckResult>;
  /** The delete request's path; revoke only for business rules. */
  deletePath(id: string, revoke: boolean): string;
}

const noChecks = async (): Promise<CheckResult> => ({ checks: {}, fingerprinted: {}, warnings: [] });
const nameOf = (value: Any): string => String(value?.displayName ?? value?.name ?? value?.systemId ?? value?.ruleId ?? '?');
const quoted = (rows: Any[], name: (row: Any) => unknown = nameOf) => rows.map((r) => `"${name(r)}"`).join(', ');

const HANDLERS: Record<DeleteKind, KindHandler> = {
  targetSystem: {
    label: 'target system',
    async read(reader, id) {
      const list = await reader.get(GATEWAY.targetSystems, { showReferenceSystems: true });
      const entry = (Array.isArray(list) ? list : []).find((s: Any) => s?.systemId === id);
      if (!entry) return undefined;
      const path = targetConfigurationPath(entry);
      const configuration = path ? await reader.get(path) : null;
      return {
        name: String(entry.displayName ?? ''),
        raw: { listEntry: entry, configuration },
        masked: { listEntry: maskTargetConfiguration(entry), configuration: maskTargetConfiguration(configuration) },
      };
    },
    async checks(reader, id) {
      const [dependingOn, overview, agentSummary] = await Promise.all([
        reader.get(GATEWAY.systemsDependingOn, { systemId: id, cachebust: cachebust(reader.now) }),
        reader.get(GATEWAY.entitlementsOverview(id), { skip: 0, take: TAKE_ALL }),
        reader.get(GATEWAY.agentSelectionSummary(id)).catch(() => null),
      ]);
      const systemsDependingOn = rowsOf(dependingOn);
      const rulesGranting = rowsOf(overview).filter((r: Any) => RULE_ENTITLEMENT_FIELDS.some((f) => r?.[f] === true));
      const warnings: string[] = [];
      if (systemsDependingOn.length) {
        warnings.push(`${systemsDependingOn.length} other system(s) depend on it (HelloID's check): ${quoted(systemsDependingOn)}`);
      }
      if (rulesGranting.length) {
        warnings.push(`${rulesGranting.length} published business rule(s) grant entitlements on it: ${quoted(rulesGranting, (r) => r?.ruleName ?? r?.ruleId)}`);
      }
      return {
        checks: { systemsDependingOn, rulesGranting, agentSelectionSummary: agentSummary ?? null },
        fingerprinted: { systemsDependingOn: dependingOn ?? null, rulesGranting },
        warnings,
      };
    },
    deletePath: (id) => DELETE_PATHS.targetSystem(id),
  },

  sourceSystem: {
    label: 'source system',
    async read(reader, id) {
      const entry = rowsOf(await reader.get(GATEWAY.sourceSystems)).find((s: Any) => s?.systemId === id);
      if (!entry) return undefined;
      const system = await reader.get(GATEWAY.sourceSystem(id));
      return { name: String(system?.displayName ?? entry.displayName ?? ''), raw: system, masked: maskSourceSystem(system) };
    },
    async checks(reader, id) {
      const [blockedPersons, snapshot] = await Promise.all([
        reader.get(DELETE_PATHS.blockedPersonsAny(id)),
        reader.get(DELETE_PATHS.snapshotStatus, { systemId: id }),
      ]);
      const warnings: string[] = [];
      if (blockedPersons === true) warnings.push('the source system has blocked persons (HelloID\'s check)');
      return {
        checks: { blockedPersons: blockedPersons ?? null, snapshotStatus: snapshot ?? null },
        fingerprinted: { blockedPersons: blockedPersons ?? null },
        warnings,
        ...(snapshot?.isBusy === true
          ? { refusal: 'Refused: a snapshot of this source system is running (snapshot status isBusy); try again when it is done.' }
          : {}),
      };
    },
    deletePath: (id) => DELETE_PATHS.sourceSystem(id),
  },

  businessRule: {
    label: 'business rule',
    async read(reader, id) {
      const row = (await readRulesOverview(reader.environment, reader.now, reader.signal)).find((r: Any) => r?.ruleId === id);
      if (!row) return undefined;
      const rule = await reader.get(GATEWAY.rule(id));
      const published = typeof row.published === 'boolean' ? row.published : rule?.published === true;
      const hasDraft = typeof row.hasDraft === 'boolean' ? row.hasDraft : rule?.hasDraft === true;
      return { name: String(row.name ?? rule?.name ?? ''), raw: { rule, published, hasDraft }, masked: rule, published, hasDraft };
    },
    async checks(reader, id, item) {
      const answer = await reader.get(GATEWAY.ruleResultPersons(id), { skip: 0, take: RULE_PERSONS_TAKE });
      const persons = rowsOf(answer);
      const personCount = typeof answer?.totalRowCount === 'number' ? answer.totalRowCount : persons.length;
      const rule = item.masked as Any;
      const entitlements = Array.isArray(rule?.entitlements) ? rule.entitlements : [];
      const draftEntitlements = Array.isArray(rule?.draft?.entitlements) ? rule.draft.entitlements : [];
      const warnings: string[] = [];
      if (personCount > 0) warnings.push(`${personCount} person(s) were in the rule at the last evaluation`);
      return {
        checks: {
          published: item.published === true,
          hasDraft: item.hasDraft === true,
          entitlements,
          draftEntitlements,
          personsInRuleLastEvaluation: { total: personCount, first: persons },
        },
        fingerprinted: { personsInRuleLastEvaluation: personCount },
        warnings,
      };
    },
    deletePath: (id, revoke) => DELETE_PATHS.businessRule(id, revoke),
  },

  notification: {
    label: 'notification',
    async read(reader, id) {
      const row = (await reader.exporter.listNotifications()).find((n: Any) => n?.identifier === id);
      if (!row) return undefined;
      const [notification, file] = await Promise.all([reader.get(GATEWAY.notification(id)), reader.exporter.notifications([id])]);
      return { name: String(notification?.name ?? row.name ?? ''), raw: notification, masked: file.notifications[0] ?? null };
    },
    checks: noChecks,
    deletePath: (id) => DELETE_PATHS.notification(id),
  },

  notificationSystem: {
    label: 'notification system',
    async read(reader, id) {
      const row = (await reader.exporter.listNotificationSystems()).find((s: Any) => s?.systemId === id);
      if (!row) return undefined;
      const system = await reader.get(GATEWAY.notificationSystem(id));
      return {
        name: String(system?.displayName ?? row.displayName ?? ''),
        raw: { listEntry: row, system },
        masked: maskNotificationSystem(system),
      };
    },
    async checks(reader, id, item) {
      const { listEntry, system } = item.raw as Any;
      const usedBy = (await reader.exporter.listNotifications())
        .filter((n: Any) => n?.notificationSystemId === id)
        .map((n: Any) => ({ identifier: n.identifier ?? null, name: n.name ?? null, event: n.event ?? null, enabled: n.enabled ?? null }));
      const builtin = listEntry?.isBuiltin === true || system?.isBuiltin === true;
      const warnings: string[] = [];
      if (usedBy.length) warnings.push(`${usedBy.length} notification(s) use it: ${quoted(usedBy)}`);
      return {
        checks: { isBuiltin: builtin, notificationsUsingIt: usedBy },
        fingerprinted: { notificationsUsingIt: usedBy },
        warnings,
        ...(builtin ? { refusal: 'Refused: this is a built-in notification system; built-in notification systems are not deleted.' } : {}),
      };
    },
    deletePath: (id) => DELETE_PATHS.notificationSystem(id),
  },

  customEvent: {
    label: 'custom event',
    async read(reader, id) {
      const event = (await reader.exporter.listCustomEvents()).find((e: Any) => e?.customEventId === id);
      return event ? { name: String(event.name ?? ''), raw: event, masked: event } : undefined;
    },
    async checks(reader, id) {
      const used = await reader.get(DELETE_PATHS.customEventUsed(id));
      return {
        checks: { used: used ?? null },
        fingerprinted: { used: used ?? null },
        warnings: used === true ? ['notifications use this custom event (HelloID\'s check)'] : [],
      };
    },
    deletePath: (id) => DELETE_PATHS.customEvent(id),
  },

  toxicCombination: {
    label: 'toxic combination',
    async read(reader, id) {
      const policy = (await reader.exporter.listToxicPolicies()).find((p: Any) => p?.toxicCombinationId === id);
      return policy ? { name: String(policy.name ?? ''), raw: policy, masked: policy } : undefined;
    },
    checks: noChecks,
    deletePath: (id) => DELETE_PATHS.toxicCombination(id),
  },
};

function readerFor(call: ToolCall<unknown, true>, context: AppContext): Reader {
  const { client } = call.environment;
  return {
    environment: call.environment,
    exporter: exporterFor(call, context),
    now: context.now,
    signal: call.signal,
    get: (path, query) => client.gatewayJson({ path, query, signal: call.signal }),
  };
}

/** What the plan store fingerprints: the item, and the checks that matter for safety. */
const fingerprintItems = (item: ReadItem | undefined, checks: CheckResult | undefined): Record<string, unknown> => ({
  ...(item ? { item: item.raw } : {}),
  ...Object.fromEntries(Object.entries(checks?.fingerprinted ?? {}).map(([key, value]) => [`check:${key}`, value])),
});

/** What a delete plan keeps for its apply. */
interface DeletePlanData {
  kind: DeleteKind;
  id: string;
  name: string;
  /** Business rules: true = revoke (and for a draft-only rule), false = mark unmanaged. */
  revoke: boolean;
  ruleEntitlements: RuleEntitlements | null;
}

const describeRuleChoice = (published: boolean, choice: RuleEntitlements | null) =>
  !published ? 'draft only' : choice === 'revoke' ? 'published; entitlements revoked' : 'published; entitlements marked as unmanaged';

export const planDeleteTool = defineTool({
  name: 'helloid_plan_delete',
  title: 'Plan a delete',
  description:
    'Plans deleting one item from HelloID: a target system, source system, business rule, notification, notification ' +
    'system, custom event or toxic combination (no other kinds). Reads the item and the checks HelloID\'s own pages make ' +
    'before deleting it (target system: the systems depending on it, the rules granting on it, its agent selection ' +
    'summary; source system: blocked persons and the snapshot status; business rule: published or draft, its entitlements ' +
    'and the persons in it at the last evaluation; notification system: the notifications using it; custom event: whether ' +
    'it is used). Returns what would be deleted, what still uses it, warnings, and a plan ID for helloid_apply_delete ' +
    '(valid 30 minutes, this MCP session only). Deletes nothing. A published business rule needs ruleEntitlements: ' +
    '"unmanaged" (mark its entitlements as unmanaged) or "revoke" (revoke them; also needs allowRevokingRuleDelete); there ' +
    'is no default; a draft-only rule needs none. Built-in notification systems and a source system whose snapshot is ' +
    'running are refused. Needs mode "write" and allowDelete true for the environment.',
  access: 'delete',
  environment: true,
  input: {
    kind: z.enum(DELETE_KINDS).describe('What to delete'),
    id: z
      .string()
      .min(1)
      .describe('The item\'s ID: systemId, ruleId, identifier (notification), customEventId or toxicCombinationId, from the list tools'),
    ruleEntitlements: z
      .enum(RULE_ENTITLEMENTS)
      .optional()
      .describe(
        'Business rules only, required when the rule is published (no default; ask the user): "unmanaged" marks the ' +
          'entitlements of the rule as unmanaged; "revoke" revokes them (needs allowRevokingRuleDelete). A draft-only rule needs none.',
      ),
  },
  output: {
    planId: z.string().describe('The plan for helloid_apply_delete'),
    expiresAt: z.string(),
    kind: z.string(),
    id: z.string(),
    name: z.string().describe('The item\'s current name: helloid_apply_delete needs it as confirmName, exactly'),
    deleteRequest: z.string().describe('The request apply sends'),
    rule: z
      .object({
        published: z.boolean(),
        hasDraft: z.boolean(),
        ruleEntitlements: z.string().nullable().describe('unmanaged or revoke; null for a draft-only rule (deleted with /true, as HelloID\'s page does)'),
      })
      .nullable()
      .describe('Business rules only'),
    checks: z.record(z.string(), z.unknown()).describe('What HelloID\'s checks answered: what still uses the item'),
    warnings: z.array(z.string()),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const { kind, id } = call.args;
    const choice = call.args.ruleEntitlements ?? null;
    const handler = HANDLERS[kind];
    if (choice !== null && kind !== 'businessRule') throw new Error('ruleEntitlements is only for kind "businessRule".');
    const reader = readerFor(call, context);
    const item = await handler.read(reader, id);
    if (!item) throw new NotFoundError(`There is no ${handler.label} '${id}' in '${call.environment.name}'.`);
    const checks = await handler.checks(reader, id, item);
    if (checks.refusal) throw new RefusedError(checks.refusal);

    const warnings = [...checks.warnings];
    let revoke = false;
    let rule: { published: boolean; hasDraft: boolean; ruleEntitlements: string | null } | null = null;
    if (kind === 'businessRule') {
      const published = item.published === true;
      if (published) {
        if (choice === null) {
          throw new RefusedError(
            `Refused: business rule "${item.name}" is published, so ruleEntitlements is required: "unmanaged" (mark its ` +
              'entitlements as unmanaged) or "revoke" (revoke them; needs allowRevokingRuleDelete). There is no default: ask the user.',
          );
        }
        if (choice === 'revoke') requireRevokingRuleDelete(call.environment.name, call.environment.config);
        revoke = choice === 'revoke';
        warnings.push(choice === 'revoke' ? 'the entitlements of the rule are revoked' : 'the entitlements of the rule are marked as unmanaged');
      } else {
        // A draft-only rule: deleted with /true, as HelloID's page sends
        revoke = true;
        if (choice !== null) warnings.push(`the rule is a draft only: ruleEntitlements "${choice}" is not used`);
      }
      rule = { published, hasDraft: item.hasDraft === true, ruleEntitlements: published ? choice : null };
    }
    const path = handler.deletePath(id, revoke);
    const plan = context.plans.create<DeletePlanData>({
      environment: call.environment.name,
      sessionId: call.sessionId,
      kind: PLAN_KIND,
      items: fingerprintItems(item, checks),
      data: { kind, id, name: item.name, revoke, ruleEntitlements: rule?.published ? choice : null },
    });
    const what = `${handler.label} "${item.name}"${rule ? ` (${describeRuleChoice(rule.published, choice)})` : ''}`;
    const warningText = warnings.length ? ` Warnings: ${warnings.join('; ')}.` : '';
    return {
      summary:
        `Plan ${plan.id} (valid 30 minutes): delete ${what}.${warningText} Deleting is for real: run it with ` +
        `helloid_apply_delete, with confirmName exactly "${item.name}".`,
      structured: {
        planId: plan.id,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        kind,
        id,
        name: item.name,
        deleteRequest: `DELETE ${path}`,
        rule,
        checks: checks.checks,
        warnings,
      },
    };
  },
});

export const applyDeleteTool = defineTool({
  name: 'helloid_apply_delete',
  title: 'Delete (apply a delete plan)',
  description:
    'DELETES an item from HelloID, for real; it cannot be undone. Runs a plan of helloid_plan_delete: reads the item and ' +
    'its checks again and refuses when anything changed since the plan ("plan again"), refuses unless confirmName is ' +
    'exactly the item\'s current name, then sends HelloID\'s delete request and reads back that the item is gone. A plan ' +
    'runs at most once, only in the MCP session that made it, within 30 minutes. The item as it was before (secrets ' +
    'masked) is written to the audit log. Needs mode "write" and allowDelete true for the environment; a published ' +
    'business rule with "revoke" also needs allowRevokingRuleDelete.',
  access: 'delete',
  environment: true,
  input: {
    planId: z.string().min(1).describe('The plan ID from helloid_plan_delete'),
    confirmName: z.string().describe('The item\'s current name, exactly (as the plan shows it); anything else is refused'),
  },
  output: {
    kind: z.string(),
    id: z.string(),
    name: z.string(),
    deleteRequest: z.string().describe('The request that was sent'),
    deleted: z.boolean().describe('Read back: the item is gone'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const environment = call.environment;
    return context.locks.run(environment.name, async () => {
      const plan = context.plans.get<DeletePlanData>(call.args.planId, { environment: environment.name, sessionId: call.sessionId, kind: PLAN_KIND });
      const { kind, id, revoke, ruleEntitlements } = plan.data;
      const handler = HANDLERS[kind];
      const reader = readerFor(call, context);

      const item = await handler.read(reader, id);
      const checks = item ? await handler.checks(reader, id, item) : undefined;
      context.plans.verify(plan, fingerprintItems(item, checks));
      if (!item || !checks) throw new RefusedError(`Refused: the ${handler.label} '${id}' is no longer in HelloID; plan again.`);
      if (call.args.confirmName !== item.name) {
        throw new RefusedError(
          `Refused: confirmName ${JSON.stringify(call.args.confirmName)} is not exactly the current name of the ${handler.label} ` +
            `(${JSON.stringify(item.name)}). Nothing was deleted.`,
        );
      }
      if (checks.refusal) throw new RefusedError(checks.refusal);
      if (kind === 'businessRule' && item.published === true && ruleEntitlements === 'revoke') {
        requireRevokingRuleDelete(environment.name, environment.config);
      }

      context.plans.markApplied(plan);
      const path = handler.deletePath(id, revoke);
      const label = `${handler.label} "${item.name}" (${id})`;
      let failure: unknown;
      try {
        await environment.client.gateway({ method: 'DELETE', path, signal: call.signal });
      } catch (error) {
        failure = error;
      }
      // Read back: the item should be gone
      const after = await handler.read(reader, id);
      if (after === undefined) call.recordChanges([{ item: label, before: item.masked, after: null }]);
      if (failure) throw failure;
      if (after !== undefined) throw new Error(`HelloID answered the delete of the ${label}, but it is still there.`);
      const how = kind === 'businessRule' && item.published === true ? (revoke ? ', entitlements revoked' : ', entitlements marked as unmanaged') : '';
      return {
        summary: `Deleted the ${label}${how}.`,
        structured: { kind, id, name: item.name, deleteRequest: `DELETE ${path}`, deleted: true },
      };
    });
  },
});

export const deleteTools: ToolGroup = [planDeleteTool, applyDeleteTool];
