-- Display codes are distinct from private UUIDs used for authorization and retries.
begin;
alter table ss_admin.bookings add column if not exists booking_number bigint generated always as identity;
alter table ss_admin.bookings add column if not exists booking_code text generated always as
 ('SS-'||lpad(booking_number::text,greatest(6,length(booking_number::text)),'0')) stored;
create unique index if not exists bookings_display_code_unique on ss_admin.bookings(booking_code);
revoke all on sequence ss_admin.bookings_booking_number_seq from public,anon,authenticated;
create or replace function ss_admin.alimtalk_enqueue() returns trigger language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare target_phone text; nickname text;
begin
 if tg_op='UPDATE' and new.status=old.status then return new; end if;
 select p.name,m.phone into nickname,target_phone from ss_admin.people p join ss_admin.members m on m.person_id=p.id where p.id=new.member_id;
 if new.status='requested' then target_phone:='01051667412';
 else update ss_admin.alimtalk_jobs set state='skipped',updated_at=now() where booking_id=new.id and kind<>'requested' and state in ('pending','no_phone'); end if;
 insert into ss_admin.alimtalk_jobs(booking_id,booking_version,kind,member_id,phone,snapshot,state)
 values(new.id,new.version,new.status,new.member_id,coalesce(target_phone,''),jsonb_build_object('booking_code',new.booking_code,'nickname',nickname,'space',new.space,'starts_at',new.starts_at,'ends_at',new.ends_at,'guests',new.guests,'total_amount',new.total_amount),case when coalesce(target_phone,'')='' then 'no_phone' else 'pending' end)
 on conflict(booking_id,booking_version,kind) do nothing;
 return new;
end $$;
-- Enrich only jobs which have not been dispatched; never enqueue or resend old notices.
update ss_admin.alimtalk_jobs j set snapshot=j.snapshot||jsonb_build_object('booking_code',b.booking_code)
from ss_admin.bookings b where b.id=j.booking_id and j.dispatched_at is null and j.state in ('pending','no_phone','failed');
commit;
