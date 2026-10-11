# BASE OAuth configuration presence check — 2026-10-11

Read-only Vercel production environment metadata inspection. Secret values were not decrypted, copied, printed or changed.

## Presence and metadata

All four required BASE OAuth variable names exist in the production target:
- BASE_CLIENT_ID — present
- BASE_CLIENT_SECRET — present
- BASE_REFRESH_TOKEN — present
- BASE_REDIRECT_URI — present

BASE_ACCESS_TOKEN also exists, but current lib/channels/base.ts does not treat it as proof of a working integration; it uses the OAuth refresh-token flow.

The BASE_REFRESH_TOKEN environment entry was updated at 2026-10-11T02:12:03Z. The other three required OAuth entries were created at 2026-10-11T01:47:46Z. The last observed production invalid-token error was at 2026-10-10T19:24:38Z, before those entries were updated/created.

## Conclusion

The error history predates the currently configured OAuth entries. Therefore the historical invalid-token logs do not prove the new configuration is still failing. Conversely, variable presence does not prove the refresh-token flow and BASE orders endpoint now work.

Next required evidence is a fresh, authenticated, read-only call to list at most one BASE order that reports:
- OAuth refresh HTTP status and whether access_token is present;
- BASE order-list HTTP status;
- returned count only (no order/customer identifiers);
- redacted error code/message.

Do not change or regenerate credentials just because older logs show invalid tokens. Do not publish BASE items, sync inventory, import orders into production state, or execute supplier orders as part of this diagnostic.
