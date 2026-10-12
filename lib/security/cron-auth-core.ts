export type CronAuthFailure = {
  status: 401;
  body: { ok: false; error: "cron_secret_not_configured" | "Unauthorized" };
};

export function checkCronAuth(
  request: Request,
  cronSecret: string | undefined,
): CronAuthFailure | null {
  if (!cronSecret) {
    return {
      status: 401,
      body: { ok: false, error: "cron_secret_not_configured" },
    };
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return {
      status: 401,
      body: { ok: false, error: "Unauthorized" },
    };
  }

  return null;
}
