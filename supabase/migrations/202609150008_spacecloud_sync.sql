-- Durable outbox. No external writes occur until an administrator enables synchronization.
begin;
create table if not exists ss_admin.sc_settings (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 worker_seen_at timestamptz, login_checked_at timestamptz, worker_error text
);
insert into ss_admin.sc_settings(singleton) values(true) on conflict do nothing;
create table if not exists ss_admin.sc_jobs (
 booking_id uuid primary key references ss_admin.bookings(id),
 desired text not null check(desired in ('blocked','released')),
 state text not null default 'pending' check(state in ('pending','working','blocked','released','error','needs_login','conflict','review')),
 revision integer not null default 1, lease uuid, lease_until timestamptz,
 attempts integer not null default 0, retry_at timestamptz not null default now(),
 error_code text, updated_at timestamptz not null default now()
);
alter table ss_admin.sc_settings enable row level security;
alter table ss_admin.sc_jobs enable row level security;
revoke all on ss_admin.sc_settings,ss_admin.sc_jobs from public,anon,authenticated;

create or replace function ss_admin.sc_enqueue() returns trigger language plpgsql set search_path=pg_catalog,ss_admin as $$
declare wanted text;
begin
 wanted:=case when new.status in ('requested','awaiting_payment','confirmed') then 'blocked' else 'released' end;
 if tg_op='INSERT' then
  if wanted='blocked' then insert into ss_admin.sc_jobs(booking_id,desired) values(new.id,wanted) on conflict do nothing; end if;
 else
  update ss_admin.sc_jobs set desired=wanted,revision=revision+1,
   state=case when state='working' then state else 'pending' end,
   attempts=0,retry_at=now(),error_code=null,updated_at=now()
  where booking_id=new.id and desired<>wanted;
 end if;
 return new;
end $$;
drop trigger if exists sc_booking_outbox on ss_admin.bookings;
create trigger sc_booking_outbox after insert or update of status on ss_admin.bookings for each row execute function ss_admin.sc_enqueue();
revoke all on function ss_admin.sc_enqueue() from public,anon,authenticated;

