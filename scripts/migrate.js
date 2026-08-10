require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log('Running migrations on Postgres...');

    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'employee',
        department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
        employee_code TEXT,
        shift_type TEXT NOT NULL DEFAULT 'full_time',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS shift_type TEXT NOT NULL DEFAULT 'full_time'
    `);

    await pool.query(`
      ALTER TABLE public.profiles
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS reset_token TEXT,
      ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_reset_token
      ON public.profiles (reset_token)
      WHERE reset_token IS NOT NULL
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_assignments (
        client_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        shift_type TEXT NOT NULL DEFAULT 'full_time',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (client_id, employee_id)
      )
    `);

    await pool.query(`
      ALTER TABLE client_assignments
      ADD COLUMN IF NOT EXISTS shift_type TEXT NOT NULL DEFAULT 'full_time'
    `);

    await pool.query(`
      ALTER TABLE client_assignments
      DROP CONSTRAINT IF EXISTS client_assignments_employee_id_key
    `);

    await pool.query(`
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
    `);

    await pool.query(`ALTER TABLE screenshot_flags ADD COLUMN IF NOT EXISTS flagged_screenshot_url TEXT`);
    await pool.query(`ALTER TABLE screenshot_flags ADD COLUMN IF NOT EXISTS flagged_screenshot_name TEXT`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        lead_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        duration_s INTEGER,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS employee_status (
        employee_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
        current_status TEXT NOT NULL DEFAULT 'offline',
        last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
        current_app TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
        check_in TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        check_out TIMESTAMPTZ,
        total_minutes INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'working',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS breaks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        attendance_id UUID NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
        start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        end_time TIMESTAMPTZ,
        duration_minutes INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recordings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID REFERENCES attendance(id) ON DELETE SET NULL,
        file_url TEXT NOT NULL,
        duration_seconds INTEGER,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_activity (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID REFERENCES attendance(id) ON DELETE SET NULL,
        app_name TEXT,
        duration_seconds INTEGER,
        start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS screenshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID REFERENCES attendance(id) ON DELETE SET NULL,
        file_url TEXT NOT NULL,
        active_app TEXT,
        activity_pct INTEGER DEFAULT 0,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        id TEXT PRIMARY KEY,
        last_run_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID REFERENCES attendance(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        app_name TEXT,
        window_title TEXT,
        detail TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        to_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT false,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_screenshots_employee ON screenshots(employee_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_screenshots_time ON screenshots(captured_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_screenshot_flags_screenshot ON screenshot_flags(screenshot_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recordings_employee ON recordings(employee_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_activity_employee ON app_activity(employee_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_events_employee ON activity_events(employee_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_breaks_attendance ON breaks(attendance_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id)`);

    await pool.query(`
      UPDATE public.profiles
      SET role = CASE role
        WHEN 'super_admin' THEN 'superadmin'
        WHEN 'team_lead' THEN 'qa_lead'
        ELSE role
      END
      WHERE role IN ('super_admin', 'team_lead')
    `);

    const { rows: existing } = await pool.query(
      "SELECT id FROM public.profiles WHERE role = 'superadmin' LIMIT 1",
    );

    if (!existing.length) {
      await pool.query(
        `INSERT INTO public.profiles (full_name, email, role)
         VALUES ($1, $2, $3)`,
        ['Super Admin', 'admin@company.com', 'superadmin'],
      );
      console.log('Created default super admin profile');
    }

    console.log('All migrations complete');
  } finally {
    await pool.end();
  }
}

runMigrations()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
