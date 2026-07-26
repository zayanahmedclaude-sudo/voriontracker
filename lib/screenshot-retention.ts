import { del } from '@vercel/blob';
import { getExistingColumns, withTransaction } from '@/lib/db';
import { assertSupabaseAdmin } from '@/lib/supabase';

const RETENTION_DAYS = 3;
const MIN_RUN_INTERVAL_HOURS = 12;
const DELETE_BATCH_SIZE = 1000;
const BLOB_DELETE_BATCH_SIZE = 100;
const JOB_ID = 'screenshot-retention';

type RetentionResult = {
  skipped: boolean;
  reason?: string;
  cutoff: string;
  deletedRows: number;
  deletedBlobUrls: number;
  deletedSupabaseObjects: number;
  storageErrors: string[];
};

function getVercelBlobUrl(rawUrl: unknown) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol === 'https:'
      && (
        url.hostname.endsWith('.blob.vercel-storage.com')
        || url.hostname.endsWith('.public.blob.vercel-storage.com')
        || url.hostname.endsWith('.vercel-storage.com')
      )
    ) {
      return rawUrl;
    }
  } catch {}
  return '';
}

function getSupabaseObjectPath(rawUrl: unknown) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const pathname = new URL(rawUrl).pathname;
    const marker = '/storage/v1/object/public/screenshots/';
    const index = pathname.indexOf(marker);
    if (index === -1) return '';
    return decodeURIComponent(pathname.slice(index + marker.length));
  } catch {}
  return '';
}

async function deleteVercelBlobs(urls: string[], storageErrors: string[]) {
  let deleted = 0;
  for (let index = 0; index < urls.length; index += BLOB_DELETE_BATCH_SIZE) {
    const batch = urls.slice(index, index + BLOB_DELETE_BATCH_SIZE);
    try {
      await del(batch);
      deleted += batch.length;
    } catch (error: any) {
      storageErrors.push(error?.message || String(error));
    }
  }
  return deleted;
}

async function deleteSupabaseObjects(paths: string[], storageErrors: string[]) {
  if (!paths.length) return 0;
  try {
    const { error } = await assertSupabaseAdmin().storage.from('screenshots').remove(paths);
    if (error) throw error;
    return paths.length;
  } catch (error: any) {
    storageErrors.push(error?.message || String(error));
    return 0;
  }
}

export async function deleteExpiredScreenshots(options: { force?: boolean; now?: Date } = {}): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const cutoffDate = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoff = cutoffDate.toISOString();
  const storageErrors: string[] = [];

  const availableColumns = await getExistingColumns('screenshots', ['blob_url', 'file_url', 'thumbnail_url']);
  const hasBlobUrl = availableColumns.has('blob_url');
  const hasFileUrl = availableColumns.has('file_url');
  const hasThumbnailUrl = availableColumns.has('thumbnail_url');
  const selectedUrlColumns = [
    ...(hasBlobUrl ? ['blob_url'] : []),
    ...(hasFileUrl ? ['file_url'] : []),
    ...(hasThumbnailUrl ? ['thumbnail_url'] : []),
  ];

  if (!selectedUrlColumns.length) {
    throw new Error('screenshots table is missing a URL column');
  }

  const deleted = await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        id TEXT PRIMARY KEY,
        last_run_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [JOB_ID]);
    if (!lock.rows[0]?.locked) {
      return { skipped: true, reason: 'retention cleanup already running', rows: [] as any[] };
    }

    const job = await client.query('SELECT last_run_at FROM maintenance_jobs WHERE id = $1 FOR UPDATE', [JOB_ID]);
    const lastRunAt = job.rows[0]?.last_run_at ? new Date(job.rows[0].last_run_at).getTime() : 0;
    const minRunIntervalMs = MIN_RUN_INTERVAL_HOURS * 60 * 60 * 1000;
    if (!options.force && lastRunAt && now.getTime() - lastRunAt < minRunIntervalMs) {
      return { skipped: true, reason: 'retention cleanup ran recently', rows: [] as any[] };
    }

    const rows: any[] = [];
    while (true) {
      const candidates = await client.query(
        `SELECT id, ${selectedUrlColumns.join(', ')}
         FROM screenshots
         WHERE captured_at < $1
           AND NOT EXISTS (
             SELECT 1
             FROM screenshot_flags sf
             WHERE sf.screenshot_id = screenshots.id
           )
         ORDER BY captured_at ASC
         LIMIT $2`,
        [cutoff, DELETE_BATCH_SIZE],
      );

      if (!candidates.rows.length) break;

      const removed = await client.query(
        `DELETE FROM screenshots
         WHERE id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1
             FROM screenshot_flags sf
             WHERE sf.screenshot_id = screenshots.id
           )
         RETURNING id`,
        [candidates.rows.map((row: any) => row.id)],
      );
      const removedIds = new Set(removed.rows.map((row: any) => row.id));
      const deletedRows = candidates.rows.filter((row: any) => removedIds.has(row.id));
      rows.push(...deletedRows);

      if (candidates.rows.length < DELETE_BATCH_SIZE) break;
    }

    await client.query(
      `INSERT INTO maintenance_jobs (id, last_run_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, updated_at = NOW()`,
      [JOB_ID],
    );

    return { skipped: false, rows };
  });

  if (deleted.skipped) {
    return {
      skipped: true,
      reason: deleted.reason,
      cutoff,
      deletedRows: 0,
      deletedBlobUrls: 0,
      deletedSupabaseObjects: 0,
      storageErrors,
    };
  }

  const blobUrls = new Set<string>();
  const supabasePaths = new Set<string>();
  for (const row of deleted.rows) {
    for (const column of selectedUrlColumns) {
      const blobUrl = getVercelBlobUrl(row[column]);
      if (blobUrl) {
        blobUrls.add(blobUrl);
        continue;
      }
      const supabasePath = getSupabaseObjectPath(row[column]);
      if (supabasePath) supabasePaths.add(supabasePath);
    }
  }

  const deletedBlobUrls = await deleteVercelBlobs([...blobUrls], storageErrors);
  const deletedSupabaseObjects = await deleteSupabaseObjects([...supabasePaths], storageErrors);

  return {
    skipped: false,
    cutoff,
    deletedRows: deleted.rows.length,
    deletedBlobUrls,
    deletedSupabaseObjects,
    storageErrors,
  };
}
