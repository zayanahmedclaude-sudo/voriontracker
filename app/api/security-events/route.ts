import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { createSecurityEvent, listSecurityEvents, listSecurityEventsPage } from '@/lib/security';
import { emitSocketEvent } from '@/lib/socket';
import { canMonitorAll, normalizeRole } from '@/lib/roles';

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);

  try {
    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get('limit');
    const isEmployee = role === 'employee';
    if (!isEmployee && !canMonitorAll(role)) return err('Forbidden', 403);
    const filters = {
      employeeId: isEmployee ? user.sub : (searchParams.get('employeeId') || undefined),
      date: searchParams.get('date') || undefined,
      eventType: searchParams.get('eventType') || undefined,
      viewAs: isEmployee ? 'employee' : undefined,
    };

    // Paged mode returns { events, total, page, pageSize }; without `page` the
    // legacy array response is kept for existing callers.
    const pageParam = searchParams.get('page');
    if (pageParam) {
      const page = Math.max(1, Math.floor(Number(pageParam)) || 1);
      const pageSize = Math.max(1, Math.min(Math.floor(Number(searchParams.get('pageSize'))) || 50, 200));
      const { events, total } = await listSecurityEventsPage({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
      return ok({ events, total, page, pageSize });
    }

    const events = await listSecurityEvents({ ...filters, limit: limitParam ? Number(limitParam) : undefined });
    return ok(events);
  } catch (e: any) {
    console.error('GET /api/security-events error:', e?.message || e);
    return err('Internal server error', 500);
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);

  try {
    const body = await req.json();
    const targetEmployeeId =
      canMonitorAll(role)
        ? body?.employee_id || body?.employeeId || user.sub || null
        : user.sub || null;
    const event = await createSecurityEvent({
      employeeId: targetEmployeeId,
      computerName: body?.computer_name || body?.computerName || null,
      eventType: String(body?.event_type || body?.eventType || '').trim(),
      value: body?.value ? String(body.value) : null,
      actionTaken: body?.action_taken || body?.actionTaken || null,
    });

    try {
      await emitSocketEvent('security-event', {
        id: event.id,
        employeeId: event.employeeId,
        employeeName: null,
        computerName: event.computerName,
        eventType: event.eventType,
        value: event.value,
        actionTaken: event.actionTaken,
        createdAt: event.createdAt,
      }, { toAdmins: true });
    } catch (socketError) {
      console.warn('Socket security-event notification failed', socketError);
    }

    return ok(event, 201);
  } catch (e: any) {
    console.error('POST /api/security-events error:', e?.message || e);
    return err(e?.message || 'Internal server error', 500);
  }
}
