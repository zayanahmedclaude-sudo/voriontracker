UPDATE breaks
SET duration_minutes = GREATEST(
  0,
  CEIL(EXTRACT(EPOCH FROM (end_time - start_time)) / 60)::int
)
WHERE end_time IS NOT NULL
  AND (
    duration_minutes IS NULL
    OR duration_minutes <> GREATEST(0, CEIL(EXTRACT(EPOCH FROM (end_time - start_time)) / 60)::int)
  );

WITH break_summary AS (
  SELECT
    attendance_id,
    COALESCE(SUM(COALESCE(duration_minutes, 0)), 0) AS break_minutes
  FROM breaks
  WHERE end_time IS NOT NULL
  GROUP BY attendance_id
),
recalculated AS (
  SELECT
    a.id,
    GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (a.check_out - a.check_in)) / 60)::int
      - COALESCE(bs.break_minutes, 0)
    ) AS total_minutes
  FROM attendance a
  LEFT JOIN break_summary bs ON bs.attendance_id = a.id
  WHERE a.check_out IS NOT NULL
)
UPDATE attendance a
SET total_minutes = recalculated.total_minutes
FROM recalculated
WHERE a.id = recalculated.id
  AND COALESCE(a.total_minutes, -1) <> recalculated.total_minutes;
