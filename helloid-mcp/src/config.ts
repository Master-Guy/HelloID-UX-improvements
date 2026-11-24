// config.json: loaded and validated at start. The server refuses to start on an invalid config and
// says which field is wrong.

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config.json', import.meta.url));

export const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const DEFAULT_PROFILE_DIR = '%LOCALAPPDATA%\\helloid-mcp\\chrome-profile';
export const DEFAULT_AUDIT_DIR = '%LOCALAPPDATA%\\helloid-mcp\\audit';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3917;

export const MODES = ['read', 'plan', 'write'] as const;
export type Mode = (typeof MODES)[number];

/** 127.0.0.0/8, ::1 and "localhost". */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') return true;
  if (isIP(bare) === 4) return bare.split('.')[0] === '127';
  if (isIP(bare) === 6) return bare === '::1' || bare === '0:0:0:0:0:0:0:1';
  return false;
}

/** The origin of an http(s) URL (scheme, host and port), without a trailing slash. */
function originOf(value: string): string {
  return new URL(value).origin;
}

const httpUrl = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL, e.g. https://example.helloid.com')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
    } catch {
      return true;
    }
  }, 'must be the address of the host only, without a path, e.g. https://example.helloid.com')
  .transform(originOf);

const nonEmpty = z.string().trim().min(1, 'must not be empty');

/** How the login starts: the identity provider to open directly, and a username to pass on. */
const loginSchema = z.strictObject({
  provider: nonEmpty.optional(),
  username: nonEmpty.optional(),
});

const environmentSchema = z.object({
  baseUrl: httpUrl,
  gatewayUrl: httpUrl.nullable().default(null),
  mode: z.enum(MODES),
  allowEvaluate: z.boolean().default(true),
  allowDelete: z.boolean().default(false),
  allowRevokingRuleDelete: z.boolean().default(false),
  allowRevokingRulePublish: z.boolean().default(false),
  allowRetryActions: z.boolean().default(false),
  allowApproveBlocked: z.boolean().default(false),
  allowEnforce: z.boolean().default(false),
  allowDryRun: z.boolean().default(false),
  login: loginSchema.optional(),
});

const configSchema = z.object({
  server: z
    .object({
      host: z
        .string()
        .default(DEFAULT_HOST)
        .refine(isLoopbackHost, 'must be a loopback address (127.0.0.1, ::1 or localhost) in this version'),
      port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    })
    .default({ host: DEFAULT_HOST, port: DEFAULT_PORT }),
  auth: z.object({
    bearerToken: z.string().min(32, 'must be at least 32 characters'),
  }),
  chrome: z
    .object({
      executablePath: z.string().min(1).default(DEFAULT_CHROME_PATH),
      profileDir: z.string().min(1).default(DEFAULT_PROFILE_DIR),
      /** Close Chrome after a successful login (the sessions stay in memory; a later login opens it again). */
      closeAfterLogin: z.boolean().default(true),
    })
    .default({ executablePath: DEFAULT_CHROME_PATH, profileDir: DEFAULT_PROFILE_DIR, closeAfterLogin: true }),
  audit: z
    .object({
      dir: z.string().min(1).default(DEFAULT_AUDIT_DIR),
    })
    .default({ dir: DEFAULT_AUDIT_DIR }),
  safety: z
    .object({
      readOnly: z.boolean().default(false),
    })
    .default({ readOnly: false }),
  environments: z
    .record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'environment names may only contain letters, digits, - and _'),
      environmentSchema,
    )
    .refine((value) => Object.keys(value).length > 0, 'must name at least one environment'),
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** %VAR% replaced by the environment variable; an unknown variable is an error. */
export function expandVars(value: string, field: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const found = env[name] ?? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (found === undefined) throw new ConfigError(`config.json: ${field} uses %${name}%, which is not set`);
    return found;
  });
}

/** Validates a parsed config.json. Throws ConfigError naming the wrong field(s). */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.') || '(root)';
      return `  ${path}: ${issue.message}`;
    });
    throw new ConfigError(`config.json is not valid:\n${lines.join('\n')}`);
  }
  const config = result.data;
  config.chrome.executablePath = expandVars(config.chrome.executablePath, 'chrome.executablePath', env);
  config.chrome.profileDir = expandVars(config.chrome.profileDir, 'chrome.profileDir', env);
  config.audit.dir = expandVars(config.audit.dir, 'audit.dir', env);
  return config;
}

/** Reads and validates config.json. */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}). ` +
        'Copy config.example.json to config.json and fill it in.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw, env);
}
