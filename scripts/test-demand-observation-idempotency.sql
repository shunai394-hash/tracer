\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE public.demand_observations (
  id bigserial PRIMARY KEY,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO public.demand_observations (metadata) VALUES
  ('{"query":"バッグ","provider":"google_trends"}'),
  ('{"query":"バッグ","provider":"google_trends"}'),
  ('{"query":"美容液","provider":"google_trends"}');

\ir ../supabase/migrations/20261013143000_google_trends_observation_idempotency.sql

DO $$
DECLARE
  row_count bigint;
  key_count bigint;
BEGIN
  SELECT count(*) INTO row_count FROM public.demand_observations;
  IF row_count <> 3 THEN
    RAISE EXCEPTION 'migration changed historical rows: expected 3, got %', row_count;
  END IF;

  IF (SELECT count(*) FROM public.demand_observations WHERE idempotency_key IS NULL) <> 3 THEN
    RAISE EXCEPTION 'historical rows must remain with NULL idempotency keys';
  END IF;

  INSERT INTO public.demand_observations (metadata, idempotency_key)
  VALUES ('{"query":"バッグ","provider":"google_trends"}', 'google-trends:source:2026-10-13:バッグ')
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.demand_observations (metadata, idempotency_key)
  VALUES ('{"query":"バッグ","provider":"google_trends"}', 'google-trends:source:2026-10-13:バッグ')
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT count(*) INTO key_count FROM public.demand_observations
    WHERE idempotency_key = 'google-trends:source:2026-10-13:バッグ';
  IF key_count <> 1 THEN
    RAISE EXCEPTION 'concurrent/repeated key should produce one row, got %', key_count;
  END IF;

  INSERT INTO public.demand_observations (metadata, idempotency_key)
  VALUES ('{"query":"バッグ","provider":"google_trends"}', 'google-trends:source:2026-10-14:バッグ')
  ON CONFLICT (idempotency_key) DO NOTHING;

  SELECT count(*) INTO key_count FROM public.demand_observations
    WHERE idempotency_key LIKE 'google-trends:source:%:バッグ';
  IF key_count <> 2 THEN
    RAISE EXCEPTION 'different observation dates should produce separate rows, got %', key_count;
  END IF;
END $$;

ROLLBACK;
