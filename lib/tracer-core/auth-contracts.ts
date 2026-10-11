/**
 * Pure authentication preflight contract for TRACER.
 * A present environment variable is configuration evidence, not auth success.
 */
export type ProviderProbe = {
  provider: "shopify" | "base";
  configComplete: boolean;
  tokenExchangeStatus: number | null;
  tokenReturned: boolean;
  apiStatus: number | null;
  expectedIdentity: string;
  returnedIdentity: string | null;
  requiredPermissions: string[];
  grantedPermissions: string[];
  providerErrorCode?: string | null;
};
export type ProviderProbeDecision = {
  authenticated: boolean;
  blockers: string[];
  identity: string | null;
  missingPermissions: string[];
};

export function evaluateProviderProbe(probe: ProviderProbe): ProviderProbeDecision {
  const blockers: string[] = [];
  if (!probe.configComplete) blockers.push("configuration_incomplete");
  if (probe.tokenExchangeStatus !== 200 || !probe.tokenReturned) blockers.push("token_exchange_not_confirmed");
  if (probe.apiStatus !== 200) blockers.push("provider_api_not_confirmed");
  const expected = probe.expectedIdentity.trim().toLowerCase();
  const returned = probe.returnedIdentity?.trim().toLowerCase() ?? "";
  if (!expected || !returned || returned !== expected) blockers.push("provider_identity_mismatch");
  const granted = new Set(probe.grantedPermissions.map((scope) => scope.trim()).filter(Boolean));
  const missingPermissions = probe.requiredPermissions.filter((scope) => !granted.has(scope));
  if (missingPermissions.length > 0) blockers.push("required_permissions_missing");
  if (probe.providerErrorCode?.trim()) blockers.push("provider_reported_error");
  return {
    authenticated: blockers.length === 0,
    blockers,
    identity: probe.returnedIdentity,
    missingPermissions,
  };
}
