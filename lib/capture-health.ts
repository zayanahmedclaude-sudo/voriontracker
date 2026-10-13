import { sql } from './db';
import { emitSocketEvent } from './socket';

// Alerts raised when a running agent stops producing screenshots or reports
// data that suggests tampering. Surfaced on Dashboard > Device alerts.
export type CaptureHealthAlertType =
  | 'screenshots_missing'
  | 'clock_tampering'
  | 'device_enrollment_invalid'
  | 'screenshot_upload_blocked'
  | 'device_unassigned';

const ALERT_DEDUP_MINUTES = 30;
// Agents capture at least every 25-60s while monitoring; allow for the 60s
// upload cadence and short network blips before calling capture silent.
export const SCREENSHOT_SILENCE_MINUTES = 10;
export const CLOCK_TAMPER_THRESHOLD_SECONDS = 5 * 60;

const ALERT_COPY: Record<CaptureHealthAlertType, { severity: string; title: string; describe: (who: string, where: string) => string }> = {
  screenshots_missing: {
    severity: 'high',
    title: 'Screenshots stopped arriving',
    describe: (who, where) => `${who} is online and checked in${where}, but no screenshot has reached the dashboard for over ${SCREENSHOT_SILENCE_MINUTES} minutes.`,
  },
  clock_tampering: {
    severity: 'high',
    title: 'Computer clock is wrong',
    describe: (who, where) => `${who}'s computer clock${where} differs from server time by more than ${CLOCK_TAMPER_THRESHOLD_SECONDS / 60} minutes. Screenshots were re-timed with server time.`,
  },
  device_enrollment_invalid: {
    severity: 'high',
    title: 'Device credential rejected',
    describe: (who, where) => `The device credential${where} was rejected, so screenshots outside check-in cannot be sent while ${who} is logged out.`,
  },
  device_unassigned: {
    severity: 'medium',
    title: 'Device not assigned to an employee',
    describe: (_who, where) => `Background screenshots are arriving from a device${where} that is not assigned to any employee, so they will not appear under an employee filter. Assign it in Dashboard > Devices.`,
  },
  screenshot_upload_blocked: {
    severity: 'high',
    title: 'Screenshot uploads failing',
    describe: (who, where) => `${who}'s agent${where} is capturing screenshots but cannot upload them. Storage may be blocked by a firewall or hosts file.`,
  },
};

