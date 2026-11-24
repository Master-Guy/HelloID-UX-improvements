import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AuditLog, maskForAudit } from '../src/audit.ts';
import { silentLogger } from '../src/log.ts';
import { makeJwt } from './fake-helloid.ts';
import { auditLines, auditText, removeDir, tempDir } from './helpers.ts';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => removeDir(dir));

describe('audit masking', () => {
  it('masks values whose name says they are secrets', () => {
    const masked = maskForAudit({
      name: 'AFAS',
      clientSecret: 'very-secret',
      password: 'p',
      apiKey: 'k',
      emptySecret: '',
      nested: [{ privateKey: 'x', certificateThumbprint: 'y', plain: 'z' }],
    });
    assert.deepEqual(masked, {
      name: 'AFAS',
      clientSecret: '***',
      password: '***',
      apiKey: '***',
      emptySecret: '',
      nested: [{ privateKey: '***', certificateThumbprint: '***', plain: 'z' }],
    });
  });

  it('replaces JWTs and large contents', () => {
    const jwt = makeJwt({ aud: 'helloid.services' });
    const large = 'x'.repeat(5000);
    const masked = maskForAudit({ note: `token ${jwt}`, file: large }) as Record<string, unknown>;
    assert.equal(masked.note, 'token <token>');
    assert.deepEqual(masked.file, { size: 5000, sha256: createHash('sha256').update(large).digest('hex') });
  });
});

describe('audit log', () => {
  it('writes one line per call in a file per day (UTC)', async () => {
    let now = Date.parse('2026-11-19T23:59:59.000Z');
    const log = new AuditLog(join(dir, 'audit'), { now: () => now, logger: silentLogger });
    await log.write({ sessionId: 's1', environment: 'training', tool: 'helloid_login', arguments: { environment: 'training' }, result: 'ok', summary: 'Logged in' });
    now = Date.parse('2026-11-20T00:00:01.000Z');
    await log.write({ sessionId: null, environment: null, tool: 'helloid_list_environments', arguments: {}, result: 'refused', summary: 'x' });
    assert.ok(existsSync(join(dir, 'audit', '2026-11-19.jsonl')));
    assert.ok(existsSync(join(dir, 'audit', '2026-11-20.jsonl')));
    const lines = auditLines(join(dir, 'audit'));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      time: '2026-11-19T23:59:59.000Z',
      sessionId: 's1',
      environment: 'training',
      tool: 'helloid_login',
      arguments: { environment: 'training' },
      result: 'ok',
      summary: 'Logged in',
    });
  });

  it('appends, and masks arguments, summary and changes', async () => {
    const log = new AuditLog(dir, { logger: silentLogger });
    const jwt = makeJwt({ aud: 'helloid.services' });
    await log.write({
      sessionId: 's',
      environment: 'training',
      tool: 'helloid_apply_plan',
      arguments: { planId: 'p', password: 'hunter2' },
      result: 'ok',
      summary: `done ${jwt}`,
      changes: [{ item: 'target system A', before: { clientSecret: 'old' }, after: { clientSecret: 'new', name: 'A' } }],
    });
    await log.write({ sessionId: 's', environment: 'training', tool: 't', arguments: {}, result: 'error', summary: 'second' });
    const text = auditText(dir);
    assert.doesNotMatch(text, /hunter2|old|new"|eyJ/);
    const lines = auditLines(dir);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0]!.changes, [{ item: 'target system A', before: { clientSecret: '***' }, after: { clientSecret: '***', name: 'A' } }]);
  });

  it('does not fail the call when it cannot write', async () => {
    const errors: string[] = [];
    // A file where the folder should be
    const log = new AuditLog(join(import.meta.dirname, 'audit.test.ts'), {
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    });
    await log.write({ sessionId: null, environment: null, tool: 't', arguments: {}, result: 'ok', summary: '' });
    assert.equal(errors.length, 1);
  });
});
