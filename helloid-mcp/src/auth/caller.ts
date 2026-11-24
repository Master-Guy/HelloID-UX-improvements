// Who may use the server. Everything about callers is in this one module, behind
// authenticateCaller(), so OAuth 2.1 (the MCP authorization spec) can replace the static bearer
// secret later without touching the rest of the server.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface CallerSettings {
  /** The secret callers send as "Authorization: Bearer <secret>". */
  bearerToken: string;
  /** The port the server listens on (for the Origin check). */
  port: number;
}

/** A caller that passed: what the rest of the server may know about it. */
export interface Caller {
  /** How the caller proved itself; "bearer" in this version. */
  method: 'bearer';
}

export type CallerCheck =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; headers: Record<string, string>; message: string };

/** The origins a browser may send: the server's own address, under either loopback name. */
export function allowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

// Hashing both sides first makes the comparison constant-time also when the lengths differ.
function secretsEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Checks one HTTP request: the Origin (DNS rebinding protection) and the bearer secret.
 * Requests without Origin (Claude Code, the CLI) are allowed; a foreign Origin is refused with 403.
 * A missing or wrong secret is refused with 401 and "WWW-Authenticate: Bearer".
 */
export function authenticateCaller(req: IncomingMessage, settings: CallerSettings): CallerCheck {
  const origin = header(req, 'origin');
  if (origin !== undefined && !allowedOrigins(settings.port).includes(origin)) {
    return { ok: false, status: 403, headers: {}, message: 'Origin not allowed' };
  }
  const authorization = header(req, 'authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match?.[1] || !secretsEqual(match[1], settings.bearerToken)) {
    return {
      ok: false,
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
      message: 'Missing or wrong bearer token',
    };
  }
  return { ok: true, caller: { method: 'bearer' } };
}
