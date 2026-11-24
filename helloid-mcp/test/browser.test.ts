import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { BrowserService } from '../src/helloid/browser.ts';
import { SessionStore } from '../src/helloid/session.ts';
import { silentLogger } from '../src/log.ts';
import { makeClientFactory } from '../src/tools/context.ts';
import { BOOTSTRAP_GATEWAY, type FakeHelloId, SESSION_COOKIE, startFakeHelloId } from './fake-helloid.ts';
import { FakeChrome, makeConfig, removeDir, tempDir } from './helpers.ts';

let fake: FakeHelloId;
let dir: string;

before(async () => {
  fake = await startFakeHelloId();
});
after(() => fake.close());
beforeEach(() => {
  dir = tempDir();
  fake.state.validSession = undefined;
  fake.state.tokenStatus = undefined;
});
afterEach(() => removeDir(dir));

function setup(gatewayUrl: string | null = null, timeoutMs = 2000) {
  const config = makeConfig(fake, dir, {
    training: { baseUrl: fake.portalUrl, gatewayUrl, mode: 'write' },
    acceptance: { baseUrl: 'https://acceptance.example.test', gatewayUrl: null, mode: 'read' },
  });
  const sessions = new SessionStore();
  const chrome = new FakeChrome();
  const clientFor = makeClientFactory(config, sessions);
  const browser = new BrowserService({ config, sessions, driver: chrome, clientFor, logger: silentLogger, pollMs: 5, timeoutMs });
  return { config, sessions, chrome, browser };
}

describe('login', () => {
  it('waits until the user has logged in, then keeps cookies, token and gateway', async () => {
    const { chrome, browser, sessions } = setup();
    chrome.cookies.push({ name: 'ms', value: 'microsoft', domain: '.login.microsoftonline.com', path: '/' });
    const progress: number[] = [];
    chrome.onGetCookies = (calls) => {
      if (calls === 3) chrome.simulateLogin(fake);
    };
    const result = await browser.login('training', { onProgress: (ms) => progress.push(ms) });
    assert.equal(result.environment, 'training');
    assert.equal(result.gateway, BOOTSTRAP_GATEWAY, 'found in the bootstrap');
    assert.ok(result.tokenValidUntil);
    assert.ok(progress.length >= 2, 'progress while waiting');
    assert.deepEqual(chrome.calls.slice(0, 2), ['launch', `openTab training ${fake.portalUrl}/`]);

    const session = sessions.get('training', fake.portalUrl);
    assert.ok(session.loggedIn);
    assert.ok(fake.state.issued.has(session.token!));
    const names = session.jar.all().map((c) => c.name);
    assert.ok(names.includes(SESSION_COOKIE));
    assert.ok(!names.includes('ms'), 'cookies of other hosts are not kept');
    assert.ok(names.includes('fake_rotated'), 'Set-Cookie of the portal is kept');
  });

  it('uses gatewayUrl from the config', async () => {
    const { chrome, browser } = setup(fake.gatewayUrl);
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    const bootstraps = () => fake.state.portalRequests.filter((r) => r.path === '/server/v2/bootstrap/provisioning').length;
    const before = bootstraps();
    const result = await browser.login('training');
    assert.equal(result.gateway, fake.gatewayUrl);
    assert.equal(bootstraps(), before, 'the bootstrap was not asked');
  });

  it('times out with a clear message', async () => {
    const { browser, sessions } = setup(null, 50);
    await assert.rejects(browser.login('training'), /timed out after .*Log in in the Chrome window, then call helloid_login again/);
    assert.equal(sessions.get('training', fake.portalUrl).loggedIn, false);
  });

  it('stops when Chrome is closed during the login', async () => {
    const { chrome, browser } = setup();
    chrome.onGetCookies = (calls) => {
      if (calls === 2) setImmediate(() => chrome.simulateUserClose());
    };
    await assert.rejects(browser.login('training'), /Chrome was closed before the login to 'training' finished/);
  });

  it('stops when the caller cancels', async () => {
    const { browser } = setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled by the caller')), 20);
    await assert.rejects(browser.login('training', { signal: controller.signal }), /cancelled by the caller/);
  });

  it('runs one login per environment at a time', async () => {
    const { chrome, browser } = setup(fake.gatewayUrl);
    chrome.onGetCookies = (calls) => {
      if (calls === 2) chrome.simulateLogin(fake);
    };
    const [a, b] = await Promise.all([browser.login('training'), browser.login('training')]);
    assert.deepEqual(a, b);
    assert.equal(chrome.calls.filter((c) => c.startsWith('openTab')).length, 1);
  });

  it('retries the gateway lookup while the portal still redirects it right after the login', async () => {
    const { chrome, browser, sessions } = setup();
    fake.state.bootstrapRedirects = 2;
    try {
      chrome.onGetCookies = () => chrome.simulateLogin(fake);
      const bootstraps = () => fake.state.portalRequests.filter((r) => r.path === '/server/v2/bootstrap/provisioning').length;
      const before = bootstraps();
      const result = await browser.login('training');
      assert.equal(result.gateway, BOOTSTRAP_GATEWAY);
      assert.equal(bootstraps() - before, 3, 'two redirects, then the answer');
      assert.ok(sessions.get('training', fake.portalUrl).loggedIn);
    } finally {
      fake.state.bootstrapRedirects = 0;
    }
  });

  it('fails when no gateway is found, and forgets the half session', async () => {
    const { chrome, browser, sessions } = setup();
    fake.state.bootstrapGateway = 'https://cdn-only.example.test';
    try {
      chrome.onGetCookies = () => chrome.simulateLogin(fake);
      await assert.rejects(browser.login('training'), /Set gatewayUrl for 'training'/);
      assert.equal(sessions.get('training', fake.portalUrl).state, 'logged-out');
    } finally {
      fake.state.bootstrapGateway = BOOTSTRAP_GATEWAY;
    }
  });
});

