import { randomUUID } from 'crypto';
import { getExistingColumns, queryRows, withTransaction } from '@/lib/db';

export const SCREENSHOT_RETENTION_DAYS = 14;
export const DEFAULT_RETENTION_BATCH_SIZE = 5000;
export const DEFAULT_RETENTION_TIME_BUDGET_MS = 25000;
const JOB_ID = 'screenshot-retention';
const LEASE_SECONDS = 120;

export type ScreenshotRetentionResult = {
  success: boolean;
  dryRun: boolean;
  cutoff: string;
  batchesProcessed: number;
  rowsExpired: number;
  eligibleRowsRemaining: boolean;
  durationMs: number;
  lockAcquired: boolean;
  batchSize: number;
};

type RetentionOptions = {
  dryRun?: boolean;
  now?: Date;
  batchSize?: number;
  timeBudgetMs?: number;
};

type ScreenshotStorageColumns = {
  fullUrlColumns: string[];
  thumbnailUrlColumns: string[];
  objectKeyColumns: string[];
  providerColumn: string | null;
  expirationColumn: string | null;
  allowedUrlPrefixes: string[];
};

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function getScreenshotRetentionCutoff(now = new Date()) {
  return new Date(now.getTime() - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function buildScreenshotRetentionWhere(columns: ScreenshotStorageColumns, paramOffset = 0) {
  const cutoffParam = `$${paramOffset + 1}`;
  const storageChecks = [...columns.fullUrlColumns, ...columns.thumbnailUrlColumns]
    .concat(columns.objectKeyColumns)
    .map((column) => `s.${column} IS NOT NULL`)
    .join(' OR ');
  const notExpired = columns.expirationColumn ? `s.${columns.expirationColumn} IS NULL` : 'TRUE';
  const urlColumns = [...columns.fullUrlColumns, ...columns.thumbnailUrlColumns];
  const allowedHostChecks = urlColumns
    .flatMap((column) => columns.allowedUrlPrefixes.map((prefix) => `s.${column} LIKE '${prefix.replace(/'/g, "''")}%'`))
    .join(' OR ');
  const allPresentUrlsAreAllowed = urlColumns.length ? urlColumns
    .map((column) => `(s.${column} IS NULL OR ${columns.allowedUrlPrefixes.map((prefix) => `s.${column} LIKE '${prefix.replace(/'/g, "''")}%'`).join(' OR ') || 'FALSE'})`)
    .join(' AND ') : 'TRUE';
  const safeProvider = columns.providerColumn ? `(s.${columns.providerColumn} IS NULL OR lower(s.${columns.providerColumn}) = 'r2')` : 'TRUE';
  const allowedKeyChecks = columns.objectKeyColumns
    .map((column) => `(s.${column} LIKE 'screenshots/regular/default/%' OR s.${column} LIKE 'screenshots/thumbnails/default/%')`)
    .join(' OR ');
  return `
    s.captured_at < ${cutoffParam}
    AND ${notExpired}
    AND (${storageChecks || 'FALSE'})
    AND (${safeProvider})
    AND ((${allowedHostChecks || 'FALSE'}) OR (${allowedKeyChecks || 'FALSE'}))
    AND (${allPresentUrlsAreAllowed || 'FALSE'})
    AND NOT EXISTS (
      SELECT 1
      FROM screenshot_flags sf
      WHERE sf.screenshot_id = s.id
    )
    AND (
      ${columns.fullUrlColumns.map((column) => `s.${column} LIKE '%/screenshots/regular/%'`).join(' OR ') || 'FALSE'}
      OR ${columns.thumbnailUrlColumns.map((column) => `s.${column} LIKE '%/screenshots/thumbnails/%'`).join(' OR ') || 'FALSE'}
      OR ${columns.objectKeyColumns.map((column) => `s.${column} LIKE 'screenshots/regular/%'`).join(' OR ') || 'FALSE'}
      OR ${columns.objectKeyColumns.map((column) => `s.${column} LIKE 'screenshots/thumbnails/%'`).join(' OR ') || 'FALSE'}
    )
    AND NOT (
      ${[...columns.fullUrlColumns, ...columns.thumbnailUrlColumns].map((column) => `COALESCE(s.${column}, '') LIKE '%/evidence/%'`).join(' OR ') || 'FALSE'}
    )
  `;
}

async function getStorageColumns(): Promise<ScreenshotStorageColumns> {
  const columns = await getExistingColumns('screenshots', ['blob_url', 'file_url', 'thumbnail_url', 'blob_path', 'storage_provider', 'storage_expired_at']);
  const fullUrlColumns = ['blob_url', 'file_url'].filter((column) => columns.has(column));
  const thumbnailUrlColumns = ['thumbnail_url'].filter((column) => columns.has(column));
  const objectKeyColumns = ['blob_path'].filter((column) => columns.has(column));
  if (!fullUrlColumns.length && !thumbnailUrlColumns.length && !objectKeyColumns.length) {
    throw new Error('screenshots table is missing screenshot storage reference columns');
  }
  const allowedUrlPrefixes = [
    process.env.R2_PUBLIC_URL,
    process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME ? `${String(process.env.R2_ENDPOINT).replace(/\/$/, '')}/${process.env.R2_BUCKET_NAME}` : '',
  ].map((value) => String(value || '').replace(/\/$/, '')).filter(Boolean);
  if (!allowedUrlPrefixes.length) {
    throw new Error('R2_PUBLIC_URL or R2_ENDPOINT/R2_BUCKET_NAME is required for retention URL safety');
  }
  return {
    fullUrlColumns,
    thumbnailUrlColumns,
    objectKeyColumns,
    providerColumn: columns.has('storage_provider') ? 'storage_provider' : null,
    expirationColumn: columns.has('storage_expired_at') ? 'storage_expired_at' : null,
    allowedUrlPrefixes,
  };
}

async function acquireLease(ownerId: string) {
  const rows = await queryRows(
    `INSERT INTO scheduled_job_leases (job_name, owner_id, locked_until, heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, NOW() + ($3::text || ' seconds')::interval, NOW(), NOW(), NOW())
     ON CONFLICT (job_name) DO UPDATE
     SET owner_id = EXCLUDED.owner_id,
         locked_until = EXCLUDED.locked_until,
         heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE scheduled_job_leases.locked_until < NOW()
     RETURNING owner_id`,
    [JOB_ID, ownerId, LEASE_SECONDS],
  );
  return rows[0]?.owner_id === ownerId;
}

async function renewLease(ownerId: string) {
  const rows = await queryRows(
    `UPDATE scheduled_job_leases
     SET locked_until = NOW() + ($3::text || ' seconds')::interval,
         heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE job_name = $1 AND owner_id = $2
     RETURNING owner_id`,
    [JOB_ID, ownerId, LEASE_SECONDS],
  );
  return rows[0]?.owner_id === ownerId;
}

async function releaseLease(ownerId: string) {
  await queryRows(
    `UPDATE scheduled_job_leases
     SET locked_until = NOW(), updated_at = NOW()
     WHERE job_name = $1 AND owner_id = $2`,
    [JOB_ID, ownerId],
  ).catch(() => undefined);
}

async function countEligible(cutoff: string, columns: ScreenshotStorageColumns) {
  const where = buildScreenshotRetentionWhere(columns);
  const rows = await queryRows(`SELECT COUNT(*)::bigint AS count FROM screenshots s WHERE ${where}`, [cutoff]);
  return Number(rows[0]?.count || 0);
}

export async function runScreenshotRetention(options: RetentionOptions = {}): Promise<ScreenshotRetentionResult> {
  const startedAt = Date.now();
  const cutoff = getScreenshotRetentionCutoff(options.now).toISOString();
  const batchSize = clampPositiveInt(options.batchSize ?? process.env.SCREENSHOT_RETENTION_BATCH_SIZE, DEFAULT_RETENTION_BATCH_SIZE, 1, 10000);
  const timeBudgetMs = clampPositiveInt(options.timeBudgetMs ?? process.env.SCREENSHOT_RETENTION_TIME_BUDGET_MS, DEFAULT_RETENTION_TIME_BUDGET_MS, 1000, 28000);
  const dryRun = Boolean(options.dryRun);
  const columns = await getStorageColumns();
  const ownerId = randomUUID();

  console.info('[screenshot-retention] start', { cutoff, dryRun, batchSize, timeBudgetMs });

  const lockAcquired = await acquireLease(ownerId);
    let batchesProcessed = 0;
    let rowsExpired = 0;

    if (!lockAcquired) {
      console.info('[screenshot-retention] lock not acquired', { cutoff, dryRun });
      return {
        success: true,
        dryRun,
        cutoff,
        batchesProcessed: 0,
        rowsExpired: 0,
        eligibleRowsRemaining: true,
        durationMs: Date.now() - startedAt,
        lockAcquired: false,
        batchSize,
      };
    }

    try {
    if (dryRun) {
      rowsExpired = await countEligible(cutoff, columns);
      return {
        success: true,
        dryRun,
        cutoff,
        batchesProcessed: 0,
        rowsExpired,
        eligibleRowsRemaining: rowsExpired > 0,
        durationMs: Date.now() - startedAt,
        lockAcquired,
        batchSize,
      };
    }

    const assignments = [
      ...columns.fullUrlColumns.map((column) => `${column} = NULL`),
      ...columns.thumbnailUrlColumns.map((column) => `${column} = NULL`),
      ...columns.objectKeyColumns.map((column) => `${column} = NULL`),
      ...(columns.expirationColumn ? [`${columns.expirationColumn} = NOW()`] : []),
    ].join(', ');
    const where = buildScreenshotRetentionWhere(columns);

    while (Date.now() - startedAt < timeBudgetMs - 1500) {
      const updated = await withTransaction(async (client) => {
        const result = await client.query(
          `WITH candidate AS (
             SELECT s.id
             FROM screenshots s
             WHERE ${where}
             ORDER BY s.captured_at ASC, s.id ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           UPDATE screenshots s
           SET ${assignments}
           FROM candidate
           WHERE s.id = candidate.id
           RETURNING s.id`,
          [cutoff, batchSize],
        );
        return result.rowCount || 0;
      });

      if (!updated) break;
      batchesProcessed += 1;
      rowsExpired += updated;
      const renewed = await renewLease(ownerId);
      if (!renewed) throw new Error('Retention lease lost');
      console.info('[screenshot-retention] batch expired', { batch: batchesProcessed, rowsExpired });
      if (updated < batchSize) break;
    }

    const remaining = await countEligible(cutoff, columns);
    console.info('[screenshot-retention] complete', {
      cutoff,
      batchesProcessed,
      rowsExpired,
      durationMs: Date.now() - startedAt,
      eligibleRowsRemaining: remaining > 0,
    });

    return {
      success: true,
      dryRun,
      cutoff,
      batchesProcessed,
      rowsExpired,
      eligibleRowsRemaining: remaining > 0,
      durationMs: Date.now() - startedAt,
      lockAcquired,
      batchSize,
    };
    } catch (error: any) {
      console.error('[screenshot-retention] failed', { category: error?.code || error?.name || 'unknown', message: error?.message || String(error) });
      throw error;
    } finally {
      await releaseLease(ownerId);
    }
}

export async function deleteExpiredScreenshots(options: RetentionOptions = {}) {
  return runScreenshotRetention(options);
}
