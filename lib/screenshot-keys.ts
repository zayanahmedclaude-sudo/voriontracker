import { DEFAULT_STORAGE_SCOPE } from './screenshot-storage';

export type ScreenshotKeyKind = 'regular' | 'thumbnail' | 'evidence';

export type ParsedScreenshotKey = {
  kind: ScreenshotKeyKind;
  storageScope: string;
  employeeId: string;
  yyyy: string;
  mm: string;
  dd: string;
  captureId: string;
  extension: 'png' | 'webp' | 'jpg' | 'jpeg';
};

const ALLOWED_EXTENSIONS = new Set(['png', 'webp', 'jpg', 'jpeg']);

function hasUnsafePathEncoding(key: string) {
  if (!key || key !== key.trim()) return true;
  if (key.includes('\\') || key.includes('//')) return true;
  if (/[\u0000-\u001f\u007f]/.test(key)) return true;
  let decoded = key;
  for (let i = 0; i < 2; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('//')) return true;
  }
  return false;
}

function parseDateSegments(yyyy: string, mm: string, dd: string) {
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) return false;
  const iso = `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === `${yyyy}-${mm}-${dd}`;
}

export function parseCanonicalScreenshotKey(key: string): ParsedScreenshotKey | null {
  if (hasUnsafePathEncoding(key)) return null;
  const segments = key.split('/');
  if (segments.length !== 8) return null;
  const [root, category, storageScope, employeeId, yyyy, mm, dd, filename] = segments;
  if (root !== 'screenshots') return null;
  if (category !== 'regular' && category !== 'thumbnails') return null;
  if (storageScope !== DEFAULT_STORAGE_SCOPE) return null;
  if (!employeeId || !parseDateSegments(yyyy, mm, dd)) return null;
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,199})\.(png|webp|jpg|jpeg)$/i.exec(filename);
  if (!match) return null;
  const extension = match[2].toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return null;
  return {
    kind: category === 'regular' ? 'regular' : 'thumbnail',
    storageScope,
    employeeId,
    yyyy,
    mm,
    dd,
    captureId: match[1],
    extension: extension as ParsedScreenshotKey['extension'],
  };
}

export function isCanonicalRegularScreenshotKey(key: string, employeeId: string) {
  const parsed = parseCanonicalScreenshotKey(key);
  return Boolean(parsed && parsed.kind === 'regular' && parsed.employeeId === employeeId);
}

export function isCanonicalRegularThumbnailKey(key: string, employeeId: string) {
  const parsed = parseCanonicalScreenshotKey(key);
  return Boolean(parsed && parsed.kind === 'thumbnail' && parsed.employeeId === employeeId);
}

export function getCaptureDateFromKey(key: string) {
  const parsed = parseCanonicalScreenshotKey(key);
  return parsed ? `${parsed.yyyy}-${parsed.mm}-${parsed.dd}` : '';
}
