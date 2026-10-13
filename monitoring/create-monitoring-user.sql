-- Read-only login for the Prometheus postgres-exporter.
-- Run once as a Postgres superuser, after replacing the password:
--   psql "postgresql://<superuser>@<host>:5432/vorion_tracker" -f create-monitoring-user.sql
-- pg_monitor grants read access to statistics views only; it cannot read or
-- change application tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vorion_monitor') THEN
    CREATE ROLE vorion_monitor LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
  END IF;
END
$$;

ALTER ROLE vorion_monitor SET statement_timeout = '10s';
GRANT pg_monitor TO vorion_monitor;
GRANT CONNECT ON DATABASE vorion_tracker TO vorion_monitor;
