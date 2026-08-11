// lib/db.ts
import { Pool, PoolClient } from 'pg';
import type { Role, ShiftType } from './roles';

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

const rawDatabaseUrl = process.env.DATABASE_URL ?? '';
const connectionString = rawDatabaseUrl ? stripQuotes(rawDatabaseUrl) : '';

let pool: Pool | null = null;
const tableColumnCache = new Map<string, Promise<Set<string>>>();

if (connectionString) {
  try {
    pool = new Pool({ connectionString });
  } catch (error) {
    console.error('Failed to parse DATABASE_URL:', error);
    throw error;
  }
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  if (!pool) throw new Error('DATABASE_URL environment variable is not set');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Transaction rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withClient<T>(callback: (client: PoolClient) => Promise<T>) {
  if (!pool) throw new Error('DATABASE_URL environment variable is not set');
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function queryRows(text: string, values: any[] = []) {
  if (!pool) throw new Error('DATABASE_URL environment variable is not set');
  const res = await pool.query(text, values);
  return res.rows;
}

export async function getExistingColumns(tableName: string, columnNames: string[], schemaName = 'public') {
  const cacheKey = `${schemaName}.${tableName}:${columnNames.slice().sort().join(',')}`;
  if (!tableColumnCache.has(cacheKey)) {
    tableColumnCache.set(cacheKey, (async () => {
      const rows = await queryRows(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = $2
           AND column_name = ANY($3::text[])`,
        [schemaName, tableName, columnNames],
      );
      return new Set(rows.map((row: any) => row.column_name));
    })().catch((error) => {
      tableColumnCache.delete(cacheKey);
      throw error;
    }));
  }
  return tableColumnCache.get(cacheKey)!;
}

export const sql: any = async (strings: TemplateStringsArray, ...values: any[]) => {
  if (!pool) throw new Error('DATABASE_URL environment variable is not set');
  const text = strings.reduce(
    (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''),
    ''
  );
  const res = await pool.query(text, values);
  return res.rows;
};

// ── Type helpers ──────────────────────────────────────────────────────────
// Matches public.profiles exactly
export interface User {
  id:            string;
  email:         string;
  full_name:     string;        // was: name
  role:          Role;
  department_id: string | null; // was: team_id
  employee_code: string | null;
  shift_type?:   ShiftType | null;
  created_at:    string;
  updated_at:    string;
}

export interface Screenshot {
  id:           string;
  user_id:      string;
  session_id:   string | null;
  file_url:     string;
  active_app:   string | null;
  activity_pct: number;
  captured_at:  string;
  user_name?:   string;
}

export interface Session {
  id:         string;
  user_id:    string;
  started_at: string;
  ended_at:   string | null;
  duration_s: number | null;
  notes:      string | null;
  user_name?: string;
}

