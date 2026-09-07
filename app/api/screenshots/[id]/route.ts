import { NextRequest } from 'next/server';
import { cachedOk, err, requireAuth } from '@/lib/api';
import { getExistingColumns, queryRows } from '@/lib/db';
import { canMonitorAll, normalizeRole } from '@/lib/roles';

function getScreenshotUrlExpression(columns: Set<string>, tableAlias = 's') {
  if (columns.has('file_url')) return `${tableAlias}.file_url`;
  throw new Error('screenshots table is missing its R2 URL column');
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!process.env.DATABASE_URL) return err('Server misconfigured: DATABASE_URL not set', 500);
  const user = requireAuth(req);
  if ('status' in user) return user;

  const { id: rawId } = await params;
  const id = String(rawId || '').trim();
  if (!id) return err('Screenshot id is required', 400);

  const role = normalizeRole(user.role);
  const columns = await getExistingColumns('screenshots', ['file_url', 'storage_expired_at']);
  const screenshotUrlExpression = getScreenshotUrlExpression(columns);
  const storageExpiredExpression = columns.has('storage_expired_at')
    ? `(${screenshotUrlExpression} IS NULL OR s.storage_expired_at IS NOT NULL)`
    : `(${screenshotUrlExpression} IS NULL)`;

  const conditions = ['s.id = $1'];
  const values: any[] = [id];
  if (role === 'employee') {
    values.push(user.sub);
    conditions.push(`s.employee_id = $${values.length}`);
  } else if (role === 'client') {
    values.push(user.sub);
    conditions.push(`EXISTS (
      SELECT 1
      FROM client_assignments ca
      WHERE ca.client_id = $${values.length}
        AND ca.employee_id = s.employee_id
    )`);
  } else if (!canMonitorAll(role)) {
    return err('Forbidden', 403);
  }

  const rows = await queryRows(
    `SELECT s.id, ${screenshotUrlExpression} AS file_url, ${storageExpiredExpression} AS "storageExpired"
     FROM screenshots s
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    values,
  );

  const screenshot = rows[0];
  if (!screenshot) return err('Screenshot not found', 404);
  if (screenshot.storageExpired || !screenshot.file_url) {
    return err('Screenshot expired after the 14-day retention period', 410);
  }
  return cachedOk({ id: screenshot.id, file_url: screenshot.file_url, storageExpired: false }, 300);
}
