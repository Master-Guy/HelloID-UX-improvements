// Safety: modes and flags per environment, the plan store (fingerprints, expiry, used once) and
// the lock that allows one write at a time per environment. Generic machinery: the tools of later
// phases use it.

import { createHash, randomUUID } from 'node:crypto';
import type { Config, EnvironmentConfig, Mode } from './config.ts';

/** A call refused by a setting. Tool results say which setting refuses it. */
export class RefusedError extends Error {
  override name = 'RefusedError';
}

/**
 * What a tool needs:
 * - none: works in every mode and without an environment setting (session and browser tools)
 * - read / plan / write: the environment's mode must be at least this
 * - evaluate: allowEvaluate (whatever the mode)
 * - delete: mode write and allowDelete
 * - retryActions: mode write and allowRetryActions (retrying failed entitlement actions)
 * - approveBlocked: mode write and allowApproveBlocked (approving blocked entitlement actions)
 * - enforce: mode write and allowEnforce (a full enforcement run)
 * - dryRun: allowDryRun, whatever the mode (as evaluate: safety.readOnly does not switch it off). The
 *   dry-run tools run target system scripts with $actionContext.DryRun = $true; they refuse a script
 *   the DryRun check finds problems in.
 */
export type Access = 'none' | 'read' | 'plan' | 'write' | 'evaluate' | 'delete' | 'retryActions' | 'approveBlocked' | 'enforce' | 'dryRun';

/** The flag of config.json each write access of the entitlement actions needs (besides mode write). */
const ACCESS_FLAGS = {
  delete: 'allowDelete',
  retryActions: 'allowRetryActions',
  approveBlocked: 'allowApproveBlocked',
  enforce: 'allowEnforce',
} as const satisfies Partial<Record<Access, keyof EnvironmentConfig>>;

const MODE_RANK: Record<Mode, number> = { read: 0, plan: 1, write: 2 };

/** The mode that applies: safety.readOnly overrides every environment to "read". */
export function effectiveMode(config: Config, environment: EnvironmentConfig): Mode {
  return config.safety.readOnly ? 'read' : environment.mode;
}

/** The reason a call is refused, or undefined when it is allowed. */
export function refusalReason(config: Config, name: string, environment: EnvironmentConfig, access: Access): string | undefined {
  const mode = effectiveMode(config, environment);
  const modeSource = config.safety.readOnly
    ? `safety.readOnly is true in config.json (every environment is "read")`
    : `environments.${name}.mode is "${environment.mode}" in config.json`;
  const needMode = (needed: Mode) =>
    MODE_RANK[mode] >= MODE_RANK[needed]
      ? undefined
      : `Refused: this needs mode "${needed}" or higher for '${name}', but ${modeSource}.`;
  switch (access) {
    case 'none':
      return undefined;
    case 'read':
    case 'plan':
    case 'write':
      return needMode(access);
    case 'evaluate':
      return environment.allowEvaluate
        ? undefined
        : `Refused: environments.${name}.allowEvaluate is false in config.json.`;
    case 'dryRun':
      return environment.allowDryRun
        ? undefined
        : `Refused: environments.${name}.allowDryRun is false in config.json (a dry run runs the real target system script with DryRun on).`;
    case 'delete':
    case 'retryActions':
    case 'approveBlocked':
    case 'enforce': {
      const flag = ACCESS_FLAGS[access];
      return needMode('write') ?? (environment[flag] ? undefined : `Refused: environments.${name}.${flag} is false in config.json.`);
    }
  }
}

/** Throws RefusedError when the call is not allowed. */
export function requireAccess(config: Config, name: string, environment: EnvironmentConfig, access: Access): void {
  const reason = refusalReason(config, name, environment, access);
  if (reason) throw new RefusedError(reason);
}

/**
 * Publishing a business rule that takes entitlements away (entitlements removed, or persons out of
 * scope) with "revoke" needs allowRevokingRulePublish. Without it, only "unmanaged".
 */
export function requireRevokingRulePublish(name: string, environment: EnvironmentConfig): void {
  if (!environment.allowRevokingRulePublish) {
    throw new RefusedError(
      `Refused: publishing a business rule with removedEntitlements "revoke" needs environments.${name}.allowRevokingRulePublish ` +
        'set to true in config.json. Without it, use "unmanaged" (the entitlements stay, no longer managed by the rule).',
    );
  }
}

