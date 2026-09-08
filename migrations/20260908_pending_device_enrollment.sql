CREATE TABLE IF NOT EXISTS pending_device_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name TEXT NOT NULL,
  requested_employee_name TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','expired')),
  assigned_employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  encrypted_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  approved_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ
);
ALTER TABLE pending_device_enrollments ADD COLUMN IF NOT EXISTS requested_employee_name TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_pending_device_enrollments_status ON pending_device_enrollments(status, expires_at);
