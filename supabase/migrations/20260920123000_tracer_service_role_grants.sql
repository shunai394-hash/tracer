grant usage on schema public to service_role;

grant all privileges on table
  public.brands,
  public.products,
  public.sources,
  public.observations,
  public.price_observations,
  public.market_signals,
  public.discoveries
to service_role;

grant usage, select on all sequences in schema public
to service_role;
