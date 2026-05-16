import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';

type StatementLike = {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (query: string, options?: any) => any;
  transaction?: (fn: any) => any;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;
type BunDatabaseInstance = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: (throwOnError?: boolean) => void;
  transaction?: (fn: any) => any;
};

function loadDatabaseCtor(): DatabaseCtor {
  const require = createRequire(import.meta.url);
  try {
    const mod = require('better-sqlite3') as { default?: DatabaseCtor } | DatabaseCtor;
    return (mod as { default?: DatabaseCtor }).default ?? (mod as DatabaseCtor);
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
    const isBunIncompat = msg.includes('better-sqlite3 is not yet supported in bun') || msg.includes('not yet supported in bun');
    if (!isBunIncompat) {
      throw err;
    }
    if (!isBunRuntime) {
      throw err;
    }

    const bunSqlite = require('bun:sqlite') as { Database: new (dbPath: string) => BunDatabaseInstance };

    return class BunCompatDatabase implements DatabaseLike {
      private readonly db: BunDatabaseInstance;

      constructor(dbPath: string) {
        this.db = new bunSqlite.Database(dbPath);
      }

      prepare(sql: string): StatementLike {
        return this.db.prepare(sql);
      }

      exec(sql: string): void {
        this.db.exec(sql);
      }

      close(): void {
        this.db.close();
      }

      transaction(fn: any): any {
        if (!this.db.transaction) {
          return undefined;
        }
        return this.db.transaction(fn);
      }
    };
  }
}

const Database = loadDatabaseCtor();

export class DatabaseManager {
  private db: DatabaseLike | null = null;
  private readonly dbPath: string;

  constructor(memoryDir: string) {
    this.dbPath = path.join(memoryDir, 'sessions.db');
  }

  /**
   * Get the database instance. Creates/opens on first call.
   */
  getDb(): DatabaseLike {
    if (!this.db) {
      this.db = this.open();
    }
    return this.db;
  }

  /**
   * Open the database and initialize schema.
   */
  private open(): DatabaseLike {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database(this.dbPath);

    // Enable WAL mode + FK enforcement for each connection.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    // Create tables and triggers
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacyMemoriesCategoryError(err)) {
        throw err;
      }

      // Legacy DB from pre-v0.6 can have memories table without the category
      // and failure metadata columns. Add missing columns, then retry schema.
      this.ensureMemoriesColumns(db);
      db.exec(SCHEMA_SQL);
    }

    // Extra safety: always ensure legacy memories columns exist, then migrate
    // legacy CHECK(target IN ('memory','user')) constraints to include 'failure'.
    this.ensureMemoriesColumns(db);
    this.migrateLegacyMemoriesTargetConstraint(db);
    this.rebuildMemoryFts(db);

    // Migrate FTS tables to Porter stemmer if they still use the old default tokenizer.
    this.migrateFtsTokenizer(db, 'message_fts', SCHEMA_SQL);
    this.migrateFtsTokenizer(db, 'memory_fts', SCHEMA_SQL);

    return db;
  }

  private isLegacyMemoriesCategoryError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category') || msg.includes('memories(category)');
  }

  private ensureMemoriesColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const columns = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('category')) {
      db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
    }
    if (!names.has('failure_reason')) {
      db.exec('ALTER TABLE memories ADD COLUMN failure_reason TEXT');
    }
    if (!names.has('tool_state')) {
      db.exec('ALTER TABLE memories ADD COLUMN tool_state TEXT');
    }
    if (!names.has('corrected_to')) {
      db.exec('ALTER TABLE memories ADD COLUMN corrected_to TEXT');
    }
  }

  private migrateLegacyMemoriesTargetConstraint(db: DatabaseLike): void {
    const tableSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (!tableSql) return;

    // Legacy schema allowed only memory/user. New schema must allow failure too.
    const hasLegacyTargetCheck = /target\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*target\s+IN\s*\(\s*'memory'\s*,\s*'user'\s*\)\s*\)/i.test(tableSql);
    if (!hasLegacyTargetCheck) return;

    if (!db.transaction) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(`
          CREATE TABLE memories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
            category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
            content TEXT NOT NULL,
            failure_reason TEXT,
            tool_state TEXT,
            corrected_to TEXT,
            created DATE NOT NULL,
            last_referenced DATE NOT NULL
          );
        `);

        db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

        db.exec('DROP TABLE memories');
        db.exec('ALTER TABLE memories_new RENAME TO memories');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      return;
    }

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
          category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);

      db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

      db.exec('DROP TABLE memories');
      db.exec('ALTER TABLE memories_new RENAME TO memories');
    });

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private rebuildMemoryFts(db: DatabaseLike): void {
    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get() as { name?: string } | undefined;
    if (!ftsTable) return;

    // Keep FTS index consistent after table rebuild/migrations.
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  /**
   * Migrate an FTS5 virtual table from the default unicode61 tokenizer to
   * porter unicode61 if it was created with the old schema.
   *
   * Detects the old tokenizer by inspecting sqlite_master.sql for the absence
   * of 'tokenize='. If the table needs migration, it is dropped along with
   * its sync triggers, recreated with the new tokenizer, and rebuilt.
   */
  private migrateFtsTokenizer(db: DatabaseLike, tableName: string, schemaSql: string): void {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
    ).get(tableName) as { sql: string } | undefined;

    if (!row) return; // Table doesn't exist yet — fresh schema will create it

    // Already has the new tokenizer — nothing to do
    if (row.sql.includes("tokenize='porter unicode61'")) return;

    // Need to rebuild: extract the CREATE statement matching this table
    // from SCHEMA_SQL so we stay in sync with whatever the current schema says.
    const createMatch = schemaSql.match(
      new RegExp(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}[^;]+;`, 'i')
    );
    if (!createMatch) return;
    const newCreateSql = createMatch[0];

    // Drop old sync triggers (named <table>_ai, _ad, _au)
    const prefix = tableName.replace(/_fts$/, 's'); // message_fts → messages, memory_fts → memories
    for (const suffix of ['_ai', '_ad', '_au']) {
      const triggerName = `${prefix}${suffix}`;
      try {
        db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
      } catch {
        // Best-effort
      }
    }

    // Drop the old FTS virtual table
    try {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    } catch {
      return; // Can't proceed if drop fails
    }

    // Recreate with new tokenizer (from current SCHEMA_SQL)
    db.exec(newCreateSql);

    // Recreate sync triggers (also from SCHEMA_SQL)
    // Extract all trigger CREATE statements for this table from SCHEMA_SQL
    const triggerRe = new RegExp(
      `CREATE TRIGGER IF NOT EXISTS ${prefix}_[a-z]+ AFTER (INSERT|DELETE|UPDATE) ON ${prefix}[^;]+;`,
      'gi'
    );
    let triggerMatch;
    while ((triggerMatch = triggerRe.exec(schemaSql)) !== null) {
      try {
        db.exec(triggerMatch[0]);
      } catch {
        // Best-effort per trigger
      }
    }

    // Rebuild the FTS index from the source table
    try {
      db.exec(`INSERT INTO ${tableName}(${tableName}) VALUES('rebuild')`);
    } catch {
      // Best-effort rebuild — next INSERT will populate incrementally
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Check if the database file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Get stats about the database.
   */
  getStats(): { sessions: number; messages: number; memories: number } {
    const db = this.getDb();
    const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    return {
      sessions: sessions.count,
      messages: messages.count,
      memories: memories.count,
    };
  }
}
