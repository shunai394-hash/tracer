# Customer support and legal setup

Routes: /support, /contact, /admin/support, /legal, /returns, /terms, /privacy.

## Existing inquiry storage
The contact form and admin inbox use the existing `public.customer_inquiries` table. The table has RLS enabled and no anon/authenticated policies; API routes use the server-side Supabase service role only. Inquiry categories must match the existing database check constraint.

## Required Vercel Production environment
- `TRACER_ADMIN_EMAILS`: comma-separated allowlist of authenticated Supabase user emails allowed into the admin inbox.
- `TRACER_LEGAL_BUSINESS_NAME`, `TRACER_LEGAL_REPRESENTATIVE`, `TRACER_LEGAL_ADDRESS`, `TRACER_LEGAL_PHONE`, `TRACER_LEGAL_EMAIL`
- `TRACER_LEGAL_PRICE`, `TRACER_LEGAL_EXTRA_FEES`, `TRACER_LEGAL_PAYMENT`, `TRACER_LEGAL_DELIVERY`, `TRACER_LEGAL_RETURNS`

The chat uses fixed FAQ responses and routes unknown questions to the contact form instead of guessing order-specific facts. Set seller identity and actual sales/return terms before publishing; legal pages deliberately flag missing values rather than inventing them.

## Verification
1. Submit a contact test and confirm a row appears in `public.customer_inquiries`.
2. Sign in with an email in `TRACER_ADMIN_EMAILS`; confirm inbox loads and status/internal notes persist.
3. Confirm a non-allowlisted account receives HTTP 403.
4. Set all legal values and ensure they match the product page and final order confirmation screen.
