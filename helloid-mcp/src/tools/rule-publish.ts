// Publishing a business rule's draft (helloid_plan_publish_rule, helloid_apply_publish_rule), in two
// steps like delete.ts, and cloning a rule (helloid_clone_business_rule).
//
// Publishing, as HelloID's Business rules page does it (from a recording): read the rule (its
// changeId), read HelloID's summary of what publishing that change does (persons and entitlements:
// current, added, removed, and the names of the entitlements added and removed), then PUT
// rules/publish/{ruleId} with the summary's names and counts, the changeId, and
// unmanageRemovedEntitlements. After publishing, the page asks whether there are orphaned
// entitlements. When entitlements are removed or persons leave the scope, HelloID either takes the
// rule's entitlements away from those persons at the next enforcement (unless another rule grants
// them): "revoke" (unmanageRemovedEntitlements false; needs allowRevokingRulePublish), or leaves
// them, no longer managed: "unmanaged" (true). Adding entitlements or persons needs no choice.

import { z } from 'zod';
import { ACTION_PATHS, GATEWAY, RULE_PATHS } from '../helloid/endpoints.ts';
import { NotFoundError } from '../helloid/exports.ts';
import { idIn } from '../planners/common.ts';
import { RefusedError, requireRevokingRulePublish } from '../safety.ts';
import { defineTool, type ResolvedEnvironment, type ToolGroup } from './helpers.ts';

type Any = any;

export const PLAN_KIND = 'publish-rule';

export const REMOVED_ENTITLEMENTS = ['revoke', 'unmanaged'] as const;
export type RemovedEntitlements = (typeof REMOVED_ENTITLEMENTS)[number];

interface Counts {
  current: number;
  added: number;
  removed: number;
}

