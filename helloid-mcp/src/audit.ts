// The audit log: one file per day, <audit.dir>/YYYY-MM-DD.jsonl (UTC date), append only, one line
// per tool call. Never contains cookies, tokens or passwords: arguments and changes are masked
// before they are written.

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactTokens } from './helloid/client.ts';
import type { Logger } from './log.ts';
import { SECRET_MASK, SECRET_NAME } from './safety.ts';

export type AuditResult = 'ok' | 'refused' | 'error';

/** The before and after of one item changed by an apply or delete. */
export interface AuditChange {
  /** What the item is, e.g. "target system 'AFAS' (id)". */
  item: string;
  before: unknown;
  after: unknown;
}

export interface AuditEntry {
  /** ISO time, UTC. */
  time: string;
  sessionId: string | null;
  environment: string | null;
  tool: string;
  arguments: unknown;
  result: AuditResult;
  summary: string;
  changes?: AuditChange[];
}

/** Strings longer than this (file contents) are replaced by their size and SHA-256. */
export const LARGE_STRING = 4096;

/**
 * A copy of `value` that is safe to write: values whose name says they are secrets are masked,
 * JWTs are replaced, and large strings become { size, sha256 }.
 */
export function maskForAudit(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_NAME.test(key) && (value === null || typeof value !== 'object')) {
    return value === null || value === '' ? value : SECRET_MASK;
  }
  if (typeof value === 'string') {
    if (value.length > LARGE_STRING) {
      const bytes = Buffer.byteLength(value, 'utf8');
      return { size: bytes, sha256: createHash('sha256').update(value, 'utf8').digest('hex') };
    }
    return redactTokens(value);
  }
  if (Array.isArray(value)) return value.map((item) => maskForAudit(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskForAudit(v, k)]));
  }
  return value;
}

export interface AuditWriter {
  write(entry: Omit<AuditEntry, 'time'>): Promise<void>;
}

export class AuditLog implements AuditWriter {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly logger: Logger;
  private queue: Promise<void> = Promise.resolve();

  constructor(dir: string, options: { now?: () => number; logger: Logger }) {
    this.dir = dir;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  /** The file of a day. */
  fileFor(time: Date): string {
    return join(this.dir, `${time.toISOString().slice(0, 10)}.jsonl`);
  }

  /**
   * Appends one line. Lines are written one after the other. A failure to write is logged to
   * stderr; it does not fail the tool call.
   */
  write(entry: Omit<AuditEntry, 'time'>): Promise<void> {
    const time = new Date(this.now());
    const line: AuditEntry = {
      time: time.toISOString(),
      sessionId: entry.sessionId,
      environment: entry.environment,
      tool: entry.tool,
      arguments: maskForAudit(entry.arguments),
      result: entry.result,
      summary: redactTokens(entry.summary),
      ...(entry.changes ? { changes: entry.changes.map((change) => maskForAudit(change) as AuditChange) } : {}),
    };
    const text = `${JSON.stringify(line)}\n`;
    const file = this.fileFor(time);
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(file, text, 'utf8');
      })
      .catch((error: unknown) => {
        this.logger.error(`Could not write the audit log ${file}: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.queue;
  }
}
