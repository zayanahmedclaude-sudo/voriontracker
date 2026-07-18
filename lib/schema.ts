import { sql } from './db';

let roleFeatureSchemaReady: Promise<void> | null = null;

async function ensureRoleFeatureSchemaInternal() {
  await sql`ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS shift_type TEXT NOT NULL DEFAULT 'full_time'`;

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

export async function ensureRoleFeatureSchema() {
  if (!roleFeatureSchemaReady) {
    roleFeatureSchemaReady = ensureRoleFeatureSchemaInternal().catch((error) => {
      roleFeatureSchemaReady = null;
      throw error;
    });
  }
  await roleFeatureSchemaReady;
}
