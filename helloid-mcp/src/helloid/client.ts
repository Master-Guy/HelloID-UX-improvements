// Requests to the portal and the gateway of one environment, with the in-memory session: the
// portal's cookies (updated by its Set-Cookie headers), the Bearer token (renewed when it expires
// within 2 minutes, and once on a 401) and the gateway origin.

import type { EnvironmentConfig } from '../config.ts';
import { cachebust, PORTAL, type QueryValue, withQuery } from './endpoints.ts';
import { type CookieJar, type EnvironmentSession, findGatewayOrigin, pickToken } from './session.ts';

export const ACCEPT = 'application/json, text/plain, */*';
/** Renew the token when it expires within this time. */
export const RENEW_BEFORE_MS = 2 * 60 * 1000;

export type FetchLike = typeof fetch;

/** The caller has to log in first. */
export class NotLoggedInError extends Error {
  override name = 'NotLoggedInError';
  constructor(environment: string) {
    super(`Not logged in to '${environment}': call helloid_login with environment '${environment}'.`);
  }
}

/** The portal no longer gives a token: the caller has to log in again. */
export class SessionExpiredError extends Error {
  override name = 'SessionExpiredError';
  constructor(environment: string, status?: number) {
    super(
      `The HelloID session of '${environment}' has expired${status ? ` (the portal answered ${status} for the token)` : ''}: ` +
        `call helloid_login with environment '${environment}' to log in again.`,
    );
  }
}

