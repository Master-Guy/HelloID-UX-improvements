import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { authenticateCaller } from '../src/auth/caller.ts';

const settings = { bearerToken: 'a'.repeat(40), port: 3917 };

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('caller auth', () => {
  it('refuses a request without a token with 401 and WWW-Authenticate', () => {
    const check = authenticateCaller(request({}), settings);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.equal(check.status, 401);
      assert.equal(check.headers['WWW-Authenticate'], 'Bearer');
    }
  });

  it('refuses a wrong token', () => {
    for (const authorization of [`Bearer ${'b'.repeat(40)}`, 'Bearer short', `Basic ${'a'.repeat(40)}`, 'Bearer ']) {
      const check = authenticateCaller(request({ authorization }), settings);
      assert.equal(check.ok, false, authorization);
      if (!check.ok) assert.equal(check.status, 401);
    }
  });

  it('accepts the right token without Origin', () => {
    const check = authenticateCaller(request({ authorization: `Bearer ${'a'.repeat(40)}` }), settings);
    assert.equal(check.ok, true);
  });

  it('refuses a foreign Origin with 403, even with the right token', () => {
    for (const origin of ['http://evil.example.test', 'http://127.0.0.1:9999', 'https://127.0.0.1:3917', 'null']) {
      const check = authenticateCaller(request({ authorization: `Bearer ${'a'.repeat(40)}`, origin }), settings);
      assert.equal(check.ok, false, origin);
      if (!check.ok) assert.equal(check.status, 403);
    }
  });

  it('accepts the server\'s own Origin', () => {
    for (const origin of ['http://127.0.0.1:3917', 'http://localhost:3917']) {
      const check = authenticateCaller(request({ authorization: `Bearer ${'a'.repeat(40)}`, origin }), settings);
      assert.equal(check.ok, true, origin);
    }
  });
});
