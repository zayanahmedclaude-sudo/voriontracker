ALTER TABLE screenshots
  ADD COLUMN IF NOT EXISTS storage_expired_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'screenshots'
      AND column_name = 'file_url'
  ) THEN
    ALTER TABLE screenshots ALTER COLUMN file_url DROP NOT NULL;
  END IF;
END $$;

DO $$
DECLARE
  predicate TEXT;
BEGIN
  SELECT string_agg(format('%I IS NOT NULL', column_name), ' OR ')
  INTO predicate
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'screenshots'
    AND column_name IN ('file_url', 'blob_url', 'thumbnail_url', 'blob_path');

  IF predicate IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_screenshots_retention_regular
       ON screenshots(captured_at ASC, id ASC)
       WHERE storage_expired_at IS NULL AND (%s)',
      predicate
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_screenshot_flags_screenshot
  ON screenshot_flags(screenshot_id);
