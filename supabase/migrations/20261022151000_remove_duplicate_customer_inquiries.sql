-- Remove the temporary duplicate inbox table; support_messages is the canonical inbox.
drop table if exists public.customer_inquiries;
drop function if exists public.set_customer_inquiries_updated_at();