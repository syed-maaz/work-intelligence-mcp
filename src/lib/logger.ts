/**
 * Structured JSON logger — writes to stderr so it doesn't pollute stdout.
 * All log entries are newline-delimited JSON for easy parsing.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function _write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ level, msg, ts: new Date().toISOString(), ...meta }) + '\n'
  );
}

export const logger = {
  info:  (msg: string, meta?: Record<string, unknown>) => _write('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => _write('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => _write('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => _write('debug', msg, meta),
};
