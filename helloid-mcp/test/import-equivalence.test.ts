// The server's import against the userscript's own import code (run in Node, see
// userscript-harness.ts), for the same files and the same fake HelloID: the same overview (per item
// the status, label and details), the same special cases (keys and defaults), and on apply the same
// requests in the same order, with the same bodies, and the same overview after the run.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { localTimeZone } from '../src/helloid/exports.ts';
import { makeEnv, type OverviewEntry, type PlannerGateway } from '../src/planners/common.ts';
import { classifyFiles, planImport, runImport } from '../src/planners/index.ts';
import { type FakeHelloId, startFakeHelloId } from './fake-helloid.ts';
import { type Fixture, IDS, installFixtures, loadFixture } from './fixture-routes.ts';
import * as files from './import-files.ts';
import { installImportRoutes, writes } from './import-routes.ts';
import { runUserscriptImport } from './userscript-harness.ts';

let fake: FakeHelloId;
let token: string;
before(async () => {
  fake = await startFakeHelloId();
  token = fake.issueToken(3600);
});
after(() => fake.close());

const counter = () => {
  let n = 0;
  return () => `e0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};

/** A fresh HelloID state, the same for both sides. */
function freshState(change: (data: Fixture) => void = () => {}): Fixture {
  const data = loadFixture();
  installFixtures(fake, data);
  installImportRoutes(fake, data);
  change(data);
  fake.state.gatewayRequests = [];
  return data;
}

/** The same requests as the userscript sends them (fetchFromGateway, sendToGateway). */
function rawGateway(): PlannerGateway {
  const headers = (json: boolean) => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/plain, */*',
    Origin: fake.portalUrl,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  return {
    async fetch(path) {
      const response = await fetch(fake.gatewayUrl + path, { headers: headers(false) });
      if (!response.ok) throw new Error(`HelloID answered ${response.status} for ${path}`);
      return response.json();
    },
    async send(path, method, body) {
      const response = await fetch(fake.gatewayUrl + path, { method, headers: headers(body !== undefined), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new Error(`HelloID answered ${response.status} for ${method} ${path}` + (detail ? `\n${detail}` : ''));
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

const snapshot = (entries: OverviewEntry[]) => entries.map((e) => ({ group: e.group, label: e.label, status: e.status, details: [...e.details] }));

async function runServer(input: any[], answers: Record<string, unknown>, confirm: boolean) {
  const clock = { now: Date.parse('2026-11-19T12:00:00Z') };
  const env = makeEnv(rawGateway(), fake.portalUrl, localTimeZone(), {
    uuid: counter(),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  const { files: classified, kinds } = classifyFiles(files.asInput(input), env);
  const { entries, decisions } = await planImport(env, { files: classified, kinds }, answers);
  const planned = snapshot(entries);
  if (confirm) await runImport(entries);
  return { planned, after: snapshot(entries), decisions: decisions.map((d) => ({ key: d.key, default: d.default })) };
}

/** Both sides on the same state; their overviews, choices, requests and the state after. */
async function compare(name: string, build: (data: Fixture) => any[], options: { answers?: Record<string, unknown>; change?: (data: Fixture) => void } = {}) {
  const answers = options.answers ?? {};
  let last: { server: Awaited<ReturnType<typeof runServer>>; writes: string[] } | undefined;
  for (const confirm of [false, true]) {
    const userscriptData = freshState(options.change);
    const input = build(userscriptData);
    const userscript = await runUserscriptImport(
      files.asInput(input).map((f) => ({ name: f.name, text: JSON.stringify(f.content) })),
      { gatewayUrl: fake.gatewayUrl, portalUrl: fake.portalUrl, token, answers, confirm, uuid: counter(), clock: { now: Date.parse('2026-11-19T12:00:00Z') } },
    );
    const userscriptWrites = writes(fake.state.gatewayRequests);

    const serverData = freshState(options.change);
    const server = await runServer(build(serverData), answers, confirm);
    const serverWrites = writes(fake.state.gatewayRequests);
    last = { server, writes: serverWrites };

    assert.deepEqual(server.planned, userscript.planned, `${name}: the overview differs`);
    if (userscript.decisions.length) assert.deepEqual(server.decisions, userscript.decisions, `${name}: the special cases differ`);
    if (confirm) {
      assert.deepEqual(serverWrites, userscriptWrites, `${name}: the requests differ`);
      assert.deepEqual(server.after, userscript.after, `${name}: the overview after the run differs`);
      assert.deepEqual(serverData, userscriptData, `${name}: HelloID differs after the run`);
    } else {
      assert.deepEqual(serverWrites, [], `${name}: the plan wrote something`);
      assert.deepEqual(userscriptWrites, [], `${name}: the userscript's plan wrote something`);
    }
  }
  return last!;
}

