#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST must point to the disposable CI PostgreSQL instance}"
: "${PGPORT:?PGPORT must be set}"
: "${PGUSER:?PGUSER must be set}"
: "${PGPASSWORD:?PGPASSWORD must be set}"
: "${PGDATABASE:?PGDATABASE must be the disposable concurrency-test database}"

export PGPASSWORD

# This database is created exclusively for this CI test. Never point this test
# at a production database: it creates a minimal table and applies the migration.
psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.demand_observations (
  id bigserial PRIMARY KEY,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
SQL

psql -v ON_ERROR_STOP=1 -f supabase/migrations/20261013143000_google_trends_observation_idempotency.sql

key="google-trends:concurrency-test:2026-10-13:shared-query"
insert_sql="INSERT INTO public.demand_observations (metadata, idempotency_key) VALUES (jsonb_build_object('query', 'shared-query'), '$key') ON CONFLICT (idempotency_key) DO NOTHING;"

# Start both requests before waiting for either one. The unique index, not
# application-side prechecks, must arbitrate the race.
psql -v ON_ERROR_STOP=1 -c "$insert_sql" &
pid_a=$!
psql -v ON_ERROR_STOP=1 -c "$insert_sql" &
pid_b=$!

wait "$pid_a"
wait "$pid_b"

count="$(psql -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM public.demand_observations WHERE idempotency_key = '$key';")"
if [[ "$count" != "1" ]]; then
  echo "FAIL: concurrent duplicate inserts produced $count rows; expected exactly 1" >&2
  exit 1
fi

echo "PASS: two concurrent inserts with the same idempotency key produced exactly one row"
