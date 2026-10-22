# Customer support and legal setup

Routes: /support, /contact, /admin/support, /legal, /returns, /terms, /privacy.

Before production launch configure Vercel Production environment variables:
- TRACER_ADMIN_EMAILS: comma-separated allowlist for admin inbox, e.g. admin@example.jp. Only listed, authenticated Supabase users can read/update inquiries.
- TRACER_LEGAL_BUSINESS_NAME, TRACER_LEGAL_REPRESENTATIVE, TRACER_LEGAL_ADDRESS, TRACER_LEGAL_PHONE, TRACER_LEGAL_EMAIL
- TRACER_LEGAL_PRICE, TRACER_LEGAL_EXTRA_FEES, TRACER_LEGAL_PAYMENT, TRACER_LEGAL_DELIVERY, TRACER_LEGAL_RETURNS

Apply supabase/migrations/20261022150000_customer_support_messages.sql to the TRACER Supabase project before enabling the form. The table has RLS enabled and no anon/authenticated policies; APIs use server-side service role only.

Verification: submit a test contact and confirm a row in public.support_messages; sign in with an allowlisted email and test status/notes; confirm a non-allowlisted user gets 403; set all legal values and check the values match checkout's final confirmation screen. The chat uses fixed FAQ answers, not a generative model, and sends unknown questions to contact instead of guessing.
