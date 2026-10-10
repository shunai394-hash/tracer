export type ShopifyAdminReadinessInput = {
  probeOk: boolean;
  adminApiOk: boolean;
  missingScopes?: readonly string[];
};

export type ShopifyAdminReadiness = {
  authenticated: boolean;
  ready: boolean;
  missingScopes: string[];
};

/**
 * A successful low-level shop probe is not enough to claim Admin API readiness.
 * The scope-bearing Admin API query must also succeed, and all required scopes
 * must be granted. A working static-token fallback may still be ready even if
 * the optional client-credentials exchange failed.
 */
export function evaluateShopifyAdminReadiness(
  input: ShopifyAdminReadinessInput,
): ShopifyAdminReadiness {
  const missingScopes = [...(input.missingScopes ?? [])];
  const authenticated = input.probeOk && input.adminApiOk;
  return {
    authenticated,
    ready: authenticated && missingScopes.length === 0,
    missingScopes,
  };
}
