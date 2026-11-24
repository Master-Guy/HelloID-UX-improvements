import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import {
  canonicalJson,
  effectiveMode,
  EnvironmentLocks,
  fingerprint,
  PlanStore,
  RefusedError,
  refusalReason,
  requireAccess,
  requireRevokingRuleDelete,
} from '../src/safety.ts';

function config(readOnly = false) {
  return parseConfig({
    auth: { bearerToken: 'x'.repeat(32) },
    safety: { readOnly },
    environments: {
      r: { baseUrl: 'https://r.example.test', mode: 'read' },
      p: { baseUrl: 'https://p.example.test', mode: 'plan', allowEvaluate: false },
      w: { baseUrl: 'https://w.example.test', mode: 'write' },
      d: { baseUrl: 'https://d.example.test', mode: 'write', allowDelete: true, allowRevokingRuleDelete: true },
    },
  });
}

describe('modes and flags', () => {
  const c = config();
  const env = (name: string) => c.environments[name]!;

  it('allows by mode', () => {
    assert.equal(refusalReason(c, 'r', env('r'), 'read'), undefined);
    assert.match(refusalReason(c, 'r', env('r'), 'plan')!, /needs mode "plan".*environments\.r\.mode is "read"/);
    assert.match(refusalReason(c, 'r', env('r'), 'write')!, /needs mode "write"/);
    assert.equal(refusalReason(c, 'p', env('p'), 'plan'), undefined);
    assert.match(refusalReason(c, 'p', env('p'), 'write')!, /environments\.p\.mode is "plan"/);
    assert.equal(refusalReason(c, 'w', env('w'), 'write'), undefined);
    assert.equal(refusalReason(c, 'r', env('r'), 'none'), undefined);
  });

  it('evaluate follows allowEvaluate, whatever the mode', () => {
    assert.equal(refusalReason(c, 'r', env('r'), 'evaluate'), undefined);
    assert.match(refusalReason(c, 'p', env('p'), 'evaluate')!, /environments\.p\.allowEvaluate is false/);
  });

  it('delete needs write and allowDelete', () => {
    assert.match(refusalReason(c, 'r', env('r'), 'delete')!, /needs mode "write"/);
    assert.match(refusalReason(c, 'w', env('w'), 'delete')!, /environments\.w\.allowDelete is false/);
    assert.equal(refusalReason(c, 'd', env('d'), 'delete'), undefined);
  });

  it('revoking rule delete needs allowRevokingRuleDelete', () => {
    assert.throws(() => requireRevokingRuleDelete('w', env('w')), /allowRevokingRuleDelete/);
    assert.doesNotThrow(() => requireRevokingRuleDelete('d', env('d')));
  });

  it('safety.readOnly makes every environment read', () => {
    const ro = config(true);
    const d = ro.environments.d!;
    assert.equal(effectiveMode(ro, d), 'read');
    assert.match(refusalReason(ro, 'd', d, 'write')!, /safety\.readOnly is true/);
    assert.match(refusalReason(ro, 'd', d, 'delete')!, /safety\.readOnly is true/);
    assert.equal(refusalReason(ro, 'd', d, 'read'), undefined);
    assert.throws(() => requireAccess(ro, 'd', d, 'plan'), RefusedError);
  });
});

describe('fingerprints', () => {
  it('do not depend on key order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } }), '{"a":{"c":3,"d":[2,{"x":2,"y":1}]},"b":1}');
    assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
    assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
    assert.equal(fingerprint(undefined), fingerprint(null));
  });
});

describe('plans', () => {
  const who = { environment: 'w', sessionId: 's1', kind: 'import' };

  function store() {
    let now = 1_000_000;
    const plans = new PlanStore({ now: () => now });
    return { plans, advance: (ms: number) => (now += ms) };
  }

  it('creates a plan and gets it back', () => {
    const { plans } = store();
    const plan = plans.create({ ...who, items: { a: { id: 1, name: 'A' } }, data: { steps: 1 } });
    assert.match(plan.id, /^[0-9a-f-]{36}$/);
    assert.equal(plan.expiresAt - plan.createdAt, 30 * 60 * 1000);
    const got = plans.get<{ steps: number }>(plan.id, who);
    assert.equal(got.data.steps, 1);
    plans.verify(got, { a: { name: 'A', id: 1 } });
  });

  it('refuses when HelloID changed since the plan', () => {
    const { plans } = store();
    const plan = plans.create({ ...who, items: { a: { id: 1, name: 'A' } }, data: null });
    assert.throws(() => plans.verify(plan, { a: { id: 1, name: 'B' } }), /HelloID changed since the plan \(a\); plan again/);
    // The plan is gone
    assert.throws(() => plans.get(plan.id, who), /there is no plan/);
  });

  it('refuses when an item went away or appeared', () => {
    const { plans } = store();
    const one = plans.create({ ...who, items: { a: 1 }, data: null });
    assert.throws(() => plans.verify(one, {}), /\(a\)/);
    const two = plans.create({ ...who, items: { a: 1 }, data: null });
    assert.throws(() => plans.verify(two, { a: 1, b: 2 }), /\(b\)/);
  });

  it('is applied at most once', () => {
    const { plans } = store();
    const plan = plans.create({ ...who, items: {}, data: null });
    plans.markApplied(plans.get(plan.id, who));
    assert.throws(() => plans.get(plan.id, who), /applied already/);
    assert.throws(() => plans.markApplied(plan), /applied already/);
  });

  it('expires after 30 minutes', () => {
    const { plans, advance } = store();
    const plan = plans.create({ ...who, items: {}, data: null });
    advance(30 * 60 * 1000 - 1);
    assert.doesNotThrow(() => plans.get(plan.id, who));
    advance(1);
    assert.throws(() => plans.get(plan.id, who), /has expired/);
  });

  it('belongs to its environment, kind and MCP session', () => {
    const { plans } = store();
    const plan = plans.create({ ...who, items: {}, data: null });
    assert.throws(() => plans.get(plan.id, { ...who, environment: 'd' }), /is for environment 'w'/);
    assert.throws(() => plans.get(plan.id, { ...who, kind: 'delete' }), /is a import plan, not a delete plan/);
    assert.throws(() => plans.get(plan.id, { ...who, sessionId: 's2' }), /another MCP session/);
    assert.throws(() => plans.get('nope', who), RefusedError);
  });
});

describe('locks', () => {
  it('runs one write at a time per environment', async () => {
    const locks = new EnvironmentLocks();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = locks.run('w', async () => {
      order.push('first start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push('first end');
      return 1;
    });
    const second = locks.run('w', async () => {
      order.push('second');
      return 2;
    });
    const other = locks.run('d', async () => {
      order.push('other env');
      return 3;
    });
    await other;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['first start', 'other env']);
    assert.ok(locks.isBusy('w'));
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first start', 'other env', 'first end', 'second']);
    assert.equal(locks.isBusy('w'), false);
  });

  it('releases the lock when the work fails', async () => {
    const locks = new EnvironmentLocks();
    await assert.rejects(locks.run('w', async () => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(await locks.run('w', async () => 'next'), 'next');
  });
});
