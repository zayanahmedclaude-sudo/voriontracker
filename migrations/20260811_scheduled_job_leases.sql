CREATE TABLE IF NOT EXISTS scheduled_job_leases (
  job_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_leases_locked_until
  ON scheduled_job_leases(locked_until);