/** Deleting a published business rule with "revoke entitlements" needs allowRevokingRuleDelete. */
export function requireRevokingRuleDelete(name: string, environment: EnvironmentConfig): void {
  if (!environment.allowRevokingRuleDelete) {
    throw new RefusedError(
      `Refused: deleting a published business rule with "revoke entitlements" needs environments.${name}.allowRevokingRuleDelete ` +
        'set to true in config.json. Without it, use "mark entitlements as unmanaged".',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Secrets

/** Names of values that are secrets (the same pattern as the userscript and Export-HelloID.ps1). */
export const SECRET_NAME = /secret|passw|pwd|token|api[-_]?key|private[-_]?key|certificate|credential/i;
/** What a masked secret looks like. */
export const SECRET_MASK = '***';

// Masking as the userscript's export does it with "include secrets" off (exportSecrets: false):
// the password fields of a configuration form, and any value whose name says it is a secret, are
// replaced by SECRET_MASK when they have a value. Ported from maskSecrets, listSecrets, maskValues,
// maskNotificationSystem and maskSourceSystem.

type Json = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isFilled = (value: unknown) => typeof value === 'string' && value !== '';

interface FormField {
  key?: unknown;
  templateOptions?: { type?: unknown };
}
const asFields = (fields: unknown): FormField[] => (Array.isArray(fields) ? fields.filter(isPlainObject) : []) as FormField[];

/** The names of the secret values in a target system's scriptConfiguration (password fields, secret names). */
function scriptSecretKeys(configuration: Json): string[] {
  const values = configuration.scriptConfiguration;
  if (!isPlainObject(values)) return [];
  const form = isPlainObject(configuration.scriptConfigurationForm) ? configuration.scriptConfigurationForm : {};
  const passwordKeys = new Set(asFields(form.fields).filter((f) => f.templateOptions?.type === 'password').map((f) => f.key));
  return Object.keys(values).filter((key) => passwordKeys.has(key) || SECRET_NAME.test(key));
}

/**
 * Built-in types (e.g. Azure AD) have their settings in the configuration itself or in a group in it:
 * the texts (or empty values) whose name says they are secrets, as [group, key] (group null: the
 * configuration itself).
 */
export function settingSecretKeys(configuration: Json): Array<[string | null, string]> {
  const secretsOf = (values: Json) =>
    Object.keys(values).filter((key) => SECRET_NAME.test(key) && (values[key] === null || typeof values[key] === 'string'));
  return [
    ...secretsOf(configuration).map((key): [null, string] => [null, key]),
    ...Object.keys(configuration)
      .filter((group) => group !== 'scriptConfiguration' && isPlainObject(configuration[group]))
      .flatMap((group) => secretsOf(configuration[group] as Json).map((key): [string, string] => [group, key])),
  ];
}

/** A target system configuration with its secrets masked. */
export function maskTargetConfiguration<T>(configuration: T): T {
  if (!isPlainObject(configuration)) return configuration;
  const masked: Json = { ...configuration };
  for (const [group, key] of settingSecretKeys(configuration)) {
    if (group) {
      const values = masked[group] as Json;
      if (!isFilled(values[key])) continue;
      masked[group] = { ...values, [key]: SECRET_MASK };
    } else if (isFilled(masked[key])) {
      masked[key] = SECRET_MASK;
    }
  }
  const keys = scriptSecretKeys(configuration);
  if (keys.length) {
    const script: Json = { ...(configuration.scriptConfiguration as Json) };
    for (const key of keys) if (isFilled(script[key])) script[key] = SECRET_MASK;
    masked.scriptConfiguration = script;
  }
  return masked as T;
}

/** Which values of a target system configuration are secrets, and whether HelloID returned one. */
export function listTargetSecrets(configuration: unknown): Array<{ key: string; hasValue: boolean }> {
  if (!isPlainObject(configuration)) return [];
  const script = configuration.scriptConfiguration as Json;
  return [
    ...settingSecretKeys(configuration).map(([group, key]) =>
      group
        ? { key: `${group}.${key}`, hasValue: isFilled((configuration[group] as Json)[key]) }
        : { key, hasValue: isFilled(configuration[key]) },
    ),
    ...scriptSecretKeys(configuration).map((key) => ({ key, hasValue: isFilled(script[key]) })),
  ];
}

const getIn = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), value);
function setIn(value: Json, path: string, replacement: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), value);
  if (isPlainObject(parent) && last in parent) parent[last] = replacement;
}

/** The values of a form (data) with its secrets masked: the password fields of the form, and secret names. */
export function maskFormValues<T>(values: T, fields: unknown): T {
  if (!isPlainObject(values)) return values;
  const copy = structuredClone(values) as Json;
  const byName = (o: Json) => {
    for (const key of Object.keys(o)) {
      const inner = o[key];
      if (isPlainObject(inner)) byName(inner);
      else if (SECRET_NAME.test(key) && isFilled(inner)) o[key] = SECRET_MASK;
    }
  };
  byName(copy);
  for (const field of asFields(fields)) {
    if (field.templateOptions?.type !== 'password' || typeof field.key !== 'string' || !field.key) continue;
    if (isFilled(getIn(copy, field.key))) setIn(copy, field.key, SECRET_MASK);
  }
  return copy as T;
}

/** A notification system with the secrets of its configuration masked. */
export function maskNotificationSystem<T>(system: T): T {
  if (!isPlainObject(system)) return system;
  const config = system.systemConfiguration;
  if (!isPlainObject(config)) return system;
  return { ...system, systemConfiguration: { ...config, data: maskFormValues(config.data, config.fields) } } as T;
}