/** HelloID's summary of publishing a rule's draft. */
interface PublishSummary {
  personCounts: Counts;
  entitlementCounts: Counts;
  addedEntitlements: string[] | null;
  removedEntitlements: string[] | null;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const counts = (value: Any): Counts => ({ current: count(value?.current), added: count(value?.added), removed: count(value?.removed) });
const names = (value: unknown): string[] | null => (Array.isArray(value) ? value.map(String) : null);

/** The summary as HelloID gives it, with the counts as numbers (the names as given: null stays null). */
function toSummary(raw: Any): PublishSummary {
  return {
    personCounts: counts(raw?.personCounts),
    entitlementCounts: counts(raw?.entitlementCounts),
    addedEntitlements: names(raw?.addedEntitlements),
    removedEntitlements: names(raw?.removedEntitlements),
  };
}

const after = (c: Counts) => c.current + c.added - c.removed;

/** Whether publishing takes entitlements from persons (entitlements removed, or persons out of scope): then a choice is needed. */
export const choiceNeeded = (summary: PublishSummary) => summary.entitlementCounts.removed > 0 || summary.personCounts.removed > 0;

/** The body of PUT rules/publish/{ruleId}, as HelloID's page sends it (recorded, in this order). */
export function publishBody(summary: PublishSummary, changeId: string, unmanage: boolean) {
  const persons = summary.personCounts;
  const entitlements = summary.entitlementCounts;
  return {
    addedEntitlements: summary.addedEntitlements,
    removedEntitlements: summary.removedEntitlements,
    changeId,
    previousPersonsInScopeCount: persons.current,
    personsAddedToScopeCount: persons.added,
    personsRemovedFromScopeCount: persons.removed,
    currentPersonsInScopeCount: after(persons),
    previousSelectedEntitlementsCount: entitlements.current,
    addedEntitlementsCount: entitlements.added,
    removedEntitlementsCount: entitlements.removed,
    currentSelectedEntitlementsCount: after(entitlements),
    unmanageRemovedEntitlements: unmanage,
  };
}

/** The rule and the summary of publishing its draft; refused when the rule has no draft. */
async function readPublishState(environment: ResolvedEnvironment, ruleId: string, now: () => number, signal: AbortSignal) {
  const { client } = environment;
  let rule: Any;
  try {
    rule = await client.gatewayJson<Any>({ path: GATEWAY.rule(ruleId), query: { cachebust: now() }, signal });
  } catch (error) {
    if ((error as { status?: number }).status === 404) throw new NotFoundError(`There is no business rule '${ruleId}' in '${environment.name}'.`);
    throw error;
  }
  if (!rule || typeof rule !== 'object') throw new NotFoundError(`There is no business rule '${ruleId}' in '${environment.name}'.`);
  const name = String(rule.name ?? '');
  if (rule.hasDraft !== true) {
    throw new RefusedError(
      `Refused: business rule "${name}" has no draft, so there is nothing to publish. Change it first (helloid_plan_edit saves a draft), then plan the publish.`,
    );
  }
  const changeId = typeof rule.changeId === 'string' && rule.changeId ? rule.changeId : null;
  if (!changeId) throw new Error(`HelloID did not give the changeId of business rule "${name}", which publishing needs.`);
  const raw = await client.gatewayJson<Any>({ path: RULE_PATHS.publishSummary(ruleId, changeId), signal });
  return { rule, name, changeId, summary: toSummary(raw) };
}

const countsOutput = z.object({
  current: z.number().describe('Now (published)'),
  added: z.number(),
  removed: z.number(),
  after: z.number().describe('After publishing: current + added - removed'),
});

const CHOICE_TEXT =
  '"revoke": at the next enforcement HelloID takes the rule\'s entitlements away from the persons that lose them (entitlements removed from ' +
  'the rule, or persons out of its scope), unless another rule grants them; needs allowRevokingRulePublish. "unmanaged": they keep them, no ' +
  'longer managed by the rule. No default: ask the user.';

interface PublishPlanData {
  ruleId: string;
  name: string;
  choice: RemovedEntitlements | null;
}

const fingerprinted = (state: { changeId: string; summary: PublishSummary }) => ({ changeId: state.changeId, summary: state.summary });

export const planPublishRule = defineTool({
  name: 'helloid_plan_publish_rule',
  title: 'Plan publishing a business rule',
  description:
    'Plans publishing the draft of a business rule (HelloID\'s "Publish"). Reads the rule and HelloID\'s summary of what publishing ' +
    'its draft does: persons in scope now, added, removed and after; entitlements now, added, removed and after, with the names of ' +
    'the entitlements added and removed. A rule without a draft is refused. When entitlements are removed or persons leave the ' +
    `scope, removedEntitlements is required (no default): ${CHOICE_TEXT} When nothing is taken away, removedEntitlements must be ` +
    'left out. Returns the summary, the publish request and a plan ID for helloid_apply_publish_rule (valid 30 minutes, this MCP ' +
    'session only), which needs confirmName. Publishes nothing. Needs mode "write".',
  access: 'write',
  environment: true,
  input: {
    ruleId: z.string().min(1).describe('The rule ID (helloid_list_business_rules)'),
    removedEntitlements: z
      .enum(REMOVED_ENTITLEMENTS)
      .optional()
      .describe(`Only when publishing takes entitlements away (entitlements removed, or persons out of scope); then required. ${CHOICE_TEXT}`),
  },
  output: {
    planId: z.string().describe('The plan for helloid_apply_publish_rule'),
    expiresAt: z.string(),
    ruleId: z.string(),
    name: z.string().describe('The rule\'s current name: helloid_apply_publish_rule needs it as confirmName, exactly'),
    published: z.boolean().describe('Whether the rule was published before (false: the first publish)'),
    changeId: z.string().describe('The change that is published'),
    persons: countsOutput.describe('Persons in the rule\'s scope'),
    entitlements: countsOutput.describe('Entitlements of the rule'),
    addedEntitlements: z.array(z.string()).describe('The names of the entitlements added (HelloID\'s summary)'),
    removedEntitlements: z.array(z.string()).describe('The names of the entitlements removed'),
    choiceNeeded: z.boolean().describe('Whether publishing takes entitlements away, so removedEntitlements was needed'),
    removedEntitlementsChoice: z.enum(REMOVED_ENTITLEMENTS).nullable().describe('revoke or unmanaged; null when no choice is needed'),
    publishRequest: z.string().describe('The request apply sends (PUT with the body)'),
    warnings: z.array(z.string()),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const environment = call.environment;
    const { ruleId } = call.args;
    const choice = call.args.removedEntitlements ?? null;
    const state = await readPublishState(environment, ruleId, context.now, call.signal);
    const { summary, name } = state;
    const needed = choiceNeeded(summary);
    const what = [
      summary.entitlementCounts.removed ? `${summary.entitlementCounts.removed} entitlement(s) removed` : '',
      summary.personCounts.removed ? `${summary.personCounts.removed} person(s) out of scope` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    if (needed && choice === null) {
      throw new RefusedError(`Refused: publishing "${name}" takes entitlements away (${what}), so removedEntitlements is required. ${CHOICE_TEXT}`);
    }
    if (!needed && choice !== null) {
      throw new RefusedError(
        `Refused: publishing "${name}" takes no entitlements away (no entitlements removed, no persons out of scope), so removedEntitlements ` +
          `"${choice}" does not apply: leave it out.`,
      );
    }
    if (choice === 'revoke') requireRevokingRulePublish(environment.name, environment.config);
    const warnings: string[] = [];
    if (choice === 'revoke') warnings.push(`${what}: at the next enforcement HelloID takes those entitlements away, unless another rule grants them`);
    if (choice === 'unmanaged') warnings.push(`${what}: the persons keep those entitlements, no longer managed by the rule`);
    const body = publishBody(summary, state.changeId, choice === 'unmanaged');
    const plan = context.plans.create<PublishPlanData>({
      environment: environment.name,
      sessionId: call.sessionId,
      kind: PLAN_KIND,
      items: fingerprinted(state),
      data: { ruleId, name, choice },
    });
    const persons = { ...summary.personCounts, after: after(summary.personCounts) };
    const entitlements = { ...summary.entitlementCounts, after: after(summary.entitlementCounts) };
    return {
      summary:
        `Plan ${plan.id} (valid 30 minutes): publish business rule "${name}". Persons ${persons.current} -> ${persons.after} ` +
        `(+${persons.added} -${persons.removed}); entitlements ${entitlements.current} -> ${entitlements.after} (+${entitlements.added} -${entitlements.removed})` +
        `${choice ? `; removed entitlements: ${choice}` : ''}.${warnings.length ? ` ${warnings.join('; ')}.` : ''} Run it with helloid_apply_publish_rule, ` +
        `with confirmName exactly "${name}".`,
      structured: {
        planId: plan.id,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        ruleId,
        name,
        published: state.rule.published === true,
        changeId: state.changeId,
        persons,
        entitlements,
        addedEntitlements: summary.addedEntitlements ?? [],
        removedEntitlements: summary.removedEntitlements ?? [],
        choiceNeeded: needed,
        removedEntitlementsChoice: choice,
        publishRequest: `PUT ${RULE_PATHS.publish(ruleId)} ${JSON.stringify(body)}`,
        warnings,
      },
    };
  },
});

export const applyPublishRule = defineTool({
  name: 'helloid_apply_publish_rule',
  title: 'Publish a business rule (apply a publish plan)',
  description:
    'PUBLISHES the draft of a business rule in HelloID: the rule\'s new conditions and entitlements take effect (HelloID grants and, with ' +
    '"revoke", takes away entitlements at the next enforcement). Runs a plan of helloid_plan_publish_rule: reads the rule and HelloID\'s ' +
    'summary again and refuses when either changed since the plan ("plan again"), refuses unless confirmName is exactly the rule\'s ' +
    'current name, then sends the publish and reads whether there are orphaned entitlements now (as HelloID\'s page does). A plan ' +
    'runs at most once, only in the MCP session that made it, within 30 minutes. The rule before and after is written to the audit ' +
    'log. Needs mode "write"; "revoke" also needs allowRevokingRulePublish.',
  access: 'write',
  environment: true,
  input: {
    planId: z.string().min(1).describe('The plan ID from helloid_plan_publish_rule'),
    confirmName: z.string().describe('The rule\'s current name, exactly (as the plan shows it); anything else is refused'),
  },
  output: {
    ruleId: z.string(),
    name: z.string(),
    publishRequest: z.string().describe('The request that was sent'),
    published: z.boolean().nullable().describe('Read back: whether the rule is published'),
    hasDraft: z.boolean().nullable().describe('Read back: whether the rule still has a draft'),
    orphanedEntitlements: z
      .boolean()
      .nullable()
      .describe('HelloID\'s check after publishing (entitlements/orphaned/any): whether there are orphaned entitlements; null when it could not be read'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const environment = call.environment;
    return context.locks.run(environment.name, async () => {
      const plan = context.plans.get<PublishPlanData>(call.args.planId, { environment: environment.name, sessionId: call.sessionId, kind: PLAN_KIND });
      const { ruleId, choice } = plan.data;
      let state: Awaited<ReturnType<typeof readPublishState>>;
      try {
        state = await readPublishState(environment, ruleId, context.now, call.signal);
      } catch (error) {
        if (error instanceof RefusedError || error instanceof NotFoundError) {
          context.plans.verify(plan, {});
        }
        throw error;
      }
      context.plans.verify(plan, fingerprinted(state));
      if (call.args.confirmName !== state.name) {
        throw new RefusedError(
          `Refused: confirmName ${JSON.stringify(call.args.confirmName)} is not exactly the current name of the business rule ` +
            `(${JSON.stringify(state.name)}). Nothing was published.`,
        );
      }
      if (choice === 'revoke') requireRevokingRulePublish(environment.name, environment.config);
      context.plans.markApplied(plan);
      const body = publishBody(state.summary, state.changeId, choice === 'unmanaged');
      const path = RULE_PATHS.publish(ruleId);
      const label = `business rule "${state.name}" (${ruleId})`;
      let failure: unknown;
      try {
        await environment.client.gateway({ method: 'PUT', path, body, signal: call.signal });
      } catch (error) {
        failure = error;
      }
      const read = await environment.client
        .gatewayJson<Any>({ path: GATEWAY.rule(ruleId), query: { cachebust: context.now() }, signal: call.signal })
        .catch(() => null);
      call.recordChanges([{ item: label, before: state.rule, after: read }]);
      if (failure) throw failure;
      const orphaned = await environment.client
        .gatewayJson<unknown>({ path: ACTION_PATHS.orphanedAny, signal: call.signal })
        .then((value) => (typeof value === 'boolean' ? value : null))
        .catch(() => null);
      const how = choice === 'revoke' ? ' (removed entitlements: revoke)' : choice === 'unmanaged' ? ' (removed entitlements: unmanaged)' : '';
      return {
        summary:
          `Published ${label}${how}.` +
          (orphaned === true ? ' HelloID now has orphaned entitlements (see helloid_check_health).' : orphaned === false ? ' No orphaned entitlements.' : ''),
        structured: {
          ruleId,
          name: state.name,
          publishRequest: `PUT ${path} ${JSON.stringify(body)}`,
          published: typeof read?.published === 'boolean' ? read.published : null,
          hasDraft: typeof read?.hasDraft === 'boolean' ? read.hasDraft : null,
          orphanedEntitlements: orphaned,
        },
      };
    });
  },
});

export const cloneBusinessRule = defineTool({
  name: 'helloid_clone_business_rule',
  title: 'Clone a business rule',
  description:
    'Makes a copy of a business rule in the same environment (HelloID\'s "Clone rule", the request the userscript sends: PUT ' +
    'rules/copy/{ruleId}). Returns the new rule\'s ID and name, read back from HelloID, and whether it is published. Changes nothing ' +
    'of the original. The new rule is written to the audit log. Needs mode "write".',
  access: 'write',
  environment: true,
  input: { ruleId: z.string().min(1).describe('The rule to copy (helloid_list_business_rules)') },
  output: {
    sourceRuleId: z.string(),
    ruleId: z.string().describe('The ID of the new rule'),
    name: z.string().nullable().describe('The name of the new rule, as HelloID gave it'),
    published: z.boolean().nullable(),
    hasDraft: z.boolean().nullable(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(call, context) {
    const environment = call.environment;
    const { ruleId } = call.args;
    return context.locks.run(environment.name, async () => {
      const original = await environment.client.gatewayJson<Any>({ path: GATEWAY.rule(ruleId), signal: call.signal }).catch((error: unknown) => {
        if ((error as { status?: number }).status === 404) throw new NotFoundError(`There is no business rule '${ruleId}' in '${environment.name}'.`);
        throw error;
      });
      const answer = await environment.client.gatewayJson<unknown>({ method: 'PUT', path: RULE_PATHS.copy(ruleId), body: {}, signal: call.signal });
      const newId = idIn(answer, 'ruleId', 'id');
      if (!newId) throw new Error('HelloID made the copy, but did not say which rule it is. Find it with helloid_list_business_rules.');
      const copy = await environment.client
        .gatewayJson<Any>({ path: GATEWAY.rule(newId), query: { cachebust: context.now() }, signal: call.signal })
        .catch(() => null);
      const name = typeof copy?.name === 'string' ? copy.name : null;
      call.recordChanges([{ item: `business rule ${name ? `"${name}" ` : ''}(${newId}), a copy of "${original?.name}" (${ruleId})`, before: null, after: copy }]);
      return {
        summary: `Copied business rule "${original?.name}": the new rule is ${name ? `"${name}" ` : ''}with ID ${newId}.`,
        structured: {
          sourceRuleId: ruleId,
          ruleId: newId,
          name,
          published: typeof copy?.published === 'boolean' ? copy.published : null,
          hasDraft: typeof copy?.hasDraft === 'boolean' ? copy.hasDraft : null,
        },
      };
    });
  },
});

export const rulePublishTools: ToolGroup = [planPublishRule, applyPublishRule, cloneBusinessRule];
