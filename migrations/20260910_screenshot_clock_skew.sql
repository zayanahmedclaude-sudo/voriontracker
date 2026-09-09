ALTER TABLE screenshots
  ADD COLUMN IF NOT EXISTS device_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clock_skew_seconds INTEGER;

COMMENT ON COLUMN screenshots.device_captured_at IS
  'Original UTC timestamp reported by the capture device before server clock-skew correction.';

COMMENT ON COLUMN screenshots.clock_skew_seconds IS
  'Whole seconds by which the device-reported capture time differed from server receipt time.';
