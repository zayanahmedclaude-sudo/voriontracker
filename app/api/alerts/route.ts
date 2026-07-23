// app/api/alerts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok } from '@/lib/api';
import { canSendAlerts } from '@/lib/auth';
import { emitSocketEvent } from '@/lib/socket';

async function getAlertColumns() {
  try {
    const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'alerts'`;
    return new Set<string>(rows.map((row: any) => String(row.column_name)));
  } catch (error) {
    console.warn('Unable to inspect alerts table schema', error);
    return new Set<string>();
  }
}

function hasModernAlertSchema(columns: Set<string>) {
  return columns.has('employee_id') && columns.has('alert_type') && columns.has('title') && columns.has('description');
}

function normalizeAlertRow(row: any, columns: Set<string>) {
  if (!row) return null;

  const hasModernSchema = hasModernAlertSchema(columns);
  const hasIsReadColumn = columns.has('is_read');
  const inferredReadState = hasIsReadColumn ? row.is_read : row.status === 'read';

  if (hasModernSchema) {
    return {
      id: row.id,
      employee_id: row.employee_id,
      alert_type: row.alert_type,
      title: row.title ?? 'Alert',
      description: row.description ?? '',
      severity: row.severity ?? 'medium',
      status: row.status ?? 'open',
      metadata: row.metadata ?? {},
      is_read: Boolean(inferredReadState ?? false),
      created_at: row.created_at ?? row.sent_at,
      sent_at: row.sent_at ?? row.created_at,
    };
  }

  return {
    id: row.id,
    employee_id: row.to_user_id ?? row.employee_id ?? null,
    alert_type: row.alert_type ?? 'legacy_alert',
    title: 'Alert',
    description: row.message ?? '',
    severity: 'medium',
    status: 'open',
    metadata: row.metadata ?? {},
    is_read: Boolean(row.is_read ?? false),
    created_at: row.created_at ?? row.sent_at,
    sent_at: row.sent_at ?? row.created_at,
  };
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  if (!canSendAlerts(user.role)) return NextResponse.json({ error: 'No permission to send alerts' }, { status: 403 });

  const body = await req.json();

  const {
    employee_id: requestedEmployeeId,
    alert_type,
    title,
    description,
    severity = 'medium',
    metadata = {},
  } = body;

  // Alerts are always one-to-one. Normalize the requested recipient once and
  // use that value for both persistence and real-time delivery so an empty or
  // malformed recipient can never fall through to a broadcast.
  const employee_id = typeof requestedEmployeeId === 'string' ? requestedEmployeeId.trim() : '';

  const missing = {
    employee_id: employee_id ?? null,
    alert_type: alert_type ?? null,
    title: title ?? null,
    description: description ?? null,
    severity: severity ?? null,
  };

  const invalidFields: Record<string, boolean> = {};
  if (!employee_id) invalidFields.employee_id = true;
  if (!alert_type) invalidFields.alert_type = true;
  if (!title) invalidFields.title = true;
  if (!description) invalidFields.description = true;

  if (Object.keys(invalidFields).length) {
    return NextResponse.json({ message: 'Validation failed', missing }, { status: 400 });
  }

  const recipients = await sql`
    SELECT id
    FROM profiles
    WHERE id = ${employee_id} AND role = 'employee'
    LIMIT 1
  `;
  if (!recipients.length) {
    return NextResponse.json({ error: 'Selected employee was not found' }, { status: 404 });
  }

  const columns = await getAlertColumns();
  const hasModernSchema = hasModernAlertSchema(columns);

  let inserted: any;

  if (hasModernSchema) {
    [inserted] = await sql`
      INSERT INTO alerts (
        employee_id,
        alert_type,
        title,
        description,
        severity,
        status,
        metadata
      )
      VALUES (
        ${employee_id},
        ${alert_type},
        ${title},
        ${description},
        ${severity},
        'open',
        ${metadata}
      )
      RETURNING id
    `;
  } else {
    [inserted] = await sql`
      INSERT INTO alerts (
        from_user_id,
        to_user_id,
        message,
        is_read,
        sent_at
      )
      VALUES (
        ${user.sub},
        ${employee_id},
        ${description},
        false,
        NOW()
      )
      RETURNING id
    `;
  }

  try {
    await emitSocketEvent('new-alert', {
      id: inserted.id,
      employee_id,
      alert_type,
      title,
      description,
      severity,
      metadata,
    }, { toEmployeeId: employee_id });
  } catch (e) {
    console.error('Socket alert delivery failed', e);
  }

  return ok({ success: true, id: inserted.id }, 201);
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const columns = await getAlertColumns();
  const hasModernSchema = hasModernAlertSchema(columns);
  const hasIsReadColumn = columns.has('is_read');
  const hasCreatedAtColumn = columns.has('created_at');

  let alerts: any[];

  if (hasModernSchema) {
    if (hasIsReadColumn) {
      alerts = await sql`
        SELECT id, employee_id, alert_type, title, description, severity, status, metadata, is_read, created_at, sent_at
        FROM alerts
        WHERE employee_id = ${user.sub}
        ORDER BY COALESCE(sent_at, created_at, NOW()) DESC
        LIMIT 20
      `;
    } else {
      alerts = await sql`
        SELECT id, employee_id, alert_type, title, description, severity, status, metadata, created_at, sent_at
        FROM alerts
        WHERE employee_id = ${user.sub}
        ORDER BY COALESCE(sent_at, created_at, NOW()) DESC
        LIMIT 20
      `;
    }
  } else {
    alerts = hasCreatedAtColumn
      ? await sql`
          SELECT id, from_user_id, to_user_id, message, is_read, sent_at, created_at
          FROM alerts
          WHERE to_user_id = ${user.sub}
          ORDER BY COALESCE(sent_at, created_at, NOW()) DESC
          LIMIT 20
        `
      : await sql`
          SELECT id, from_user_id, to_user_id, message, is_read, sent_at, NULL AS created_at
          FROM alerts
          WHERE to_user_id = ${user.sub}
          ORDER BY COALESCE(sent_at, NOW()) DESC
          LIMIT 20
        `;
  }

  return ok(alerts.map((row) => normalizeAlertRow(row, columns)));
}
