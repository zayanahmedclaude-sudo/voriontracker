CREATE TABLE IF NOT EXISTS timeline_preferences (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS timeline_employee_config (
  employee_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  schedule JSONB NOT NULL DEFAULT '[]', geofence JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_key TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  flagged BOOLEAN NOT NULL DEFAULT FALSE, duration_minutes DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(employee_id,event_key)
);
CREATE INDEX IF NOT EXISTS timeline_events_employee_at ON timeline_events(employee_id,created_at);
CREATE TABLE IF NOT EXISTS timeline_locations (
  employee_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, accuracy DOUBLE PRECISION NOT NULL,
  label TEXT NOT NULL DEFAULT '', within_bounds BOOLEAN, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS timeline_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly')), format TEXT NOT NULL CHECK(format IN ('csv','pdf')),
  recipient TEXT NOT NULL, next_run TIMESTAMPTZ NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  lease_until TIMESTAMPTZ, last_sent TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS timeline_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE, event_key TEXT NOT NULL, message TEXT NOT NULL,
  flagged BOOLEAN NOT NULL DEFAULT FALSE, dismissed BOOLEAN NOT NULL DEFAULT FALSE, read_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ, lease_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,event_key)
);
