import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { getExistingColumns, withTransaction } from '@/lib/db';
import { emitSocketEvent } from '@/lib/socket';
import { ensureScreenshotThumbnailSchema } from '@/lib/schema';
import { getR2KeyFromUrl, isR2Url } from '@/lib/r2';
import { getCaptureDateFromKey, parseCanonicalScreenshotKey } from '@/lib/screenshot-keys';
import {
  SCREENSHOT_MAX_BATCH_SIZE,
  requireAgentProtocol,
} from '@/lib/screenshot-protocol';

function getValidationError(shot: { path: string; url: string }, employeeId: string, expectedKind: 'regular' | 'thumbnail') {
  if (!shot.path) return 'missing path';
  const parsed = parseCanonicalScreenshotKey(shot.path);
  if (!parsed || parsed.kind !== expectedKind || parsed.employeeId !== employeeId) return 'path outside canonical screenshot prefixes';
  if (!shot.url) return 'missing url';
  if (!isR2Url(shot.url)) return 'unsupported screenshot url host';
  const urlPath = getR2KeyFromUrl(shot.url);
  if (urlPath !== shot.path) return `R2 url key does not match metadata path: ${urlPath}`;
  return '';
}

export async function POST(req: NextRequest) {
  const protocolError = requireAgentProtocol(req);
  if (protocolError) return protocolError;
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  const user = requireAuth(req);
  if ('status' in user) return user;
  try {
    const input = (await req.json())?.screenshots;
    if (!Array.isArray(input) || input.length < 1 || input.length > SCREENSHOT_MAX_BATCH_SIZE) return err(`screenshots must contain 1 to ${SCREENSHOT_MAX_BATCH_SIZE} items`, 400);
    await ensureScreenshotThumbnailSchema();
    const shots = input.map((item: any) => {
      const url = String(item?.url || '');
      const path = String(item?.path || getR2KeyFromUrl(url) || '');
      const thumbnailUrl = String(item?.thumbnailUrl || '');
      const thumbnailPath = String(item?.thumbnailPath || getR2KeyFromUrl(thumbnailUrl) || '');
      const checksum = String(item?.checksum || item?.sha256 || '');
      return {
        path, url,
        thumbnailPath,
        thumbnailUrl,
        checksum,
        localId: item?.localId ? String(item.localId).slice(0, 200) : null,
        attempt: Number.isFinite(Number(item?.attempt)) ? Number(item.attempt) : null,
        deviceId: item?.deviceId ? String(item.deviceId).slice(0, 200) : null,
        activeApp: String(item?.activeApp || 'Unknown').slice(0, 500),
        activityPct: Math.max(0, Math.min(100, Number.parseInt(String(item?.activityPct || 0), 10) || 0)),
        capturedAt: item?.capturedAt ? String(item.capturedAt) : new Date().toISOString(), sessionId: item?.sessionId ? String(item.sessionId) : null,
      };
    });
    const validationErrors = shots.flatMap((shot, index) => {
      const parsed = parseCanonicalScreenshotKey(shot.path);
      const thumbnail = shot.thumbnailPath ? parseCanonicalScreenshotKey(shot.thumbnailPath) : null;
      const capturedAtMs = new Date(shot.capturedAt).getTime();
      const keyDate = getCaptureDateFromKey(shot.path);
      const capturedDate = Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString().slice(0, 10) : '';
      const errors = [{
        index,
        error: getValidationError(shot, user.sub, 'regular'),
        path: shot.path,
        url: shot.url,
      }];
      if (!shot.checksum || !/^[a-f0-9]{64}$/i.test(shot.checksum)) {
        errors.push({ index, error: 'missing or invalid checksum', path: shot.path, url: shot.url });
      }
      if (!Number.isFinite(capturedAtMs)) {
        errors.push({ index, error: 'invalid capturedAt', path: shot.path, url: shot.url });
      }
      if (!keyDate || keyDate !== capturedDate) {
        errors.push({ index, error: 'capturedAt does not match canonical key date', path: shot.path, url: shot.url });
      }
      if (shot.thumbnailUrl || shot.thumbnailPath) {
        errors.push({
          index,
          error: getValidationError({ path: shot.thumbnailPath, url: shot.thumbnailUrl }, user.sub, 'thumbnail'),
          path: shot.thumbnailPath,
          url: shot.thumbnailUrl,
        });
        if (!parsed || !thumbnail || parsed.captureId !== thumbnail.captureId) {
          errors.push({ index, error: 'full and thumbnail capture IDs do not match', path: shot.thumbnailPath, url: shot.thumbnailUrl });
        }
      }
      return errors;
    }).filter((item) => item.error);
    if (validationErrors.length) {
      console.error('POST /api/agent/screenshots/commit validation failed:', validationErrors);
      return err('Invalid screenshot blob', 400);
    }
    const availableColumns = await getExistingColumns('screenshots', ['blob_url', 'file_url', 'thumbnail_url', 'blob_path', 'storage_provider', 'device_id']);
    const saved = await withTransaction(async (client) => {
      const urlColumns = ['blob_url', 'file_url'].filter((column) => availableColumns.has(column));
      if (!urlColumns.length) throw new Error('screenshots table is missing a URL column');

      const hasDeviceId = availableColumns.has('device_id');
      const hasThumbnailUrl = availableColumns.has('thumbnail_url');
      const hasBlobPath = availableColumns.has('blob_path');
      const hasStorageProvider = availableColumns.has('storage_provider');
      const columns = ['employee_id', ...(hasDeviceId ? ['device_id'] : []), ...urlColumns, ...(hasThumbnailUrl ? ['thumbnail_url'] : []), ...(hasBlobPath ? ['blob_path'] : []), ...(hasStorageProvider ? ['storage_provider'] : []), 'captured_at', 'active_app', 'activity_pct', 'session_id'];
      const values: any[] = [];
      const valueRows = shots.map((shot, rowIndex) => {
        const rowValues = [
          user.sub,
          ...(hasDeviceId ? [shot.deviceId] : []),
          ...urlColumns.map(() => shot.url),
          ...(hasThumbnailUrl ? [shot.thumbnailUrl || null] : []),
          ...(hasBlobPath ? [shot.path] : []),
          ...(hasStorageProvider ? ['r2'] : []),
          shot.capturedAt,
          shot.activeApp,
          shot.activityPct,
          shot.sessionId,
        ];
        values.push(...rowValues);
        const offset = rowIndex * rowValues.length;
        return `(${rowValues.map((_, valueIndex) => `$${offset + valueIndex + 1}`).join(', ')})`;
      });
      const result = await client.query(
        `INSERT INTO screenshots (${columns.join(', ')})
         VALUES ${valueRows.join(', ')}
         ${hasBlobPath ? `ON CONFLICT (blob_path) WHERE blob_path IS NOT NULL DO UPDATE SET blob_path = EXCLUDED.blob_path` : ''}
         RETURNING id`,
        values,
      );
      const rows = shots.map((shot, index) => {
        return { ...shot, id: result.rows[index]?.id, fileUrl: shot.url, thumbnailUrl: shot.thumbnailUrl || shot.url };
      });
      if (rows.some((row) => !row.id)) {
        throw new Error('Failed to save all screenshots');
      }
      const latest = rows[rows.length - 1];
      // Screenshots prove that the agent is connected, but they do not prove
      // keyboard or mouse activity. In particular, the agent keeps capturing
      // while a person is idle. Preserve the status last reported by its
      // heartbeat instead of turning every capture into "working".
      const presenceResult = await client.query(
        "INSERT INTO employee_status(employee_id, current_status, current_app, last_activity, updated_at) VALUES($1, 'working', $2, NOW(), NOW()) ON CONFLICT (employee_id) DO UPDATE SET current_app = $2, last_activity = NOW(), updated_at = NOW() RETURNING current_status",
        [user.sub, latest.activeApp],
      );
      return { rows, status: presenceResult.rows[0]?.current_status || 'working' };
    });
    const latest = saved.rows[saved.rows.length - 1];
    const presence = { employeeId: user.sub, employeeName: user.name, status: saved.status, currentApp: latest.activeApp, activityPct: latest.activityPct, lastActivity: new Date().toISOString(), timestamp: new Date().toISOString() };
    await emitSocketEvent('employee-status', presence, { toAdmins: true });
    await emitSocketEvent('employee-activity-updated', presence, { toAdmins: true });
    await Promise.all(saved.rows.map((shot) => emitSocketEvent('new-screenshot', { userId: user.sub, userName: user.name, screenshotId: shot.id, fileUrl: shot.fileUrl, blobUrl: shot.fileUrl, thumbnailUrl: shot.thumbnailUrl, activeApp: shot.activeApp, activityPct: shot.activityPct, capturedAt: shot.capturedAt }, { toAdmins: true })));
    return ok({ screenshots: saved.rows.map((shot) => ({ id: shot.id, path: shot.path })) }, 201);
  } catch (error: any) {
    console.error('POST /api/agent/screenshots/commit error:', error?.message || error);
    return err('Failed to save screenshots', 500);
  }
}
