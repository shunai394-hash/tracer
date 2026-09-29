-- Prevent overlapping executions of the same cron job.
-- Stale running rows are reclaimed by the job before acquiring its lock.
create unique index if not exists cron_runs_one_running_job_uq
  on public.cron_runs(job_name)
  where status = 'running';
