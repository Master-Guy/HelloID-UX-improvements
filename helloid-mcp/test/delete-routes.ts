// The gateway routes of the delete tools (helloid_plan_delete, helloid_apply_delete) on the fake
// HelloID: the checks HelloID's pages make before deleting, and the delete requests, which remove
// the item from the fixture (so reading back shows it is gone). Synthetic only; the shapes are
// HelloID's (boolean answers, the snapshot status object, an empty 200 answer for a delete).

import type { FakeHelloId, FakeRequest, FakeResponse } from './fake-helloid.ts';
import type { Fixture } from './fixture-routes.ts';

const ok = (body: unknown = ''): FakeResponse => ({ body });
const notFound: FakeResponse = { status: 404, body: { message: 'Not found' } };
const ID = '([^/]+)';
const exact = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\(ID\\)', ID)}$`);
const idOf = (request: FakeRequest, pattern: RegExp, group = 1) => decodeURIComponent(pattern.exec(request.path)?.[group] ?? '');

/** A snapshot status as HelloID answers it (made-up values). */
export const snapshotStatus = (isBusy = false) => ({
  isBusy,
  isLatestSuccessful: true,
  isLatestCanceled: false,
  hasDataToStartSnapshot: true,
  startTime: '2026-01-20T02:00:00.000Z',
  isScheduled: true,
  systems: [],
});

/** Removes the rows whose key is id; whether one was removed. */
function removeFrom(rows: any[], key: string, id: string): boolean {
  const index = rows.findIndex((r) => r?.[key] === id);
  if (index === -1) return false;
  rows.splice(index, 1);
  return true;
}

/** Installs the delete routes on top of installFixtures (later routes win). */
export function installDeleteRoutes(fake: FakeHelloId, data: Fixture): Fixture {
  const route = (method: string, path: string | RegExp, handler: (request: FakeRequest) => FakeResponse) => fake.route(method, path, handler);
  data.blockedPersons ??= {};
  data.snapshotStatuses ??= {};
  data.customEventUsed ??= {};

  // Checks
  const blocked = exact('/service/provisioning-integration/api/blockedpersons/(ID)/any');
  route('GET', blocked, (r) => ok(data.blockedPersons[idOf(r, blocked)] ?? false));
  route('GET', '/service/provisioning-pipeline/api/snapshot/status', (r) => ok(data.snapshotStatuses[r.query.get('systemId') ?? ''] ?? snapshotStatus()));
  const used = exact('/service/notifications/api/custom-events/(ID)/used');
  route('GET', used, (r) => ok(data.customEventUsed[idOf(r, used)] ?? false));

  // Deletes
  const target = exact('/service/provisioning-api/api/target-systems/(ID)');
  route('DELETE', target, (r) => {
    const id = idOf(r, target);
    if (!removeFrom(data.targetSystems, 'systemId', id)) return notFound;
    delete data.powershellConfigurations?.[id];
    delete data.azureAdConfigurations?.[id];
    return ok();
  });
  const source = exact('/service/provisioning-api/api/source-systems/(ID)');
  route('DELETE', source, (r) => {
    const id = idOf(r, source);
    if (!removeFrom(data.sourceSystems, 'systemId', id)) return notFound;
    delete data.sourceSystemDetails[id];
    return ok();
  });
  const rule = exact('/service/rules/api/rules/(ID)/(ID)');
  route('DELETE', rule, (r) => {
    const id = idOf(r, rule);
    if (!['true', 'false'].includes(idOf(r, rule, 2))) return { status: 400, body: { message: 'Bad request' } };
    if (!removeFrom(data.rulesOverview, 'ruleId', id)) return notFound;
    delete data.rules[id];
    return ok();
  });
  const notification = exact('/service/notifications/api/notifications/(ID)');
  route('DELETE', notification, (r) => {
    const id = idOf(r, notification);
    if (!removeFrom(data.notifications, 'identifier', id)) return notFound;
    delete data.notificationDetails[id];
    return ok();
  });
  const notificationSystem = exact('/service/notifications/api/notification/systems/(ID)');
  route('DELETE', notificationSystem, (r) => {
    const id = idOf(r, notificationSystem);
    if (!removeFrom(data.notificationSystems, 'systemId', id)) return notFound;
    delete data.notificationSystemDetails[id];
    return ok();
  });
  const customEvent = exact('/service/notifications/api/custom-events/(ID)');
  route('DELETE', customEvent, (r) => (removeFrom(data.customEvents, 'customEventId', idOf(r, customEvent)) ? ok() : notFound));
  const toxic = exact('/service/rules/api/toxic-combinations/(ID)');
  route('DELETE', toxic, (r) => (removeFrom(data.toxicCombinations, 'toxicCombinationId', idOf(r, toxic)) ? ok() : notFound));
  return data;
}

/** The delete requests sent, as "DELETE <path>". */
export function deletes(requests: FakeRequest[]): string[] {
  return requests.filter((r) => r.method === 'DELETE').map((r) => `DELETE ${r.path}`);
}
