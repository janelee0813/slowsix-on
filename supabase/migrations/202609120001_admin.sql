-- Run once in the NEW project qhvwwdrwfzwpehfjntbv. No existing tables are changed.
begin;
create schema if not exists ss_admin;
revoke all on schema ss_admin from public, anon, authenticated;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists ss_admin.people (
 id uuid primary key, username text unique not null check(username ~ '^[a-z][a-z0-9]{2,23}$'),
 name text not null check(length(name) between 1 and 40), auth_email text unique not null,
 role text not null check(role in ('admin','operator')),
 status text not null check(status in ('pending','active','rejected','suspended')),
 created_at timestamptz not null default now()
);
create unique index if not exists only_one_admin on ss_admin.people ((role)) where role='admin';
create table if not exists ss_admin.links (
 id uuid primary key default gen_random_uuid(), token_hash text unique not null,
 kind text not null check(kind in ('bootstrap','invite','reset')), target_id uuid references ss_admin.people(id),
 expires_at timestamptz not null, used_at timestamptz, revoked_at timestamptz,
 created_by uuid references ss_admin.people(id), created_at timestamptz not null default now()
);
create table if not exists ss_admin.sessions (
 token_hash text primary key, person_id uuid not null references ss_admin.people(id),
 expires_at timestamptz not null default now()+interval '8 hours', created_at timestamptz not null default now()
);
create index if not exists sessions_person on ss_admin.sessions(person_id);
create table if not exists ss_admin.limits (
 key text primary key, attempts int not null default 0, strikes int not null default 0,
 window_start timestamptz not null default now(), blocked_until timestamptz
);
create table if not exists ss_admin.entries (
 id uuid primary key default gen_random_uuid(), entry_date date not null,
 description text not null check(length(description) between 1 and 200),
 category text not null check(category in ('spacecloud','invoice','cash','fixed','expense')),
 amount bigint not null check(amount between 1 and 10000000000),
 created_by uuid not null references ss_admin.people(id), updated_by uuid not null references ss_admin.people(id),
 version int not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 deleted_at timestamptz, request_id uuid not null unique
);
create index if not exists entries_date on ss_admin.entries(entry_date) where deleted_at is null;
create table if not exists ss_admin.audit (
 id bigint generated always as identity primary key, actor_id uuid references ss_admin.people(id),
 action text not null, target_id uuid, before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
);
-- No direct data access through the anon/authenticated APIs.
alter table ss_admin.people enable row level security;
alter table ss_admin.links enable row level security;
alter table ss_admin.sessions enable row level security;
alter table ss_admin.limits enable row level security;
alter table ss_admin.entries enable row level security;
alter table ss_admin.audit enable row level security;
revoke all on all tables in schema ss_admin from public, anon, authenticated;
revoke all on all sequences in schema ss_admin from public, anon, authenticated;

