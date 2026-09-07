import { getExistingColumns, queryRows, sql } from './db';
import { ensureScreenshotR2Schema } from './screenshot-r2-schema';

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
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS storage_expired_at TIMESTAMPTZ`;
  await ensureScreenshotR2Schema();
  const columns = await getExistingColumns('screenshots', ['file_url', 'thumbnail_url', 'r2_key']);
  if (columns.has('file_url')) {
    await sql`ALTER TABLE screenshots ALTER COLUMN file_url DROP NOT NULL`;
  }
  const retentionColumns = ['file_url', 'thumbnail_url', 'r2_key'].filter((column) => columns.has(column));
  if (retentionColumns.length) {
    await queryRows(`
      CREATE INDEX IF NOT EXISTS idx_screenshots_retention_regular
      ON screenshots(captured_at ASC, id ASC)
      WHERE storage_expired_at IS NULL
        AND (${retentionColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')})
    `);
  }
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
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS storage_expired_at TIMESTAMPTZ`;
  await ensureScreenshotR2Schema();

  await sql`
    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL, assigned_employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_devices_employee ON devices(assigned_employee_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS pending_device_enrollments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), device_name TEXT NOT NULL, public_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','expired')),
      assigned_employee_id UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      approved_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
      device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL, encrypted_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
      approved_at TIMESTAMPTZ, claimed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pending_device_enrollments_status ON pending_device_enrollments(status, expires_at)`;
  await sql`ALTER TABLE screenshots ALTER COLUMN employee_id DROP NOT NULL`;
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS device_registration_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL`;
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS capture_context TEXT NOT NULL DEFAULT 'employee_session'`;
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS capture_local_id TEXT`;
  await sql`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS r2_key TEXT`;
  await sql`UPDATE screenshots SET capture_context = 'device_background' WHERE capture_context = 'device_outside_session'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_screenshots_device_time ON screenshots(device_registration_id, captured_at DESC)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_screenshots_capture_local_id_unique ON screenshots(capture_local_id) WHERE capture_local_id IS NOT NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_screenshots_r2_key_unique ON screenshots(r2_key) WHERE r2_key IS NOT NULL`;

  // Legacy-named telemetry inventory keyed by the agent instance id. This is
  // not an authentication source; `devices` is the canonical machine identity.
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
  await sql`CREATE INDEX IF NOT EXISTS idx_employee_status_updated_at ON employee_status(updated_at DESC)`;
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
