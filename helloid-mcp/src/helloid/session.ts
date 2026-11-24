// The in-memory session per environment: the portal host's cookies, the current Bearer token and
// its expiry, and the gateway origin. Nothing here is ever written to disk, logged or returned to
// a caller.

/** A cookie as Chrome's DevTools Protocol describes it (Network.Cookie / Network.CookieParam). */
export interface Cookie {
  name: string;
  value: string;
  /** Host-only cookies have the bare host; domain cookies have a leading dot. */
  domain: string;
  path: string;
  /** Seconds since 1970; -1 (or absent) for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\./.test(hostname);
}

/** Whether a cookie of `domain` belongs to `host` (RFC 6265 domain matching). */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  if (d.startsWith('.')) {
    const bare = d.slice(1);
    return h === bare || h.endsWith(`.${bare}`);
  }
  return h === d;
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const last = requestPath.lastIndexOf('/');
  return last <= 0 ? '/' : requestPath.slice(0, last);
}

function isExpired(cookie: Cookie, nowMs: number): boolean {
  return cookie.expires !== undefined && cookie.expires >= 0 && cookie.expires * 1000 <= nowMs;
}

/** The cookies of one portal host. */
export class CookieJar {
  private cookies: Cookie[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Every cookie still valid. */
  all(): Cookie[] {
    const now = this.now();
    this.cookies = this.cookies.filter((cookie) => !isExpired(cookie, now));
    return this.cookies.map((cookie) => ({ ...cookie }));
  }

  get size(): number {
    return this.all().length;
  }

  /** Replaces the whole jar, keeping only cookies that belong to `host`. */
  replace(cookies: Cookie[], host: string): void {
    this.cookies = cookies.filter((cookie) => domainMatches(host, cookie.domain)).map((cookie) => ({ ...cookie }));
  }

  clear(): void {
    this.cookies = [];
  }

  private put(cookie: Cookie): void {
    this.cookies = this.cookies.filter(
      (c) => !(c.name === cookie.name && c.domain.toLowerCase() === cookie.domain.toLowerCase() && c.path === cookie.path),
    );
    if (!isExpired(cookie, this.now())) this.cookies.push(cookie);
  }

  /** The value of the Cookie header for a request to `url`, or undefined when no cookie applies. */
  headerFor(url: string): string | undefined {
    const target = new URL(url);
    const secureOk = target.protocol === 'https:' || isLoopback(target.hostname);
    const matching = this.all()
      .filter(
        (cookie) =>
          domainMatches(target.hostname, cookie.domain) &&
          pathMatches(target.pathname, cookie.path || '/') &&
          (!cookie.secure || secureOk),
      )
      // Longer paths first, as browsers send them
      .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
    if (matching.length === 0) return undefined;
    return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /** Applies the Set-Cookie headers of a response to a request to `url`. */
  applySetCookie(url: string, setCookies: string[]): void {
    const target = new URL(url);
    for (const line of setCookies) {
      const cookie = parseSetCookie(line, target, this.now());
      if (cookie) this.put(cookie);
    }
  }
}

/** One Set-Cookie header as a Cookie, or undefined when it is malformed or for another host. */
export function parseSetCookie(line: string, requestUrl: URL, nowMs: number): Cookie | undefined {
  const [pair, ...attributes] = line.split(';');
  if (!pair) return undefined;
  const equals = pair.indexOf('=');
  if (equals <= 0) return undefined;
  const cookie: Cookie = {
    name: pair.slice(0, equals).trim(),
    value: pair.slice(equals + 1).trim(),
    domain: requestUrl.hostname,
    path: defaultPath(requestUrl.pathname),
    expires: -1,
  };
  if (!cookie.name) return undefined;
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const value = index < 0 ? '' : attribute.slice(index + 1).trim();
    switch (key) {
      case 'domain': {
        const bare = value.replace(/^\./, '').toLowerCase();
        if (!bare) break;
        if (!domainMatches(requestUrl.hostname, `.${bare}`)) return undefined;
        cookie.domain = `.${bare}`;
        break;
      }
      case 'path':
        if (value.startsWith('/')) cookie.path = value;
        break;
      case 'expires': {
        const time = Date.parse(value);
        if (!Number.isNaN(time)) cookie.expires = time / 1000;
        break;
      }
      case 'max-age': {
        const seconds = Number(value);
        if (Number.isInteger(seconds)) maxAge = seconds;
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const lower = value.toLowerCase();
        if (lower === 'strict') cookie.sameSite = 'Strict';
        else if (lower === 'lax') cookie.sameSite = 'Lax';
        else if (lower === 'none') cookie.sameSite = 'None';
        break;
      }
    }
  }
  // Max-Age wins over Expires; 0 or less removes the cookie
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : nowMs / 1000 + maxAge;
  return cookie;
}

/** The claims of a JWT, or undefined. */
export function jwtClaims(jwt: string): Record<string, unknown> | undefined {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Bearer token in the portal's answer to /server/v2/security/token: wherever it is in the
 * answer, the JWT whose `aud` is "helloid.services", else the first JWT (as Update-Token in
 * Export-HelloID.ps1 does).
 */
export function pickToken(text: string): string | undefined {
  const tokens = text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) ?? [];
  const audienceIs = (token: string) => {
    const aud = jwtClaims(token)?.aud;
    return aud === 'helloid.services' || (Array.isArray(aud) && aud.includes('helloid.services'));
  };
  return tokens.find(audienceIs) ?? tokens[0];
}

/** The expiry of a JWT in milliseconds since 1970, or undefined when it has no `exp`. */
export function tokenExpiry(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/**
 * The gateway origin in the bootstrap of Provisioning: the first https URL whose host contains
 * "gateway" (as Find-Gateway in Export-HelloID.ps1 does).
 */
export function findGatewayOrigin(text: string): string | undefined {
  const urls = text.replaceAll('\\/', '/').match(/https:\/\/[^"\s\\,]+/g) ?? [];
  for (const candidate of urls) {
    try {
      const url = new URL(candidate);
      if (/gateway/i.test(url.hostname)) return url.origin;
    } catch {
      // not a URL; next
    }
  }
  return undefined;
}

export type SessionState = 'logged-out' | 'logged-in' | 'expired';

/** The session of one environment. */
export class EnvironmentSession {
  readonly environment: string;
  readonly host: string;
  readonly jar: CookieJar;
  state: SessionState = 'logged-out';
  token: string | undefined;
  /** Milliseconds since 1970, from the JWT's exp. */
  tokenExpires: number | undefined;
  gateway: string | undefined;

  constructor(environment: string, baseUrl: string, now: () => number = Date.now) {
    this.environment = environment;
    this.host = new URL(baseUrl).hostname;
    this.jar = new CookieJar(now);
  }

  get loggedIn(): boolean {
    return this.state === 'logged-in';
  }

  setToken(token: string): void {
    this.token = token;
    this.tokenExpires = tokenExpiry(token);
  }

  /** Logged in: the cookies, token and gateway from a finished login. */
  establish(cookies: Cookie[], token: string, gateway: string): void {
    this.jar.replace(cookies, this.host);
    this.setToken(token);
    this.gateway = gateway;
    this.state = 'logged-in';
  }

  /** The portal no longer gives a token: the user has to log in again. */
  expire(): void {
    this.state = 'expired';
    this.token = undefined;
    this.tokenExpires = undefined;
  }

  /** Forgets everything (logout). */
  forget(): void {
    this.state = 'logged-out';
    this.jar.clear();
    this.token = undefined;
    this.tokenExpires = undefined;
    this.gateway = undefined;
  }
}

/** The sessions of all environments, created on first use. */
export class SessionStore {
  private readonly sessions = new Map<string, EnvironmentSession>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(environment: string, baseUrl: string): EnvironmentSession {
    let session = this.sessions.get(environment);
    if (!session) {
      session = new EnvironmentSession(environment, baseUrl, this.now);
      this.sessions.set(environment, session);
    }
    return session;
  }

  /** The session if one was ever created, without creating it. */
  peek(environment: string): EnvironmentSession | undefined {
    return this.sessions.get(environment);
  }

  /** The sessions that are logged in. */
  loggedIn(): EnvironmentSession[] {
    return [...this.sessions.values()].filter((session) => session.loggedIn);
  }
}
