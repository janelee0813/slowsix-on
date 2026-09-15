-- Recurring expenses are expanded once per settlement month at query time; no scheduled job or duplicate inserts.
-- Run in qhvwwdrwfzwpehfjntbv. Do not convert historical profit amounts into fees.
begin;
-- Persistent sessions remain revocable by logout or account suspension.
alter table ss_admin.sessions alter column expires_at set default 'infinity'::timestamptz;
update ss_admin.sessions s set expires_at='infinity'::timestamptz
 from ss_admin.people u where s.person_id=u.id and u.status in ('active','pending') and s.expires_at>now();
create table if not exists ss_admin.period_fees (
 id uuid not null unique default gen_random_uuid(),
 period_start date not null, period_end date not null,
 amount bigint not null check(amount between -1000000000000 and 1000000000000),
 version integer not null default 1,
 updated_by uuid not null references ss_admin.people(id), updated_at timestamptz not null default now(),
 primary key(period_start,period_end), check(period_end>=period_start and period_end-period_start<=366)
);
alter table ss_admin.period_fees enable row level security;
revoke all on ss_admin.period_fees from public,anon,authenticated;

create table if not exists ss_admin.recurring_expenses (
 id uuid primary key, description text not null check(length(trim(description)) between 1 and 200),
 category text not null check(category in ('fixed','expense')),
 amount bigint not null check(amount between 1 and 10000000000),
 start_month date not null check(extract(day from start_month)=1),
 end_month date check(extract(day from end_month)=1 and end_month>=start_month),
 version int not null default 1, created_by uuid not null references ss_admin.people(id),
 updated_by uuid not null references ss_admin.people(id), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), deleted_at timestamptz
);
alter table ss_admin.recurring_expenses enable row level security;
revoke all on ss_admin.recurring_expenses from public,anon,authenticated;

-- Bounded expansion respects exact date filters, including partial settlement periods.
create or replace function ss_admin.ledger_rows(d1 date,d2 date)
returns table(id uuid,entry_date date,description text,category text,amount bigint,
 created_by uuid,updated_by uuid,version int,created_at timestamptz,updated_at timestamptz,
 deleted_at timestamptz,request_id uuid,recurring_id uuid)
language sql stable set search_path=pg_catalog,ss_admin as $$
 select e.*,null::uuid from ss_admin.entries e where e.deleted_at is null and e.entry_date between d1 and d2
 union all
 select md5(r.id::text||':'||m.day::date::text)::uuid,m.day::date+11,r.description,r.category,r.amount,
 r.created_by,r.updated_by,r.version,r.created_at,r.updated_at,null::timestamptz,null::uuid,r.id
 from ss_admin.recurring_expenses r
 cross join generate_series(date_trunc('month',d1::timestamp),date_trunc('month',d2::timestamp),interval '1 month') m(day)
 where r.deleted_at is null and m.day::date>=r.start_month and (r.end_month is null or m.day::date<=r.end_month)
 and m.day::date+11 between d1 and d2;
$$;
revoke all on function ss_admin.ledger_rows(date,date) from public,anon,authenticated;

