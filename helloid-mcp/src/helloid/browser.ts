// Chrome: launch, login, show/hide/close, cookies in and out.
//
// ChromeDriver is the low-level interface to one Chrome window (PuppeteerChrome is the real one;
// tests use a fake, so they never start Chrome). BrowserService holds the logic: the interactive
// login, and putting the server's cookies back when Chrome is started again.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, CDPSession } from 'puppeteer-core';
import type { Config } from '../config.ts';
import { errorMessage, type Logger } from '../log.ts';
import { type HelloIdClient, requestToken, type FetchLike } from './client.ts';
import { PORTAL } from './endpoints.ts';
import { type Cookie, CookieJar, domainMatches, type SessionStore } from './session.ts';
import {
  fetchIdentityProviders,
  findIdentityProvider,
  type IdentityProvider,
  providerUrl,
  withUsername,
} from './signin.ts';

/** One Chrome window with one tab per environment. */
export interface ChromeDriver {
  isOpen(): boolean;
  /** Starts Chrome (with the shared profile). */
  launch(): Promise<void>;
  /** Opens the tab of `key` on `url`, or reuses it, and brings the window to the front. */
  openTab(key: string, url: string): Promise<void>;
  /** All cookies of the profile. */
  getCookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  /** Restores the window (not minimized) and focuses it. */
  showWindow(): Promise<void>;
  minimizeWindow(): Promise<void>;
  close(): Promise<void>;
  /** Called when Chrome goes away (closed by the user, crashed, or close()). */
  onDisconnected(listener: () => void): void;
}

/** The real Chrome, controlled over the DevTools Protocol with puppeteer-core. */
export class PuppeteerChrome implements ChromeDriver {
  private browser: Browser | undefined;
  private session: CDPSession | undefined;
  /** Environment key to the tab (target ID) opened for it. */
  private readonly tabs = new Map<string, string>();
  private readonly listeners: Array<() => void> = [];
  private readonly executablePath: string;
  private readonly profileDir: string;

  constructor(options: { executablePath: string; profileDir: string }) {
    this.executablePath = options.executablePath;
    this.profileDir = options.profileDir;
  }

  isOpen(): boolean {
    return this.browser?.connected === true;
  }

