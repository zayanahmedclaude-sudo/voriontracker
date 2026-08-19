require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const weeklyQuery = `
WITH week_days AS (
  SELECT generate_series(
    date_trunc('week', CURRENT_DATE::timestamp)::date,
    (date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '6 days')::date,
    INTERVAL '1 day'
  )::date AS day
),
break_summary AS (
  SELECT
    attendance_id,
    COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
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
SELECT
  wd.day,
  COALESCE(wr.active_users, 0) AS active_users,
  COALESCE(wr.total_seconds, 0) AS total_seconds,
  (
    SELECT COUNT(*)
    FROM screenshots s
    JOIN public.profiles sp ON sp.id = s.employee_id
    WHERE DATE(s.captured_at) = wd.day
  ) AS screenshots
FROM week_days wd
LEFT JOIN weekly_rollup wr ON wr.day = wd.day
ORDER BY wd.day
`;

const dailySmokeQuery = `
WITH break_summary AS (
  SELECT
    attendance_id,
    COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
  FROM breaks
  GROUP BY attendance_id
)
SELECT COUNT(*) AS count
FROM break_summary
`;

async function main() {
  try {
    const weekly = await pool.query(weeklyQuery);
    console.log('WEEKLY_OK', weekly.rowCount);
  } catch (error) {
    console.error('WEEKLY_ERR', error.message);
  }

  try {
    const daily = await pool.query(dailySmokeQuery);
    console.log('DAILY_OK', daily.rows[0]);
  } catch (error) {
    console.error('DAILY_ERR', error.message);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error('FATAL_ERR', error.message);
  await pool.end();
  process.exit(1);
});
