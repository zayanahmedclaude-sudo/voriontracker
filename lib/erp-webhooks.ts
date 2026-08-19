import { createHmac } from 'crypto';
import { sql } from './db';

type ErpAttendanceEvent =
  | 'attendance.check_in'
  | 'attendance.check_out'
  | 'attendance.break_start'
  | 'attendance.break_end'
  | 'attendance.auto_checkout';

type WebhookUser = {
  sub: string;
  name?: string | null;
  email?: string | null;
};

type SendAttendanceWebhookInput = {
  event: ErpAttendanceEvent;
  user: WebhookUser;
  attendanceId: string;
  breakId?: string | null;
};

const WEBHOOK_TIMEOUT_MS = 5000;

function signPayload(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function normalizeNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export async function sendAttendanceWebhook(input: SendAttendanceWebhookInput) {
  const webhookUrl = process.env.ERP_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const [attendance] = await sql`
      SELECT
        a.id,
        a.employee_id,
        a.check_in,
        a.check_out,
        a.total_minutes,
        a.status,
        p.full_name,
        p.email,
        p.employee_code,
        es.current_status
      FROM attendance a
      LEFT JOIN public.profiles p ON p.id = a.employee_id
      LEFT JOIN employee_status es ON es.employee_id = a.employee_id
      WHERE a.id = ${input.attendanceId}
      LIMIT 1
    `;

    if (!attendance) {
      console.warn('ERP webhook skipped: attendance not found', input.attendanceId);
      return;
    }

    const breaks = await sql`
      SELECT id, start_time, end_time, duration_minutes
      FROM breaks
      WHERE attendance_id = ${input.attendanceId}
      ORDER BY start_time ASC
    `;

    const breakMinutes = breaks.reduce((sum: number, item: any) => sum + normalizeNumber(item.duration_minutes), 0);
    const payload = {
      event: input.event,
      eventId: `${input.event}:${input.attendanceId}:${input.breakId || 'attendance'}:${Date.now()}`,
      sentAt: new Date().toISOString(),
      employee: {
        id: attendance.employee_id,
        code: attendance.employee_code ?? null,
        name: attendance.full_name ?? input.user.name ?? null,
        email: attendance.email ?? input.user.email ?? null,
      },
      attendance: {
        id: attendance.id,
        checkIn: attendance.check_in ?? null,
        checkOut: attendance.check_out ?? null,
        status: attendance.status ?? attendance.current_status ?? null,
        totalMinutes: normalizeNumber(attendance.total_minutes),
        breakMinutes,
        workMinutes: Math.max(0, normalizeNumber(attendance.total_minutes) - breakMinutes),
      },
      break: input.breakId
        ? breaks.find((item: any) => item.id === input.breakId) ?? null
        : null,
      breaks: breaks.map((item: any) => ({
        id: item.id,
        start: item.start_time ?? null,
        end: item.end_time ?? null,
        durationMinutes: normalizeNumber(item.duration_minutes),
      })),
    };

    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'VorionTracker-ERP-Webhook/1.0',
    };

    if (process.env.ERP_WEBHOOK_SECRET) {
      headers['X-Vorion-Signature'] = `sha256=${signPayload(body, process.env.ERP_WEBHOOK_SECRET)}`;
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      console.warn('ERP webhook failed', {
        event: input.event,
        attendanceId: input.attendanceId,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (error: any) {
    console.warn('ERP webhook error', {
      event: input.event,
      attendanceId: input.attendanceId,
      message: error?.message || String(error),
    });
  }
}
