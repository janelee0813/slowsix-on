begin;
alter table ss_admin.members add column if not exists phone text not null default '' check(phone='' or phone ~ '^010[0-9]{8}$');
alter table ss_admin.members add column if not exists phone_version int not null default 1;
create table if not exists ss_admin.alimtalk_jobs (
 id uuid primary key default gen_random_uuid(), booking_id uuid not null references ss_admin.bookings(id),
 booking_version int not null, kind text not null check(kind in ('requested','awaiting_payment','confirmed','rejected','cancelled')),
 member_id uuid not null references ss_admin.people(id), phone text not null, snapshot jsonb not null,
 state text not null check(state in ('pending','sending','sent','failed','unknown','no_phone','skipped')),
 attempts int not null default 0, available_at timestamptz not null default now(), lease uuid, lease_until timestamptz,
 dispatched_at timestamptz, provider_code text, message_key text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(booking_id,booking_version,kind)
);
alter table ss_admin.alimtalk_jobs enable row level security;
revoke all on ss_admin.alimtalk_jobs from public,anon,authenticated;
create or replace function ss_admin.alimtalk_enqueue() returns trigger language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare target_phone text; nickname text;
begin
 if tg_op='UPDATE' and new.status=old.status then return new; end if;
 select p.name,m.phone into nickname,target_phone from ss_admin.people p join ss_admin.members m on m.person_id=p.id where p.id=new.member_id;
 if new.status='requested' then target_phone:='01051667412';
 else update ss_admin.alimtalk_jobs set state='skipped',updated_at=now() where booking_id=new.id and kind<>'requested' and state in ('pending','no_phone'); end if;
 insert into ss_admin.alimtalk_jobs(booking_id,booking_version,kind,member_id,phone,snapshot,state)
 values(new.id,new.version,new.status,new.member_id,coalesce(target_phone,''),jsonb_build_object('nickname',nickname,'space',new.space,'starts_at',new.starts_at,'ends_at',new.ends_at,'guests',new.guests,'total_amount',new.total_amount),case when coalesce(target_phone,'')='' then 'no_phone' else 'pending' end)
 on conflict(booking_id,booking_version,kind) do nothing;
 return new;
end $$;
revoke all on function ss_admin.alimtalk_enqueue() from public,anon,authenticated;
drop trigger if exists alimtalk_booking_outbox on ss_admin.bookings;
create trigger alimtalk_booking_outbox after insert or update of status on ss_admin.bookings for each row execute function ss_admin.alimtalk_enqueue();

-- Wrap the existing gateway once, retaining every current finance and membership rule.
do $$ begin
 if to_regprocedure('ss_admin.gateway_before_alimtalk(text,jsonb)') is null then
  alter function public.ss_admin_gateway(text,jsonb) rename to gateway_before_alimtalk;
  alter function public.gateway_before_alimtalk(text,jsonb) set schema ss_admin;
 end if;
