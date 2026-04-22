-- Позволяет приложению безопасно инициировать перезагрузку schema cache PostgREST.
-- Это важно сразу после миграций, когда API может кратковременно видеть старую схему.

create or replace function public.reload_postgrest_schema_cache()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_notify('pgrst', 'reload schema');
end;
$$;

revoke all on function public.reload_postgrest_schema_cache() from public;
grant execute on function public.reload_postgrest_schema_cache() to authenticated;

