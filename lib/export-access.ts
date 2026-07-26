import { sql } from '@/lib/db';

export type ExportAccessLogRecord = {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  exportType: string;
  target: string | null;
  startDate: string | null;
  endDate: string | null;
  details: Record<string, any> | null;
  createdAt: string;
};

let exportAccessSchemaReady: Promise<void> | null = null;

export function ensureExportAccessSchema() {
  if (!exportAccessSchemaReady) {
    exportAccessSchemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS export_access_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          actor_user_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
          actor_name TEXT NULL,
          actor_email TEXT NULL,
          export_type TEXT NOT NULL,
          target TEXT NULL,
          start_date DATE NULL,
          end_date DATE NULL,
          details JSONB NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS export_access_logs_created_at_idx
        ON export_access_logs (created_at DESC)
      `;
    })().catch((error) => {
      exportAccessSchemaReady = null;
      throw error;
    });
  }
  return exportAccessSchemaReady;
}

function mapRow(row: any): ExportAccessLogRecord {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    exportType: row.export_type,
    target: row.target,
    startDate: row.start_date ? String(row.start_date).slice(0, 10) : null,
    endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
    details: row.details && typeof row.details === 'object' ? row.details : null,
    createdAt: row.created_at,
  };
}

export async function createExportAccessLog(input: {
  actorUserId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  exportType: string;
  target?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  details?: Record<string, any> | null;
}) {
  await ensureExportAccessSchema();
  const rows = await sql`
    INSERT INTO export_access_logs (
      actor_user_id,
      actor_name,
      actor_email,
      export_type,
      target,
      start_date,
      end_date,
      details
    )
    VALUES (
      ${input.actorUserId ?? null},
      ${input.actorName ?? null},
      ${input.actorEmail ?? null},
      ${input.exportType},
      ${input.target ?? null},
      ${input.startDate ?? null},
      ${input.endDate ?? null},
      ${input.details ? JSON.stringify(input.details) : null}::jsonb
    )
    RETURNING id, actor_user_id, actor_name, actor_email, export_type, target, start_date, end_date, details, created_at
  `;
  return mapRow(rows?.[0]);
}

export async function listExportAccessLogs(limit = 100) {
  await ensureExportAccessSchema();
  const rows = await sql`
    SELECT
      id,
      actor_user_id,
      actor_name,
      actor_email,
      export_type,
      target,
      start_date,
      end_date,
      details,
      created_at
    FROM export_access_logs
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  return (rows || []).map(mapRow);
}
