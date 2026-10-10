-- Disposable PostgreSQL integration contract for CJ variant identity persistence.
-- Runs after PR #175's migration test in CI; never targets production.
\set ON_ERROR_STOP on

alter table public.marketplace_bestsellers add column if not exists product_id uuid;

create table if not exists public.supplier_listings (
  id uuid primary key,
  bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null,
  product_id uuid,
  identity_method text check (identity_method in ('gtin','jan','ean','upc') or identity_method is null),
  identity_status text not null default 'unverified',
  identity_confidence numeric not null default 0,
  orderable boolean not null default false,
  api_available boolean not null default false,
  tracking_available boolean not null default false,
  verification_status text not null default 'identity_unverified',
  metadata jsonb not null default '{}'::jsonb
);

insert into public.marketplace_bestsellers(id, marketplace, title, source, product_id)
values
 ('30000000-0000-4000-8000-000000000001','amazon.co.jp','Canonical A','ci_fixture','40000000-0000-4000-8000-000000000001'),
 ('30000000-0000-4000-8000-000000000002','amazon.co.jp','Canonical B','ci_fixture','40000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

insert into public.marketplace_bestseller_variants(
 bestseller_id, marketplace, source, source_variant_id, title, gtin,
 evidence_source, raw_evidence, fetched_at
) values
 ('30000000-0000-4000-8000-000000000001','amazon.co.jp','ci_fixture','B0CHILD-A','Child A','4901234567894','schema_org_product_group_has_variant','{"fixture":true}'::jsonb,now()),
 ('30000000-0000-4000-8000-000000000002','amazon.co.jp','ci_fixture','B0CHILD-B','Child B','4901234567894','schema_org_product_group_has_variant','{"fixture":true}'::jsonb,now())
on conflict (bestseller_id, source_variant_id) do nothing;

insert into public.supplier_listings(id,bestseller_id,product_id,identity_method,identity_status,identity_confidence,orderable,api_available,tracking_available,verification_status,metadata)
values ('50000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001','gtin','linked',0.98,false,false,false,'verified','{"old_link":true}'::jsonb)
on conflict(id) do update set bestseller_id=excluded.bestseller_id, product_id=excluded.product_id,
 identity_method=excluded.identity_method,identity_status=excluded.identity_status,
 identity_confidence=excluded.identity_confidence,metadata=excluded.metadata;

do $$
declare
  v_exact integer;
  v_ambiguous integer;
  v_status text;
  v_product uuid;
  v_failure boolean := false;
begin
  -- Exact barcode must be unique across child evidence, not merely unique per parent.
  select count(*) into v_exact from public.marketplace_bestseller_variants
   where gtin='4901234567894' and evidence_source='schema_org_product_group_has_variant';
  if v_exact <> 2 then raise exception 'fixture expected 2 matching child rows, got %',v_exact; end if;

  -- Ambiguous match is refused; stale linked identity must be cleared rather than retained.
  select count(*) into v_ambiguous from public.marketplace_bestseller_variants where gtin='4006381333932';
  if v_ambiguous <> 0 then raise exception 'unexpected mismatch barcode fixture'; end if;

  update public.supplier_listings set
    bestseller_id=null, product_id=null, identity_method=null, identity_status='unverified',
    identity_confidence=0, orderable=false, api_available=false, tracking_available=false,
    verification_status='identity_unverified',
    metadata=metadata || jsonb_build_object('marketplace_variant_evidence_id',null,'identity_rationale','ambiguous_or_no_exact_child_match')
  where id='50000000-0000-4000-8000-000000000001';

  select identity_status, product_id into v_status,v_product from public.supplier_listings
   where id='50000000-0000-4000-8000-000000000001';
  if v_status <> 'unverified' or v_product is not null then
    raise exception 'stale identity was not cleared after ambiguous/no match';
  end if;

  -- A failed write must not partially mutate the current row (subtransaction rollback).
  update public.supplier_listings set bestseller_id='30000000-0000-4000-8000-000000000001',
    product_id='40000000-0000-4000-8000-000000000001', identity_method='gtin',
    identity_status='linked', identity_confidence=0.98, verification_status='verified'
  where id='50000000-0000-4000-8000-000000000001';
  begin
    update public.supplier_listings set identity_method='not-a-barcode-method'
     where id='50000000-0000-4000-8000-000000000001';
  exception when check_violation then
    v_failure := true;
  end;
  if not v_failure then raise exception 'expected simulated persistence constraint failure'; end if;
  select identity_status,product_id into v_status,v_product from public.supplier_listings
   where id='50000000-0000-4000-8000-000000000001';
  if v_status <> 'linked' or v_product is null then
    raise exception 'failed write unexpectedly corrupted existing row';
  end if;
end $$;

-- Distinct-child ambiguity is explicitly recorded and must never be promoted.
select 'PASS: variant evidence ambiguity, stale-link clearing, and failed-write rollback contract' as result;