/** HelloID answered with a status outside 200-299. */
export class HelloIdHttpError extends Error {
  override name = 'HelloIdHttpError';
  readonly status: number;
  readonly body: string;
  constructor(status: number, method: string, path: string, body: string) {
    const excerpt = redactTokens(body).replace(/\s+/g, ' ').trim().slice(0, 300);
    super(`HelloID answered ${status} for ${method} ${path}${excerpt ? `: ${excerpt}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

/** JWTs replaced, so an answer that echoes a token can never reach a caller or a log. */
export function redactTokens(text: string): string {
  return text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>');
}

export interface HelloIdResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** The answer as JSON (undefined for an empty answer). */
export function parseJson<T = unknown>(response: HelloIdResponse): T {
  if (!response.text.trim()) return undefined as T;
  return JSON.parse(response.text) as T;
}

export interface GatewayRequest {
  method?: string;
  /** Path on the gateway, e.g. /service/rules/api/rules/overview. */
  path: string;
  query?: Record<string, QueryValue>;
  /** A JSON body (objects are serialised; a string is sent as it is with contentType). */
  body?: unknown;
  contentType?: string;
  accept?: string;
  signal?: AbortSignal;
}

export interface TokenResult {
  status: number;
  token?: string;
}

/**
 * GET <baseUrl>/server/v2/security/token with the cookies of `jar`; Set-Cookie headers update the jar.
 * Used for the login check (with the browser's cookies) and for renewing.
 */
export async function requestToken(
  baseUrl: string,
  jar: CookieJar,
  options: { fetch?: FetchLike; now?: () => number; signal?: AbortSignal } = {},
): Promise<TokenResult> {
  const doFetch = options.fetch ?? fetch;
  const url = baseUrl + withQuery(PORTAL.token, { cachebust: cachebust(options.now) });
  const headers: Record<string, string> = { Accept: ACCEPT };
  const cookie = jar.headerFor(url);
  if (cookie) headers.Cookie = cookie;
  const response = await doFetch(url, { headers, redirect: 'manual', signal: options.signal });
  jar.applySetCookie(url, response.headers.getSetCookie());
  const text = await response.text();
  if (response.status !== 200) return { status: response.status };
  const token = pickToken(text);
  return token ? { status: 200, token } : { status: 200 };
}

/** The client of one environment. */
export class HelloIdClient {
  readonly environment: string;
  readonly config: EnvironmentConfig;
  readonly session: EnvironmentSession;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private renewing: Promise<void> | undefined;

  constructor(
    environment: string,
    config: EnvironmentConfig,
    session: EnvironmentSession,
    options: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.environment = environment;
    this.config = config;
    this.session = session;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** A request to the portal with the session's cookies; its Set-Cookie headers update them. */
  async portal(path: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const url = this.config.baseUrl + path;
    const headers: Record<string, string> = { Accept: ACCEPT, ...init.headers };
    const cookie = this.session.jar.headerFor(url);
    if (cookie) headers.Cookie = cookie;
    const response = await this.fetch(url, {
      method: init.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: init.signal,
    });
    this.session.jar.applySetCookie(url, response.headers.getSetCookie());
    return { status: response.status, headers: response.headers, text: await response.text() } satisfies HelloIdResponse;
  }

  /**
   * Gets a new token with the session's cookies. When the portal does not answer 200 with a token,
   * the session is expired and SessionExpiredError is thrown. Concurrent callers share one renewal.
   */
  renewToken(): Promise<void> {
    this.renewing ??= (async () => {
      try {
        const result = await requestToken(this.config.baseUrl, this.session.jar, { fetch: this.fetch, now: this.now });
        if (result.status !== 200 || !result.token) {
          this.session.expire();
          throw new SessionExpiredError(this.environment, result.status);
        }
        this.session.setToken(result.token);
      } finally {
        this.renewing = undefined;
      }
    })();
    return this.renewing;
  }

  /**
   * The gateway origin: gatewayUrl from the config when set, else the first gateway URL in the
   * portal's bootstrap of Provisioning.
   */
  async discoverGateway(): Promise<string> {
    if (this.config.gatewayUrl) return this.config.gatewayUrl;
    const headers: Record<string, string> = {};
    if (this.session.token) headers.Authorization = `Bearer ${this.session.token}`;
    const response = await this.portal(PORTAL.bootstrapProvisioning, { headers });
    const gateway = response.status === 200 ? findGatewayOrigin(response.text) : undefined;
    if (!gateway) {
      throw new Error(
        `The provisioning gateway of '${this.environment}' was not found (the portal answered ${response.status} for ` +
          `${PORTAL.bootstrapProvisioning}). Set gatewayUrl for '${this.environment}' in config.json, e.g. ` +
          'https://provisioning-gateway-xx.helloid.cloud: the browser DevTools show it in the requests of the Target systems page.',
      );
    }
    return gateway;
  }

  private assertLoggedIn(): void {
    if (this.session.state === 'expired') throw new SessionExpiredError(this.environment);
    if (this.session.state !== 'logged-in' || !this.session.gateway) throw new NotLoggedInError(this.environment);
  }

  private tokenNeedsRenewal(): boolean {
    if (!this.session.token) return true;
    const expires = this.session.tokenExpires;
    return expires !== undefined && expires - this.now() < RENEW_BEFORE_MS;
  }

  /** The raw answer of a gateway request (any status). */
  private async sendGateway(request: GatewayRequest): Promise<HelloIdResponse> {
    const path = request.query ? withQuery(request.path, request.query) : request.path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.session.token ?? ''}`,
      Accept: request.accept ?? ACCEPT,
      Origin: this.config.baseUrl,
    };
    let body: string | undefined;
    if (request.body !== undefined) {
      if (typeof request.body === 'string') {
        body = request.body;
        headers['Content-Type'] = request.contentType ?? 'application/json';
      } else {
        body = JSON.stringify(request.body);
        headers['Content-Type'] = request.contentType ?? 'application/json';
      }
    }
    const response = await this.fetch(this.session.gateway + path, {
      method: request.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: request.signal,
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  /**
   * A request to the gateway. Renews the token first when it expires within 2 minutes, and once on
   * a 401 (then retries once). Throws HelloIdHttpError for an answer outside 200-299,
   * SessionExpiredError when the token cannot be renewed, NotLoggedInError without a session.
   */
  async gateway(request: GatewayRequest): Promise<HelloIdResponse> {
    this.assertLoggedIn();
    if (this.tokenNeedsRenewal()) await this.renewToken();
    let response = await this.sendGateway(request);
    if (response.status === 401) {
      await this.renewToken();
      response = await this.sendGateway(request);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HelloIdHttpError(response.status, request.method ?? 'GET', request.path, response.text);
    }
    return response;
  }

  /** A gateway request whose answer is JSON. */
  async gatewayJson<T = unknown>(request: GatewayRequest): Promise<T> {
    return parseJson<T>(await this.gateway(request));
  }
}

/** One event of a server-sent event stream. */
export interface ServerSentEvent {
  /** The event name ("message" when the event has none). */
  event: string;
  /** The data lines, joined with a newline. */
  data: string;
}

/**
 * Parses a text/event-stream answer: events are separated by a blank line; each has "event:" and
 * "data:" lines (several data lines are joined with a newline); lines starting with ":" are comments.
 */
export function parseEventStream(text: string): ServerSentEvent[] {
  const events: ServerSentEvent[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return events;
}