-- Called only by the server using service_role. This role never reaches the browser.
create or replace function public.ss_spacecloud_worker(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare j ss_admin.sc_jobs; s ss_admin.sc_settings; b ss_admin.bookings; code text;
begin
 perform pg_advisory_xact_lock(992302);
 if p_action='claim' then
  update ss_admin.sc_settings set worker_seen_at=now() where singleton returning * into s;
  -- An interrupted write must be inspected by a human before retrying, never blindly replayed.
  update ss_admin.sc_jobs set state='review',error_code='INTERRUPTED',lease=null,lease_until=null,updated_at=now()
   where state='working' and lease_until<=now();
  if not s.enabled or exists(select 1 from ss_admin.sc_jobs where state='working') then return '{}'::jsonb; end if;
  select * into j from ss_admin.sc_jobs where state in ('pending','error') and retry_at<=now() and attempts<3 order by case desired when 'released' then 0 else 1 end,updated_at limit 1 for update;
  if not found then return '{}'::jsonb; end if;
  select * into b from ss_admin.bookings where id=j.booking_id;
  if j.desired='blocked' and b.starts_at<=now() then
   update ss_admin.sc_jobs set state='review',error_code='PAST_BOOKING',updated_at=now() where booking_id=j.booking_id;
   return '{}'::jsonb;
  end if;
  update ss_admin.sc_jobs set state='working',lease=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
   where booking_id=j.booking_id returning * into j;
  return jsonb_build_object('id',j.booking_id,'desired',j.desired,'revision',j.revision,'lease',j.lease,'starts_at',b.starts_at,'ends_at',b.ends_at);
 elsif p_action='finish' then
  select * into j from ss_admin.sc_jobs where booking_id=(p->>'id')::uuid and lease=(p->>'lease')::uuid and state='working' and lease_until>now() for update;
  if not found then raise exception 'CONFLICT'; end if;
  code:=p->>'error';
  if code is not null and code not in ('LOGIN_REQUIRED','TIME_CONFLICT','UI_CHANGED','INTERRUPTED','UNVERIFIED','NETWORK','PARTIAL','CONFIGURATION') then raise exception 'INVALID_ENTRY'; end if;
  update ss_admin.sc_jobs set
   state=case when code is null then case when j.revision=(p->>'revision')::int then j.desired else 'pending' end
    when code='LOGIN_REQUIRED' then 'needs_login' when code='TIME_CONFLICT' then 'conflict'
    when code in ('NETWORK','CONFIGURATION') then 'error' else 'review' end,
   lease=null,lease_until=null,error_code=code,retry_at=case when code is null then now() else now()+interval '2 minutes' end,updated_at=now()
   where booking_id=j.booking_id;
  update ss_admin.sc_settings set worker_error=code,login_checked_at=case when (p->>'logged_in')::boolean then now() else login_checked_at end where singleton;
  if code='LOGIN_REQUIRED' then update ss_admin.sc_settings set enabled=false where singleton; end if;
  if code is not null then
   insert into ss_admin.member_notifications(recipient,message,booking_id)
    select id,'스페이스클라우드 일정 연동 확인이 필요합니다. 관리자 모드에서 확인해주세요.',j.booking_id from ss_admin.people where role='admin';
  end if;
  return '{}'::jsonb;
 end if;
 raise exception 'INVALID_ACTION';
end $$;
revoke all on function public.ss_spacecloud_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.ss_spacecloud_worker(text,jsonb) to service_role;

create or replace function public.ss_spacecloud_admin(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare u ss_admin.people; b ss_admin.bookings; j ss_admin.sc_jobs;
begin
 select a.* into u from ss_admin.people a join ss_admin.sessions s on s.person_id=a.id where s.token_hash=p->>'session_hash' and s.expires_at>now();
 if not found then raise exception 'SESSION_EXPIRED'; end if;
 if u.role<>'admin' or u.status<>'active' then raise exception 'FORBIDDEN'; end if;
 if p_action='member_sc_state' then
  return jsonb_build_object('settings',(select to_jsonb(s) from ss_admin.sc_settings s where singleton),
   'items',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select jobs.booking_id,jobs.desired,jobs.state,jobs.error_code,jobs.updated_at,booking.starts_at,booking.ends_at from ss_admin.sc_jobs jobs join ss_admin.bookings booking on booking.id=jobs.booking_id order by jobs.updated_at desc limit 200)t));
 elsif p_action='member_sc_enable' then
  if jsonb_typeof(p->'enabled')<>'boolean' then raise exception 'INVALID_ENTRY'; end if;
  if (p->>'enabled')::boolean and not exists(select 1 from ss_admin.sc_settings where worker_seen_at>now()-interval '20 minutes') then raise exception 'SC_NOT_CONNECTED'; end if;
  update ss_admin.sc_settings set enabled=(p->>'enabled')::boolean where singleton;
  insert into ss_admin.audit(actor_id,action,after_data) values(u.id,'spacecloud_sync_enabled',jsonb_build_object('enabled',(p->>'enabled')::boolean));
 elsif p_action='member_sc_retry' then
  perform pg_advisory_xact_lock(992302);
  select * into b from ss_admin.bookings where id=(p->>'id')::uuid;
  if not found then raise exception 'INVALID_ENTRY'; end if;
  select * into j from ss_admin.sc_jobs where booking_id=b.id for update;
  if j.state='working' and j.lease_until>now() then raise exception 'CONFLICT'; end if;
  if b.starts_at<=now() and b.status in ('requested','awaiting_payment','confirmed') then raise exception 'INVALID_BOOKING'; end if;
  insert into ss_admin.sc_jobs(booking_id,desired) values(b.id,case when b.status in ('requested','awaiting_payment','confirmed') then 'blocked' else 'released' end)
   on conflict(booking_id) do update set state='pending',lease=null,lease_until=null,attempts=0,retry_at=now(),error_code=null,updated_at=now();
  insert into ss_admin.audit(actor_id,action,target_id) values(u.id,'spacecloud_sync_retry',b.id);
 else raise exception 'INVALID_ACTION'; end if;
 return '{}'::jsonb;
end $$;
revoke all on function public.ss_spacecloud_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.ss_spacecloud_admin(text,jsonb) to service_role;
commit;