end $$;
revoke all on function ss_admin.gateway_before_alimtalk(text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.ss_admin_gateway(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare result jsonb; u ss_admin.people; m ss_admin.members; v_phone text; vals jsonb;
begin
 if p_action='register' and exists(select 1 from ss_admin.links where token_hash=p->>'link_hash' and kind='member') then
  v_phone:=coalesce(p->>'phone','');if v_phone !~ '^010[0-9]{8}$' then raise exception 'PHONE_REQUIRED';end if;
  result:=ss_admin.gateway_before_alimtalk(p_action,p);
  update ss_admin.members set phone=v_phone where person_id=(p->>'id')::uuid;
  return result;
 end if;
 if p_action in ('member_phone_save','member_alimtalk','member_alimtalk_retry','member_request') then
  select a.* into u from ss_admin.people a join ss_admin.sessions s on s.person_id=a.id where s.token_hash=p->>'session_hash' and s.expires_at>now();
  if not found then raise exception 'SESSION_EXPIRED';end if;
  if u.status<>'active' then raise exception 'ACCESS_DENIED';end if;
  if p_action='member_phone_save' then
   if u.role<>'member' then raise exception 'FORBIDDEN';end if;
   v_phone:=coalesce(p->>'phone','');if v_phone !~ '^010[0-9]{8}$' then raise exception 'PHONE_REQUIRED';end if;
   update ss_admin.members set phone=v_phone,phone_version=phone_version+1 where person_id=u.id and deleted_at is null and phone_version=(p->>'version')::int returning * into m;
   if not found then raise exception 'CONFLICT';end if;
   update ss_admin.alimtalk_jobs set phone=v_phone,state='pending',available_at=now(),updated_at=now() where member_id=u.id and state='no_phone';
   insert into ss_admin.audit(actor_id,action,target_id,after_data) values(u.id,'member_phone_changed',u.id,jsonb_build_object('last4',right(v_phone,4)));
   return jsonb_build_object('phone',m.phone,'phone_version',m.phone_version);
  elsif p_action in ('member_alimtalk','member_alimtalk_retry') then
   if u.role<>'admin' then raise exception 'FORBIDDEN';end if;
   if p_action='member_alimtalk_retry' then
    update ss_admin.alimtalk_jobs set state='pending',attempts=0,available_at=now(),provider_code=null,updated_at=now() where id=(p->>'id')::uuid and state='failed';
    if not found then raise exception 'CONFLICT';end if;
    insert into ss_admin.audit(actor_id,action,target_id) values(u.id,'alimtalk_retry',(p->>'id')::uuid);return '{}'::jsonb;
   end if;
   select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') into vals from (
    select id,booking_id,kind,state,attempts,provider_code,created_at,updated_at,case when phone='' then '미등록' else left(phone,3)||'-****-'||right(phone,4) end as phone_masked,snapshot->>'nickname' as nickname from ss_admin.alimtalk_jobs order by created_at desc limit 100)t;
   return jsonb_build_object('items',vals);
  elsif not exists(select 1 from ss_admin.bookings where id=(p->>'id')::uuid) then
   if u.role<>'member' then raise exception 'FORBIDDEN';end if;
   if not exists(select 1 from ss_admin.members where person_id=u.id and phone ~ '^010[0-9]{8}$' and deleted_at is null) then raise exception 'PHONE_REQUIRED';end if;
  end if;
 end if;
 result:=ss_admin.gateway_before_alimtalk(p_action,p);
 if p_action='member_home' then
  select profile.* into m from ss_admin.members profile join ss_admin.sessions s on s.person_id=profile.person_id where s.token_hash=p->>'session_hash' and s.expires_at>now();
  if found then result:=result||jsonb_build_object('phone',m.phone,'phone_version',m.phone_version);end if;
 end if;
 return result;
end $$;
revoke all on function public.ss_admin_gateway(text,jsonb) from public,anon,authenticated;
grant execute on function public.ss_admin_gateway(text,jsonb) to service_role;

create or replace function public.ss_ppurio_worker(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare j ss_admin.alimtalk_jobs; target_state text;
begin
 perform pg_advisory_xact_lock(992319);
 if p_action='claim' then
  update ss_admin.alimtalk_jobs set state=case when dispatched_at is null and attempts<3 then 'pending' else 'unknown' end,lease=null,lease_until=null,updated_at=now() where state='sending' and lease_until<=now();
  select * into j from ss_admin.alimtalk_jobs where state='pending' and available_at<=now() and attempts<3 order by created_at limit 1 for update skip locked;
  if not found then return '{}'::jsonb;end if;
  update ss_admin.alimtalk_jobs set state='sending',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',dispatched_at=null,updated_at=now() where id=j.id returning * into j;
  return to_jsonb(j);
 elsif p_action in ('dispatch','finish') then
  select * into j from ss_admin.alimtalk_jobs where id=(p->>'id')::uuid and lease=(p->>'lease')::uuid and state='sending' and lease_until>now() for update;
  if not found then raise exception 'CONFLICT';end if;
  if p_action='dispatch' then
   if j.dispatched_at is not null then raise exception 'CONFLICT';end if;
   update ss_admin.alimtalk_jobs set dispatched_at=now(),updated_at=now() where id=j.id;return '{}'::jsonb;
  end if;
  target_state:=p->>'state';
  if target_state not in ('sent','failed','unknown','retry') or target_state is null then raise exception 'INVALID_ENTRY';end if;
  if target_state='retry' and j.dispatched_at is not null then raise exception 'CONFLICT';end if;
  update ss_admin.alimtalk_jobs set state=case when target_state='retry' then case when attempts<3 then 'pending' else 'failed' end else target_state end,available_at=now()+interval '1 minute',lease=null,lease_until=null,provider_code=left(p->>'provider_code',40),message_key=left(p->>'message_key',100),updated_at=now() where id=j.id;
  return '{}'::jsonb;
 end if;
 raise exception 'INVALID_ACTION';
end $$;
revoke all on function public.ss_ppurio_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.ss_ppurio_worker(text,jsonb) to service_role;
commit;