create or replace function public.ss_admin_gateway(p_action text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, ss_admin
as $$
declare
 u ss_admin.people; v ss_admin.people; l ss_admin.links; r ss_admin.limits;
 pr ss_admin.period_fees; old_pr ss_admin.period_fees;
 e ss_admin.entries; old_e ss_admin.entries; result jsonb; vals jsonb;
 sort_key text; sort_dir text; rr ss_admin.recurring_expenses; old_rr ss_admin.recurring_expenses;
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
 if p_action='update_name' then
  if p->>'name' is null or length(trim(p->>'name')) not between 1 and 40 then raise exception 'INVALID_ENTRY'; end if;
  vals:=jsonb_build_object('name',u.name);
  update ss_admin.people set name=trim(p->>'name') where id=u.id returning * into u;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'name_updated',u.id,vals,jsonb_build_object('name',u.name));
  return jsonb_build_object('name',u.name);
 end if;
 if p_action='me' then
  return jsonb_build_object('id',u.id,'username',u.username,'name',u.name,'role',u.role,'status',u.status);
 end if;
 if u.status<>'active' then raise exception 'APPROVAL_REQUIRED'; end if;

 if p_action='recurring_list' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.start_month desc,t.created_at desc),'[]') into vals
   from ss_admin.recurring_expenses t where t.deleted_at is null;
  return jsonb_build_object('items',vals);
 end if;
 if p_action='list' then
  sort_key:=coalesce(p->>'sort_by','date'); sort_dir:=coalesce(p->>'sort_dir','desc');
  if sort_key not in ('date','author','description','spacecloud','invoice','cash','fixed','expense') or sort_dir not in ('asc','desc') then raise exception 'INVALID_ENTRY'; end if;
  d1:=(p->>'from')::date; d2:=(p->>'to')::date;
  if d1 is null or d2 is null or d1>d2 or d2-d1>366 then raise exception 'INVALID_PERIOD'; end if;
  select coalesce(sum(amount) filter(where category='spacecloud'),0),coalesce(sum(amount) filter(where category='invoice'),0),
   coalesce(sum(amount) filter(where category='cash'),0),coalesce(sum(amount) filter(where category='fixed'),0),coalesce(sum(amount) filter(where category='expense'),0)
   into sc,inv,cash,fixed,expense from ss_admin.ledger_rows(d1,d2);
  select * into pr from ss_admin.period_fees where period_start=d1 and period_end=d2;
  profit:=sc+inv+cash-fixed-expense; fee:=pr.amount;
  select count(*) into n from ss_admin.ledger_rows(d1,d2);
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into vals from (
   select entry.*,a.name as author from ss_admin.ledger_rows(d1,d2) entry join ss_admin.people a on a.id=entry.created_by
   where entry.deleted_at is null and entry.entry_date between d1 and d2 order by case when sort_dir='asc' then case sort_key when 'date' then entry.entry_date::text when 'author' then a.name when 'description' then entry.description end end asc nulls last,
    case when sort_dir='asc' and entry.category=sort_key then entry.amount end asc nulls last,
    case when sort_dir='desc' then case sort_key when 'date' then entry.entry_date::text when 'author' then a.name when 'description' then entry.description end end desc nulls last,
    case when sort_dir='desc' and entry.category=sort_key then entry.amount end desc nulls last,
    entry.entry_date desc,
    entry.created_at desc,
    entry.id
   limit 100 offset greatest(0,least(coalesce((p->>'offset')::int,0),1000000))
  )t;
  return jsonb_build_object('sort_supported',true,'entries',vals,'count',n,'summary',jsonb_build_object('spacecloud',sc,'invoice',inv,'cash',cash,'fixed',fixed,'expense',expense,
   'revenue',sc+inv+cash,'spending',fixed+expense,'fee_mode','manual','fee_version',coalesce(pr.version,0),'profit',profit,'fee',fee,'settlement',inv+cash-expense-fee));
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
 if p_action='recurring_save' then
  if p->>'id' is null or p->>'version' is null or (p->>'version')::int<0 or
   p->>'category' is null or p->>'category' not in ('fixed','expense') or
   p->>'description' is null or length(trim(p->>'description')) not between 1 and 200 or
   p->>'amount' is null or (p->>'amount')::numeric<>trunc((p->>'amount')::numeric) or (p->>'amount')::numeric not between 1 and 10000000000 then raise exception 'INVALID_ENTRY'; end if;
  d1:=(p->>'start_month')::date; d2:=nullif(p->>'end_month','')::date;
  if d1 is null or extract(day from d1)<>1 or (d2 is not null and (extract(day from d2)<>1 or d2<d1)) then raise exception 'INVALID_ENTRY'; end if;
  perform pg_advisory_xact_lock(hashtextextended('recurring:'||(p->>'id'),0));
  select * into old_rr from ss_admin.recurring_expenses where id=(p->>'id')::uuid for update;
  -- A retried create returns the existing rule only when every supplied value matches.
  if old_rr.id is not null and (p->>'version')::int=0 and old_rr.version=1 and old_rr.deleted_at is null and
   old_rr.description=trim(p->>'description') and old_rr.category=p->>'category' and old_rr.amount=(p->>'amount')::bigint and
   old_rr.start_month=d1 and old_rr.end_month is not distinct from d2 then return jsonb_build_object('id',old_rr.id); end if;
  if coalesce(old_rr.version,0)<>(p->>'version')::int or old_rr.deleted_at is not null then raise exception 'CONFLICT'; end if;
  insert into ss_admin.recurring_expenses(id,description,category,amount,start_month,end_month,created_by,updated_by)
   values((p->>'id')::uuid,trim(p->>'description'),p->>'category',(p->>'amount')::bigint,d1,d2,u.id,u.id)
   on conflict(id) do update set description=excluded.description,category=excluded.category,amount=excluded.amount,
    start_month=excluded.start_month,end_month=excluded.end_month,updated_by=u.id,updated_at=now(),version=ss_admin.recurring_expenses.version+1
   returning * into rr;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data)
   values(u.id,'recurring_saved',rr.id,case when old_rr.id is null then null else to_jsonb(old_rr) end,to_jsonb(rr));
  return jsonb_build_object('id',rr.id);
 elsif p_action='recurring_delete' then
  select * into old_rr from ss_admin.recurring_expenses where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found or p->>'version' is null or old_rr.version<>(p->>'version')::int then raise exception 'CONFLICT'; end if;
  update ss_admin.recurring_expenses set deleted_at=now(),updated_at=now(),updated_by=u.id,version=version+1 where id=old_rr.id returning * into rr;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'recurring_deleted',rr.id,to_jsonb(old_rr),to_jsonb(rr));
  return '{}'::jsonb;
 elsif p_action='save_fee' then
  d1:=(p->>'from')::date; d2:=(p->>'to')::date;
  if d1 is null or d2 is null or d1>d2 or d2-d1>366 then raise exception 'INVALID_PERIOD'; end if;
  if p->>'amount' is null or (p->>'amount')::numeric<>trunc((p->>'amount')::numeric) or abs((p->>'amount')::numeric)>1000000000000 or p->>'version' is null or (p->>'version')::int<0 then raise exception 'INVALID_ENTRY'; end if;
  -- Serialize both first inserts and updates for the same exact reporting period.
  perform pg_advisory_xact_lock(hashtextextended('fee:'||d1::text||':'||d2::text,0));
  select * into old_pr from ss_admin.period_fees where period_start=d1 and period_end=d2 for update;
  if coalesce(old_pr.version,0)<>(p->>'version')::int then raise exception 'CONFLICT'; end if;
  insert into ss_admin.period_fees(period_start,period_end,amount,updated_by)
   values(d1,d2,(p->>'amount')::bigint,u.id)
   on conflict(period_start,period_end) do update set amount=excluded.amount,updated_by=u.id,updated_at=now(),version=ss_admin.period_fees.version+1
   returning * into pr;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data)
   values(u.id,'fee_saved',pr.id,case when old_pr.id is null then null else to_jsonb(old_pr) end,to_jsonb(pr));
  return jsonb_build_object('version',pr.version);
 elsif p_action='delete_entry' then
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
