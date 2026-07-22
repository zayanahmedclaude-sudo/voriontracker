import { NextRequest } from 'next/server';
import { requireAuth, ok, err } from '@/lib/api';
import { getExistingColumns, withTransaction } from '@/lib/db';
import { emitSocketEvent } from '@/lib/socket';
import { ensureRoleFeatureSchema } from '@/lib/schema';

const MAX_BATCH_SIZE = 30;

function isVercelBlobUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && (
      url.hostname.endsWith('.blob.vercel-storage.com')
      || url.hostname.endsWith('.public.blob.vercel-storage.com')
      || url.hostname.endsWith('.vercel-storage.com')
    );
  } catch {
    return false;
  }
}

function getVercelBlobPath(rawUrl: string) {
  try {
    if (!isVercelBlobUrl(rawUrl)) return '';
    return decodeURIComponent(new URL(rawUrl).pathname.replace(/^\/+/, ''));
  } catch {}
  return '';
}

function getValidationError(shot: { path: string; url: string }, prefix: string) {
  if (!shot.path) return 'missing path';
  if (!shot.path.startsWith(prefix)) return `path outside employee prefix: ${shot.path}`;
  if (!/\.(png|webp|jpg|jpeg)$/i.test(shot.path)) return `unsupported screenshot extension: ${shot.path}`;
  if (!shot.url) return 'missing url';
  if (!isVercelBlobUrl(shot.url)) return `unsupported screenshot url host: ${shot.url}`;
  const urlPath = getVercelBlobPath(shot.url);
  if (urlPath && urlPath !== shot.path) return `blob url path does not match metadata path: ${urlPath}`;
  return '';
}

export async function POST(req: NextRequest) {
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  const user = requireAuth(req);
  if ('status' in user) return user;
  try {
    const input = (await req.json())?.screenshots;
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_BATCH_SIZE) return err('screenshots must contain 1 to 30 items', 400);
    await ensureRoleFeatureSchema();
    const shots = input.map((item: any) => {
      const url = String(item?.url || item?.fileUrl || item?.blobUrl || '');
      const path = String(item?.path || item?.pathname || getVercelBlobPath(url) || '');
      const thumbnailUrl = String(item?.thumbnailUrl || item?.thumbnail_url || '');
      const thumbnailPath = String(item?.thumbnailPath || item?.thumbnail_path || getVercelBlobPath(thumbnailUrl) || '');
      return {
        path, url,
        thumbnailPath,
        thumbnailUrl,
        localId: item?.localId ? String(item.localId).slice(0, 200) : null,
        attempt: Number.isFinite(Number(item?.attempt)) ? Number(item.attempt) : null,
        deviceId: item?.deviceId ? String(item.deviceId).slice(0, 200) : null,
        activeApp: String(item?.activeApp || 'Unknown').slice(0, 500),
        activityPct: Math.max(0, Math.min(100, Number.parseInt(String(item?.activityPct || 0), 10) || 0)),
        capturedAt: new Date(item?.capturedAt || Date.now()).toISOString(), sessionId: item?.sessionId ? String(item.sessionId) : null,
      };
    });
    const prefix = `screenshots/${user.sub}/`;
    const validationErrors = shots.flatMap((shot, index) => {
      const errors = [{ index, error: getValidationError(shot, prefix), path: shot.path, url: shot.url }];
      if (shot.thumbnailUrl || shot.thumbnailPath) {
        errors.push({
          index,
          error: getValidationError({ path: shot.thumbnailPath, url: shot.thumbnailUrl }, prefix),
          path: shot.thumbnailPath,
          url: shot.thumbnailUrl,
        });
      }
      return errors;
    }).filter((item) => item.error);
    if (validationErrors.length) {
      console.error('POST /api/agent/screenshots/commit validation failed:', validationErrors);
      return err('Invalid screenshot blob', 400);
    }
    console.info('POST /api/agent/screenshots/commit accepted batch', {
      employeeId: user.sub,
      count: shots.length,
      screenshots: shots.map((shot) => ({
        localId: shot.localId,
        attempt: shot.attempt,
        path: shot.path,
      })),
    });
    const availableColumns = await getExistingColumns('screenshots', ['blob_url', 'file_url', 'thumbnail_url', 'device_id']);
    const saved = await withTransaction(async (client) => {
      const urlColumns = ['blob_url', 'file_url'].filter((column) => availableColumns.has(column));
      if (!urlColumns.length) throw new Error('screenshots table is missing a URL column');

      const hasDeviceId = availableColumns.has('device_id');
      const hasThumbnailUrl = availableColumns.has('thumbnail_url');
      const columns = ['employee_id', ...(hasDeviceId ? ['device_id'] : []), ...urlColumns, ...(hasThumbnailUrl ? ['thumbnail_url'] : []), 'captured_at', 'active_app', 'activity_pct', 'session_id'];
      const values: any[] = [];
      const valueRows = shots.map((shot, rowIndex) => {
        const rowValues = [
          user.sub,
          ...(hasDeviceId ? [shot.deviceId] : []),
          ...urlColumns.map(() => shot.url),
          ...(hasThumbnailUrl ? [shot.thumbnailUrl || null] : []),
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
