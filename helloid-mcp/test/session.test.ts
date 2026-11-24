import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CookieJar,
  domainMatches,
  EnvironmentSession,
  findGatewayOrigin,
  parseSetCookie,
  pickToken,
  SessionStore,
  tokenExpiry,
} from '../src/helloid/session.ts';
import { makeJwt } from './fake-helloid.ts';

describe('cookies', () => {
  it('matches domains', () => {
    assert.ok(domainMatches('a.example.test', 'a.example.test'));
    assert.ok(!domainMatches('b.a.example.test', 'a.example.test'));
    assert.ok(domainMatches('b.a.example.test', '.a.example.test'));
    assert.ok(domainMatches('a.example.test', '.a.example.test'));
    assert.ok(!domainMatches('login.microsoftonline.com', '.example.test'));
  });

  it('keeps only the cookies of the host', () => {
    const jar = new CookieJar();
    jar.replace(
      [
        { name: 'a', value: '1', domain: 'portal.example.test', path: '/' },
        { name: 'b', value: '2', domain: '.example.test', path: '/' },
        { name: 'ms', value: '3', domain: '.login.microsoftonline.com', path: '/' },
      ],
      'portal.example.test',
    );
    assert.deepEqual(
      jar.all().map((c) => c.name),
      ['a', 'b'],
    );
  });

  it('builds the Cookie header by path, secure and expiry', () => {
    let now = Date.UTC(2026, 0, 1);
    const jar = new CookieJar(() => now);
    jar.replace(
      [
        { name: 'root', value: 'r', domain: 'portal.example.test', path: '/' },
        { name: 'srv', value: 's', domain: 'portal.example.test', path: '/server' },
        { name: 'other', value: 'o', domain: 'portal.example.test', path: '/other' },
        { name: 'sec', value: 'x', domain: 'portal.example.test', path: '/', secure: true },
        { name: 'old', value: 'y', domain: 'portal.example.test', path: '/', expires: now / 1000 + 10 },
      ],
      'portal.example.test',
    );
    assert.equal(jar.headerFor('https://portal.example.test/server/v2/security/token'), 'srv=s; root=r; sec=x; old=y');
    assert.equal(jar.headerFor('http://portal.example.test/server/x'), 'srv=s; root=r; old=y');
    assert.equal(jar.headerFor('https://portal.example.test/serverless'), 'root=r; sec=x; old=y');
    now += 20_000;
    assert.equal(jar.headerFor('https://portal.example.test/'), 'root=r; sec=x');
    assert.equal(jar.headerFor('https://elsewhere.example.test/'), undefined);
  });

  it('applies Set-Cookie: add, replace, remove', () => {
    const now = Date.UTC(2026, 0, 1);
    const jar = new CookieJar(() => now);
    const url = 'https://portal.example.test/server/v2/security/token';
    jar.applySetCookie(url, ['a=1; Path=/; HttpOnly; Secure; SameSite=Lax', 'b=2; Path=/', 'c=3; Max-Age=60']);
    assert.equal(jar.size, 3);
    jar.applySetCookie(url, ['a=changed; Path=/', 'b=; Path=/; Max-Age=0']);
    const cookies = jar.all();
    assert.equal(cookies.find((c) => c.name === 'a')?.value, 'changed');
    assert.equal(cookies.find((c) => c.name === 'b'), undefined);
    // Default path is the directory of the request
    assert.equal(cookies.find((c) => c.name === 'c')?.path, '/server/v2/security');
    jar.applySetCookie(url, ['a=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    assert.equal(jar.all().find((c) => c.name === 'a'), undefined);
  });

  it('ignores Set-Cookie for another domain', () => {
    const url = new URL('https://portal.example.test/');
    assert.equal(parseSetCookie('a=1; Domain=evil.test', url, Date.now()), undefined);
    assert.equal(parseSetCookie('a=1; Domain=example.test', url, Date.now())?.domain, '.example.test');
    assert.equal(parseSetCookie('novalue', url, Date.now()), undefined);
  });
});

describe('token and gateway', () => {
  it('picks the token for helloid.services, else the first', () => {
    const other = makeJwt({ aud: 'other' });
    const services = makeJwt({ aud: 'helloid.services', exp: 2_000_000_000 });
    assert.equal(pickToken(JSON.stringify({ a: other, b: services })), services);
    assert.equal(pickToken(`"${other}"`), other);
    assert.equal(pickToken(JSON.stringify({ x: [makeJwt({ aud: ['x', 'helloid.services'] })] })), makeJwt({ aud: ['x', 'helloid.services'] }));
    assert.equal(pickToken('no token here'), undefined);
    assert.equal(tokenExpiry(services), 2_000_000_000_000);
    assert.equal(tokenExpiry(other), undefined);
  });

  it('finds the gateway in the bootstrap', () => {
    const text = '{"cdn":"https:\\/\\/cdn.example.test\\/a","api":"https:\\/\\/provisioning-gateway-xx.example.test\\/api","other":"https://gateway2.example.test"}';
    assert.equal(findGatewayOrigin(text), 'https://provisioning-gateway-xx.example.test');
    assert.equal(findGatewayOrigin('{"api":"http://gateway.example.test"}'), undefined);
    assert.equal(findGatewayOrigin('{}'), undefined);
  });
});

describe('environment session', () => {
  it('establishes, expires and forgets', () => {
    const store = new SessionStore();
    const session = store.get('training', 'https://portal.example.test');
    assert.equal(store.get('training', 'https://portal.example.test'), session);
    assert.equal(session.state, 'logged-out');
    const token = makeJwt({ aud: 'helloid.services', exp: 2_000_000_000 });
    session.establish([{ name: 'a', value: '1', domain: 'portal.example.test', path: '/' }], token, 'https://gw.example.test');
    assert.ok(session.loggedIn);
    assert.deepEqual(store.loggedIn(), [session]);
    assert.equal(session.tokenExpires, 2_000_000_000_000);
    session.expire();
    assert.equal(session.state, 'expired');
    assert.equal(session.token, undefined);
    session.forget();
    assert.equal(session.state, 'logged-out');
    assert.equal(session.jar.size, 0);
    assert.ok(new EnvironmentSession('x', 'https://a.example.test').host === 'a.example.test');
  });
});