  /**
   * Chrome is started as a plain process (no puppeteer.launch), then connected to over the DevTools
   * port. puppeteer.launch adds --enable-automation and many --disable-* flags; pages then see
   * navigator.webdriver, and the Cloudflare check in login extensions (Dashlane) refuses to run.
   */
  async launch(): Promise<void> {
    if (this.isOpen()) return;
    mkdirSync(this.profileDir, { recursive: true });
    const portFile = join(this.profileDir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    const child = spawn(
      this.executablePath,
      [
        `--user-data-dir=${this.profileDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: 'ignore', detached: false, windowsHide: false },
    );
    let exited: Error | undefined;
    child.once('error', (error) => (exited = error));
    child.once('exit', (code) => (exited ??= new Error(`Chrome exited (code ${code}) before it could be connected to.`)));
    const deadline = Date.now() + 30_000;
    let endpoint: string | undefined;
    while (!endpoint) {
      if (exited) throw exited;
      if (Date.now() > deadline) throw new Error('Chrome did not open its DevTools port within 30 seconds.');
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
        if (port && path) endpoint = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
      }
      if (!endpoint) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      defaultViewport: null,
      // Attach to no tab, frame or extension page: only the browser itself. A page with DevTools
      // attached is spotted by the Cloudflare check in login extensions (Dashlane), which then
      // refuses to run. Tabs, window and cookies are all handled from the browser session below.
      targetFilter: (target) => target.type() === 'browser',
    });
    this.browser = browser;
    this.session = await browser.target().createCDPSession();
    browser.on('disconnected', () => {
      if (this.browser !== browser) return;
      this.browser = undefined;
      this.session = undefined;
      this.tabs.clear();
      for (const listener of this.listeners) listener();
    });
  }

  private requireSession(): CDPSession {
    if (!this.browser?.connected || !this.session) throw new Error('Chrome is not open.');
    return this.session;
  }

  /** The IDs of the open tabs (normal pages, not extension pages). */
  private async pageTargets(): Promise<Array<{ targetId: string; url: string }>> {
    const { targetInfos } = await this.requireSession().send('Target.getTargets');
    return targetInfos
      .filter((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
      .map((t) => ({ targetId: t.targetId, url: t.url }));
  }

  private async anyTab(): Promise<string> {
    const open = await this.pageTargets();
    const ids = new Set(open.map((t) => t.targetId));
    const own = [...this.tabs.values()].find((id) => ids.has(id));
    if (own) return own;
    if (open[0]) return open[0].targetId;
    const { targetId } = await this.requireSession().send('Target.createTarget', { url: 'about:blank' });
    return targetId;
  }

  private async setWindowState(targetId: string, windowState: 'normal' | 'minimized'): Promise<void> {
    const session = this.requireSession();
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  }

  private async focus(targetId: string): Promise<void> {
    await this.setWindowState(targetId, 'normal');
    await this.requireSession().send('Target.activateTarget', { targetId });
  }

  async openTab(key: string, url: string): Promise<void> {
    const session = this.requireSession();
    const open = await this.pageTargets();
    let targetId = this.tabs.get(key);
    if (!targetId || !open.some((t) => t.targetId === targetId)) {
      targetId = (await session.send('Target.createTarget', { url })).targetId;
      this.tabs.set(key, targetId);
      // A fresh Chrome starts with one empty tab: close it (navigating it would need attaching)
      const own = new Set(this.tabs.values());
      for (const t of open) {
        if ((t.url === 'about:blank' || t.url === 'chrome://newtab/') && !own.has(t.targetId)) {
          await session.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
        }
      }
    }
    await this.focus(targetId);
  }

  async getCookies(): Promise<Cookie[]> {
    const { cookies } = await this.requireSession().send('Storage.getCookies');
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.session ? -1 : c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    if (cookies.length === 0) return;
    await this.requireSession().send('Storage.setCookies', {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        ...(c.expires !== undefined && c.expires >= 0 ? { expires: c.expires } : {}),
      })),
    });
  }

  async showWindow(): Promise<void> {
    await this.focus(await this.anyTab());
  }

  async minimizeWindow(): Promise<void> {
    await this.setWindowState(await this.anyTab(), 'minimized');
  }

  async close(): Promise<void> {
    const browser = this.browser;
    if (browser?.connected) await browser.close();
  }

  onDisconnected(listener: () => void): void {
    this.listeners.push(listener);
  }
}

export const LOGIN_POLL_MS = 2000;
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** How often the gateway lookup is tried after a login before it fails (one poll apart). */
export const GATEWAY_ATTEMPTS = 5;

export interface LoginResult {
  environment: string;
  /** ISO time until which the token is valid, when the token says. */
  tokenValidUntil: string | undefined;
  gateway: string;
}

export interface BrowserServiceOptions {
  config: Config;
  sessions: SessionStore;
  driver: ChromeDriver;
  clientFor: (environment: string) => HelloIdClient;
  logger: Logger;
  fetch?: FetchLike;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The interactive login and the Chrome window, for all environments. */
export class BrowserService {
  private readonly options: BrowserServiceOptions;
  private launching: Promise<boolean> | undefined;
  private readonly logins = new Map<string, Promise<LoginResult>>();
  /** Incremented every time Chrome goes away, so a running login notices. */
  private disconnects = 0;

  constructor(options: BrowserServiceOptions) {
    this.options = options;
    options.driver.onDisconnected(() => {
      this.disconnects++;
      options.logger.info('Chrome was closed; the server keeps working from its in-memory sessions.');
    });
  }

  get isOpen(): boolean {
    return this.options.driver.isOpen();
  }

  private environmentConfig(environment: string) {
    const config = this.options.config.environments[environment];
    if (!config) throw new Error(`Unknown environment '${environment}'.`);
    return config;
  }

  /**
   * Starts Chrome when it is not open, and puts the cookies of every logged-in environment back,
   * so the user is still logged in there. Returns whether Chrome was started.
   */
  private ensureOpen(): Promise<boolean> {
    if (this.options.driver.isOpen()) return Promise.resolve(false);
    this.launching ??= (async () => {
      try {
        await this.options.driver.launch();
        const cookies = this.options.sessions.loggedIn().flatMap((session) => session.jar.all());
        if (cookies.length > 0) await this.options.driver.setCookies(cookies);
        return true;
      } finally {
        this.launching = undefined;
      }
    })();
    return this.launching;
  }

  /**
   * The identity providers on the sign-in page of an environment (read without cookies; no login
   * needed). Throws when the page cannot be read or has none.
   */
  async identityProviders(environment: string, options: { signal?: AbortSignal } = {}): Promise<IdentityProvider[]> {
    const config = this.environmentConfig(environment);
    try {
      return await fetchIdentityProviders(config.baseUrl, { fetch: this.options.fetch, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(`Cannot read the identity providers of '${environment}': ${errorMessage(error)}.`);
    }
  }

  /**
   * The address the login opens: without login settings the portal (it shows the sign-in page);
   * with login.provider that provider's link from the sign-in page, so the choice is skipped; with
   * login.username that address (or the sign-in page) with username=<value>, as HelloID's own
   * sign-in page passes it on to the provider.
   */
  async loginUrl(environment: string, signal?: AbortSignal): Promise<string> {
    const config = this.environmentConfig(environment);
    const { provider: providerName, username } = config.login ?? {};
    let url = `${config.baseUrl}/`;
    if (providerName !== undefined) {
      const providers = await this.identityProviders(environment, { signal });
      const provider = findIdentityProvider(providers, providerName);
      if (!provider) {
        throw new Error(
          `The identity provider '${providerName}' (login.provider of '${environment}' in config.json) is not on the ` +
            `sign-in page. Available: ${providers.map((p) => `'${p.name}'`).join(', ')}. Change login.provider to one ` +
            'of these names, or remove it to choose in Chrome.',
        );
      }
      url = providerUrl(config.baseUrl, provider);
    } else if (username !== undefined) {
      url = config.baseUrl + PORTAL.signIn;
    }
    return username !== undefined ? withUsername(url, username) : url;
  }

  /**
   * Opens (or reuses) the tab of the environment, brings the window to the front and waits until
   * the user has logged in: the portal gives a token with the tab's cookies. Then the cookies of
   * that host, the token and the gateway are kept in memory. One login per environment at a time.
   */
  login(environment: string, options: { signal?: AbortSignal; onProgress?: (elapsedMs: number) => void } = {}) {
    let running = this.logins.get(environment);
    if (!running) {
      running = this.runLogin(environment, options)
        .then(async (result) => {
          await this.closeAfterLogin(environment);
          return result;
        })
        .finally(() => this.logins.delete(environment));
      this.logins.set(environment, running);
    }
    return running;
  }

  /**
   * With chrome.closeAfterLogin (the default): closes Chrome once a login succeeded, unless a login
   * to another environment is still waiting in it. The sessions stay in memory. A failure to close
   * is logged, never a failed login.
   */
  private async closeAfterLogin(environment: string): Promise<void> {
    if (!this.options.config.chrome.closeAfterLogin || !this.options.driver.isOpen()) return;
    if ([...this.logins.keys()].some((other) => other !== environment)) return;
    try {
      await this.options.driver.close();
      this.options.logger.info(`Logged in to '${environment}': Chrome was closed (chrome.closeAfterLogin).`);
    } catch (error) {
      this.options.logger.warn(`Logged in to '${environment}', but closing Chrome failed: ${errorMessage(error)}`);
    }
  }

  private async runLogin(
    environment: string,
    options: { signal?: AbortSignal; onProgress?: (elapsedMs: number) => void },
  ): Promise<LoginResult> {
    const { driver, sessions, logger } = this.options;
    const now = this.options.now ?? Date.now;
    const pollMs = this.options.pollMs ?? LOGIN_POLL_MS;
    const timeoutMs = this.options.timeoutMs ?? LOGIN_TIMEOUT_MS;
    const config = this.environmentConfig(environment);
    const session = sessions.get(environment, config.baseUrl);
    const host = new URL(config.baseUrl).hostname;
    // Before Chrome is started, so a wrong login.provider opens nothing
    const startUrl = await this.loginUrl(environment, options.signal);

    await this.ensureOpen();
    const disconnectsAtStart = this.disconnects;
    await driver.openTab(environment, startUrl);
    logger.info(`Login to '${environment}': waiting for the user in Chrome.`);

    const started = now();
    const wasLoggedIn = session.loggedIn;
    let lastProblem = '';
    let token: string | undefined;
    let gateway: string | undefined;
    let gatewayAttempts = 0;
    let jar = new CookieJar(now);
    while (!gateway) {
      if (this.disconnects !== disconnectsAtStart || !driver.isOpen()) {
        throw new Error(`Chrome was closed before the login to '${environment}' finished. Call helloid_login again.`);
      }
      jar = new CookieJar(now);
      try {
        const cookies = (await driver.getCookies()).filter((cookie) => domainMatches(host, cookie.domain));
        jar.replace(cookies, host);
        const result = await requestToken(config.baseUrl, jar, { fetch: this.options.fetch, now, signal: options.signal });
        if (result.status === 200 && result.token) {
          token = result.token;
          // Logged in: keep the cookies and the token, then find the gateway. Right after the
          // login (e.g. the Local sign-in) the portal can still answer the bootstrap with a
          // redirect: read the cookies and the token again and retry a few times.
          session.jar.replace(jar.all(), host);
          session.setToken(token);
          try {
            gateway = await this.options.clientFor(environment).discoverGateway();
            break;
          } catch (error) {
            if (!wasLoggedIn) session.forget();
            gatewayAttempts += 1;
            if (gatewayAttempts >= GATEWAY_ATTEMPTS) throw error;
            lastProblem = errorMessage(error);
          }
        } else {
          lastProblem = result.status === 200 ? 'the portal answered without a token' : `the portal answered ${result.status}`;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (gatewayAttempts >= GATEWAY_ATTEMPTS) throw error;
        if (this.disconnects !== disconnectsAtStart || !driver.isOpen()) continue;
        lastProblem = errorMessage(error);
      }
      const elapsed = now() - started;
      if (elapsed >= timeoutMs) {
        throw new Error(
          `The login to '${environment}' timed out after ${Math.round(timeoutMs / 60000)} minutes ` +
            `(last check: ${lastProblem || 'no answer'}). Log in in the Chrome window, then call helloid_login again.`,
        );
      }
      options.onProgress?.(elapsed);
      await sleep(Math.min(pollMs, timeoutMs - elapsed), options.signal);
    }

    session.establish(session.jar.all(), token!, gateway);
    logger.info(`Logged in to '${environment}'.`);
    return {
      environment,
      tokenValidUntil: session.tokenExpires ? new Date(session.tokenExpires).toISOString() : undefined,
      gateway,
    };
  }

  /**
   * Restores and focuses the window. When Chrome is closed: starts it, puts the cookies back and
   * opens one tab per logged-in environment.
   */
  async show(): Promise<{ launched: boolean; tabsOpened: string[] }> {
    const launched = await this.ensureOpen();
    const tabsOpened: string[] = [];
    if (launched) {
      for (const session of this.options.sessions.loggedIn()) {
        await this.options.driver.openTab(session.environment, `${this.environmentConfig(session.environment).baseUrl}/`);
        tabsOpened.push(session.environment);
      }
    }
    await this.options.driver.showWindow();
    return { launched, tabsOpened };
  }

  /** Minimizes the window. Returns false when Chrome is not open. */
  async hide(): Promise<boolean> {
    if (!this.options.driver.isOpen()) return false;
    await this.options.driver.minimizeWindow();
    return true;
  }

  /** Closes Chrome; the in-memory sessions stay. Returns false when Chrome was not open. */
  async close(): Promise<boolean> {
    if (!this.options.driver.isOpen()) return false;
    await this.options.driver.close();
    return true;
  }
}
