import { getAutoCheckoutCutoffForTimestamp } from './shifts';

// An unclosed session belongs to its original shift, never to later shifts.
export function attendanceBounds(attendance: any, range: { start: Date; end: Date }, nowMs: number, staleSeconds: number) {
  const checkIn = new Date(attendance.check_in).getTime();
  if (!Number.isFinite(checkIn)) return null;
  const cutoff = getAutoCheckoutCutoffForTimestamp(attendance.check_in).getTime();
  const start = Math.max(checkIn, range.start.getTime());
  const sessionEvidence = new Date(attendance.session_last_activity || attendance.check_in).getTime();
  const heartbeat = new Date(attendance.last_activity || 0).getTime();
  const live = heartbeat >= checkIn && heartbeat < cutoff && heartbeat >= nowMs - staleSeconds * 1000;
  const end = Math.min(
    attendance.check_out ? new Date(attendance.check_out).getTime() : live ? nowMs : sessionEvidence,
    cutoff, range.end.getTime(), nowMs,
  );
  return Number.isFinite(end) && end > start ? { start, end } : null;
}
