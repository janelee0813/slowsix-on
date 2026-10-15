-- Optional recovery, only when requested by the owner. Never overwrite post-reset edits.
begin;
lock table ss_admin.entries,ss_admin.period_fees,ss_admin.recurring_expenses in share row exclusive mode;
do $restore$
declare archive ss_admin.ledger_archives; original jsonb;
begin
 select * into archive from ss_admin.ledger_archives where id='restart-2026-10';
 if archive.id is null then raise exception 'Backup not found'; end if;
 for original in select * from jsonb_array_elements(archive.snapshot->'entries') loop
  update ss_admin.entries set deleted_at=null,updated_at=now(),version=version+1
   where id=(original->>'id')::uuid and deleted_at=archive.created_at and version=(original->>'version')::int+1;
 end loop;
 for original in select * from jsonb_array_elements(archive.snapshot->'recurring') loop
  update ss_admin.recurring_expenses set deleted_at=null,updated_at=now(),version=version+1
   where id=(original->>'id')::uuid and deleted_at=archive.created_at and version=(original->>'version')::int+1;
 end loop;
 for original in select * from jsonb_array_elements(archive.snapshot->'fees') loop
  update ss_admin.period_fees set deleted_at=null,updated_at=now(),version=version+1
   where id=(original->>'id')::uuid and deleted_at=archive.created_at and version=(original->>'version')::int+1;
 end loop;
 insert into ss_admin.audit(actor_id,action,after_data) values(archive.created_by,'ledger_restored',jsonb_build_object('archive',archive.id));
end $restore$;
commit;
