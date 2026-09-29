-- Remove exact duplicate indexes left by the iterative hardening migrations.
-- Keep the constraint-backed unique indexes; only drop redundant standalone copies.
drop index if exists public.supplier_order_attempts_idempotency_key_uq;
drop index if exists public.supplier_order_attempts_purchase_order_idx;
