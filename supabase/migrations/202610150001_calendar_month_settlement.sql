-- Calendar-month settlement. Data reset is a separate, explicitly run operation.
begin;
alter table ss_admin.period_fees add column if not exists deleted_at timestamptz;

create table if not exists ss_admin.ledger_archives (
 id text primary key, created_at timestamptz not null default now(),
 created_by uuid not null references ss_admin.people(id), snapshot jsonb not null
);
alter table ss_admin.ledger_archives enable row level security;
revoke all on ss_admin.ledger_archives from public,anon,authenticated,service_role;

create or replace function ss_admin.ledger_rows(d1 date,d2 date)
returns table(id uuid,entry_date date,description text,category text,amount bigint,
 created_by uuid,updated_by uuid,version int,created_at timestamptz,updated_at timestamptz,
 deleted_at timestamptz,request_id uuid,recurring_id uuid)
language sql stable set search_path=pg_catalog,ss_admin as $$
 select e.*,null::uuid from ss_admin.entries e where e.deleted_at is null and e.entry_date between d1 and d2
 union all
 select md5(r.id::text||':'||m.day::date::text)::uuid,m.day::date,r.description,r.category,r.amount,
 r.created_by,r.updated_by,r.version,r.created_at,r.updated_at,null::timestamptz,null::uuid,r.id
 from ss_admin.recurring_expenses r
 cross join generate_series(date_trunc('month',d1::timestamp),date_trunc('month',d2::timestamp),interval '1 month') m(day)
 where r.deleted_at is null and m.day::date>=r.start_month and (r.end_month is null or m.day::date<=r.end_month)
 and m.day::date between d1 and d2;
$$;
revoke all on function ss_admin.ledger_rows(date,date) from public,anon,authenticated;

-- Preserve the existing role/session checks and accounting formula in the gateway.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('ss_admin.finance_gateway(text,jsonb)'::regprocedure);
 definition:=replace(definition,
  'select * into pr from ss_admin.period_fees where period_start=d1 and period_end=d2;',
  'select * into pr from ss_admin.period_fees where period_start=d1 and period_end=d2 and deleted_at is null;');
 definition:=replace(definition,
  'select * into old_pr from ss_admin.period_fees where period_start=d1 and period_end=d2 for update;',
  'select * into old_pr from ss_admin.period_fees where period_start=d1 and period_end=d2 and deleted_at is null for update;');
 definition:=replace(definition,
  'on conflict(period_start,period_end) do update set amount=excluded.amount,updated_by=u.id,updated_at=now(),version=ss_admin.period_fees.version+1',
  'on conflict(period_start,period_end) do update set amount=excluded.amount,updated_by=u.id,updated_at=now(),deleted_at=null,version=ss_admin.period_fees.version+1');
 if position('and deleted_at is null for update' in definition)=0 or position('deleted_at=null,version=ss_admin.period_fees.version+1' in definition)=0 then
  raise exception 'Unexpected finance gateway definition; no changes applied';
 end if;
 execute definition;
end $migration$;
commit;
