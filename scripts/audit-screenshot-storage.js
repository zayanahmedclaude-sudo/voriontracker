#!/usr/bin/env node
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const columns = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'screenshots' AND column_name IN ('blob_url','file_url','thumbnail_url'))
          OR (table_name = 'screenshot_flags' AND column_name IN ('flagged_screenshot_url','pdf_url')))
      ORDER BY table_name, column_name
    `);
    const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    const endpoint = String(process.env.R2_ENDPOINT || '').replace(/\/$/, '');
    const bucket = String(process.env.R2_BUCKET_NAME || '');
    for (const { table_name: table, column_name: column } of columns.rows) {
      const result = await client.query(`
        SELECT classification, count(*)::int AS count
        FROM (
          SELECT CASE
            WHEN ${column} IS NULL OR btrim(${column}) = '' THEN 'null_or_empty'
            WHEN ${column} LIKE '%/storage/v1/%' THEN 'legacy_supabase'
            WHEN ${column} LIKE '%.blob.vercel-storage.com/%' OR ${column} LIKE '%.vercel-storage.com/%' THEN 'legacy_vercel_blob'
            WHEN ($1 <> '' AND ${column} LIKE $1 || '/%')
              OR ($2 <> '' AND $3 <> '' AND ${column} LIKE $2 || '/' || $3 || '/%') THEN 'cloudflare_r2'
            ELSE 'unknown'
          END AS classification
          FROM ${table}
        ) classified
        GROUP BY classification
        ORDER BY classification
      `, [publicBase, endpoint, bucket]);
      console.log(JSON.stringify({ table, column, counts: Object.fromEntries(result.rows.map((row) => [row.classification, row.count])) }));
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[storage-audit] failed:', error.message);
  process.exitCode = 1;
});
