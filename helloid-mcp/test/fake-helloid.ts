// A fake HelloID on 127.0.0.1: the portal (/server/v2/security/token, /server/v2/bootstrap/provisioning,
// the sign-in page) and the gateway. Gateway routes are injectable, so later phases add the endpoints of their tools.
// All data is synthetic. The shape of the token answer is not known from the recordings; the
// client finds the JWTs wherever they are in the answer, as Export-HelloID.ps1 does.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string | string[]>;
  /** Objects are sent as JSON; strings as they are. */
  body?: unknown;
}

export type FakeHandler = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

interface Route {
  method: string;
  path: string | RegExp;
  handler: FakeHandler;
}

/** A JWT with the given claims (unsigned: HelloID's signature is not checked by the server). */
export function makeJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.${Buffer.from('fake-signature').toString('base64url')}`;
}

export const SESSION_COOKIE = 'fake_hid_session';
export const BOOTSTRAP_GATEWAY = 'https://provisioning-gateway-test.example.test';

/** A sign-in page in HelloID's shape (made-up providers), with a class attribute over two lines. */
export const SIGN_IN_HTML = `<!DOCTYPE html>
<html><body>
<div class="combined-list">
    <div class="form-group has-feedback has-feedback-left p-r-0">
        <a href="/directoryauthentication/login/0a1b2c3d-0000-4000-8000-00000000a1b2?returnUrl=%2F" class="btn btn-default w-100 sign-in-link text-left">
            <img src="https://cdn.example.test/x/images/ABC" width="20px" class="rounded-circle me-2" />
            AD - fake.local
        </a>
    </div>
    <div class="form-group has-feedback has-feedback-left p-r-0">
        <a href="/directoryauthentication/login/0a1b2c3d-0000-4000-8000-00000000c3d4?returnUrl=%2F" class="btn btn-default w-100 sign-in-link text-left">
            <img src="https://cdn.example.test/x/images/DEF" width="20px" class="rounded-circle me-2" />
            Contoso &amp; Partners
        </a>
    </div>
    <div class="form-group has-feedback has-feedback-left p-r-0">
        <a href="/authentication/admlogin?returnUrl=%2F" class="btn 
        btn-default w-100 sign-in-link text-left">
            <img src="https://cdn.example.test/x/images/GHI" width="20px" class="rounded-circle me-2" />
            Local
        </a>
    </div>
