CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  assigned_employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_employee ON devices(assigned_employee_id);

ALTER TABLE screenshots ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS device_registration_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS capture_context TEXT NOT NULL DEFAULT 'employee_session';
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS capture_local_id TEXT;
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS r2_key TEXT;
UPDATE screenshots SET capture_context = 'device_background' WHERE capture_context = 'device_outside_session';
ALTER TABLE screenshots DROP CONSTRAINT IF EXISTS screenshots_capture_context_check;
ALTER TABLE screenshots ADD CONSTRAINT screenshots_capture_context_check CHECK (capture_context IN ('employee_session', 'device_background')) NOT VALID;
ALTER TABLE screenshots VALIDATE CONSTRAINT screenshots_capture_context_check;
ALTER TABLE screenshots DROP CONSTRAINT IF EXISTS screenshots_device_background_provenance_check;
ALTER TABLE screenshots ADD CONSTRAINT screenshots_device_background_provenance_check CHECK (capture_context <> 'device_background' OR (device_registration_id IS NOT NULL AND employee_id IS NULL AND session_id IS NULL)) NOT VALID;
ALTER TABLE screenshots VALIDATE CONSTRAINT screenshots_device_background_provenance_check;
CREATE INDEX IF NOT EXISTS idx_screenshots_device_time ON screenshots(device_registration_id, captured_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_screenshots_capture_local_id_unique ON screenshots(capture_local_id) WHERE capture_local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_screenshots_r2_key_unique ON screenshots(r2_key) WHERE r2_key IS NOT NULL;
