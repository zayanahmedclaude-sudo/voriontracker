import { sql } from './db';

let roleFeatureSchemaReady: Promise<void> | null = null;
let profileSchemaReady: Promise<void> | null = null;
let screenshotThumbnailSchemaReady: Promise<void> | null = null;
let monitoringSchemaReady: Promise<void> | null = null;

async function ensureProfileSchemaInternal() {
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS shift_type TEXT NOT NULL DEFAULT 'full_time'`;
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS employment_type TEXT`;
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active'`;
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS password_hash TEXT`;
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reset_token TEXT`;
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ`;
  await sql`UPDATE public.profiles SET account_status = 'active' WHERE account_status IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_profiles_reset_token ON public.profiles (reset_token) WHERE reset_token IS NOT NULL`;
}

async function ensureScreenshotThumbnailSchemaInternal() {
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`;
}

async function ensureRoleFeatureSchemaInternal() {
  await ensureProfileSchema();

  await sql`
    CREATE TABLE IF NOT EXISTS client_assignments (
      client_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      shift_type TEXT NOT NULL DEFAULT 'full_time',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, employee_id)
    )
  `;

  await sql`ALTER TABLE client_assignments ADD COLUMN IF NOT EXISTS shift_type TEXT NOT NULL DEFAULT 'full_time'`;
  await sql`ALTER TABLE client_assignments DROP CONSTRAINT IF EXISTS client_assignments_employee_id_key`;

  await sql`
    CREATE TABLE IF NOT EXISTS screenshot_flags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      screenshot_id UUID NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
      employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      flagged_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      comment TEXT NOT NULL DEFAULT '',
      pdf_url TEXT,
      pdf_name TEXT,
      email_to TEXT[] NOT NULL DEFAULT '{}',
      email_cc TEXT[] NOT NULL DEFAULT '{}',
      email_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`ALTER TABLE screenshot_flags ADD COLUMN IF NOT EXISTS flagged_screenshot_url TEXT`;
  await sql`ALTER TABLE screenshot_flags ADD COLUMN IF NOT EXISTS flagged_screenshot_name TEXT`;
}

async function ensureMonitoringSchemaInternal() {
  await ensureRoleFeatureSchema();

  await sql`
    CREATE TABLE IF NOT EXISTS device_registrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL UNIQUE,
      employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      hostname TEXT,
      os_platform TEXT,
      os_version TEXT,
      app_version TEXT,
      install_scope TEXT,
      device_label TEXT,
      disclosure_acknowledged_at TIMESTAMPTZ,
      disclosure_acknowledged_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      disclosure_version TEXT,
      is_company_device BOOLEAN NOT NULL DEFAULT FALSE,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS device_monitoring_acknowledgments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL,
      employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      hostname TEXT,
      notice_text TEXT NOT NULL,
      notice_version TEXT NOT NULL DEFAULT '2026-07-26',
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS device_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      device_id TEXT NOT NULL,
      hostname TEXT,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'monitoring',
      severity TEXT NOT NULL DEFAULT 'info',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS device_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      device_id TEXT NOT NULL,
      hostname TEXT,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_device_events_device_time ON device_events(device_id, occurred_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_device_alerts_device_time ON device_alerts(device_id, detected_at DESC)`;
}

export async function ensureProfileSchema() {
  if (!profileSchemaReady) {
    profileSchemaReady = ensureProfileSchemaInternal().catch((error) => {
      profileSchemaReady = null;
      throw error;
    });
  }
  await profileSchemaReady;
}

export async function ensureScreenshotThumbnailSchema() {
  if (!screenshotThumbnailSchemaReady) {
    screenshotThumbnailSchemaReady = ensureScreenshotThumbnailSchemaInternal().catch((error) => {
      screenshotThumbnailSchemaReady = null;
      throw error;
    });
  }
  await screenshotThumbnailSchemaReady;
}

export async function ensureRoleFeatureSchema() {
  if (!roleFeatureSchemaReady) {
    roleFeatureSchemaReady = ensureRoleFeatureSchemaInternal().catch((error) => {
      roleFeatureSchemaReady = null;
      throw error;
    });
  }
  await roleFeatureSchemaReady;
}

export async function ensureMonitoringSchema() {
  if (!monitoringSchemaReady) {
    monitoringSchemaReady = ensureMonitoringSchemaInternal().catch((error) => {
      monitoringSchemaReady = null;
      throw error;
    });
  }
  await monitoringSchemaReady;
}
