-- Public availability contains time intervals only. Keep database access server-only.
begin;
create or replace function public.ss_public_schedule(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare st timestamptz := (p->>'from')::timestamptz;
 en timestamptz := (p->>'to')::timestamptz;
 selected_space text := p->>'space';
begin
 if selected_space is null or selected_space not in ('on','p','d') then raise exception 'INVALID_ENTRY'; end if;
 if st is null or en is null or en<=st or en-st>interval '32 days' then raise exception 'INVALID_PERIOD'; end if;
 return jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(t) order by t.starts_at),'[]') from (
  select starts_at,ends_at,space from ss_admin.bookings
   where space=selected_space and status in ('requested','awaiting_payment','confirmed') and starts_at<en and ends_at>st
  union all
  select starts_at,ends_at,space from ss_admin.booking_blocks
   where space=selected_space and starts_at<en and ends_at>st
 )t));
end $$;
revoke all on function public.ss_public_schedule(jsonb) from public,anon,authenticated;
grant execute on function public.ss_public_schedule(jsonb) to service_role;
comment on function public.ss_public_schedule(jsonb) is 'Server-only read of public availability. Returns times and space only; no identities, notes, prices or account data.';
notify pgrst, 'reload schema';
commit;
