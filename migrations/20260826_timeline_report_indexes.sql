CREATE INDEX IF NOT EXISTS idx_attendance_employee_check_in
  ON attendance(employee_id, check_in DESC);

CREATE INDEX IF NOT EXISTS idx_attendance_open_window
  ON attendance(employee_id, check_in DESC, check_out);

CREATE INDEX IF NOT EXISTS idx_breaks_attendance_time
  ON breaks(attendance_id, start_time DESC, end_time);

CREATE INDEX IF NOT EXISTS idx_screenshots_employee_captured_at
  ON screenshots(employee_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_screenshots_session_captured_at
  ON screenshots(session_id, captured_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_screenshots_employee_app_captured_at
  ON screenshots(employee_id, active_app, captured_at DESC)
  WHERE active_app IS NOT NULL AND TRIM(active_app) <> '';

CREATE INDEX IF NOT EXISTS idx_profiles_active_employee_name
  ON public.profiles(full_name)
  WHERE role = 'employee' AND COALESCE(account_status, 'active') = 'active';

CREATE INDEX IF NOT EXISTS idx_client_assignments_client_employee
  ON client_assignments(client_id, employee_id);
