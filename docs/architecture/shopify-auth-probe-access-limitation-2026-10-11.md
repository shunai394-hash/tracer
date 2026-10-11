# Shopify read-only probe access limitation — 2026-10-11

A branch-only diagnostic workflow attempted GET /api/admin/shopify/auth-check against the production alias using a GitHub Actions OIDC token. The request returned outer HTTP 401 before the diagnostic ran. No Shopify API call or write endpoint was reached.

Root cause from lib/security/cron-auth.ts:
- accepted audience is https://tracer-pied-alpha.vercel.app;
- accepted repository is shunai394-hash/tracer;
- accepted ref is exactly refs/heads/main.

The workflow was running from refs/heads/refactor/commerce-boundaries-audit, so the authorization rejection is expected. It is not evidence of a Shopify Admin API 401 and must not be reported as one.

The temporary branch-only workflow was removed to avoid repeated expected failures. The production OIDC allowlist was not weakened, and no secrets were read or changed.

## Safe path to finish the auth check

Use the existing main-only workflow .github/workflows/tracer-shopify-auth-check.yml with sync_batch=0, or run the existing read-only auth-check from a trusted main-branch workflow. Do not enable any sync batch: the workflow treats sync_batch > 0 as write-enabled and includes linked blocked listings for unpublishing.

Success criteria remain:
- diagnostic endpoint itself returns HTTP 200;
- Shopify probe returns HTTP 200;
- GraphQL errors are empty;
- shop ID equals gid://shopify/Shop/74624434220;
- client-credentials token exchange and the Admin API identity query both succeed.

Until those checks are observed, Shopify product writes remain paused.
