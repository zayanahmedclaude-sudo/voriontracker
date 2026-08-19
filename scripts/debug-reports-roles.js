require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getOne(role) {
  const result = await pool.query(
    `SELECT id, full_name, role FROM public.profiles WHERE role = $1 ORDER BY full_name NULLS LAST LIMIT 1`,
    [role],
  );
  return result.rows[0] || null;
}

async function runWeekly(isEmployee, userSub) {
  const query = `
    WITH week_days AS (
      SELECT generate_series(
        date_trunc('week', CURRENT_DATE::timestamp)::date,
        (date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '6 days')::date,
        INTERVAL '1 day'
      )::date AS day
    ),
    break_summary AS (
      SELECT attendance_id, COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
      FROM breaks
      GROUP BY attendance_id
    ),
    attendance_weekly AS (
      SELECT
        DATE(a.check_in) AS day,
        a.employee_id,
        a.check_in,
        a.check_out,
        a.total_minutes,
        COALESCE(b.break_minutes, 0) AS break_minutes
      FROM attendance a
      LEFT JOIN break_summary b ON b.attendance_id = a.id
      JOIN public.profiles p ON p.id = a.employee_id
      WHERE DATE(a.check_in) >= date_trunc('week', CURRENT_DATE::timestamp)::date
        AND DATE(a.check_in) <= (date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '6 days')::date
        AND p.role = 'employee'
        AND (($1 = true AND a.employee_id = $2::uuid) OR ($1 = false))
    ),
    weekly_rollup AS (
      SELECT
        day,
        COUNT(DISTINCT employee_id) AS active_users,
        COALESCE(SUM(
          CASE
            WHEN check_out IS NOT NULL THEN GREATEST(0, COALESCE(total_minutes, 0) - break_minutes)
            ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - check_in)) / 60)::int - break_minutes)
          END
        ), 0) * 60 AS total_seconds
      FROM attendance_weekly
      GROUP BY day
    )
    SELECT wd.day, COALESCE(wr.active_users, 0) AS active_users, COALESCE(wr.total_seconds, 0) AS total_seconds
    FROM week_days wd
    LEFT JOIN weekly_rollup wr ON wr.day = wd.day
    ORDER BY wd.day
  `;
  return pool.query(query, [isEmployee, userSub]);
}

async function main() {
  try {
    const employee = await getOne('employee');
    const admin = await getOne('admin');
    console.log('SAMPLES', {
      employee: employee ? { id: employee.id, role: employee.role } : null,
      admin: admin ? { id: admin.id, role: admin.role } : null,
    });

    if (employee) {
      const weeklyEmployee = await runWeekly(true, employee.id);
      console.log('WEEKLY_EMPLOYEE_OK', weeklyEmployee.rowCount);
    }

    if (admin) {
      const weeklyAdmin = await runWeekly(false, admin.id);
      console.log('WEEKLY_ADMIN_OK', weeklyAdmin.rowCount);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('DEBUG_ROLES_ERR', error.message);
  process.exit(1);
});
