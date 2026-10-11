export type VerifiedAdminUser = { email: string };

type AuthUser = { email?: string | null } | null;
type AuthClient = {
  auth: {
    getUser(token: string): Promise<{ data: { user: AuthUser }; error: unknown }>;
  };
};

type VerifyAdminDependencies = {
  getPublicConfig(): { url: string | null | undefined; anonKey: string | null | undefined };
  createAuthClient(url: string, anonKey: string, token: string): AuthClient;
  allowedEmails: string | undefined;
};

export type VerifyAdminResult =
  | { ok: true; admin: VerifiedAdminUser }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function verifyAdminRequest(
  request: Request,
  dependencies: VerifyAdminDependencies,
): Promise<VerifyAdminResult> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { ok: false, status: 401, error: "authentication_required" };

  const { url, anonKey } = dependencies.getPublicConfig();
  if (!url || !anonKey) return { ok: false, status: 503, error: "authentication_unavailable" };

  try {
    const client = dependencies.createAuthClient(url, anonKey, token);
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user?.email) return { ok: false, status: 401, error: "invalid_authentication" };

    const allowedEmails = (dependencies.allowedEmails ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (allowedEmails.length === 0 || !allowedEmails.includes(user.email.toLowerCase())) {
      return { ok: false, status: 403, error: "admin_access_required" };
    }
    return { ok: true, admin: { email: user.email } };
  } catch {
    return { ok: false, status: 503, error: "authentication_unavailable" };
  }
}
