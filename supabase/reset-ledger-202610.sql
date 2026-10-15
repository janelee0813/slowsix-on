-- Run once, only at the owner's request. Original data stays in the private database.
-- Does not change accounts, membership, reservations, coupons or previous audit records.
begin;
lock table ss_admin.entries,ss_admin.period_fees,ss_admin.recurring_expenses in share row exclusive mode;
do $reset$
declare actor uuid; backup jsonb;
begin
 if exists(select 1 from ss_admin.ledger_archives where id='restart-2026-10') then
  raise notice 'Reset already completed; new records have not been changed'; return;
 end if;
 select id into actor from ss_admin.people where role='admin' and username='slowsix';
 if actor is null then raise exception 'Administrator not found'; end if;
 backup:=jsonb_build_object(
  'entries',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from ss_admin.entries t where deleted_at is null),
  'fees',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from ss_admin.period_fees t where deleted_at is null),
  'recurring',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from ss_admin.recurring_expenses t where deleted_at is null)
 );
 insert into ss_admin.ledger_archives(id,created_by,snapshot) values('restart-2026-10',actor,backup);
 update ss_admin.entries set deleted_at=now(),updated_at=now(),updated_by=actor,version=version+1 where deleted_at is null;
 update ss_admin.recurring_expenses set deleted_at=now(),updated_at=now(),updated_by=actor,version=version+1 where deleted_at is null;
 update ss_admin.period_fees set deleted_at=now(),updated_at=now(),updated_by=actor,version=version+1 where deleted_at is null;
 insert into ss_admin.audit(actor_id,action,before_data,after_data) values(actor,'ledger_reset',
  jsonb_build_object('entries',jsonb_array_length(backup->'entries'),'fees',jsonb_array_length(backup->'fees'),'recurring',jsonb_array_length(backup->'recurring')),
  jsonb_build_object('starts_on','2026-10-01','archive','restart-2026-10'));
end $reset$;
commit;
-- Verification returns counts only, not the archived financial data.
select (select count(*) from ss_admin.entries where deleted_at is null) as active_entries,
 (select count(*) from ss_admin.period_fees where deleted_at is null) as active_fees,
 (select count(*) from ss_admin.recurring_expenses where deleted_at is null) as active_recurring,
 exists(select 1 from ss_admin.ledger_archives where id='restart-2026-10') as backup_saved;
