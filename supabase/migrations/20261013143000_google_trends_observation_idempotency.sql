-- Additive cross-run idempotency for Google Trends demand observations.
-- Historical rows keep NULL keys and are neither deleted nor rewritten.
ALTER TABLE public.demand_observations
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- PostgreSQL permits multiple NULLs in a unique index, so legacy history remains intact.
CREATE UNIQUE INDEX IF NOT EXISTS demand_observations_idempotency_key_uidx
  ON public.demand_observations (idempotency_key);
