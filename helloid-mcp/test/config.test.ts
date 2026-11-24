import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, expandVars, isLoopbackHost, loadConfig, parseConfig } from '../src/config.ts';
import { removeDir, tempDir } from './helpers.ts';

const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' };

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    auth: { bearerToken: 'x'.repeat(32) },
    environments: { training: { baseUrl: 'https://example.helloid.training', mode: 'write' } },
    ...overrides,
  };
}

function refusal(raw: unknown): string {
  try {
    parseConfig(raw, env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.message;
  }
  assert.fail('the config was accepted');
}

describe('config', () => {
  it('loads config.example.json', () => {
    const path = fileURLToPath(new URL('../config.example.json', import.meta.url));
    const config = loadConfig(path, env);
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.port, 3917);
    assert.equal(config.chrome.profileDir, 'C:\\Users\\someone\\AppData\\Local\\helloid-mcp\\chrome-profile');
    assert.equal(config.audit.dir, 'C:\\Users\\someone\\AppData\\Local\\helloid-mcp\\audit');
    assert.equal(config.environments.training?.gatewayUrl, null);
    assert.deepEqual(config.environments.training?.login, { provider: 'Microsoft', username: 'someone@example.com' });
  });

  it('fills in the defaults', () => {
    const config = parseConfig(valid(), env);
    assert.deepEqual(config.server, { host: '127.0.0.1', port: 3917 });
    assert.equal(config.chrome.executablePath, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.equal(config.chrome.profileDir, 'C:\\Users\\someone\\AppData\\Local\\helloid-mcp\\chrome-profile');
    assert.equal(config.safety.readOnly, false);
    const training = config.environments.training!;
    assert.equal(training.allowEvaluate, true);
    assert.equal(training.allowDelete, false);
    assert.equal(training.allowRevokingRuleDelete, false);
    assert.equal(training.gatewayUrl, null);
  });

  it('keeps only the origin of the URLs', () => {
    const config = parseConfig(
      valid({
        environments: {
          t: { baseUrl: 'https://example.helloid.training/', gatewayUrl: 'https://gw.example.test/', mode: 'read' },
        },
      }),
      env,
    );
    assert.equal(config.environments.t?.baseUrl, 'https://example.helloid.training');
    assert.equal(config.environments.t?.gatewayUrl, 'https://gw.example.test');
  });

  it('refuses a short bearer token and names the field', () => {
    assert.match(refusal(valid({ auth: { bearerToken: 'short' } })), /auth\.bearerToken: must be at least 32 characters/);
  });

  it('refuses a missing bearer token', () => {
    assert.match(refusal(valid({ auth: {} })), /auth\.bearerToken/);
  });

  it('refuses a host that is not loopback', () => {
    assert.match(refusal(valid({ server: { host: '0.0.0.0', port: 3917 } })), /server\.host: must be a loopback address/);
    assert.match(refusal(valid({ server: { host: '192.168.1.10', port: 3917 } })), /server\.host/);
  });

  it('accepts loopback hosts', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1']) assert.ok(isLoopbackHost(host), host);
    assert.ok(!isLoopbackHost('example.com'));
  });

  it('refuses an unknown mode', () => {
    assert.match(
      refusal(valid({ environments: { training: { baseUrl: 'https://a.example.test', mode: 'admin' } } })),
      /environments\.training\.mode/,
    );
  });

  it('refuses an environment without mode', () => {
    assert.match(refusal(valid({ environments: { training: { baseUrl: 'https://a.example.test' } } })), /environments\.training\.mode/);
  });

  it('refuses a baseUrl that is not a URL or has a path', () => {
    assert.match(
      refusal(valid({ environments: { training: { baseUrl: 'example.helloid.com', mode: 'read' } } })),
      /environments\.training\.baseUrl: must be an http\(s\) URL/,
    );
    assert.match(
      refusal(valid({ environments: { training: { baseUrl: 'https://a.example.test/admin', mode: 'read' } } })),
      /without a path/,
    );
  });

  it('refuses no environments and bad names', () => {
    assert.match(refusal(valid({ environments: {} })), /environments: must name at least one environment/);
    assert.match(
      refusal(valid({ environments: { 'bad name': { baseUrl: 'https://a.example.test', mode: 'read' } } })),
      /environments/,
    );
  });

  it('refuses wrong types', () => {
    assert.match(
      refusal(valid({ environments: { t: { baseUrl: 'https://a.example.test', mode: 'read', allowDelete: 'yes' } } })),
      /environments\.t\.allowDelete/,
    );
    assert.match(refusal(valid({ safety: { readOnly: 1 } })), /safety\.readOnly/);
  });

  it('accepts login settings, all optional', () => {
    const environment = (login: unknown) => ({ environments: { t: { baseUrl: 'https://a.example.test', mode: 'read', login } } });
    assert.equal(parseConfig(valid(), env).environments.training?.login, undefined);
    assert.deepEqual(parseConfig(valid(environment({})), env).environments.t?.login, {});
    assert.deepEqual(parseConfig(valid(environment({ provider: ' Fake IdP ' })), env).environments.t?.login, { provider: 'Fake IdP' });
    assert.deepEqual(
      parseConfig(valid(environment({ provider: 'Local', username: 'someone@fake.example.test' })), env).environments.t?.login,
      { provider: 'Local', username: 'someone@fake.example.test' },
    );
  });

  it('refuses empty or wrong login settings and unknown keys', () => {
    const environment = (login: unknown) => ({ environments: { t: { baseUrl: 'https://a.example.test', mode: 'read', login } } });
    assert.match(refusal(valid(environment({ provider: '' }))), /environments\.t\.login\.provider: must not be empty/);
    assert.match(refusal(valid(environment({ username: '   ' }))), /environments\.t\.login\.username: must not be empty/);
    assert.match(refusal(valid(environment({ provider: 3 }))), /environments\.t\.login\.provider/);
    assert.match(refusal(valid(environment({ providr: 'Local' }))), /environments\.t\.login: .*providr/);
    assert.match(refusal(valid(environment('Local'))), /environments\.t\.login/);
  });

  it('expands %VAR% and refuses unknown variables', () => {
    assert.equal(expandVars('%LOCALAPPDATA%\\x', 'f', env), 'C:\\Users\\someone\\AppData\\Local\\x');
    assert.equal(expandVars('%localappdata%\\x', 'f', env), 'C:\\Users\\someone\\AppData\\Local\\x');
    assert.throws(() => expandVars('%NOPE%\\x', 'audit.dir', env), /audit\.dir uses %NOPE%/);
  });

  it('says when the file is missing or not JSON', () => {
    const dir = tempDir();
    try {
      assert.throws(() => loadConfig(join(dir, 'config.json'), env), /Copy config\.example\.json to config\.json/);
      writeFileSync(join(dir, 'config.json'), '{ not json');
      assert.throws(() => loadConfig(join(dir, 'config.json'), env), /is not valid JSON/);
    } finally {
      removeDir(dir);
    }
  });
});
