-- Prevent concurrent market-sourcing cron workers from claiming the same job.
create unique index if not exists cron_runs_running_job_uq
  on public.cron_runs (job_name)
  where status = 'running';

comment on index public.cron_runs_running_job_uq is
  'Ensures only one running cron worker exists per job name.';
