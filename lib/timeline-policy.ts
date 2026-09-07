import { addDays, getLocalDateInTimeZone, zonedDateTimeToUtc, BUSINESS_TIME_ZONE } from './shifts';

export type ScheduleDay = { day: number; start: string; end: string; off: boolean };
export type TimelinePreferences = { threshold: number; offlineMinutes: number; missedMinutes: number; channel: 'in-app' | 'both' | 'email'; offlineAlerts: boolean; missedAlerts: boolean; weeklyEmail: boolean; dark: boolean; views: Array<{ name: string; query: string; status: string; team?: boolean; sort?: string }> };
export const defaultPreferences: TimelinePreferences = { threshold: 15, offlineMinutes: 5, missedMinutes: 15, channel: 'in-app', offlineAlerts: true, missedAlerts: true, weeklyEmail: false, dark: false, views: [] };
export function validatePreferences(value: any): TimelinePreferences {
  for (const key of ['threshold', 'offlineMinutes', 'missedMinutes']) if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 240) throw new Error(`${key} must be between 1 and 240 minutes`);
  if (!['in-app', 'both', 'email'].includes(value.channel)) throw new Error('Invalid notification channel');
  if (!Array.isArray(value.views) || value.views.length > 30 || value.views.some((v: any) => !v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40 || typeof v.query !== 'string' || v.query.length > 200 || !['all','working','idle','on_break','offline'].includes(v.status))) throw new Error('Invalid saved views');
  return { threshold: value.threshold, offlineMinutes: value.offlineMinutes, missedMinutes: value.missedMinutes, channel: value.channel, offlineAlerts: value.offlineAlerts === true, missedAlerts: value.missedAlerts === true, weeklyEmail: value.weeklyEmail === true, dark: value.dark === true, views: value.views.map((v: any) => ({ name: v.name.trim(), query: v.query, status: v.status, team: v.team === true, sort: String(v.sort || 'most_work') })) };
}
export function validateSchedule(value: any): ScheduleDay[] {
  if (!Array.isArray(value) || value.length !== 7) throw new Error('Provide seven schedule days');
  const days = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item.day) || item.day < 0 || item.day > 6 || days.has(item.day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.end) || (!item.off && item.start === item.end)) throw new Error('Invalid schedule');
    days.add(item.day);
  }
  return value.map(d => ({ day: d.day, start: d.start, end: d.end, off: d.off === true }));
}
export function scheduledWindow(schedule: ScheduleDay[], date: string) {
  const day = schedule.find(d => d.day === new Date(`${date}T12:00:00Z`).getUTCDay());
  if (!day || day.off) return null;
  return { start: zonedDateTimeToUtc(date, `${day.start}:00`, BUSINESS_TIME_ZONE), end: zonedDateTimeToUtc(day.end <= day.start ? addDays(date, 1) : date, `${day.end}:00`, BUSINESS_TIME_ZONE) };
}
export function earlyAttempt(schedule: ScheduleDay[], checkIn: string, now = new Date()) {
  const arrival=new Date(checkIn);
  const date = getLocalDateInTimeZone(arrival, BUSINESS_TIME_ZONE);
  const candidates=[scheduledWindow(schedule,date),scheduledWindow(schedule,addDays(date,-1))].filter((v):v is NonNullable<typeof v>=>!!v);
  const window=candidates.find(w=>arrival>=w.start&&arrival<w.end) || candidates.find(w=>arrival<w.start&&w.start.getTime()-arrival.getTime()<=4*3600000);
  const remainingMinutes = window ? Math.max(0, Math.ceil((window.end.getTime() - now.getTime()) / 60000)) : 0;
  return { flagged: remainingMinutes > 0, remainingMinutes, shiftEnd: window?.end.toISOString() || null };
}
export function geofenceDistance(lat: number, lon: number, centerLat: number, centerLon: number) {
  const radians = (n: number) => n * Math.PI / 180;
  const a = Math.sin(radians(lat-centerLat)/2)**2 + Math.cos(radians(lat))*Math.cos(radians(centerLat))*Math.sin(radians(lon-centerLon)/2)**2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
export function nextExportAt(frequency: string, from = new Date()) {
  const next = new Date(from);
  if (frequency === 'monthly') { const day = next.getUTCDate(); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth()+1); const last = new Date(Date.UTC(next.getUTCFullYear(),next.getUTCMonth()+1,0)).getUTCDate(); next.setUTCDate(Math.min(day,last)); }
  else next.setUTCDate(next.getUTCDate() + (frequency === 'weekly' ? 7 : 1));
  return next;
}
