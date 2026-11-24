import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import {
  HelloIdClient,
  HelloIdHttpError,
  NotLoggedInError,
  requestToken,
  SessionExpiredError,
} from '../src/helloid/client.ts';
import { CookieJar, EnvironmentSession } from '../src/helloid/session.ts';
import { BOOTSTRAP_GATEWAY, type FakeHelloId, SESSION_COOKIE, startFakeHelloId } from './fake-helloid.ts';

let fake: FakeHelloId;

before(async () => {
  fake = await startFakeHelloId();
  fake.route('GET', '/service/test/items', () => ({ body: { pageData: [{ id: 1 }], totalRowCount: 1 } }));
  fake.route('POST', '/service/test/echo', (request) => ({ body: { got: request.json } }));
  fake.route('GET', '/service/test/fail', () => ({ status: 500, body: { message: 'Something broke' } }));
});
after(() => fake.close());

beforeEach(() => {
  fake.state.validSession = 'valid';
  fake.state.tokenStatus = undefined;
  fake.state.tokenLifetimeSeconds = 3600;
  fake.state.portalRequests.length = 0;
  fake.state.gatewayRequests.length = 0;
  fake.state.tokensIssued = 0;
});

function environment(gatewayUrl: string | null = null) {
  return parseConfig({
    auth: { bearerToken: 'x'.repeat(32) },
    environments: { training: { baseUrl: fake.portalUrl, gatewayUrl, mode: 'write' } },
  }).environments.training!;
}

/** A logged-in session with a token from the fake. */
function loggedIn(tokenLifetime = 3600) {
  const config = environment(fake.gatewayUrl);
  const session = new EnvironmentSession('training', config.baseUrl);
  session.establish(
    [{ name: SESSION_COOKIE, value: 'valid', domain: '127.0.0.1', path: '/' }],
    fake.issueToken(tokenLifetime),
    fake.gatewayUrl,
  );
  return { session, client: new HelloIdClient('training', config, session) };
}

describe('requestToken', () => {
  it('gets the token with the cookies and keeps Set-Cookie', async () => {
    const jar = new CookieJar();
    jar.replace([{ name: SESSION_COOKIE, value: 'valid', domain: '127.0.0.1', path: '/' }], '127.0.0.1');
    const result = await requestToken(fake.portalUrl, jar);
    assert.equal(result.status, 200);
    assert.ok(fake.state.issued.has(result.token!), 'the helloid.services token was picked');
    const request = fake.state.portalRequests.at(-1)!;
    assert.match(request.query.get('cachebust') ?? '', /^\d+$/);
    assert.equal(request.headers.accept, 'application/json, text/plain, */*');
    assert.ok(jar.all().some((c) => c.name === 'fake_rotated'));
  });

  it('reports the status when not logged in', async () => {
    const result = await requestToken(fake.portalUrl, new CookieJar());
    assert.deepEqual(result, { status: 401 });
  });
});

