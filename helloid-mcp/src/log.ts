// Logging to stderr only: stdout stays free, and nothing here may contain a secret (callers pass
// messages without cookies, tokens or passwords).

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function write(level: LogLevel, message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
}

export const stderrLogger: Logger = {
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message) => write('error', message),
};

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The message of an error, for logs and tool results. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
