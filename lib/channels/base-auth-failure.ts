/** Stable marker used to stop scheduled BASE calls after a confirmed invalid-token response. */
export const BASE_AUTH_REAUTH_REQUIRED = "base_auth_invalid_reauthorization_required";

/** Detect BASE token rejection without treating ordinary item validation errors as auth failures. */
export function isBaseAuthenticationFailure(message: unknown): boolean {
  if (typeof message !== "string" || !message.trim()) return false;
  const decoded = message.replace(/\\\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return /アクセストークンが無効|invalid[_ ]token|invalid access token|access token.{0,30}(?:invalid|expired)/i.test(decoded);
}
