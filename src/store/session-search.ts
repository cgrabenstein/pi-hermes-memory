import { DatabaseManager } from './db.js';
import { buildFts5Query } from './fts5-query.js';

/**
 * Search result from session history.
 */
export interface SessionSearchResult {
  sessionId: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}

/**
 * Search options for session search.
 */
export interface SessionSearchOptions {
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Filter by project name */
  project?: string;
  /** Filter by role: 'user', 'assistant', 'system' */
  role?: string;
  /** Only return messages after this date (ISO string) */
  since?: string;
}

/**
 * Search across indexed session messages using FTS5.
 *
 * @param dbManager — Database manager instance
 * @param query — FTS5 search query
 * @param options — Search options
 * @returns Array of search results with snippets
 */
export function searchSessions(
  dbManager: DatabaseManager,
  query: string,
  options: SessionSearchOptions = {}
): SessionSearchResult[] {
  const db = dbManager.getDb();
  const { limit = 10, project, role, since } = options;

  // Build the query dynamically based on filters
  const conditions: string[] = [];
  const params: unknown[] = [];

  // FTS5 match condition — use JOIN + MATCH on the FTS table for BM25 ranking.
  // The FTS table name must be used literally (not aliased) for bm25() to work.
  conditions.push('message_fts MATCH ?');
  params.push(buildFts5Query(query));

  // Project filter
  if (project) {
    conditions.push('s.project = ?');
    params.push(project);
  }

  // Role filter
  if (role) {
    conditions.push('m.role = ?');
    params.push(role);
  }

  // Date filter
  if (since) {
    conditions.push('m.timestamp >= ?');
    params.push(since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      m.session_id,
      s.project,
      m.role,
      m.content,
      m.timestamp,
      m.content as snippet
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    JOIN message_fts ON message_fts.rowid = m.rowid
    ${whereClause}
    ORDER BY bm25(message_fts)
    LIMIT ?
  `;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      session_id: string;
      project: string;
      role: string;
      content: string;
      timestamp: string;
      snippet: string;
    }>;

    // Map snake_case column names to camelCase
    return rows.map(row => ({
      sessionId: row.session_id,
      project: row.project,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      snippet: row.snippet,
    }));
  } catch (err) {
    // FTS5 can throw on malformed queries — return empty results
    return [];
  }
}

/**
 * Get the total number of indexed messages.
 */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}
