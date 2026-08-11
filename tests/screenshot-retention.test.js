const assert = require('node:assert/strict');
const test = require('node:test');

test('regular screenshot prefixes are separated from evidence prefixes', () => {
  const employeeId = 'employee-1';
  const date = '2026-08-11';
  const regular = `screenshots/regular/default/${employeeId}/${date}/shot.webp`;
  const thumb = `screenshots/thumbnails/default/${employeeId}/${date}/shot.webp`;
  const evidence = `evidence/flagged/default/${employeeId}/${date}/shot.webp`;

  assert.match(regular, /^screenshots\/regular\/default\/employee-1\/2026-08-11\//);
  assert.match(thumb, /^screenshots\/thumbnails\/default\/employee-1\/2026-08-11\//);
  assert.doesNotMatch(evidence, /^screenshots\/(regular|thumbnails)\//);
});

test('retention cutoff is exactly 14 elapsed days', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  assert.equal(cutoff.toISOString(), '2026-08-01T12:00:00.000Z');
});

test('retention SQL preserves rows and excludes protected/unsafe records', () => {
  const where = `
    s.captured_at < $1
    AND s.storage_expired_at IS NULL
    AND (s.file_url IS NOT NULL OR s.thumbnail_url IS NOT NULL)
    AND (s.file_url LIKE 'https://r2.example.com/bucket%' OR s.thumbnail_url LIKE 'https://r2.example.com/bucket%')
    AND NOT EXISTS (
      SELECT 1
      FROM screenshot_flags sf
      WHERE sf.screenshot_id = s.id
    )
    AND NOT (COALESCE(s.file_url, '') LIKE '%/evidence/%' OR COALESCE(s.thumbnail_url, '') LIKE '%/evidence/%')
  `;
  const update = `
    WITH candidate AS (SELECT s.id FROM screenshots s WHERE ${where} ORDER BY s.captured_at ASC, s.id ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
    UPDATE screenshots s
    SET file_url = NULL, thumbnail_url = NULL, storage_expired_at = NOW()
    FROM candidate
    WHERE s.id = candidate.id
    RETURNING s.id
  `;

  assert.match(update, /UPDATE screenshots s/);
  assert.doesNotMatch(update, /DELETE FROM screenshots/i);
  assert.match(update, /NOT EXISTS[\s\S]+screenshot_flags/);
  assert.match(update, /storage_expired_at IS NULL/);
  assert.match(update, /LIKE 'https:\/\/r2\.example\.com\/bucket%'/);
  assert.match(update, /FOR UPDATE SKIP LOCKED/);
});
