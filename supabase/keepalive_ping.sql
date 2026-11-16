-- Hosts call this every few hours so the free project is not paused for inactivity.
create or replace function public.ping() returns timestamptz
language sql stable set search_path = '' as $$ select now() $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