export async function raiseCaptureHealthAlert(input: {
  type: CaptureHealthAlertType;
  employeeId: string | null;
  employeeName?: string | null;
  deviceId: string;
  hostname?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const copy = ALERT_COPY[input.type];
  const who = input.employeeName || 'An employee';
  const where = input.hostname ? ` on ${input.hostname}` : '';
  const description = copy.describe(who, where);
  const metadata = { ...input.metadata, employeeId: input.employeeId, employeeName: input.employeeName || null, hostname: input.hostname || null, deviceId: input.deviceId };

  const inserted = await sql`
    INSERT INTO device_alerts (employee_id, device_id, hostname, alert_type, severity, title, description, metadata)
    SELECT ${input.employeeId}, ${input.deviceId}, ${input.hostname || null}, ${input.type}, ${copy.severity}, ${copy.title}, ${description}, ${JSON.stringify(metadata)}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM device_alerts da
      WHERE da.device_id = ${input.deviceId}
        AND da.alert_type = ${input.type}
        AND da.resolved_at IS NULL
        AND da.detected_at > NOW() - (${ALERT_DEDUP_MINUTES} * INTERVAL '1 minute')
    )
    RETURNING id, detected_at
  `;
  if (!inserted?.length) return false;

  // The Device alerts page reads security_events. An unassigned device has no
  // employee; if the column rejects NULL, keep the device_alerts row and socket event.
  await sql`
    INSERT INTO security_events (employee_id, computer_name, type, target, action, details)
    VALUES (${input.employeeId}, ${input.hostname || null}, ${input.type}, ${input.hostname || input.deviceId}, 'alerted_admins', ${JSON.stringify(metadata)}::jsonb)
  `.catch((error: any) => console.warn('security_events insert skipped:', error?.message || error));
  await emitSocketEvent('security-event', {
    id: inserted[0].id,
    employeeId: input.employeeId,
    employeeName: input.employeeName || null,
    computerName: input.hostname || null,
    eventType: input.type,
    value: input.hostname || input.deviceId,
    actionTaken: 'alerted_admins',
    createdAt: inserted[0].detected_at,
    severity: copy.severity,
    title: copy.title,
    description,
    metadata,
  }, { toAdmins: true });
  return true;
}

const SILENCE_CHECK_THROTTLE_MS = 2 * 60_000;
// After reconnecting, give the backlog time to upload before alerting.
const SYNC_GRACE_MS = 15 * 60_000;
// Uploads committed this recently mean the backlog is draining.
const UPLOAD_PROGRESS_WINDOW_MS = 3 * 60_000;
const lastSilenceCheck = new Map<string, number>();

// Called from the heartbeat: the server, not the agent, decides whether a
// checked-in employee's screenshots have gone silent, so a frozen or tampered
// capture loop cannot hide itself.
export async function checkScreenshotSilence(input: {
  employeeId: string;
  employeeName: string | null;
  deviceId: string;
  hostname: string | null;
  presenceStatus: string;
  agentReport?: Record<string, unknown>;
}) {
  if (!['working', 'active', 'idle'].includes(input.presenceStatus)) return;
  // Capture is intentionally paused while Windows is locked or asleep.
  if (input.agentReport?.screenLocked === true) return;
  const now = Date.now();
  if (now - (lastSilenceCheck.get(input.employeeId) || 0) < SILENCE_CHECK_THROTTLE_MS) return;
  lastSilenceCheck.set(input.employeeId, now);
  const [row] = await sql`
    SELECT a.check_in,
      (SELECT MAX(s.captured_at) FROM screenshots s
        WHERE s.employee_id = ${input.employeeId} AND s.captured_at > NOW() - INTERVAL '1 day') AS last_shot
    FROM attendance a
    WHERE a.employee_id = ${input.employeeId} AND a.check_out IS NULL
    ORDER BY a.check_in DESC
    LIMIT 1
  `;
  if (!row) return;
  const report = input.agentReport || {};
  // Just reconnected after an outage, or uploads are moving through a backlog:
  // screenshots are on their way, so this is not silence.
  const backlog = Number(report.queueDepth || 0);
  const reconnectedAgoMs = Number(report.reconnectedAgoMs);
  const lastCommitAgoMs = Number(report.lastCommitAgoMs);
  if (backlog > 0 && Number.isFinite(reconnectedAgoMs) && reconnectedAgoMs < SYNC_GRACE_MS) return;
  if (backlog > 0 && Number.isFinite(lastCommitAgoMs) && lastCommitAgoMs < UPLOAD_PROGRESS_WINDOW_MS) return;
  // Long admin-configured capture intervals must not look like silence.
  const intervalMs = Math.max(0, Number(report.captureIntervalSec) || 0) * 1000;
  const silenceLimitMs = Math.max(SCREENSHOT_SILENCE_MINUTES * 60_000, intervalMs * 3);
  const silenceStart = Math.max(new Date(row.check_in).getTime(), row.last_shot ? new Date(row.last_shot).getTime() : 0);
  if (Date.now() - silenceStart < silenceLimitMs) return;

  // Still capturing locally but nothing lands: uploads are failing or blocked.
  const lastCaptureAgoMs = Number(report.lastCaptureAgoMs);
  const uploadFailing = Number(report.queueDepth || 0) > 5 && Number.isFinite(lastCaptureAgoMs) && lastCaptureAgoMs < 5 * 60_000;
  await raiseCaptureHealthAlert({
    type: uploadFailing ? 'screenshot_upload_blocked' : 'screenshots_missing',
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    deviceId: input.deviceId,
    hostname: input.hostname,
    metadata: { lastScreenshotAt: row.last_shot || null, checkIn: row.check_in, agentReport: report },
  });
}
