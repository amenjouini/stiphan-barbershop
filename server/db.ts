import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.ts';

let db: DatabaseSync | null = null;
const statements = new Map<string, StatementSync>();

export function getDb(): DatabaseSync {
  if (db) return db;
  if (config.databasePath !== ':memory:') fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function closeDb() {
  statements.clear();
  db?.close();
  db = null;
}

/** Applies every server/migrations/*.sql file once, in filename order. */
function migrate(d: DatabaseSync) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir = path.join(ROOT, 'server', 'migrations');
  const applied = new Set(d.prepare('SELECT name FROM schema_migrations').all().map((r: any) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      d.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      d.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      d.exec('COMMIT');
      if (!config.isTest) console.log(`[db] applied migration ${file}`);
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  }
}

function stmt(sql: string) {
  let s = statements.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

const bind = (params: unknown[]) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];

export const all = <T = any>(sql: string, ...params: unknown[]): T[] => stmt(sql).all(...bind(params)) as T[];
export const get = <T = any>(sql: string, ...params: unknown[]): T | undefined => stmt(sql).get(...bind(params)) as T | undefined;
export const run = (sql: string, ...params: unknown[]) => {
  const r = stmt(sql).run(...bind(params));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};

let depth = 0;
/** Runs fn inside a write transaction (BEGIN IMMEDIATE). Nested calls join the outer one. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

/** Builds "?, ?, ?" for IN (...) clauses. */
export const marks = (n: number) => Array(n).fill('?').join(',');
