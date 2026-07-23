export const dynamic = 'force-dynamic';
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';

function hasModernAlertSchema(columns: Set<string>) {
  return columns.has('employee_id') && columns.has('alert_type') && columns.has('title') && columns.has('description');
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { params } = context;
  const resolvedParams = await params;
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const columns = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'alerts'`;
    const names = new Set<string>(columns.map((row: any) => String(row.column_name)));
    const hasModernSchema = hasModernAlertSchema(names);
    const hasIsReadColumn = names.has('is_read');
    const hasStatusColumn = names.has('status');
    const hasCreatedAtColumn = names.has('created_at');

    let updated: any[];

    if (hasModernSchema) {
      if (hasIsReadColumn) {
        updated = await sql`
          UPDATE alerts
          SET is_read = true
          WHERE id = ${resolvedParams.id} AND employee_id = ${user.sub}
          RETURNING id, employee_id, alert_type, title, description, severity, status, metadata, is_read, created_at, sent_at
        `;
      } else if (hasStatusColumn) {
        updated = await sql`
          UPDATE alerts
          SET status = 'read'
          WHERE id = ${resolvedParams.id} AND employee_id = ${user.sub}
          RETURNING id, employee_id, alert_type, title, description, severity, status, metadata, created_at, sent_at
        `;
        updated = updated.map((row: any) => ({ ...row, is_read: true }));
      } else {
        updated = await sql`
          SELECT id, employee_id, alert_type, title, description, severity, metadata, created_at, sent_at
          FROM alerts
          WHERE id = ${resolvedParams.id} AND employee_id = ${user.sub}
        `;
        updated = updated.map((row: any) => ({ ...row, is_read: true }));
      }
    } else {
      updated = hasCreatedAtColumn
        ? await sql`
            UPDATE alerts
            SET is_read = true
            WHERE id = ${resolvedParams.id} AND to_user_id = ${user.sub}
            RETURNING id, from_user_id, to_user_id, message, is_read, sent_at, created_at
          `
        : await sql`
            UPDATE alerts
            SET is_read = true
            WHERE id = ${resolvedParams.id} AND to_user_id = ${user.sub}
            RETURNING id, from_user_id, to_user_id, message, is_read, sent_at, NULL AS created_at
          `;
    }

    if (!updated.length) return err('Alert not found', 404);
    return ok(updated[0]);
  } catch (error: any) {
    console.error('PATCH /api/alerts/[id] error:', error?.message || error);
    return err(error?.message || 'Failed to update alert', 500);
  }
}
