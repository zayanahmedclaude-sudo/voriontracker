export const dynamic = 'force-dynamic';
import { NextRequest } from 'next/server';
import { queryRows, sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';

function hasModernAlertSchema(columns: Set<string>) {
  return columns.has('employee_id') && columns.has('alert_type') && columns.has('title') && columns.has('description');
}

function timestampSelect(columns: Set<string>) {
  const createdAt = columns.has('created_at') ? 'created_at' : 'NULL AS created_at';
  const sentAt = columns.has('sent_at')
    ? 'sent_at'
    : columns.has('created_at')
      ? 'created_at AS sent_at'
      : 'NULL AS sent_at';

  return { createdAt, sentAt };
}

function modernAlertSelect(columns: Set<string>, includeIsRead: boolean) {
  return [
    'id',
    'employee_id',
    'alert_type',
    'title',
    'description',
    columns.has('severity') ? 'severity' : "'medium' AS severity",
    columns.has('status') ? 'status' : "'open' AS status",
    columns.has('metadata') ? 'metadata' : "'{}'::jsonb AS metadata",
    includeIsRead ? 'is_read' : 'NULL AS is_read',
    timestampSelect(columns).createdAt,
    timestampSelect(columns).sentAt,
  ].join(', ');
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { params } = context;
  const resolvedParams = await params;
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const columns = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alerts'`;
    const names = new Set<string>(columns.map((row: any) => String(row.column_name)));
    const hasModernSchema = hasModernAlertSchema(names);
    const hasIsReadColumn = names.has('is_read');
    const hasStatusColumn = names.has('status');
    const modernSelect = modernAlertSelect(names, hasIsReadColumn);
    const legacyTimestamps = timestampSelect(names);

    let updated: any[];

    if (hasModernSchema) {
      if (hasIsReadColumn) {
        updated = await queryRows(
          `
          UPDATE alerts
          SET is_read = true
          WHERE id = $1 AND employee_id = $2
          RETURNING ${modernSelect}
          `,
          [resolvedParams.id, user.sub],
        );
      } else if (hasStatusColumn) {
        updated = await queryRows(
          `
          UPDATE alerts
          SET status = 'read'
          WHERE id = $1 AND employee_id = $2
          RETURNING ${modernSelect}
          `,
          [resolvedParams.id, user.sub],
        );
        updated = updated.map((row: any) => ({ ...row, is_read: true }));
      } else {
        updated = await queryRows(
          `
          SELECT ${modernSelect}
          FROM alerts
          WHERE id = $1 AND employee_id = $2
          `,
          [resolvedParams.id, user.sub],
        );
        updated = updated.map((row: any) => ({ ...row, is_read: true }));
      }
    } else {
      updated = await queryRows(
        `
        UPDATE alerts
        SET is_read = true
        WHERE id = $1 AND to_user_id = $2
        RETURNING id, from_user_id, to_user_id, message, is_read, ${legacyTimestamps.sentAt}, ${legacyTimestamps.createdAt}
        `,
        [resolvedParams.id, user.sub],
      );
    }

    if (!updated.length) return err('Alert not found', 404);
    return ok(updated[0]);
  } catch (error: any) {
    console.error('PATCH /api/alerts/[id] error:', error?.message || error);
    return err(error?.message || 'Failed to update alert', 500);
  }
}
