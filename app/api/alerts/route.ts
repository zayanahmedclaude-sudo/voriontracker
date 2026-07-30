// app/api/alerts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getExistingColumns, queryRows, sql } from '@/lib/db';
import { requireAuth, ok, err, getErrorMessage } from '@/lib/api';
import { canSendAlerts } from '@/lib/auth';
import { emitSocketEvent } from '@/lib/socket';

export const dynamic = 'force-dynamic';

const ALERT_COLUMNS = [
  'id',
  'employee_id',
  'alert_type',
  'title',
  'description',
  'severity',
  'status',
  'metadata',
  'is_read',
  'created_at',
  'sent_at',
  'from_user_id',
  'to_user_id',
  'message',
];

async function getAlertColumns() {
  // Cache this metadata per warm function instance. The desktop agent polls
  // this endpoint frequently, so querying information_schema on every request
  // adds avoidable database traffic.
  return getExistingColumns('alerts', ALERT_COLUMNS);
}

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

function timestampOrder(columns: Set<string>) {
  const parts = [];
  if (columns.has('sent_at')) parts.push('sent_at');
  if (columns.has('created_at')) parts.push('created_at');
  parts.push('NOW()');

  return `COALESCE(${parts.join(', ')}) DESC`;
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
    const insertColumns = ['employee_id', 'alert_type', 'title', 'description'];
    const insertValues = [employee_id, alert_type, title, description];

    if (columns.has('severity')) {
      insertColumns.push('severity');
      insertValues.push(severity);
    }
    if (columns.has('status')) {
      insertColumns.push('status');
      insertValues.push('open');
    }
    if (columns.has('metadata')) {
      insertColumns.push('metadata');
      insertValues.push(metadata);
    }

    const placeholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');
    [inserted] = await queryRows(
      `INSERT INTO alerts (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      insertValues,
    );
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

  const alertPayload = {
    id: inserted.id,
    employee_id,
    alert_type,
    title,
    description,
    severity,
    status: 'open',
    metadata,
    is_read: false,
    sent_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  await emitSocketEvent('new-alert', alertPayload, { toEmployeeId: employee_id });

  return ok({ success: true, id: inserted.id, alert: alertPayload }, 201);
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  try {
    const columns = await getAlertColumns();
    const hasModernSchema = hasModernAlertSchema(columns);
    const hasIsReadColumn = columns.has('is_read');
    const { createdAt, sentAt } = timestampSelect(columns);
    const orderByTimestamp = timestampOrder(columns);

    let alerts: any[];

    if (hasModernSchema) {
      alerts = await queryRows(
        `
        SELECT ${modernAlertSelect(columns, hasIsReadColumn)}
        FROM alerts
        WHERE employee_id = $1
        ORDER BY ${orderByTimestamp}
        LIMIT 20
        `,
        [user.sub],
      );
    } else {
      alerts = await queryRows(
        `
        SELECT id, from_user_id, to_user_id, message, is_read, ${sentAt}, ${createdAt}
        FROM alerts
        WHERE to_user_id = $1
        ORDER BY ${orderByTimestamp}
        LIMIT 20
        `,
        [user.sub],
      );
    }

    return ok(alerts.map((row) => normalizeAlertRow(row, columns)));
  } catch (error) {
    console.error('GET /api/alerts error:', error);
    return err(getErrorMessage(error, 'Failed to load alerts'), 500);
  }
}