describe('gateway requests', () => {
  it('sends Bearer, Accept and Origin, and parses JSON', async () => {
    const { client, session } = loggedIn();
    const data = await client.gatewayJson<{ totalRowCount: number }>({ path: '/service/test/items', query: { take: 999999 } });
    assert.equal(data.totalRowCount, 1);
    const request = fake.state.gatewayRequests.at(-1)!;
    assert.equal(request.headers.authorization, `Bearer ${session.token}`);
    assert.equal(request.headers.origin, fake.portalUrl);
    assert.equal(request.headers.accept, 'application/json, text/plain, */*');
    assert.equal(request.query.get('take'), '999999');
    assert.equal(fake.state.tokensIssued, 0, 'no renewal needed');
  });

  it('sends JSON bodies', async () => {
    const { client } = loggedIn();
    const data = await client.gatewayJson<{ got: unknown }>({ method: 'POST', path: '/service/test/echo', body: { a: 1 } });
    assert.deepEqual(data.got, { a: 1 });
    assert.equal(fake.state.gatewayRequests.at(-1)!.headers['content-type'], 'application/json');
  });

  it('renews the token when it expires within 2 minutes', async () => {
    const { client, session } = loggedIn(60);
    const old = session.token;
    await client.gateway({ path: '/service/test/items' });
    assert.equal(fake.state.tokensIssued, 1);
    assert.notEqual(session.token, old);
    assert.equal(fake.state.gatewayRequests.at(-1)!.headers.authorization, `Bearer ${session.token}`);
    // The portal's Set-Cookie updated the in-memory cookies
    assert.ok(session.jar.all().some((c) => c.name === 'fake_rotated' && c.value === '1'));
  });

  it('renews once on a 401 and retries once', async () => {
    const { client, session } = loggedIn();
    fake.state.revoked.add(session.token!);
    await client.gateway({ path: '/service/test/items' });
    assert.equal(fake.state.tokensIssued, 1);
    assert.equal(fake.state.gatewayRequests.length, 2);
  });

  it('does not retry a second 401', async () => {
    const { client } = loggedIn();
    let calls = 0;
    fake.route('GET', '/service/test/always401', () => {
      calls++;
      return { status: 401, body: '' };
    });
    await assert.rejects(client.gateway({ path: '/service/test/always401' }), (error: unknown) => {
      assert.ok(error instanceof HelloIdHttpError);
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(fake.state.tokensIssued, 1);
  });

  it('marks the session expired when the token cannot be renewed', async () => {
    const { client, session } = loggedIn();
    fake.state.revoked.add(session.token!);
    fake.state.validSession = undefined; // the portal session has ended
    await assert.rejects(client.gateway({ path: '/service/test/items' }), (error: unknown) => {
      assert.ok(error instanceof SessionExpiredError);
      assert.match(error.message, /call helloid_login/);
      assert.match(error.message, /401/);
      return true;
    });
    assert.equal(session.state, 'expired');
    // Later calls say so without asking HelloID
    const before = fake.state.gatewayRequests.length;
    await assert.rejects(client.gateway({ path: '/service/test/items' }), SessionExpiredError);
    assert.equal(fake.state.gatewayRequests.length, before);
  });

  it('shares one renewal between concurrent calls', async () => {
    const { client } = loggedIn(30);
    await Promise.all([1, 2, 3].map(() => client.gateway({ path: '/service/test/items' })));
    assert.equal(fake.state.tokensIssued, 1);
  });

  it('refuses without a session', async () => {
    const config = environment(fake.gatewayUrl);
    const client = new HelloIdClient('training', config, new EnvironmentSession('training', config.baseUrl));
    await assert.rejects(client.gateway({ path: '/service/test/items' }), (error: unknown) => {
      assert.ok(error instanceof NotLoggedInError);
      assert.match(error.message, /Not logged in to 'training': call helloid_login/);
      return true;
    });
  });

  it('throws HelloIdHttpError with an excerpt for other statuses, without tokens', async () => {
    const { client } = loggedIn();
    fake.route('GET', '/service/test/leaky', (request) => ({ status: 400, body: `bad ${request.headers.authorization}` }));
    await assert.rejects(client.gateway({ path: '/service/test/fail' }), /HelloID answered 500 for GET \/service\/test\/fail: .*Something broke/);
    await assert.rejects(client.gateway({ path: '/service/test/leaky' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /eyJ/);
      return true;
    });
  });
});

describe('gateway discovery', () => {
  it('uses the bootstrap when gatewayUrl is not set', async () => {
    const config = environment(null);
    const session = new EnvironmentSession('training', config.baseUrl);
    session.jar.replace([{ name: SESSION_COOKIE, value: 'valid', domain: '127.0.0.1', path: '/' }], '127.0.0.1');
    const client = new HelloIdClient('training', config, session);
    assert.equal(await client.discoverGateway(), BOOTSTRAP_GATEWAY);
    assert.equal(fake.state.portalRequests.at(-1)!.path, '/server/v2/bootstrap/provisioning');
  });

  it('prefers gatewayUrl from the config', async () => {
    const config = environment('https://configured-gateway.example.test');
    const client = new HelloIdClient('training', config, new EnvironmentSession('training', config.baseUrl));
    assert.equal(await client.discoverGateway(), 'https://configured-gateway.example.test');
    assert.equal(fake.state.portalRequests.length, 0);
  });

  it('says to set gatewayUrl when the bootstrap names none', async () => {
    const config = environment(null);
    const client = new HelloIdClient('training', config, new EnvironmentSession('training', config.baseUrl));
    await assert.rejects(client.discoverGateway(), /Set gatewayUrl for 'training' in config\.json/);
  });
});