const parseJsonText = (text: unknown, fallback: unknown): unknown => {
  try {
    return typeof text === 'string' && text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** A source system with the secrets of its configuration (JSON in a text, with its form) masked. */
export function maskSourceSystem<T>(system: T): T {
  if (!isPlainObject(system)) return system;
  const values = parseJsonText(system.scriptConfiguration, null);
  if (!isPlainObject(values)) return system;
  const form = parseJsonText(system.scriptConfigurationForm, []);
  return { ...system, scriptConfiguration: JSON.stringify(maskFormValues(values, Array.isArray(form) ? form : [])) } as T;
}

// ---------------------------------------------------------------------------------------------
// Fingerprints

/** JSON with the keys of every object sorted, so equal data gives equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return inner;
  });
}

/** A hash of an item as read from HelloID. */
export function fingerprint(item: unknown): string {
  return createHash('sha256').update(canonicalJson(item ?? null), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Plans

export const PLAN_TTL_MS = 30 * 60 * 1000;

export interface Plan<T = unknown> {
  id: string;
  environment: string;
  /** The MCP session of the caller that made the plan. */
  sessionId: string | undefined;
  /** What the plan is for, e.g. "import" or "delete". */
  kind: string;
  /** Fingerprint per item the plan touches (key: an item key of the plan's choosing). */
  fingerprints: Record<string, string>;
  /** What the apply step needs. */
  data: T;
  createdAt: number;
  expiresAt: number;
  applied: boolean;
}

export interface NewPlan<T> {
  environment: string;
  sessionId: string | undefined;
  kind: string;
  /** The items as read from HelloID, per key; stored as fingerprints. */
  items: Record<string, unknown>;
  data: T;
}

/** Plans in memory: made by plan tools, used at most once by apply tools. */
export class PlanStore {
  private readonly plans = new Map<string, Plan>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PLAN_TTL_MS;
  }

  create<T>(plan: NewPlan<T>): Plan<T> {
    this.prune();
    const createdAt = this.now();
    const stored: Plan<T> = {
      id: randomUUID(),
      environment: plan.environment,
      sessionId: plan.sessionId,
      kind: plan.kind,
      fingerprints: Object.fromEntries(Object.entries(plan.items).map(([key, item]) => [key, fingerprint(item)])),
      data: plan.data,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      applied: false,
    };
    this.plans.set(stored.id, stored);
    return stored;
  }

  /** Expired plans are removed (applied ones too: they can never be used again). */
  private prune(): void {
    const now = this.now();
    for (const [id, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(id);
  }

  /**
   * The plan for an apply step. Throws RefusedError when it does not exist, has expired, was
   * applied already, belongs to another environment or kind, or was made in another MCP session.
   */
  get<T = unknown>(id: string, expect: { environment: string; sessionId: string | undefined; kind: string }): Plan<T> {
    const plan = this.plans.get(id);
    if (!plan) throw new RefusedError(`Refused: there is no plan '${id}' (plans live 30 minutes and are lost on a restart). Plan again.`);
    if (plan.expiresAt <= this.now()) {
      this.plans.delete(id);
      throw new RefusedError(`Refused: plan '${id}' has expired (plans live 30 minutes). Plan again.`);
    }
    if (plan.applied) throw new RefusedError(`Refused: plan '${id}' was applied already; a plan is applied at most once.`);
    if (plan.environment !== expect.environment) {
      throw new RefusedError(`Refused: plan '${id}' is for environment '${plan.environment}', not '${expect.environment}'.`);
    }
    if (plan.kind !== expect.kind) throw new RefusedError(`Refused: plan '${id}' is a ${plan.kind} plan, not a ${expect.kind} plan.`);
    if (plan.sessionId !== expect.sessionId) throw new RefusedError(`Refused: plan '${id}' was made in another MCP session. Plan again.`);
    return plan as Plan<T>;
  }

  /**
   * Compares the items as read again from HelloID with the plan's fingerprints. Throws RefusedError
   * (and drops the plan) when any item changed, appeared or went away.
   */
  verify(plan: Plan, currentItems: Record<string, unknown>): void {
    const changed: string[] = [];
    const keys = new Set([...Object.keys(plan.fingerprints), ...Object.keys(currentItems)]);
    for (const key of keys) {
      const before = plan.fingerprints[key];
      const now = key in currentItems ? fingerprint(currentItems[key]) : undefined;
      if (before !== now) changed.push(key);
    }
    if (changed.length > 0) {
      this.plans.delete(plan.id);
      throw new RefusedError(`Refused: HelloID changed since the plan (${changed.join(', ')}); plan again.`);
    }
  }

  /** Marks a plan as applied; call this before running it, so it can never run twice. */
  markApplied(plan: Plan): void {
    const stored = this.plans.get(plan.id);
    if (!stored || stored.applied) throw new RefusedError(`Refused: plan '${plan.id}' was applied already; a plan is applied at most once.`);
    stored.applied = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Locks

/** One write at a time per environment: apply and delete run inside run(); others wait their turn. */
export class EnvironmentLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(environment: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(environment) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(environment, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(environment) === tail) this.tails.delete(environment);
    }
  }

  /** Whether a write is running (or waiting) for the environment. */
  isBusy(environment: string): boolean {
    return this.tails.has(environment);
  }
}