describe('equivalence with the userscript (its own code, run in Node)', () => {
  it('target systems: overwrite with masked secrets, a new one depending on one by name', async () => {
    await compare('target systems', (data) => [files.alphaFile(data), files.deltaFile()]);
  });

  it('target systems: a partial file', async () => {
    const out = await compare('partial', () => [files.partialAlphaFile()]);
    assert.ok(out.writes.some((w) => w.includes('"serviceUser":"svc-alpha-2"') && w.includes('"clientSecret":"alpha-client-secret-value"')));
  });

  it('target systems: the dependency by name left out', async () => {
    await compare('target systems, left out', () => [files.deltaFile()], {
      answers: { [`dependsByName:${files.OTHER.delta}`]: 'alternative' },
    });
  });

  it('pending items: notifications, rules and reconciliation with a target system made in the run', async () => {
    await compare('pending', (data) => [files.deltaFile(), files.deltaNotificationsFile(), files.ruleWithDeltaFile(data), files.reconciliationFile(data)]);
  });

  it('target systems: rule links, retrieving a permission that is not there yet, entitlements the file does not have', async () => {
    const kept = await compare('rule links', (data) => [files.alphaWithRulesFile(data)]);
    const details = kept.server.planned[0]!.details.join('\n');
    assert.match(details, /lets HelloID retrieve the permissions of the system now/);
    assert.match(details, /\+ "Empty rule": permission "Group Sales" \(Groups\)/);
    assert.ok(kept.server.decisions.some((d) => d.key === `ruleRemovals:${IDS.alpha}`));
    assert.ok(kept.writes.some((w) => w.includes('snapshots/create/') && w.includes('permissionsOnly=true')));
    assert.equal(kept.server.after[0]!.status, 'done');
    const out = await compare('rule links, taken out', (data) => [files.alphaWithRulesFile(data)], { answers: { [`ruleRemovals:${IDS.alpha}`]: 'alternative' } });
    assert.match(out.server.planned[0]!.details.join('\n'), /- "Employees get Alpha": account/);
  });

  it('pending items: a notification of a notification system made in the run', async () => {
    await compare('notification system', () => files.teamsFiles());
  });

  it('notifications: overwrite with a masked template secret; refused and same ones', async () => {
    await compare('notifications', (data) => [files.alphaNotificationFile(data), files.deltaNotificationsFile()]);
  });

  it('source systems: overwrite by name with masked secrets', async () => {
    await compare('source system', (data) => [files.sourceFile(data)]);
  });

  it('items: same rule (empty source system ID), new rule with left-out entitlements, custom event, toxic policy', async () => {
    await compare('items', (data) => [files.sameRuleFile(data), files.newRuleFile(), files.customEventFile(), files.toxicFile(data)]);
  });

  it('schedules: more than HelloID allows, with the default choices and with a replacement', async () => {
    const build = () => [files.scheduleFile(1), files.scheduleFile(2), files.scheduleFile(3)];
    await compare('schedules', build);
    await compare('schedules, replace', build, {
      answers: { [`limit:schedule:${files.OTHER.newSchedule(3)}`]: 'replace:cccccccc-cccc-4ccc-8ccc-ccccccccccc1' },
    });
  });

  it('settings pages, with the custom field kept', async () => {
    await compare('settings', (data) => files.settingFiles(data));
    await compare('settings, keep', (data) => files.settingFiles(data), { answers: { 'sourceConfiguration:removeFields': false } });
  });

  it('a backup with several parts, and files that are skipped', async () => {
    await compare('backup', (data) => [
      { exportedAt: 'x', contents: 'backups', files: [files.sameRuleFile(data), files.customEventFile(), { contents: 'unknown' }] },
      { contents: 'sourceSystem', system: {} },
      files.toxicFile(data),
    ]);
  });

  it('a failure stops what needs it', async () => {
    await compare('failure', () => [files.deltaFile(), files.deltaNotificationsFile()], {
      change: () => {
        fake.route('POST', '/connector/powershell-target/api/configuration/create/powershell-target', () => ({ status: 500, body: 'broken' }));
      },
    });
  });
});
