// The tools of phase 5a over MCP, against two fake HelloID environments: publishing a business rule
// (the three recorded variants, the choice, the flag, refusals), partial edits (set, unset, list
// operations, replaceList, identity, unknown paths, a script diff, masked secrets, rules as drafts,
// applied with helloid_apply_plan), cloning a rule, new IDs in the apply output, copying between
// environments, comparing and searching. Made-up data only.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type FakeHelloId, type FakeRequest, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import * as files from './import-files.ts';
import { installImportRoutes, writes } from './import-routes.ts';
import { auditLines, auditText, callOk, callTool, logIn, makeConfig, removeDir, resultText, type TestServer, startTestServer, tempDir } from './helpers.ts';

const SECRETS = ['alpha-client-secret-value', 'alpha-hidden-password', 'hr-api-key-value', 'hr-hidden-value', 'template-hidden-value', 'notify-hidden-value', 'notify-token-value'];

let fakeA: FakeHelloId;
let fakeB: FakeHelloId;
let dataA: Fixture;
let dataB: Fixture;
let dir: string;
let server: TestServer;
let client: Client;

before(async () => {
  fakeA = await startFakeHelloId();
  fakeB = await startFakeHelloId();
});
after(async () => {
  await fakeA.close();
  await fakeB.close();
});

/** The publish, copy and orphaned routes on a fake (on top of the fixture and import routes). */
function installRuleRoutes(fake: FakeHelloId, data: Fixture) {
  data.publishSummaries ??= {};
  data.published = [] as FakeRequest[];
  let counter = 0;
  const summary = /^\/service\/rule-evaluation\/api\/evaluation\/evaluate\/rule\/([^/]+)\/summary\/([^/]+)$/;
  fake.route('GET', summary, (r) => {
    const [, ruleId, changeId] = summary.exec(r.path)!;
    const rule = data.rules[ruleId!];
    if (!rule || rule.changeId !== changeId) return { status: 404, body: { message: 'Not found' } };
    return { body: data.publishSummaries[ruleId!] };
  });
  const publish = /^\/service\/rules\/api\/rules\/publish\/([^/]+)$/;
  fake.route('PUT', publish, (r) => {
    const rule = data.rules[publish.exec(r.path)![1]!];
    data.published.push(r);
    Object.assign(rule, {
      published: true,
      hasDraft: false,
      condition: rule.draft?.condition ?? rule.condition,
      entitlements: rule.draft?.entitlements ?? rule.entitlements,
      draft: null,
      changeId: `published-${++counter}`,
    });
    return { body: '' };
  });
  const copy = /^\/service\/rules\/api\/rules\/copy\/([^/]+)$/;
  fake.route('PUT', copy, (r) => {
    const original = data.rules[copy.exec(r.path)![1]!];
    const id = `c0000000-0000-4000-8000-00000000000${++counter}`;
    data.rules[id] = { ...structuredClone(original), ruleId: id, name: `${original.name} (copy)`, published: false, hasDraft: true };
    data.rulesOverview.push({ ruleId: id, name: `${original.name} (copy)`, published: false, hasDraft: true });
    return { body: JSON.stringify(id), headers: { 'Content-Type': 'application/json' } };
  });
  fake.route('GET', '/service/rules/api/entitlements/orphaned/any', () => ({ body: false }));
  // Saving a draft gives the rule a new changeId, as HelloID does
  fake.route('POST', '/service/rules/api/rules', (r) => {
    const body = r.json as any;
    const rule = data.rules[body.ruleId];
    rule.hasDraft = true;
    rule.draft = { condition: body.condition, entitlements: body.entitlements };
    rule.changeId = `draft-${++counter}`;
    return { body: { hasDraft: true, changeId: rule.changeId } };
  });
}

async function start(training: Record<string, unknown> = {}) {
  dataA = loadFixture();
  dataB = loadFixture();
  for (const [fake, data] of [[fakeA, dataA], [fakeB, dataB]] as const) {
    installFixtures(fake, data);
    installImportRoutes(fake, data);
    installRuleRoutes(fake, data);
  }
  dir = tempDir();
  const config = makeConfig(fakeA, dir, {
    training: { baseUrl: fakeA.portalUrl, gatewayUrl: fakeA.gatewayUrl, mode: 'write', ...training },
    acceptance: { baseUrl: fakeB.portalUrl, gatewayUrl: fakeB.gatewayUrl, mode: 'write' },
  });
  server = await startTestServer(config);
  client = await server.connect();
  await logIn(server, client, fakeA, 'training');
  await logIn(server, client, fakeB, 'acceptance');
  fakeA.state.gatewayRequests = [];
  fakeB.state.gatewayRequests = [];
}