describe('chrome.closeAfterLogin', () => {
  function setupClosing(closeAfterLogin: boolean | undefined) {
    const chromeConfig: Record<string, unknown> = { executablePath: 'C:\\chrome.exe', profileDir: `${dir}\\profile` };
    if (closeAfterLogin !== undefined) chromeConfig.closeAfterLogin = closeAfterLogin;
    const config = makeConfig(
      fake,
      dir,
      {
        training: { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl, mode: 'write' },
        other: { baseUrl: fake.portalUrl.replace('127.0.0.1', 'localhost'), gatewayUrl: fake.gatewayUrl, mode: 'read' },
      },
      { chrome: chromeConfig },
    );
    const sessions = new SessionStore();
    const chrome = new FakeChrome();
    const clientFor = makeClientFactory(config, sessions);
    const browser = new BrowserService({ config, sessions, driver: chrome, clientFor, logger: silentLogger, pollMs: 5, timeoutMs: 2000 });
    return { config, chrome, browser, sessions };
  }

  it('is on by default: Chrome is closed after the login, the session stays', async () => {
    const { config, chrome, browser, sessions } = setupClosing(undefined);
    assert.equal(config.chrome.closeAfterLogin, true);
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    await browser.login('training');
    assert.equal(chrome.calls.at(-1), 'close');
    assert.equal(chrome.isOpen(), false);
    assert.ok(sessions.get('training', fake.portalUrl).loggedIn);
  });

  it('keeps Chrome open when set to false', async () => {
    const { chrome, browser } = setupClosing(false);
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    await browser.login('training');
    assert.ok(!chrome.calls.includes('close'));
    assert.equal(chrome.isOpen(), true);
  });

  it('keeps Chrome open while a login to another environment is still waiting', async () => {
    const { chrome, browser } = setupClosing(true);
    // "other" is the same fake portal under another host name, so it has no cookies until it gets its own
    const otherLogin = browser.login('other');
    await new Promise((resolve) => setTimeout(resolve, 20));
    chrome.simulateLogin(fake);
    await browser.login('training');
    assert.ok(!chrome.calls.includes('close'), 'not closed while "other" is still running');
    chrome.cookies.push({ name: SESSION_COOKIE, value: 'session-1', domain: 'localhost', path: '/', expires: -1, httpOnly: true });
    await otherLogin;
    assert.equal(chrome.calls.filter((c) => c === 'close').length, 1, 'closed after the last login');
  });

  it('a failure to close does not fail the login', async () => {
    const { chrome, browser, sessions } = setupClosing(true);
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    chrome.close = async () => {
      throw new Error('cannot close');
    };
    const result = await browser.login('training');
    assert.equal(result.environment, 'training');
    assert.ok(sessions.get('training', fake.portalUrl).loggedIn);
  });
});