</div>
<a href="/privacy" class="footer-link">Privacy</a>
</body></html>`;

export interface FakeState {
  /** The value of SESSION_COOKIE the portal accepts; undefined: nobody is logged in. */
  validSession: string | undefined;
  /** Lifetime of new tokens in seconds. */
  tokenLifetimeSeconds: number;
  /** Tokens the gateway accepts (until they expire or are revoked). */
  issued: Map<string, number>;
  revoked: Set<string>;
  /** Number of token requests answered 200. */
  tokensIssued: number;
  /** Rotates a cookie on every token answer (Set-Cookie). */
  rotateCookie: boolean;
  /** When set, the token endpoint answers this status. */
  tokenStatus: number | undefined;
  /** What the bootstrap names as gateway. */
  bootstrapGateway: string;
  /** The number of bootstrap requests still answered with a redirect (as just after a Local sign-in). */
  bootstrapRedirects: number;
  /** The HTML of the sign-in page (GET / redirects to it). */
  signInHtml: string;
  /** When set, the sign-in page answers this status. */
  signInStatus: number | undefined;
  portalRequests: FakeRequest[];
  gatewayRequests: FakeRequest[];
}

export interface FakeHelloId {
  portalUrl: string;
  gatewayUrl: string;
  state: FakeState;
  /** Adds a gateway route (later routes win over earlier ones for the same path). */
  route(method: string, path: string | RegExp, handler: FakeHandler): void;
  /** Adds a portal route. */
  portalRoute(method: string, path: string | RegExp, handler: FakeHandler): void;
  /** A new token the gateway accepts. */
  issueToken(lifetimeSeconds?: number): string;
  close(): Promise<void>;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

async function readRequest(req: IncomingMessage): Promise<FakeRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let json: unknown;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  return { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, json };
}

function send(res: ServerResponse, response: FakeResponse): void {
  const headers: Record<string, string | string[]> = { ...response.headers };
  let body = '';
  if (response.body !== undefined) {
    if (typeof response.body === 'string') {
      body = response.body;
    } else {
      body = JSON.stringify(response.body);
      headers['Content-Type'] ??= 'application/json; charset=utf-8';
    }
  }
  res.writeHead(response.status ?? 200, headers);
  res.end(body);
}

function findRoute(routes: Route[], request: FakeRequest): Route | undefined {
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i]!;
    if (route.method !== request.method) continue;
    if (typeof route.path === 'string' ? route.path === request.path : route.path.test(request.path)) return route;
  }
  return undefined;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startFakeHelloId(): Promise<FakeHelloId> {
  const state: FakeState = {
    validSession: undefined,
    tokenLifetimeSeconds: 3600,
    issued: new Map(),
    revoked: new Set(),
    tokensIssued: 0,
    rotateCookie: true,
    tokenStatus: undefined,
    bootstrapGateway: BOOTSTRAP_GATEWAY,
    bootstrapRedirects: 0,
    signInHtml: SIGN_IN_HTML,
    signInStatus: undefined,
    portalRequests: [],
    gatewayRequests: [],
  };
  const portalRoutes: Route[] = [];
  const gatewayRoutes: Route[] = [];

  const issueToken = (lifetimeSeconds = state.tokenLifetimeSeconds): string => {
    const exp = Math.floor(Date.now() / 1000) + lifetimeSeconds;
    const token = makeJwt({ aud: 'helloid.services', exp, sub: 'fake-admin', n: state.issued.size + 1 });
    state.issued.set(token, exp);
    return token;
  };

  const loggedIn = (request: FakeRequest) =>
    state.validSession !== undefined && cookieValue(request.headers.cookie, SESSION_COOKIE) === state.validSession;

  // Portal defaults
  portalRoutes.push({
    method: 'GET',
    path: '/server/v2/security/token',
    handler: (request) => {
      if (state.tokenStatus !== undefined) return { status: state.tokenStatus, body: '' };
      if (!loggedIn(request)) return { status: 401, body: '' };
      state.tokensIssued++;
      // Two JWTs: one for another audience first, so the client has to pick the right one
      const other = makeJwt({ aud: 'other.audience', exp: Math.floor(Date.now() / 1000) + 3600 });
      const token = issueToken();
      const headers: Record<string, string[]> = {};
      if (state.rotateCookie) headers['Set-Cookie'] = [`fake_rotated=${state.tokensIssued}; Path=/; HttpOnly`];
      return {
        status: 200,
        headers,
        body: { idToken: other, accessToken: token },
      };
    },
  });
  portalRoutes.push({
    method: 'GET',
    path: '/server/v2/bootstrap/provisioning',
    handler: (request) => {
      if (!loggedIn(request)) return { status: 401, body: '' };
      if (state.bootstrapRedirects > 0) {
        state.bootstrapRedirects -= 1;
        const redirect: FakeResponse = { status: 302, headers: { Location: '/Authentication/SignIn' }, body: '' };
        return redirect;
      }
      // URLs escaped as JSON may escape them
      const escaped = state.bootstrapGateway.replaceAll('/', '\\/');
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: `{"cdnUrl":"https:\\/\\/cdn.example.test\\/assets","apiUrl":"${escaped}\\/","version":"1.0.0"}`,
      };
    },
  });

  // Without a login, the start page redirects to the sign-in page, which lists the identity providers
  portalRoutes.push({
    method: 'GET',
    path: '/',
    handler: () => ({ status: 302, headers: { Location: '/Authentication/SignIn?ReturnUrl=%2F' }, body: '' }),
  });
  portalRoutes.push({
    method: 'GET',
    path: '/Authentication/SignIn',
    handler: () => ({
      status: state.signInStatus ?? 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: state.signInHtml,
    }),
  });

  const portal = createServer((req, res) => {
    void (async () => {
      const request = await readRequest(req);
      state.portalRequests.push(request);
      const route = findRoute(portalRoutes, request);
      send(res, route ? await route.handler(request) : { status: 404, body: 'Not found' });
    })();
  });
  const portalUrl = await listen(portal);

  const gateway = createServer((req, res) => {
    void (async () => {
      const request = await readRequest(req);
      state.gatewayRequests.push(request);
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const exp = token ? state.issued.get(token) : undefined;
      const valid = token !== undefined && exp !== undefined && exp * 1000 > Date.now() && !state.revoked.has(token);
      if (!valid) return send(res, { status: 401, body: '' });
      if (request.headers.origin !== portalUrl) return send(res, { status: 403, body: 'Wrong origin' });
      const route = findRoute(gatewayRoutes, request);
      send(res, route ? await route.handler(request) : { status: 404, body: { message: 'Not found' } });
    })();
  });
  const gatewayUrl = await listen(gateway);

  return {
    portalUrl,
    gatewayUrl,
    state,
    route: (method, path, handler) => gatewayRoutes.push({ method, path, handler }),
    portalRoute: (method, path, handler) => portalRoutes.push({ method, path, handler }),
    issueToken,
    async close() {
      for (const server of [portal, gateway]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
