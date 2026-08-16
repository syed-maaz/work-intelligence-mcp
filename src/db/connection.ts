import Database from 'better-sqlite3';
import { initializeDatabase, createBackup } from './schema.js';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { getDatabasePath as getConfiguredDatabasePath } from '../services/wi-config.js';

let dbInstance: Database.Database | null = null;

// Signal handlers registered once at module load time, not inside the factory.
// Registering inside getDatabase() would double-register them in tests that
// reset the singleton, triggering Node's MaxListenersExceededWarning.
process.on('exit', () => { closeDatabase(); });
process.on('SIGINT', () => { closeDatabase(); process.exit(0); });
process.on('SIGTERM', () => { closeDatabase(); process.exit(0); });

export interface DatabaseConfig {
  path: string;
  readonly?: boolean;
  enableWAL?: boolean;
  busyTimeout?: number;
}

export function getDatabase(config?: DatabaseConfig): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const defaultPath = getConfiguredDatabasePath();
  const databasePath = process.env.DATABASE_PATH || config?.path || defaultPath;
  const databaseDir = path.dirname(databasePath);

  // Ensure database directory exists
  if (!existsSync(databaseDir)) {
    mkdirSync(databaseDir, { recursive: true });
  }

  dbInstance = new Database(databasePath, {
    readonly: config?.readonly || false,
    fileMustExist: false,
  });

  // Configure database
  if (config?.busyTimeout) {
    dbInstance.pragma(`busy_timeout = ${config.busyTimeout}`);
  } else {
    dbInstance.pragma('busy_timeout = 5000');
  }

  // WAL mode unconditionally — better concurrent read/write performance.
  // This must run before initializeDatabase() so migrations see WAL mode.
  // The config.enableWAL flag is kept for backward compat but WAL is always on.
  dbInstance.pragma('journal_mode = WAL');

  // Initialize schema
  initializeDatabase(dbInstance);

  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      dbInstance = null;
    } catch (error) {
      console.error('Error closing database:', error);
    }
  }
}

export function isConnected(): boolean {
  return dbInstance !== null && dbInstance.open;
}

export interface TransactionOptions {
  immediate?: boolean;
}

export function transaction<T>(
  db: Database.Database,
  callback: () => T,
  options?: TransactionOptions
): T {
  if (options?.immediate) {
    return db.transaction(callback).immediate();
  }
  return db.transaction(callback)();
}

export function backupDatabase(backupPath?: string): void {
  const db = getDatabase();
  const backupLocation = backupPath || path.join(
    path.dirname(getConfiguredDatabasePath()),
    'backups',
    `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
  );

  const backupDir = path.dirname(backupLocation);
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  createBackup(db, backupLocation);
}

export function getDatabasePath(): string | null {
  return dbInstance ? (dbInstance as Database.Database & { name: string }).name : null;
}
