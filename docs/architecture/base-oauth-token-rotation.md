# BASE OAuth refresh-token rotation

## Finding

BASE's official refresh-token documentation states that access tokens last about one hour and refresh tokens about 30 days. The refresh-token response includes a `refresh_token` field. The previous `lib/channels/base.ts` implementation returned only `access_token`, discarded the new refresh token, and requested a new access token on every API call. That design can lose token rotation and creates unnecessary refresh races.

Official reference: https://docs.thebase.in/api/oauth/refresh_token/

## Change on this branch

- Add a private `private.channel_oauth_tokens` table with service-role-only RPCs.
- Persist the latest refresh token and cached access token/expiry.
- Serialize refresh requests with a short database lease so multiple serverless instances do not consume the same rotating token concurrently.
- Reuse the cached access token until shortly before expiry.
- On an API HTTP 401, invalidate the cached access token and retry once.
- The OAuth callback stores the returned access/refresh tokens server-side when the migration is available; it falls back to the existing manual token screen if storage is not ready.
- No product publication, order placement, order status update, or database migration is executed by this branch.

## Required deployment order

1. Apply `supabase/migrations/20261011120000_base_oauth_token_store.sql` to the **TRACER** Supabase project, not Zenova.
2. Confirm the six RPCs exist and are executable only by `service_role`.
3. Deploy this branch to a preview and run the read-only BASE diagnostic.
4. Verify HTTP 200 and successful refresh-token persistence.
5. Only then merge the token-store code and enable BASE write paths.

The current Supabase connector is authorized for **Zenova Project** only and rejects access to the TRACER project ref. Therefore this migration has not been applied; this branch must remain unmerged until the actual TRACER database is accessible and the migration is applied.