create or replace function public.ss_admin_gateway(p_action text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, ss_admin
as $$
declare
 u ss_admin.people; v ss_admin.people; l ss_admin.links; r ss_admin.limits;
 e ss_admin.entries; old_e ss_admin.entries; result jsonb; vals jsonb;
 d1 date; d2 date; n int; cap int; wait_seconds int;
 sc numeric; inv numeric; cash numeric; fixed numeric; expense numeric; profit numeric; fee numeric;
begin
 -- These branches are called ONLY by the server-side Edge Function.
 if p_action='rate' then
  cap := least(100,greatest(1,(p->>'cap')::int));
  insert into ss_admin.limits(key) values(p->>'key') on conflict do nothing;
  select * into r from ss_admin.limits where key=p->>'key' for update;
  if r.blocked_until > now() then
   return jsonb_build_object('allowed',false,'retryAfter',ceil(extract(epoch from r.blocked_until-now())));
  end if;
  if r.window_start < now()-interval '15 minutes' or r.blocked_until is not null then
   r.attempts:=0; r.window_start:=now(); r.blocked_until:=null;
  end if;
  r.attempts:=r.attempts+1;
  if r.attempts>cap then
   r.strikes:=least(r.strikes+1,4);
   r.blocked_until:=now()+make_interval(secs => 900 * power(2,r.strikes-1)::int);
  end if;
  update ss_admin.limits set attempts=r.attempts,strikes=r.strikes,window_start=r.window_start,blocked_until=r.blocked_until where key=r.key;
  return jsonb_build_object('allowed',r.attempts<=cap,'retryAfter',coalesce(ceil(extract(epoch from r.blocked_until-now())),0));
 elsif p_action='rate_clear' then
  delete from ss_admin.limits where key=p->>'key'; return '{}'::jsonb;
 elsif p_action='credentials' then
  select * into u from ss_admin.people where username=p->>'username';
  if not found then return null; end if;
  return jsonb_build_object('id',u.id,'email',u.auth_email);
 elsif p_action='link_info' then
  select * into l from ss_admin.links where token_hash=p->>'link_hash' and used_at is null and revoked_at is null and expires_at>now();
  if not found then raise exception 'LINK_INVALID'; end if;
  return jsonb_build_object('kind',l.kind,'username',case when l.kind='bootstrap' then 'slowsix' else (select username from ss_admin.people where id=l.target_id) end);
 elsif p_action='register' then
  select * into l from ss_admin.links where token_hash=p->>'link_hash' for update;
  if not found or l.used_at is not null or l.revoked_at is not null or l.expires_at<=now() or l.kind not in ('bootstrap','invite') then raise exception 'LINK_INVALID'; end if;
  if l.kind='bootstrap' and (p->>'username'<>'slowsix' or exists(select 1 from ss_admin.people where role='admin')) then raise exception 'LINK_INVALID'; end if;
  if l.kind='invite' and p->>'username'='slowsix' then raise exception 'USERNAME_TAKEN'; end if;
  insert into ss_admin.people(id,username,name,auth_email,role,status)
   values((p->>'id')::uuid,p->>'username',p->>'name',p->>'email',case when l.kind='bootstrap' then 'admin' else 'operator' end,case when l.kind='bootstrap' then 'active' else 'pending' end) returning * into u;
  update ss_admin.links set used_at=now() where id=l.id;
  insert into ss_admin.audit(actor_id,action,target_id,after_data) values(u.id,'account_created',u.id,jsonb_build_object('username',u.username,'role',u.role,'status',u.status));
  return jsonb_build_object('status',u.status);
 elsif p_action='session_create' then
  select * into u from ss_admin.people where id=(p->>'id')::uuid;
  if not found or u.status in ('rejected','suspended') then raise exception 'ACCESS_DENIED'; end if;
  delete from ss_admin.sessions where expires_at<now();
  delete from ss_admin.limits where window_start<now()-interval '7 days' and (blocked_until is null or blocked_until<now());
  insert into ss_admin.sessions(token_hash,person_id) values(p->>'new_session_hash',u.id);
  return '{}'::jsonb;
 end if;

 -- All remaining business operations resolve identity from a server-side session.
 select a.* into u from ss_admin.people a join ss_admin.sessions s on s.person_id=a.id
  where s.token_hash=p->>'session_hash' and s.expires_at>now();
 if not found then raise exception 'SESSION_EXPIRED'; end if;
 if p_action='logout' then
  delete from ss_admin.sessions where token_hash=p->>'session_hash'; return '{}'::jsonb;
 end if;
 if u.status in ('rejected','suspended') then raise exception 'ACCESS_DENIED'; end if;
 if p_action='me' then
  return jsonb_build_object('id',u.id,'username',u.username,'name',u.name,'role',u.role,'status',u.status);
 end if;
 if u.status<>'active' then raise exception 'APPROVAL_REQUIRED'; end if;

 if p_action='list' then
  d1:=(p->>'from')::date; d2:=(p->>'to')::date;
  if d1 is null or d2 is null or d1>d2 or d2-d1>366 then raise exception 'INVALID_PERIOD'; end if;
  select coalesce(sum(amount) filter(where category='spacecloud'),0),coalesce(sum(amount) filter(where category='invoice'),0),
   coalesce(sum(amount) filter(where category='cash'),0),coalesce(sum(amount) filter(where category='fixed'),0),coalesce(sum(amount) filter(where category='expense'),0)
   into sc,inv,cash,fixed,expense from ss_admin.entries where deleted_at is null and entry_date between d1 and d2;
  profit:=sc+inv+cash-fixed-expense; fee:=round(profit*0.05);
  select count(*) into n from ss_admin.entries where deleted_at is null and entry_date between d1 and d2;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into vals from (
   select entry.*,a.name as author from ss_admin.entries entry join ss_admin.people a on a.id=entry.created_by
   where entry.deleted_at is null and entry.entry_date between d1 and d2 order by entry.entry_date desc,entry.created_at desc,entry.id
   limit 100 offset greatest(0,least(coalesce((p->>'offset')::int,0),1000000))
  )t;
  return jsonb_build_object('entries',vals,'count',n,'summary',jsonb_build_object('spacecloud',sc,'invoice',inv,'cash',cash,'fixed',fixed,'expense',expense,
   'revenue',sc+inv+cash,'spending',fixed+expense,'profit',profit,'fee',fee,'settlement',inv+cash-expense-fee));
 elsif p_action='save_entry' then
  if p->>'category' not in ('spacecloud','invoice','cash','fixed','expense') then raise exception 'INVALID_ENTRY'; end if;
  if u.role<>'admin' and (p->>'category' not in ('spacecloud','fixed') or nullif(p->>'id','') is not null) then raise exception 'FORBIDDEN'; end if;
  if nullif(p->>'id','') is null then
   select * into e from ss_admin.entries where request_id=(p->>'request_id')::uuid;
   if found then
    if e.created_by<>u.id then raise exception 'FORBIDDEN'; end if;
    if e.entry_date<>(p->>'date')::date or e.category<>p->>'category' or e.amount<>(p->>'amount')::bigint or e.description<>trim(p->>'description') then raise exception 'CONFLICT'; end if;
    return jsonb_build_object('id',e.id);
   end if;
   insert into ss_admin.entries(entry_date,description,category,amount,created_by,updated_by,request_id)
    values((p->>'date')::date,trim(p->>'description'),p->>'category',(p->>'amount')::bigint,u.id,u.id,(p->>'request_id')::uuid) returning * into e;
   insert into ss_admin.audit(actor_id,action,target_id,after_data) values(u.id,'entry_created',e.id,to_jsonb(e));
  else
   select * into old_e from ss_admin.entries where id=(p->>'id')::uuid and deleted_at is null for update;
   if not found or old_e.version<>(p->>'version')::int then raise exception 'CONFLICT'; end if;
   update ss_admin.entries set entry_date=(p->>'date')::date,description=trim(p->>'description'),category=p->>'category',amount=(p->>'amount')::bigint,
    updated_by=u.id,updated_at=now(),version=version+1 where id=old_e.id returning * into e;
   insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'entry_updated',e.id,to_jsonb(old_e),to_jsonb(e));
  end if;
  return jsonb_build_object('id',e.id);
 end if;

 if u.role<>'admin' then raise exception 'FORBIDDEN'; end if;
 if p_action='delete_entry' then
  select * into old_e from ss_admin.entries where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found or old_e.version<>(p->>'version')::int then raise exception 'CONFLICT'; end if;
  update ss_admin.entries set deleted_at=now(),updated_at=now(),updated_by=u.id,version=version+1 where id=old_e.id returning * into e;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'entry_deleted',e.id,to_jsonb(old_e),to_jsonb(e));
  return '{}'::jsonb;
 elsif p_action='people' then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'name',name,'role',role,'status',status,'created_at',created_at) order by created_at desc),'[]') into vals from ss_admin.people;
  return jsonb_build_object('people',vals,'links',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'expires_at',expires_at,'used_at',used_at,'revoked_at',revoked_at) order by created_at desc),'[]') from (select * from ss_admin.links where kind<>'bootstrap' order by created_at desc limit 30)t));
 elsif p_action='set_status' then
  perform pg_advisory_xact_lock(882091);
  select * into v from ss_admin.people where id=(p->>'id')::uuid for update;
  if not found or v.role='admin' or p->>'status' not in ('active','rejected','suspended') then raise exception 'FORBIDDEN'; end if;
  if p->>'status'='active' and v.status<>'active' and (select count(*) from ss_admin.people where role='operator' and status='active')>=2 then raise exception 'OPERATOR_LIMIT'; end if;
  update ss_admin.people set status=p->>'status' where id=v.id;
  if p->>'status'<>'active' then delete from ss_admin.sessions where person_id=v.id; end if;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'status_changed',v.id,jsonb_build_object('status',v.status),jsonb_build_object('status',p->>'status'));
  return '{}'::jsonb;
 elsif p_action='create_invite' then
  insert into ss_admin.links(token_hash,kind,expires_at,created_by) values(p->>'link_hash','invite',now()+interval '48 hours',u.id) returning * into l;
  insert into ss_admin.audit(actor_id,action,target_id) values(u.id,'invite_created',l.id);
  return jsonb_build_object('expires_at',l.expires_at);
 elsif p_action='revoke_invite' then
  update ss_admin.links set revoked_at=now() where id=(p->>'id')::uuid and kind='invite' and used_at is null;
  return '{}'::jsonb;
 elsif p_action='audit' then
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into vals from (
   select a.id,a.action,a.target_id,a.before_data,a.after_data,a.created_at,person.name as actor
   from ss_admin.audit a left join ss_admin.people person on person.id=a.actor_id order by a.id desc limit 100
  )t;
  return jsonb_build_object('audit',vals);
 else raise exception 'INVALID_ACTION';
 end if;
exception when unique_violation then raise exception 'DUPLICATE';
end $$;
revoke all on function public.ss_admin_gateway(text,jsonb) from public,anon,authenticated;
grant execute on function public.ss_admin_gateway(text,jsonb) to service_role;
comment on function public.ss_admin_gateway(text,jsonb) is 'Server-only gateway. No direct anon/authenticated access. Every business operation checks an opaque session and current database role.';
commit;