describe('login settings: identity provider and username', () => {
  function setupLogin(login: Record<string, unknown> | undefined) {
    const config = makeConfig(fake, dir, {
      training: { baseUrl: fake.portalUrl, gatewayUrl: fake.gatewayUrl, mode: 'write', ...(login ? { login } : {}) },
    });
    const sessions = new SessionStore();
    const chrome = new FakeChrome();
    const clientFor = makeClientFactory(config, sessions);
    const browser = new BrowserService({ config, sessions, driver: chrome, clientFor, logger: silentLogger, pollMs: 5, timeoutMs: 2000 });
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    return { chrome, browser };
  }
  const signInRequests = () => fake.state.portalRequests.filter((r) => r.path === '/Authentication/SignIn');

  it('without login settings opens the portal and does not read the sign-in page', async () => {
    const { chrome, browser } = setupLogin(undefined);
    const before = signInRequests().length;
    await browser.login('training');
    assert.deepEqual(chrome.calls.slice(0, 2), ['launch', `openTab training ${fake.portalUrl}/`]);
    assert.equal(signInRequests().length, before);
  });

  it('opens the configured provider directly (case-insensitive), without cookies on the sign-in request', async () => {
    const { chrome, browser } = setupLogin({ provider: '  local ' });
    const before = fake.state.portalRequests.length;
    await browser.login('training');
    assert.equal(chrome.calls[1], `openTab training ${fake.portalUrl}/authentication/admlogin?returnUrl=%2F`);
    const pageRequests = fake.state.portalRequests.slice(before).filter((r) => r.path === '/' || r.path === '/Authentication/SignIn');
    assert.deepEqual(pageRequests.map((r) => r.path), ['/', '/Authentication/SignIn'], 'redirect followed');
    assert.ok(pageRequests.every((r) => r.headers.cookie === undefined && r.headers.authorization === undefined));
  });

  it('adds the username to the provider link', async () => {
    const { chrome, browser } = setupLogin({ provider: 'AD - FAKE.LOCAL', username: 'someone@fake.example.test' });
    await browser.login('training');
    assert.equal(
      chrome.calls[1],
      `openTab training ${fake.portalUrl}/directoryauthentication/login/0a1b2c3d-0000-4000-8000-00000000a1b2` +
        '?returnUrl=%2F&username=someone%40fake.example.test',
    );
  });

  it('adds the username to the sign-in page when no provider is set', async () => {
    const { chrome, browser } = setupLogin({ username: 'someone@fake.example.test' });
    await browser.login('training');
    assert.equal(
      chrome.calls[1],
      `openTab training ${fake.portalUrl}/Authentication/SignIn?ReturnUrl=%2F&username=someone%40fake.example.test`,
    );
  });

  it('fails when the provider is not on the sign-in page, listing the names, without opening Chrome', async () => {
    const { chrome, browser } = setupLogin({ provider: 'Contoso' });
    await assert.rejects(
      browser.login('training'),
      /The identity provider 'Contoso' .* is not on the sign-in page\. Available: 'AD - fake\.local', 'Contoso & Partners', 'Local'\./,
    );
    assert.deepEqual(chrome.calls, []);
  });

  it('fails clearly when the sign-in page cannot be read, without opening Chrome', async () => {
    const { chrome, browser } = setupLogin({ provider: 'Local' });
    fake.state.signInStatus = 500;
    try {
      await assert.rejects(browser.login('training'), /Cannot read the identity providers of 'training': .*answered 500/);
      assert.deepEqual(chrome.calls, []);
    } finally {
      fake.state.signInStatus = undefined;
    }
  });
});

describe('show, hide, close', () => {
  it('show starts Chrome again with the cookies and one tab per logged-in environment', async () => {
    const { chrome, browser } = setup(fake.gatewayUrl);
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    await browser.login('training');
    chrome.onGetCookies = undefined;
    assert.equal(await browser.close(), true);
    assert.equal(chrome.isOpen(), false);
    chrome.cookies = []; // a profile without the cookies
    chrome.calls = [];

    const result = await browser.show();
    assert.deepEqual(result, { launched: true, tabsOpened: ['training'] });
    assert.equal(chrome.calls[0], 'launch');
    assert.match(chrome.calls[1]!, new RegExp(`^setCookies .*${SESSION_COOKIE}`));
    assert.equal(chrome.calls[2], `openTab training ${fake.portalUrl}/`);
    assert.equal(chrome.calls.at(-1), 'showWindow');
    assert.ok(chrome.cookies.some((c) => c.name === SESSION_COOKIE));
  });

  it('show on an open Chrome only restores the window', async () => {
    const { chrome, browser } = setup();
    await browser.show();
    chrome.calls = [];
    await browser.hide();
    assert.equal(chrome.minimized, true);
    const result = await browser.show();
    assert.deepEqual(result, { launched: false, tabsOpened: [] });
    assert.deepEqual(chrome.calls, ['minimizeWindow', 'showWindow']);
    assert.equal(chrome.minimized, false);
  });

  it('hide and close when Chrome is not open', async () => {
    const { chrome, browser } = setup();
    assert.equal(await browser.hide(), false);
    assert.equal(await browser.close(), false);
    assert.deepEqual(chrome.calls, []);
  });

  it('keeps the sessions when the user closes Chrome', async () => {
    const { chrome, browser, sessions } = setup(fake.gatewayUrl);
    chrome.onGetCookies = () => chrome.simulateLogin(fake);
    await browser.login('training');
    chrome.simulateUserClose();
    assert.equal(browser.isOpen, false);
    assert.ok(sessions.get('training', fake.portalUrl).loggedIn);
  });
});
