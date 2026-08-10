import { getExistingColumns, withTransaction } from '@/lib/db';
import { deleteR2Objects, getR2KeyFromUrl } from '@/lib/r2';

const RETENTION_DAYS = 3;
const MIN_RUN_INTERVAL_HOURS = 12;
const DELETE_BATCH_SIZE = 1000;
const JOB_ID = 'screenshot-retention';

type RetentionResult = {
  skipped: boolean;
  reason?: string;
  cutoff: string;
  deletedRows: number;
  deletedR2Objects: number;
  storageErrors: string[];
};

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
      deletedR2Objects: 0,
      storageErrors,
    };
  }

  const r2Keys = new Set<string>();
  for (const row of deleted.rows) {
    for (const column of selectedUrlColumns) {
      const key = getR2KeyFromUrl(row[column]);
      if (key) r2Keys.add(key);
    }
  }

  let deletedR2Objects = 0;
  try {
    deletedR2Objects = await deleteR2Objects([...r2Keys]);
  } catch (error: any) {
    storageErrors.push(error?.message || String(error));
  }

  return {
    skipped: false,
    cutoff,
    deletedRows: deleted.rows.length,
    deletedR2Objects,
    storageErrors,
  };
}
