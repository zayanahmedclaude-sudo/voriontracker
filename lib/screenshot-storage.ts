export const DEFAULT_STORAGE_SCOPE = 'default';

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

export function getRegularScreenshotPrefix(storageScope: string, employeeId: string, date: Date | string | number = new Date()) {
  return `screenshots/regular/${safeSegment(storageScope, DEFAULT_STORAGE_SCOPE)}/${safeSegment(employeeId, 'employee')}/${getStorageDatePath(date)}/`;
}

export function getRegularThumbnailPrefix(storageScope: string, employeeId: string, date: Date | string | number = new Date()) {
  return `screenshots/thumbnails/${safeSegment(storageScope, DEFAULT_STORAGE_SCOPE)}/${safeSegment(employeeId, 'employee')}/${getStorageDatePath(date)}/`;
}

export function getFlaggedEvidencePrefix(storageScope: string, employeeId: string, date: Date | string | number = new Date()) {
  return `evidence/flagged/${safeSegment(storageScope, DEFAULT_STORAGE_SCOPE)}/${safeSegment(employeeId, 'employee')}/${getStorageDatePath(date)}/`;
}

export function isRegularScreenshotKey(key: string, storageScope: string, employeeId: string) {
  return key.startsWith(getRegularScreenshotPrefix(storageScope, employeeId));
}

export function isRegularThumbnailKey(key: string, storageScope: string, employeeId: string) {
  return key.startsWith(getRegularThumbnailPrefix(storageScope, employeeId));
}
