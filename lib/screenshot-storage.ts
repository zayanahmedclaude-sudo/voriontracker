export const DEFAULT_ORGANIZATION_SCOPE = 'default';

function safeSegment(value: unknown, fallback: string) {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || fallback;
}

export function getStorageDatePath(value: Date | string | number = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const isoDate = Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
  return isoDate.replace(/-/g, '/');
}

export function getRegularScreenshotPrefix(organizationId: string, employeeId: string, date: Date | string | number = new Date()) {
  return `screenshots/regular/${safeSegment(organizationId, DEFAULT_ORGANIZATION_SCOPE)}/${safeSegment(employeeId, 'employee')}/${getStorageDatePath(date)}/`;
}

export function getRegularThumbnailPrefix(organizationId: string, employeeId: string, date: Date | string | number = new Date()) {
  return `screenshots/thumbnails/${safeSegment(organizationId, DEFAULT_ORGANIZATION_SCOPE)}/${safeSegment(employeeId, 'employee')}/${getStorageDatePath(date)}/`;
}

export function getFlaggedEvidencePrefix(organizationId: string, employeeId: string, date: Date | string | number = new Date()) {
  return `evidence/flagged/${safeSegment(organizationId, DEFAULT_ORGANIZATION_SCOPE)}/${safeSegment(employeeId, 'employee')}/${getStorageDatePath(date)}/`;
}

export function isRegularScreenshotKey(key: string, organizationId: string, employeeId: string) {
  return key.startsWith(getRegularScreenshotPrefix(organizationId, employeeId));
}

export function isRegularThumbnailKey(key: string, organizationId: string, employeeId: string) {
  return key.startsWith(getRegularThumbnailPrefix(organizationId, employeeId));
}
