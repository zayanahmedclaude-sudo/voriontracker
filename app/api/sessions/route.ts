// app/api/sessions/route.ts
import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { requireAuth, ok, err } from '@/lib/api';
import { emitSocketEvent } from '@/lib/socket';
import { clampLimit } from '@/lib/request-security';
import { canMonitorAll, normalizeRole } from '@/lib/roles';
import { BUSINESS_TIME_ZONE, getAutoCheckoutCutoffForTimestamp } from '@/lib/shifts';

function employeeStatusPayload(user: any, status: string, appName?: string | null) {
  const timestamp = new Date().toISOString();
  return {
    employeeId: user.sub,
    employeeName: user.name,
    status,
    currentApp: appName || null,
    lastActivity: timestamp,
    timestamp,
  };
}

async function reconcileAutomaticCheckout(employeeId: string) {
  const openRows = await sql`
    SELECT id, check_in
    FROM attendance
    WHERE employee_id = ${employeeId}
      AND check_out IS NULL
    ORDER BY check_in ASC
  `;

  let closedCount = 0;
  const now = Date.now();
  for (const row of openRows || []) {
    const cutoff = getAutoCheckoutCutoffForTimestamp(row.check_in, BUSINESS_TIME_ZONE);
    const checkIn = new Date(row.check_in);
    if (cutoff.getTime() > now || cutoff.getTime() <= checkIn.getTime()) continue;

    await sql`
      UPDATE breaks
      SET end_time = ${cutoff},
          duration_minutes = GREATEST(
            0,
            CEIL(EXTRACT(EPOCH FROM (${cutoff}::timestamptz - start_time)) / 60)::int
          )
      WHERE attendance_id = ${row.id}
        AND end_time IS NULL
    `;
    await sql`
      UPDATE attendance
      SET check_out = ${cutoff},
          total_minutes = GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (${cutoff}::timestamptz - check_in)) / 60)::int
          ),
          status = 'checked_out'
      WHERE id = ${row.id}
        AND check_out IS NULL
    `;
    closedCount += 1;
  }

  if (closedCount > 0) {
    await sql`
      INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
      VALUES(${employeeId}, 'checked_out', NULL, NOW(), NOW())
      ON CONFLICT (employee_id) DO UPDATE
      SET current_status = 'checked_out', current_app = NULL, last_activity = NOW(), updated_at = NOW()
    `;
  }
  return closedCount;
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;

  const { action, sessionId, appName } = await req.json();
  // NOTE: "sessionId" here is actually the attendance.id, kept as the same
  // field name the client already sends to avoid changing the agent code.

  try {
    if (action === 'reconcile_auto_checkout') {
      const closedCount = await reconcileAutomaticCheckout(user.sub);
      if (closedCount > 0) {
        await emitSocketEvent('employee-status', employeeStatusPayload(user, 'checked_out', null), { toAdmins: true });
        await emitSocketEvent('employee-checked-out', employeeStatusPayload(user, 'checked_out', null), { toAdmins: true });
      }
      return ok({ ok: true, checkedOut: closedCount > 0, closedCount });
    }

    if (action === 'start') {
      await reconcileAutomaticCheckout(user.sub);
      const openRows = await sql`
        SELECT
          a.id,
          a.check_in,
          es.last_activity,
          GREATEST(
            a.check_in,
            COALESCE((
              SELECT MAX(s.captured_at)
              FROM screenshots s
              WHERE s.session_id = a.id
            ), a.check_in),
            COALESCE((
              SELECT MAX(b.start_time)
              FROM breaks b
              WHERE b.attendance_id = a.id
            ), a.check_in),
            COALESCE((
              SELECT MAX(b.end_time)
              FROM breaks b
              WHERE b.attendance_id = a.id
            ), a.check_in)
          ) AS session_last_activity
        FROM attendance a
        LEFT JOIN employee_status es ON es.employee_id = a.employee_id
        WHERE a.employee_id = ${user.sub}
          AND a.check_out IS NULL
        ORDER BY a.check_in DESC
      `;

      for (const row of openRows || []) {
        // Only trust activity that is tied to this attendance row. A fresh
        // agent login can update employee_status.last_activity long after the
        // original session was abandoned, which would otherwise inflate a
        // stale session into many fake hours.
        const effectiveEnd =
          row.session_last_activity && new Date(row.session_last_activity) > new Date(row.check_in)
            ? row.session_last_activity
            : row.check_in;

        await sql`
          UPDATE attendance
          SET check_out = ${effectiveEnd},
              total_minutes = GREATEST(
                0,
                FLOOR(EXTRACT(EPOCH FROM (${effectiveEnd}::timestamptz - check_in)) / 60)::int
              ),
              status = 'checked_out'
          WHERE id = ${row.id}
        `;
      }

      const [attendance] = await sql`
        INSERT INTO attendance(employee_id, check_in, status, created_at)
        VALUES(${user.sub}, NOW(), 'working', NOW())
        RETURNING id, check_in
      `;

      await sql`
        INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
        VALUES(${user.sub}, 'working', ${appName ?? null}, NOW(), NOW())
        ON CONFLICT (employee_id) DO UPDATE
        SET current_status = 'working', current_app = ${appName ?? null}, last_activity = NOW(), updated_at = NOW()
      `;

      await emitSocketEvent('employee-status', employeeStatusPayload(user, 'working', appName), { toAdmins: true });
      await emitSocketEvent('employee-work-started', employeeStatusPayload(user, 'working', appName), { toAdmins: true });
      // Return the attendance id under the key the agent expects: sessionId
      return ok({ sessionId: attendance.id }, 201);
    }

    if (action === 'start_break') {
      const [attendance] = await sql`
        SELECT id FROM attendance
        WHERE employee_id = ${user.sub}
          AND check_out IS NULL
        ORDER BY check_in DESC
        LIMIT 1
      `;

      if (!attendance) return err('No active attendance found', 400);

      const [brk] = await sql`
        INSERT INTO breaks(attendance_id, start_time)
        VALUES(${attendance.id}, NOW())
        RETURNING id
      `;

      await sql`
        UPDATE attendance
        SET total_minutes =
          FLOOR(EXTRACT(EPOCH FROM (NOW() - check_in)) / 60)::int
        WHERE id = ${attendance.id}
      `;

      await sql`
        UPDATE attendance
        SET status = 'on_break'
        WHERE id = ${attendance.id}
      `;

      await sql`
        INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
        VALUES(${user.sub}, 'on_break', ${appName ?? null}, NOW(), NOW())
        ON CONFLICT (employee_id) DO UPDATE
        SET current_status = 'on_break', current_app = ${appName ?? null}, last_activity = NOW(), updated_at = NOW()
      `;

      await emitSocketEvent('employee-status', employeeStatusPayload(user, 'on_break', appName), { toAdmins: true });
      await emitSocketEvent('employee-break-started', employeeStatusPayload(user, 'on_break', appName), { toAdmins: true });
      return ok({ breakId: brk.id }, 201);
    }

    if (action === 'end_break') {
      const [breakRecord] = await sql`
        SELECT b.id, b.attendance_id, b.start_time FROM breaks b
        JOIN attendance a ON a.id = b.attendance_id
        WHERE a.employee_id = ${user.sub}
          AND b.end_time IS NULL
        ORDER BY b.start_time DESC
        LIMIT 1
      `;

      if (!breakRecord) return err('No active break found', 400);

      await sql`
        UPDATE breaks
        SET end_time = NOW(),
            duration_minutes = CEIL(EXTRACT(EPOCH FROM (NOW() - ${breakRecord.start_time})) / 60)::int
        WHERE id = ${breakRecord.id}
      `;

      await sql`
        UPDATE attendance
        SET status = 'working'
        WHERE id = ${breakRecord.attendance_id}
      `;

      await sql`
        INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
        VALUES(${user.sub}, 'working', ${appName ?? null}, NOW(), NOW())
        ON CONFLICT (employee_id) DO UPDATE
        SET current_status = 'working', current_app = ${appName ?? null}, last_activity = NOW(), updated_at = NOW()
      `;

      await emitSocketEvent('employee-status', employeeStatusPayload(user, 'working', appName), { toAdmins: true });
      await emitSocketEvent('employee-break-ended', employeeStatusPayload(user, 'working', appName), { toAdmins: true });
      return ok({ ok: true });
    }

    if (action === 'end' || action === 'checkout') {
      // sessionId from the client is the attendance.id. We try it first,
      // but always fall back to "most recent open session for this
      // employee" if it's missing OR if it no longer matches an open row
      // (e.g. it was already closed by a stale-session cleanup in
      // action === 'start', or the agent is holding onto an old/incorrect
      // id after a reconnect). Without this fallback, a mismatched sessionId
      // causes a hard 404 and the agent's checkout is silently dropped.
      let attendance;

      if (sessionId) {
        [attendance] = await sql`
          SELECT id, check_in FROM attendance
          WHERE id = ${sessionId} AND employee_id = ${user.sub}
          LIMIT 1
        `;
      }

      if (!attendance) {
        [attendance] = await sql`
          SELECT id, check_in FROM attendance
          WHERE employee_id = ${user.sub} AND check_out IS NULL
          ORDER BY check_in DESC
          LIMIT 1
        `;
      }

      if (!attendance) {
        [attendance] = await sql`
          SELECT id, check_in FROM attendance
          WHERE employee_id = ${user.sub} AND check_out IS NULL
          ORDER BY check_in DESC
          LIMIT 1
        `;
      }

      if (!attendance) return err('Attendance record not found', 404);

      const breakResult = await sql`
        SELECT COALESCE(SUM(duration_minutes), 0) AS break_minutes
        FROM breaks
        WHERE attendance_id = ${attendance.id}
      `;

      const breakMinutes = breakResult?.[0]?.break_minutes ?? 0;

      const minutesResult = await sql`
        SELECT
          GREATEST(
            FLOOR(EXTRACT(EPOCH FROM (NOW() - ${attendance.check_in})) / 60)::int - ${breakMinutes},
            0
          ) AS total_minutes
      `;

      const minutes = minutesResult?.[0]?.total_minutes ?? 0;

      await sql`
        UPDATE breaks
        SET
          end_time = NOW(),
          duration_minutes = CEIL(EXTRACT(EPOCH FROM (NOW() - start_time)) / 60)::int
        WHERE attendance_id = ${attendance.id}
          AND end_time IS NULL
      `;

      await sql`
        UPDATE attendance
        SET check_out = NOW(), total_minutes = ${minutes}, status = 'checked_out'
        WHERE id = ${attendance.id}
      `;

      await sql`
        INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
        VALUES(${user.sub}, 'checked_out', NULL, NOW(), NOW())
        ON CONFLICT (employee_id) DO UPDATE
        SET current_status = 'checked_out', current_app = NULL, last_activity = NOW(), updated_at = NOW()
      `;

      await emitSocketEvent('employee-status', employeeStatusPayload(user, 'checked_out', null), { toAdmins: true });
      await emitSocketEvent('employee-checked-out', employeeStatusPayload(user, 'checked_out', null), { toAdmins: true });
      return ok({ ok: true });
    }

    if (action === 'activity') {
      // No activity_events table exists; just bump employee_status's
      // last_activity / current_app so heartbeats still register.
      await sql`
        INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
        VALUES(${user.sub}, 'working', ${appName ?? null}, NOW(), NOW())
        ON CONFLICT (employee_id) DO UPDATE
        SET current_app = ${appName ?? null}, last_activity = NOW(), updated_at = NOW()
      `;
      await emitSocketEvent('employee-activity-updated', employeeStatusPayload(user, 'working', appName), { toAdmins: true });
      return ok({ ok: true });
    }

    if (action === 'logout') {
      await sql`
        INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at)
        VALUES(${user.sub}, 'offline', NULL, NOW(), NOW())
        ON CONFLICT (employee_id) DO UPDATE
        SET current_status = 'offline', current_app = NULL, last_activity = NOW(), updated_at = NOW()
      `;
      await emitSocketEvent('employee-status', employeeStatusPayload(user, 'offline', null), { toAdmins: true });
      await emitSocketEvent('employee-logged-out', employeeStatusPayload(user, 'offline', null), { toAdmins: true });
      return ok({ ok: true });
    }

    return err('Invalid action');
  } catch (e: any) {
    console.error('================ ERROR =================');
    console.error(e);
    console.error('MESSAGE:', e?.message);
    console.error('STACK:', e?.stack);
    console.error('========================================');

    return err(e?.message || 'Internal server error', 500);
  }
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);
  const { sub } = user;
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const limit = clampLimit(searchParams.get('limit'), 200, 500);

  try {
    let rows;
    if (role === 'employee') {
      rows = await sql`
        SELECT a.*, p.full_name AS user_name
        FROM attendance a
        JOIN public.profiles p ON p.id = a.employee_id
        WHERE a.employee_id = ${sub} AND DATE(a.check_in) = ${date}
        ORDER BY a.check_in DESC
        LIMIT ${limit}
      `;
    } else if (canMonitorAll(role)) {
      rows = await sql`
        SELECT a.*, p.full_name AS user_name
        FROM attendance a
        JOIN public.profiles p ON p.id = a.employee_id
        WHERE DATE(a.check_in) = ${date}
        ORDER BY a.check_in DESC
        LIMIT ${limit}
      `;
    } else {
      return err('Forbidden', 403);
    }
    return ok(rows);
  } catch (e: any) {
    console.error('GET /api/sessions error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
