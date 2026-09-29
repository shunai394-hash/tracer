-- Pin the trigger function search_path so its SECURITY INVOKER trigger
-- cannot resolve objects through a caller-controlled search path.
alter function public.tracer_supplier_order_attempts_set_updated_at()
  set search_path = public;