async function restart(training: Record<string, unknown> = {}) {
  await server.close();
  removeDir(dir);
  await start(training);
}

beforeEach(() => start());
afterEach(async () => {
  await server.close();
  removeDir(dir);
});

function assertNoSecrets(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret ${secret} leaked`);
}

const env = (more: Record<string, unknown>) => ({ environment: 'training', ...more });
const ok = async (name: string, args: Record<string, unknown>) => {
  const result = await callTool(client, name, args);
  if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
  assertNoSecrets(result);
  return result.structuredContent as any;
};
const refused = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
  const result = await callTool(client, name, args);
  assert.equal(result.isError, true, `${name} should fail`);
  assert.match(resultText(result), pattern);
  return resultText(result);
};

describe('annotations of the new tools', () => {
  it('plan, compare and search are read-only; apply is destructive; clone writes but is not destructive', async () => {
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    for (const name of ['helloid_plan_publish_rule', 'helloid_plan_edit', 'helloid_plan_copy', 'helloid_compare', 'helloid_search_configuration']) {
      assert.equal(tool(name).annotations?.readOnlyHint, true, name);
      assert.equal(tool(name).annotations?.destructiveHint, false, name);
    }
    assert.equal(tool('helloid_apply_publish_rule').annotations?.readOnlyHint, false);
    assert.equal(tool('helloid_apply_publish_rule').annotations?.destructiveHint, true);
    assert.equal(tool('helloid_clone_business_rule').annotations?.readOnlyHint, false);
    assert.equal(tool('helloid_clone_business_rule').annotations?.destructiveHint, false);
  });

  it('helloid_list_environments shows allowRevokingRulePublish (default false)', async () => {
    const listed = await callOk(client, 'helloid_list_environments');
    assert.equal(listed.environments[0].allowRevokingRulePublish, false);
  });
});

// ---------------------------------------------------------------------------------------------

/** A rule with a draft and HelloID's summary of publishing it. */
function prepareRule(ruleId: string, summary: any, published = true) {
  Object.assign(dataA.rules[ruleId], { published, hasDraft: true, changeId: 'change-1', draft: dataA.rules[ruleId].draft ?? { condition: null, entitlements: [] } });
  dataA.publishSummaries[ruleId] = summary;
}

const publishPlan = (ruleId: string, removedEntitlements?: string) =>
  callTool(client, 'helloid_plan_publish_rule', env({ ruleId, ...(removedEntitlements ? { removedEntitlements } : {}) }));

describe('publishing a business rule', () => {
  it('a new rule, entitlements only added: no choice, the recorded body (unmanageRemovedEntitlements false)', async () => {
    const added = ['Alpha - Account', 'Alpha - Account Access', 'Alpha - Group Sales', 'Beta - Account', 'Beta - Account Access', 'Beta - Group One'];
    prepareRule(IDS.r3, { personCounts: { current: 0, added: 78, removed: 0 }, entitlementCounts: { current: 0, added: 6, removed: 0 }, addedEntitlements: added, removedEntitlements: null }, false);
    const planned = await ok('helloid_plan_publish_rule', env({ ruleId: IDS.r3 }));
    assert.equal(planned.choiceNeeded, false);
    assert.equal(planned.removedEntitlementsChoice, null);
    assert.deepEqual(planned.persons, { current: 0, added: 78, removed: 0, after: 78 });
    assert.deepEqual(planned.entitlements, { current: 0, added: 6, removed: 0, after: 6 });
    assert.deepEqual(planned.addedEntitlements, added);
    assert.equal(planned.published, false);
    assert.equal(dataA.published.length, 0, 'planning publishes nothing');

    const applied = await ok('helloid_apply_publish_rule', env({ planId: planned.planId, confirmName: 'Empty rule' }));
    assert.equal(applied.orphanedEntitlements, false);
    assert.equal(applied.published, true);
    assert.equal(applied.hasDraft, false);
    assert.equal(dataA.published.length, 1);
    assert.equal(dataA.published[0].body, JSON.stringify({
      addedEntitlements: added,
      removedEntitlements: null,
      changeId: 'change-1',
      previousPersonsInScopeCount: 0,
      personsAddedToScopeCount: 78,
      personsRemovedFromScopeCount: 0,
      currentPersonsInScopeCount: 78,
      previousSelectedEntitlementsCount: 0,
      addedEntitlementsCount: 6,
      removedEntitlementsCount: 0,
      currentSelectedEntitlementsCount: 6,
      unmanageRemovedEntitlements: false,
    }));
    assert.ok(fakeA.state.gatewayRequests.some((r) => r.path === '/service/rules/api/entitlements/orphaned/any'));
    const line = auditLines(dir).findLast((l) => l.tool === 'helloid_apply_publish_rule')!;
    assert.equal(line.result, 'ok');
    assert.equal(line.changes[0].before.hasDraft, true);
    assert.equal(line.changes[0].after.hasDraft, false);
  });

  it('entitlements added and removed, "revoke": refused without allowRevokingRulePublish; with it, unmanageRemovedEntitlements false', async () => {
    const summary = { personCounts: { current: 0, added: 0, removed: 0 }, entitlementCounts: { current: 3, added: 1, removed: 1 }, addedEntitlements: ['Gamma - Account Access'], removedEntitlements: ['Beta - Group All'] };
    prepareRule(IDS.r2, summary);
    await refused('helloid_plan_publish_rule', env({ ruleId: IDS.r2 }), /removedEntitlements is required/);
    await refused('helloid_plan_publish_rule', env({ ruleId: IDS.r2, removedEntitlements: 'revoke' }), /allowRevokingRulePublish/);

    await restart({ allowRevokingRulePublish: true });
    prepareRule(IDS.r2, summary);
    const planned = await ok('helloid_plan_publish_rule', env({ ruleId: IDS.r2, removedEntitlements: 'revoke' }));
    assert.equal(planned.choiceNeeded, true);
    assert.deepEqual(planned.entitlements, { current: 3, added: 1, removed: 1, after: 3 });
    await ok('helloid_apply_publish_rule', env({ planId: planned.planId, confirmName: 'Sales get Alpha' }));
    assert.deepEqual(JSON.parse(dataA.published[0].body), {
      addedEntitlements: ['Gamma - Account Access'],
      removedEntitlements: ['Beta - Group All'],
      changeId: 'change-1',
      previousPersonsInScopeCount: 0,
      personsAddedToScopeCount: 0,
      personsRemovedFromScopeCount: 0,
      currentPersonsInScopeCount: 0,
      previousSelectedEntitlementsCount: 3,
      addedEntitlementsCount: 1,
      removedEntitlementsCount: 1,
      currentSelectedEntitlementsCount: 3,
      unmanageRemovedEntitlements: false,
    });
  });

  it('an entitlement removed, "unmanaged": unmanageRemovedEntitlements true, no flag needed', async () => {
    prepareRule(IDS.r2, { personCounts: { current: 0, added: 0, removed: 0 }, entitlementCounts: { current: 3, added: 0, removed: 1 }, addedEntitlements: [], removedEntitlements: ['Beta - Group Public'] });
    const planned = await ok('helloid_plan_publish_rule', env({ ruleId: IDS.r2, removedEntitlements: 'unmanaged' }));
    assert.deepEqual(planned.entitlements, { current: 3, added: 0, removed: 1, after: 2 });
    await ok('helloid_apply_publish_rule', env({ planId: planned.planId, confirmName: 'Sales get Alpha' }));
    const body = JSON.parse(dataA.published[0].body);
    assert.deepEqual(body.addedEntitlements, []);
    assert.equal(body.currentSelectedEntitlementsCount, 2);
    assert.equal(body.unmanageRemovedEntitlements, true);
  });

  it('persons out of scope need a choice too; a choice when nothing is taken away is refused', async () => {
    prepareRule(IDS.r2, { personCounts: { current: 10, added: 2, removed: 3 }, entitlementCounts: { current: 2, added: 0, removed: 0 }, addedEntitlements: [], removedEntitlements: [] });
    await refused('helloid_plan_publish_rule', env({ ruleId: IDS.r2 }), /3 person\(s\) out of scope/);
    const planned = await ok('helloid_plan_publish_rule', env({ ruleId: IDS.r2, removedEntitlements: 'unmanaged' }));
    assert.deepEqual(planned.persons, { current: 10, added: 2, removed: 3, after: 9 });

    prepareRule(IDS.r2, { personCounts: { current: 10, added: 2, removed: 0 }, entitlementCounts: { current: 2, added: 1, removed: 0 }, addedEntitlements: ['x'], removedEntitlements: [] });
    await refused('helloid_plan_publish_rule', env({ ruleId: IDS.r2, removedEntitlements: 'unmanaged' }), /does not apply: leave it out/);
  });

  it('refuses a rule without a draft', async () => {
    await refused('helloid_plan_publish_rule', env({ ruleId: IDS.r1 }), /has no draft/);
  });

  it('refuses when the summary changed since the plan, and a wrong confirmName', async () => {
    prepareRule(IDS.r3, { personCounts: { current: 0, added: 1, removed: 0 }, entitlementCounts: { current: 0, added: 1, removed: 0 }, addedEntitlements: ['a'], removedEntitlements: null }, false);
    const planned = await ok('helloid_plan_publish_rule', env({ ruleId: IDS.r3 }));
    await refused('helloid_apply_publish_rule', env({ planId: planned.planId, confirmName: 'Empty Rule' }), /confirmName "Empty Rule" is not exactly/);
    dataA.publishSummaries[IDS.r3] = { ...dataA.publishSummaries[IDS.r3], personCounts: { current: 0, added: 2, removed: 0 } };
    await refused('helloid_apply_publish_rule', env({ planId: planned.planId, confirmName: 'Empty rule' }), /HelloID changed since the plan/);
    assert.equal(dataA.published.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------

const edit = (kind: string, more: Record<string, unknown>) => ok('helloid_plan_edit', env({ kind, ...more }));
const editRefused = (kind: string, more: Record<string, unknown>, pattern: RegExp) => refused('helloid_plan_edit', env({ kind, ...more }), pattern);
const applyPlan = (planId: string) => ok('helloid_apply_plan', env({ planId }));

describe('helloid_plan_edit', () => {
  it('set: a toxic combination switched off, planned and applied with helloid_apply_plan', async () => {
    const planned = await edit('toxicCombination', { id: IDS.tx1, changes: { set: [{ path: 'policy.enabled', value: false }] } });
    assert.deepEqual(planned.changes.map((c: any) => [c.change, c.target, c.before, c.after, c.newProperty]), [['set', 'policy.enabled', 'true', 'false', false]]);
    assert.match(planned.planId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(writes(fakeA.state.gatewayRequests), [], 'planning writes nothing');
    const applied = await applyPlan(planned.planId);
    assert.equal(applied.failed, 0, applied.overview);
    assert.equal(dataA.toxicCombinations[0].enabled, false);
  });

  it('by name (toxicPolicy is the same kind); a new property is flagged', async () => {
    const planned = await edit('toxicPolicy', { name: 'No sales and finance', changes: { set: [{ path: 'policy.extra', value: 'x' }] } });
    assert.equal(planned.changes[0].newProperty, true);
    assert.match(planned.changes[0].warnings[0], /new property/);
    assert.ok(planned.notes.some((n: string) => /New properties/.test(n)));
  });

  it('unset and set in a target system: the masked secrets keep their value in HelloID', async () => {
    // (a permission no system has would make the import retrieve the permissions and wait for them)
    dataA.rules[IDS.r2].entitlements = dataA.rules[IDS.r2].entitlements.filter((e: any) => e.type !== 'Permission');
    const planned = await edit('targetSystem', {
      id: IDS.alpha,
      changes: { set: [{ path: 'configuration.scriptConfiguration.baseUrl', value: 'https://alpha-edit.example.test' }], unset: ['configuration.scriptConfiguration.serviceUser'] },
    });
    assert.deepEqual(planned.changes.map((c: any) => c.change), ['set', 'unset']);
    assert.ok(planned.planId, planned.overview);
    const applied = await applyPlan(planned.planId);
    assert.equal(applied.failed, 0, applied.overview);
    const values = writes(fakeA.state.gatewayRequests).find((w) => w.includes('/script-configuration'))!;
    assert.match(values, /"clientSecret":"alpha-client-secret-value"/);
    assert.match(values, /"hiddenValue":"alpha-hidden-password"/);
    assert.match(values, /alpha-edit\.example\.test/);
    assert.ok(!values.includes('svc-alpha'));
    assertNoSecrets(auditText(dir));
  });

  it('a script change: line counts and a unified diff', async () => {
    dataA.powershellConfigurations[IDS.alpha].scripts = { accountCreate: 'line 1\nline 2\nline 3\nline 4\nline 5' };
    const planned = await edit('targetSystem', { id: IDS.alpha, changes: { set: [{ path: 'configuration.scripts.accountCreate', value: 'line 1\nline 2\nline three\nline 4\nline 5\nline 6' }] } });
    const text = planned.changes[0].text;
    assert.equal(text.linesBefore, 5);
    assert.equal(text.linesAfter, 6);
    assert.equal(text.added, 2);
    assert.equal(text.removed, 1);
    assert.match(text.diff, /^@@ -1,5 \+1,6 @@/);
    assert.match(text.diff, /\n-line 3\n\+line three\n/);
    assert.match(text.diff, /\n\+line 6$/);
    assert.ok(planned.entries.some((e: any) => e.details.some((d: string) => d.includes('scripts.accountCreate'))), planned.overview);
  });

  it('list operations on a rule\'s entitlements: saved as a draft, then publishable', async () => {
    const planned = await edit('businessRule', {
      id: IDS.r1,
      changes: { lists: [{ path: 'rule.entitlements', op: 'add', value: { entitlementId: IDS.e3 } }, { path: 'rule.entitlements', op: 'remove', match: { entitlementId: '88888888-8888-4888-8888-888888888884' } }] },
    });
    assert.deepEqual(planned.changes.map((c: any) => c.change), ['add', 'remove']);
    assert.ok(planned.notes.some((n: string) => n.includes('helloid_plan_publish_rule')));
    const applied = await applyPlan(planned.planId);
    assert.equal(applied.failed, 0, applied.overview);
    const draft = dataA.rules[IDS.r1].draft;
    assert.deepEqual(draft.entitlements.map((e: any) => e.entitlementId), [IDS.e1, IDS.e3]);
    assert.equal(dataA.rules[IDS.r1].published, true, 'the published rule stays as it was');
    dataA.publishSummaries[IDS.r1] = { personCounts: { current: 1, added: 0, removed: 0 }, entitlementCounts: { current: 2, added: 1, removed: 1 }, addedEntitlements: ['Alpha - Group Sales'], removedEntitlements: ['Beta - Account'] };
    const publish = await ok('helloid_plan_publish_rule', env({ ruleId: IDS.r1, removedEntitlements: 'unmanaged' }));
    assert.equal(publish.changeId, dataA.rules[IDS.r1].changeId);
  });

  it('a rule with a draft is edited as its draft', async () => {
    const planned = await edit('businessRule', { id: IDS.r2, changes: { lists: [{ path: 'rule.entitlements', op: 'remove', match: { entitlementId: IDS.e1 } }] } });
    assert.equal(planned.changes[0].change, 'remove');
    assert.ok(planned.notes.some((n: string) => /unpublished draft/.test(n)));
  });

  it('list refusals: add of what is there, remove of nothing, several matches, change of a list ID', async () => {
    await editRefused('businessRule', { id: IDS.r1, changes: { lists: [{ path: 'rule.entitlements', op: 'add', value: { entitlementId: IDS.e1 } }] } }, /matches .* already/);
    await editRefused('businessRule', { id: IDS.r1, changes: { lists: [{ path: 'rule.entitlements', op: 'remove', match: { entitlementId: IDS.e3 } }] } }, /no item matches/);
    await editRefused('businessRule', { id: IDS.r1, changes: { lists: [{ path: 'rule.entitlements', op: 'change', match: { type: 'Account' }, value: { displayName: 'x' } }] } }, /2 items match/);
    await editRefused('targetSystem', { id: IDS.alpha, changes: { lists: [{ path: 'configuration.permissions', op: 'change', match: { displayName: 'Groups' }, value: { identification: 'other' } }] } }, /identification is the ID/);
    await editRefused('targetSystem', { id: IDS.alpha, changes: { lists: [{ path: 'configuration.permissions', op: 'add', value: { displayName: 'New', identification: 'p2' } }] } }, /leave identification out/);
    await editRefused('businessRule', { id: IDS.r1, changes: { lists: [{ path: 'rule.name', op: 'add', value: 'x' }] } }, /not a list/);
  });

  it('change of one list item, and a list of texts', async () => {
    const changed = await edit('targetSystem', {
      id: IDS.alpha,
      changes: { lists: [{ path: 'configuration.permissions', op: 'change', match: { displayName: 'Groups' }, value: { displayName: 'All groups' } }] },
    });
    assert.equal(changed.changes[0].target, 'configuration.permissions[displayName=Groups]');
    assert.match(changed.changes[0].after, /All groups/);
    const texts = await edit('toxicCombination', { id: IDS.tx1, changes: { lists: [{ path: 'policy.outputObjectIds', op: 'add', value: IDS.e1 }] } });
    assert.equal(texts.changes[0].change, 'add');
    await editRefused('toxicCombination', { id: IDS.tx1, changes: { lists: [{ path: 'policy.outputObjectIds', op: 'remove' }] } }, /\$value/);
  });

  it('a whole list only with replaceList', async () => {
    await editRefused('businessRule', { id: IDS.r1, changes: { set: [{ path: 'rule.entitlements', value: [] }] } }, /replaceList: true/);
    await editRefused('businessRule', { id: IDS.r1, changes: { set: [{ path: 'rule.condition', value: { hasActiveContract: true } }] } }, /replaces the list/);
    const planned = await edit('businessRule', { id: IDS.r1, changes: { set: [{ path: 'rule.entitlements', value: [], replaceList: true }] } });
    assert.equal(planned.changes[0].change, 'set');
    assert.ok(planned.planId);
  });

  it('identity fields, unknown paths and parts the import does not read are refused', async () => {
    await editRefused('businessRule', { id: IDS.r1, changes: { set: [{ path: 'rule.ruleId', value: 'x' }] } }, /identity/);
    await editRefused('targetSystem', { id: IDS.alpha, changes: { set: [{ path: 'configuration.permissions[displayName=Groups].identification', value: 'x' }] } }, /ID HelloID gives/);
    await editRefused('businessRule', { id: IDS.r1, changes: { set: [{ path: 'rule.condition.nothing.here', value: 1 }] } }, /does not exist/);
    await editRefused('businessRule', { id: IDS.r1, changes: { set: [{ path: 'systems', value: [] }] } }, /does not read/);
    await editRefused('businessRule', { id: IDS.r1, changes: { unset: ['rule.name'] } }, /required/);
    await editRefused('businessRule', { name: 'No such rule', changes: { set: [{ path: 'rule.description', value: 'x' }] } }, /no business rule named/);
  });

  it('a source system: a path into the JSON of its configuration; masked values stay', async () => {
    const planned = await edit('sourceSystem', { id: IDS.hr, changes: { set: [{ path: 'system.scriptConfiguration.url', value: 'https://hr-new.example.test' }] } });
    assert.equal(planned.changes[0].before, '"https://hr.example.test"');
    const applied = await applyPlan(planned.planId);
    assert.equal(applied.failed, 0, applied.overview);
    const values = JSON.parse(dataA.sourceSystemDetails[IDS.hr].scriptConfiguration);
    assert.deepEqual(values, { url: 'https://hr-new.example.test', apiKey: 'hr-api-key-value', passphrase: 'hr-hidden-value' });
  });

  it('a secret set in a change is masked in the plan and the audit', async () => {
    const planned = await edit('targetSystem', { id: IDS.alpha, changes: { set: [{ path: 'configuration.scriptConfiguration.clientSecret', value: 'brand-new-secret' }] } });
    assert.equal(planned.changes[0].after, '"***"');
    assert.ok(!JSON.stringify(planned).includes('brand-new-secret'));
    assert.ok(!auditText(dir).includes('brand-new-secret'));
  });
});

// ---------------------------------------------------------------------------------------------

describe('helloid_clone_business_rule', () => {
  it('copies a rule, returns the new ID and name, and audits it', async () => {
    const cloned = await ok('helloid_clone_business_rule', env({ ruleId: IDS.r1 }));
    assert.match(cloned.ruleId, /^c0000000-/);
    assert.equal(cloned.name, 'Employees get Alpha (copy)');
    assert.ok(fakeA.state.gatewayRequests.some((r) => r.method === 'PUT' && r.path === `/service/rules/api/rules/copy/${IDS.r1}` && r.body === '{}'));
    const line = auditLines(dir).findLast((l) => l.tool === 'helloid_clone_business_rule')!;
    assert.equal(line.changes[0].before, null);
    assert.equal(line.changes[0].after.ruleId, cloned.ruleId);
  });
});

describe('new IDs in the apply output', () => {
  it('a new target system and its notification, a new rule', async () => {
    const planned = await ok('helloid_plan_import', env({
      files: files.asInput([files.deltaFile(), files.deltaNotificationsFile(), files.newRuleFile()]),
      answers: { [`dependsByName:${files.OTHER.delta}`]: true },
    }));
    const applied = await applyPlan(planned.planId);
    assert.equal(applied.failed, 0, applied.overview);
    const delta = dataA.targetSystems.find((s: any) => s.displayName === 'Delta Directory');
    const system = applied.entries.find((e: any) => e.label.startsWith('"Delta Directory"'));
    assert.equal(system.createdId, delta.systemId);
    assert.ok(system.details.includes(`new targetSystem "Delta Directory": ID ${delta.systemId}`));
    const notification = applied.entries.find((e: any) => e.label.startsWith('"Delta created"'));
    const made = Object.values(dataA.notificationDetails).find((n: any) => n.name === 'Delta created') as any;
    assert.equal(notification.createdId, made.identifier);
    const rule = applied.entries.find((e: any) => e.label.startsWith('"Contractors"'));
    const newRule = Object.values(dataA.rules).find((r: any) => r.name === 'Contractors') as any;
    assert.equal(rule.createdId, newRule.ruleId);
    assert.deepEqual(rule.created, [{ kind: 'businessRule', id: newRule.ruleId, name: 'Contractors' }]);
    assert.ok(planned.entries.every((e: any) => e.createdId === null));
    const line = auditLines(dir).findLast((l) => l.tool === 'helloid_apply_plan')!;
    assert.match(line.summary, new RegExp(`New IDs: .*${delta.systemId}`));
  });
});

// ---------------------------------------------------------------------------------------------

describe('helloid_plan_copy', () => {
  it('copies items from one environment to another; new ones get new IDs; secrets are not copied', async () => {
    // Only in acceptance: a toxic policy, a custom event and a rule of other names and IDs
    dataB.toxicCombinations[0] = { ...dataB.toxicCombinations[0], toxicCombinationId: 'b1000000-0000-4000-8000-000000000001', name: 'Only in acceptance' };
    dataB.customEvents[0] = { ...dataB.customEvents[0], customEventId: 'b1000000-0000-4000-8000-000000000002', name: 'Event of acceptance' };
    const planned = await ok('helloid_plan_copy', {
      sourceEnvironment: 'acceptance',
      targetEnvironment: 'training',
      items: [
        { kind: 'toxicCombination', name: 'Only in acceptance' },
        { kind: 'customEvent', id: 'b1000000-0000-4000-8000-000000000002' },
        { kind: 'sourceSystem', id: IDS.hr },
      ],
    });
    assert.equal(planned.targetEnvironment, 'training');
    assert.ok(planned.notes.some((n: string) => /new items get empty secrets/.test(n)));
    // (a note: one of its entitlements is in neither environment)
    assert.equal(planned.entries.find((e: any) => e.label.startsWith('"Only in acceptance"')).status, 'note');
    assert.deepEqual(writes(fakeA.state.gatewayRequests), []);
    assert.deepEqual(writes(fakeB.state.gatewayRequests), []);
    // Applied in the target, not in the source
    await refused('helloid_apply_plan', { environment: 'acceptance', planId: planned.planId }, /is for environment 'training'/);
    const applied = await ok('helloid_apply_plan', env({ planId: planned.planId }));
    assert.equal(applied.failed, 0, applied.overview);
    const toxic = dataA.toxicCombinations.find((t: any) => t.name === 'Only in acceptance');
    assert.equal(toxic.enabled, false, 'new: disabled');
    assert.equal(applied.entries.find((e: any) => e.label.startsWith('"Only in acceptance"')).createdId, toxic.toxicCombinationId);
    const event = dataA.customEvents.find((e: any) => e.name === 'Event of acceptance');
    assert.equal(applied.entries.find((e: any) => e.label.startsWith('"Event of acceptance"')).createdId, event.customEventId);
    assert.equal(JSON.parse(dataA.sourceSystemDetails[IDS.hr].scriptConfiguration).apiKey, 'hr-api-key-value');
    assert.deepEqual(writes(fakeB.state.gatewayRequests), [], 'nothing written in the source');
  });

  it('needs mode write in the target', async () => {
    await server.close();
    removeDir(dir);
    dataA = loadFixture();
    dataB = loadFixture();
    installFixtures(fakeA, dataA);
    installFixtures(fakeB, dataB);
    dir = tempDir();
    server = await startTestServer(makeConfig(fakeA, dir, {
      training: { baseUrl: fakeA.portalUrl, gatewayUrl: fakeA.gatewayUrl, mode: 'plan' },
      acceptance: { baseUrl: fakeB.portalUrl, gatewayUrl: fakeB.gatewayUrl, mode: 'read' },
    }));
    client = await server.connect();
    await logIn(server, client, fakeA, 'training');
    await logIn(server, client, fakeB, 'acceptance');
    // A target in mode read is refused; mode plan is enough to plan (applying needs write)
    await refused('helloid_plan_copy', { sourceEnvironment: 'training', targetEnvironment: 'acceptance', items: [{ kind: 'customEvent', id: IDS.ce1 }] }, /needs mode "plan"/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('helloid_compare', () => {
  it('two items: volatile fields are left out; a script as a diff', async () => {
    dataA.rules[IDS.r1].lastChanged = '2026-01-01T00:00:00Z';
    dataB.rules[IDS.r1].lastChanged = '2026-02-02T00:00:00Z';
    dataB.rules[IDS.r1].changeId = 'other';
    const same = await ok('helloid_compare', { left: { environment: 'training', kind: 'businessRule', id: IDS.r1 }, right: { environment: 'acceptance', kind: 'businessRule', name: 'Employees get Alpha' } });
    assert.equal(same.identical, true, JSON.stringify(same.groups));

    dataA.powershellConfigurations[IDS.alpha].scripts = { accountCreate: 'a\nb\nc' };
    dataB.powershellConfigurations[IDS.alpha].scripts = { accountCreate: 'a\nB\nc' };
    dataB.powershellConfigurations[IDS.alpha].description = 'Changed';
    const differ = await ok('helloid_compare', { left: { environment: 'training', kind: 'targetSystem', id: IDS.alpha }, right: { environment: 'acceptance', kind: 'targetSystem', id: IDS.alpha } });
    assert.equal(differ.identical, false);
    const differences = differ.groups[1].differences;
    const script = differences.find((d: any) => d.path === 'configuration.scripts.accountCreate');
    assert.match(script.diff, /-b\n\+B/);
    assert.ok(differences.some((d: any) => d.path === 'configuration.description' && d.left === '"PowerShell v2 example"' && d.right === '"Changed"'));
    assert.ok(!differences.some((d: any) => /exported/.test(d.path)));
    assertNoSecrets(differ);
    const paged = await ok('helloid_compare', { left: { environment: 'training', kind: 'targetSystem', id: IDS.alpha }, right: { environment: 'acceptance', kind: 'targetSystem', id: IDS.alpha }, limit: 1 });
    assert.equal(paged.groups[1].differences.length, 1);
    assert.equal(paged.groups[1].total, differences.length);
  });

  it('the same item by name across the logged-in environments: groups', async () => {
    dataB.rules[IDS.r1].description = 'Other description';
    const compared = await ok('helloid_compare', { kind: 'businessRule', name: 'Employees get Alpha' });
    assert.equal(compared.form, 'environments');
    assert.equal(compared.groups.length, 2);
    assert.deepEqual(compared.groups[1].differences.map((d: any) => d.path), ['rule.description']);
    const missing = await ok('helloid_compare', { kind: 'customEvent', name: 'Manager changed', environments: ['training', 'acceptance'] });
    assert.equal(missing.identical, true);
    dataB.customEvents.splice(0, 1);
    const gone = await ok('helloid_compare', { kind: 'customEvent', name: 'Manager changed' });
    assert.deepEqual(gone.missing, ['acceptance']);
  });
});

describe('helloid_search_configuration', () => {
  it('plain text (case-insensitive), regex, kinds and environments', async () => {
    const plain = await ok('helloid_search_configuration', { query: 'write-output' });
    const hit = plain.matches.find((m: any) => m.kind === 'sourceSystem');
    assert.equal(hit.path, 'system.personsScript');
    assert.deepEqual(new Set(plain.matches.map((m: any) => m.environment)), new Set(['training', 'acceptance']));
    assert.deepEqual(plain.searched.map((s: any) => s.environment), ['training', 'acceptance']);

    const regex = await ok('helloid_search_configuration', { query: '^Employees get \\w+$', regex: true, kinds: ['businessRule'], environments: ['training'] });
    assert.ok(regex.matches.length >= 1);
    assert.ok(regex.matches.every((m: any) => m.kind === 'businessRule' && m.environment === 'training'));
    assert.ok(regex.matches.some((m: any) => m.path === 'name' || m.path === 'rule.name'));

    const kinds = await ok('helloid_search_configuration', { query: 'Manager', kinds: ['customEvent'] });
    assert.ok(kinds.matches.length >= 1 && kinds.matches.every((m: any) => m.kind === 'customEvent'));
  });

  it('a text of several lines: the line number and the lines around it', async () => {
    dataA.powershellConfigurations[IDS.alpha].scripts = { accountCreate: 'first\nsecond needle\nthird' };
    const found = await ok('helloid_search_configuration', { query: 'NEEDLE', environments: ['training'], kinds: ['targetSystem'] });
    assert.deepEqual(found.matches.map((m: any) => [m.path, m.line, m.text, m.before, m.after]), [['configuration.scripts.accountCreate', 2, 'second needle', 'first', 'third']]);
  });

  it('never matches or returns a secret', async () => {
    for (const secret of ['alpha-client-secret', 'hr-api-key-value', 'template-hidden', 'notify-token']) {
      // (the summary repeats the query, so the answer is not checked for the secret itself)
      const found = await callOk(client, 'helloid_search_configuration', { query: secret });
      assert.equal(found.total, 0, secret);
    }
    const masked = await ok('helloid_search_configuration', { query: '^\\*\\*\\*$', regex: true });
    assert.equal(masked.total, 0);
  });

  it('refuses an invalid regular expression', async () => {
    await refused('helloid_search_configuration', { query: '(', regex: true }, /not a valid regular expression/);
  });
});
