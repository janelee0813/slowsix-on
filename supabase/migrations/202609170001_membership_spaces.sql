-- Existing bookings and blocks belong to ON; each new booking is isolated by space.
begin;
alter table ss_admin.bookings add column if not exists space text not null default 'on' check (space in ('on','p','d'));
alter table ss_admin.booking_blocks add column if not exists space text not null default 'on' check (space in ('on','p','d'));
create index if not exists bookings_space_time on ss_admin.bookings(space,starts_at,ends_at);
create index if not exists blocks_space_time on ss_admin.booking_blocks(space,starts_at,ends_at);
create or replace function public.ss_admin_gateway(p_action text,p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare u ss_admin.people; l ss_admin.links; m ss_admin.members; b ss_admin.bookings; old_b ss_admin.bookings;
 result jsonb; vals jsonb; price jsonb; st timestamptz; en timestamptz; cm date; slot int; quota int; used int; target_status text; selected_space text := coalesce(p->>'space','on');
begin
 if p_action in ('link_info','register') then
  select * into l from ss_admin.links where token_hash=p->>'link_hash' for update;
  if l.kind='member' then
   if l.used_at is not null or l.revoked_at is not null or l.expires_at<=now() then raise exception 'LINK_INVALID'; end if;
   if p_action='link_info' then return jsonb_build_object('kind','member','tier',l.tier); end if;
   if p->>'username'='slowsix' then raise exception 'USERNAME_TAKEN'; end if;
   insert into ss_admin.people(id,username,name,auth_email,role,status) values((p->>'id')::uuid,p->>'username',p->>'name',p->>'email','member','pending') returning * into u;
   insert into ss_admin.members(person_id,tier,gender,age_group,purposes) values(u.id,l.tier,coalesce(p->>'gender',''),coalesce(p->>'age_group',''),coalesce(p->'purposes','[]'));
   update ss_admin.links set used_at=now() where id=l.id;
   insert into ss_admin.audit(actor_id,action,target_id,after_data) values(u.id,'member_joined',u.id,jsonb_build_object('username',u.username,'name',u.name,'tier',l.tier));
   insert into ss_admin.member_notifications(recipient,message) select id,u.name||'님의 멤버십 가입 승인 요청이 도착했습니다.' from ss_admin.people where role='admin';
   return jsonb_build_object('status','pending');
  end if;
 end if;
 if p_action='session_create' and exists(select 1 from ss_admin.people where id=(p->>'id')::uuid and role='member' and status='pending') then raise exception 'APPROVAL_REQUIRED'; end if;
 if p_action in ('rate','rate_clear','credentials','session_create','link_info','register') then return ss_admin.finance_gateway(p_action,p); end if;
 select a.* into u from ss_admin.people a join ss_admin.sessions s on s.person_id=a.id where s.token_hash=p->>'session_hash' and s.expires_at>now();
 if not found then raise exception 'SESSION_EXPIRED'; end if;
 if p_action='logout' then return ss_admin.finance_gateway(p_action,p); end if;
 if u.status in ('rejected','suspended') then raise exception 'ACCESS_DENIED'; end if;
 if p_action in ('me','update_name') then return ss_admin.finance_gateway(p_action,p); end if;
 if u.status<>'active' then raise exception 'APPROVAL_REQUIRED'; end if;
 if p_action not like 'member_%' then
  if u.role='member' then raise exception 'FORBIDDEN'; end if;
  if p_action='set_status' and exists(select 1 from ss_admin.people where id=(p->>'id')::uuid and role='member') then raise exception 'FORBIDDEN'; end if;
  result:=ss_admin.finance_gateway(p_action,p);
  if p_action='people' then
   result:=jsonb_set(result,'{people}',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(result->'people') x where x->>'role'<>'member'));
   result:=jsonb_set(result,'{links}',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(result->'links') x where x->>'kind'='invite'));
  end if;
  return result;
 end if;
 if u.role='operator' then raise exception 'FORBIDDEN'; end if;
 if selected_space not in ('on','p','d') then raise exception 'INVALID_ENTRY'; end if;
 cm:=date_trunc('month',now() at time zone 'Asia/Seoul')::date;
 if u.role='member' then select * into m from ss_admin.members where person_id=u.id; end if;
 if p_action='member_coupon_wallet' then
  if u.role<>'member' then raise exception 'FORBIDDEN'; end if;
  quota:=case m.tier when 'crew' then 2 else 1 end;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into vals from (
   select 'monthly-'||i::text as id,'monthly'::text as kind,(cm+interval '1 month') at time zone 'Asia/Seoul' as expires_at,
   case when booked.status='confirmed' then 'used' when booked.status is not null then 'held' else 'available' end as state
   from generate_series(1,quota) i left join lateral (select status from ss_admin.bookings where member_id=u.id and coupon_month=cm and coupon_slot is not null and status in ('requested','awaiting_payment','confirmed') order by coupon_slot limit 1 offset i-1) booked on true
   union all
   select coupon.id::text,coupon.kind,coupon.expires_at,
   case when booked.status='confirmed' then 'used' when booked.status is not null then 'held' when coupon.expires_at<=now() then 'expired' else 'available' end
   from ss_admin.special_coupons coupon left join lateral(select status from ss_admin.bookings where special_coupon_id=coupon.id and status in ('requested','awaiting_payment','confirmed') limit 1) booked on true
   where coupon.member_id=u.id
  )t;
  return jsonb_build_object('items',vals);
 end if;
 if p_action='member_home' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') into vals from (select id,message,booking_id,read_at,created_at from ss_admin.member_notifications where recipient=u.id order by created_at desc limit 50)t;
  if u.role='admin' then return jsonb_build_object('notifications',vals,'pending',(select count(*) from ss_admin.bookings where status in ('requested','awaiting_payment')),'pending_members',(select count(*) from ss_admin.people where role='member' and status='pending')); end if;
  quota:=case m.tier when 'crew' then 2 else 1 end;
  select count(*) into used from ss_admin.bookings where member_id=u.id and coupon_month=cm and coupon_slot is not null and status in ('requested','awaiting_payment','confirmed');
  return jsonb_build_object('tier',m.tier,'coupon_month',cm,'coupon_quota',quota,'coupon_remaining',greatest(0,quota-used),'notifications',vals);
 elsif p_action='member_read' then
  update ss_admin.member_notifications set read_at=now() where recipient=u.id and read_at is null and id<=coalesce((p->>'through')::bigint,0);return '{}'::jsonb;
 elsif p_action='member_calendar' or p_action='member_bookings' then
  st:=(p->>'from')::timestamptz;en:=(p->>'to')::timestamptz;
  if st is null or en is null or en<=st or en-st>interval '366 days' then raise exception 'INVALID_PERIOD'; end if;
  if p_action='member_calendar' then
   select coalesce(jsonb_agg(to_jsonb(t) order by t.starts_at),'[]') into vals from (
    select starts_at,ends_at,space from ss_admin.bookings where space=selected_space and status in ('requested','awaiting_payment','confirmed') and starts_at<en and ends_at>st
    union all select starts_at,ends_at,space from ss_admin.booking_blocks where space=selected_space and starts_at<en and ends_at>st)t;
  else
   select coalesce(jsonb_agg(to_jsonb(t) order by t.starts_at),'[]') into vals from (
    select booking.*,a.name as nickname,a.username from ss_admin.bookings booking join ss_admin.people a on a.id=booking.member_id
    where booking.space=selected_space and (u.role='admin' or booking.member_id=u.id) and booking.starts_at<en and booking.ends_at>st)t;
  end if;
  return jsonb_build_object('items',vals);
 elsif p_action in ('member_quote','member_request') then
  if u.role<>'member' then raise exception 'FORBIDDEN'; end if;
  if (selected_space='p' and (p->>'guests')::int not between 8 and 9) or (selected_space='d' and (p->>'guests')::int not between 6 and 12) then raise exception 'INVALID_BOOKING'; end if;
  st:=(p->>'starts_at')::timestamptz;en:=(p->>'ends_at')::timestamptz;
  if st<=now() or st>now()+interval '365 days' then raise exception 'INVALID_BOOKING'; end if;
  price:=ss_admin.booking_price(st,en,(p->>'guests')::int,m.tier,coalesce((p->>'use_coupon')::boolean,false));
  if nullif(p->>'coupon_id','') is not null and coalesce((p->>'use_coupon')::boolean,false) then raise exception 'INVALID_ENTRY'; end if;
  if p_action='member_quote' then
   if nullif(p->>'coupon_id','') is not null then price:=ss_admin.special_coupon_price((p->>'coupon_id')::uuid,u.id,st,en,(p->>'guests')::int,price); end if;
   return price;
  end if;
  -- A single resource lock serializes availability and coupon allocation for every write.
  perform pg_advisory_xact_lock(992301);
  select * into b from ss_admin.bookings where id=(p->>'id')::uuid;
  if found then
   if b.member_id<>u.id then raise exception 'FORBIDDEN'; end if;
   if b.space<>selected_space or b.special_coupon_id is distinct from nullif(p->>'coupon_id','')::uuid or b.starts_at<>st or b.ends_at<>en or b.guests<>(p->>'guests')::int or (b.coupon_slot is not null)<>coalesce((p->>'use_coupon')::boolean,false) or b.note<>coalesce(p->>'note','') then raise exception 'CONFLICT'; end if;
   return to_jsonb(b);
  end if;
  if exists(select 1 from ss_admin.bookings where space=selected_space and status in ('requested','awaiting_payment','confirmed') and starts_at<en and ends_at>st) or exists(select 1 from ss_admin.booking_blocks where space=selected_space and starts_at<en and ends_at>st) then raise exception 'TIME_UNAVAILABLE'; end if;
  if not exists(select 1 from ss_admin.people where id=u.id and status='active') then raise exception 'ACCESS_DENIED'; end if;
  select * into m from ss_admin.members where person_id=u.id;
  price:=ss_admin.booking_price(st,en,(p->>'guests')::int,m.tier,coalesce((p->>'use_coupon')::boolean,false));
  if coalesce((p->>'use_coupon')::boolean,false) then
   quota:=case m.tier when 'crew' then 2 else 1 end;
   select count(*) into used from ss_admin.bookings where member_id=u.id and coupon_month=cm and coupon_slot is not null and status in ('requested','awaiting_payment','confirmed');
   if used>=quota then raise exception 'COUPON_UNAVAILABLE'; end if;
   select i into slot from generate_series(1,quota) i where not exists(select 1 from ss_admin.bookings where member_id=u.id and coupon_month=cm and coupon_slot=i and status in ('requested','awaiting_payment','confirmed')) limit 1;
  end if;
  if nullif(p->>'coupon_id','') is not null then price:=ss_admin.special_coupon_price((p->>'coupon_id')::uuid,u.id,st,en,(p->>'guests')::int,price); end if;
  insert into ss_admin.bookings(space,special_coupon_id,id,member_id,starts_at,ends_at,guests,tier,discount_percent,base_amount,discount_amount,coupon_amount,total_amount,coupon_month,coupon_slot,note)
   values(selected_space,nullif(p->>'coupon_id','')::uuid,(p->>'id')::uuid,u.id,st,en,(p->>'guests')::int,m.tier,(price->>'discount_percent')::int,(price->>'base_amount')::bigint,(price->>'discount_amount')::bigint,(price->>'coupon_amount')::int,(price->>'total_amount')::bigint,case when slot is not null then cm end,slot,coalesce(p->>'note','')) returning * into b;
  insert into ss_admin.member_notifications(recipient,message,booking_id) select id,u.name||'님의 슬로우식스'||upper(selected_space)||' 예약 요청이 도착했습니다.',b.id from ss_admin.people where role='admin';
  return to_jsonb(b);
 elsif p_action='member_cancel' then
  perform pg_advisory_xact_lock(992301);
  select * into old_b from ss_admin.bookings where id=(p->>'id')::uuid for update;
  if not found or (u.role='member' and old_b.member_id<>u.id) then raise exception 'FORBIDDEN'; end if;
  if u.role='member' and (old_b.status not in ('requested','awaiting_payment') or old_b.starts_at<=now()) then raise exception 'CANCEL_REQUIRES_ADMIN'; end if;
  target_status:='cancelled';
 elsif u.role<>'admin' then raise exception 'FORBIDDEN';
 elsif p_action='member_inbox' then
  return jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at),'[]') from (select booking.*,a.name as nickname,a.username from ss_admin.bookings booking join ss_admin.people a on a.id=booking.member_id where booking.status in ('requested','awaiting_payment'))t));
 elsif p_action='member_invite' then
  if p->>'tier' is null or p->>'tier' not in ('friends','crew') then raise exception 'INVALID_ENTRY'; end if;
  insert into ss_admin.links(token_hash,kind,tier,expires_at,created_by) values(p->>'link_hash','member',p->>'tier',now()+interval '72 hours',u.id) returning * into l;
  return jsonb_build_object('expires_at',l.expires_at);
 elsif p_action='member_invites' then
  return jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') from (select id,tier,expires_at,used_at,revoked_at,created_at from ss_admin.links where kind='member' order by created_at desc limit 50)t));
 elsif p_action='member_revoke' then
  update ss_admin.links set revoked_at=now() where id=(p->>'id')::uuid and kind='member' and used_at is null;return '{}'::jsonb;
 elsif p_action='member_people' then
  return jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') from (select a.id,a.username,a.name,a.status,a.created_at,profile.tier,profile.gender,profile.age_group,profile.purposes,profile.version from ss_admin.members profile join ss_admin.people a on a.id=profile.person_id where profile.deleted_at is null)t));
 elsif p_action='member_coupon_issue' then
  if p->>'kind' is null or p->>'kind' not in ('discount5000','night','hours3') or p->>'expires_at' is null or (p->>'expires_at')::timestamptz<=now() then raise exception 'INVALID_ENTRY'; end if;
  perform pg_advisory_xact_lock(992301);
  if not exists(select 1 from ss_admin.members profile join ss_admin.people person on person.id=profile.person_id where profile.person_id=(p->>'member_id')::uuid and profile.deleted_at is null and person.status='active') then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from ss_admin.special_coupons where id=(p->>'id')::uuid) then
   if not exists(select 1 from ss_admin.special_coupons where id=(p->>'id')::uuid and member_id=(p->>'member_id')::uuid and kind=p->>'kind' and expires_at=(p->>'expires_at')::timestamptz) then raise exception 'CONFLICT'; end if;
   return '{}'::jsonb;
  end if;
  insert into ss_admin.special_coupons(id,member_id,kind,expires_at,created_by) values((p->>'id')::uuid,(p->>'member_id')::uuid,p->>'kind',(p->>'expires_at')::timestamptz,u.id);
  insert into ss_admin.member_notifications(recipient,message) values((p->>'member_id')::uuid,'특별쿠폰이 도착했습니다. 내 쿠폰함을 확인해주세요.');
  insert into ss_admin.audit(actor_id,action,target_id,after_data) values(u.id,'coupon_issued',(p->>'id')::uuid,p-'session_hash');
  return '{}'::jsonb;
 elsif p_action='member_delete' then
  perform pg_advisory_xact_lock(992301);
  select * into m from ss_admin.members where person_id=(p->>'id')::uuid and deleted_at is null for update;
  if not found or p->>'version' is null or m.version<>(p->>'version')::int then raise exception 'CONFLICT'; end if;
  if exists(select 1 from ss_admin.bookings where member_id=m.person_id and (status in ('requested','awaiting_payment') or (status='confirmed' and ends_at>now()))) then raise exception 'MEMBER_HAS_BOOKINGS'; end if;
  update ss_admin.members set deleted_at=now(),version=version+1 where person_id=m.person_id;
  update ss_admin.people set status='rejected' where id=m.person_id;
  delete from ss_admin.sessions where person_id=m.person_id;
  insert into ss_admin.audit(actor_id,action,target_id,before_data) values(u.id,'member_deleted',m.person_id,to_jsonb(m));
  return '{}'::jsonb;
 elsif p_action='member_person_save' then
  perform pg_advisory_xact_lock(992301);
  select * into m from ss_admin.members where person_id=(p->>'id')::uuid and deleted_at is null for update;
  if not found or m.version<>(p->>'version')::int then raise exception 'CONFLICT'; end if;
  if p->>'tier' is null or p->>'tier' not in ('friends','crew') or p->>'status' is null or p->>'status' not in ('active','suspended') then raise exception 'INVALID_ENTRY'; end if;
  update ss_admin.members set tier=p->>'tier',version=version+1 where person_id=m.person_id;
  update ss_admin.people set status=p->>'status' where id=m.person_id;
  if p->>'status'='suspended' then delete from ss_admin.sessions where person_id=m.person_id; end if;
  insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'member_changed',m.person_id,to_jsonb(m),p-'session_hash');
  return '{}'::jsonb;
 elsif p_action='member_settings' then
  return jsonb_build_object('payment_note',(select payment_note from ss_admin.membership_settings where id));
 elsif p_action='member_settings_save' then
  update ss_admin.membership_settings set payment_note=coalesce(p->>'payment_note','') where id;return '{}'::jsonb;
 elsif p_action='member_blocks' then
  return jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(t) order by t.starts_at),'[]') from ss_admin.booking_blocks t where ends_at>now()));
 elsif p_action='member_block_save' then
  perform pg_advisory_xact_lock(992301);
  st:=(p->>'starts_at')::timestamptz;en:=(p->>'ends_at')::timestamptz;
  if st is null or en is null or en<=st or en-st>interval '366 days' then raise exception 'INVALID_BOOKING'; end if;
  if exists(select 1 from ss_admin.bookings where space=selected_space and status in ('requested','awaiting_payment','confirmed') and starts_at<en and ends_at>st) then raise exception 'TIME_UNAVAILABLE'; end if;
  insert into ss_admin.booking_blocks(space,id,starts_at,ends_at,note,created_by) values(selected_space,(p->>'id')::uuid,st,en,coalesce(p->>'note',''),u.id) on conflict(id) do nothing;return '{}'::jsonb;
 elsif p_action='member_block_delete' then
  perform pg_advisory_xact_lock(992301);delete from ss_admin.booking_blocks where id=(p->>'id')::uuid;return '{}'::jsonb;
 elsif p_action='member_status' then
  perform pg_advisory_xact_lock(992301);
  select * into old_b from ss_admin.bookings where id=(p->>'id')::uuid for update;
  if not found then raise exception 'CONFLICT'; end if;
  target_status:=p->>'status';
  if target_status is null or not ((old_b.status='requested' and target_status in ('awaiting_payment','rejected','cancelled')) or (old_b.status='awaiting_payment' and target_status in ('confirmed','rejected','cancelled')) or (old_b.status='confirmed' and target_status='cancelled')) then raise exception 'INVALID_TRANSITION'; end if;
  if target_status='awaiting_payment' and length(trim(coalesce(p->>'payment_note','')))=0 then raise exception 'PAYMENT_NOTE_REQUIRED'; end if;
 else raise exception 'INVALID_ACTION'; end if;
 -- Shared booking transition: coupon reservations are released by the status change atomically.
 if p->>'version' is null or old_b.version<>(p->>'version')::int or old_b.status in ('cancelled','rejected') then raise exception 'CONFLICT'; end if;
 update ss_admin.bookings set status=target_status,version=version+1,updated_at=now(),
  payment_note=case when target_status='awaiting_payment' then p->>'payment_note' else payment_note end,
  admin_note=case when u.role='admin' then coalesce(p->>'admin_note','') else admin_note end where id=old_b.id returning * into b;
 insert into ss_admin.audit(actor_id,action,target_id,before_data,after_data) values(u.id,'booking_status',b.id,to_jsonb(old_b),to_jsonb(b));
 insert into ss_admin.member_notifications(recipient,message,booking_id) values(b.member_id,
 case target_status when 'awaiting_payment' then '예약이 승인되었습니다. 예약 내역의 입금 안내를 확인해주세요.' when 'confirmed' then '입금이 확인되어 예약이 확정되었습니다.' when 'rejected' then '예약 요청이 거절되었습니다. 사용한 쿠폰은 발급월 내에서 다시 사용할 수 있습니다.' else '예약이 취소되었습니다. 사용한 쿠폰은 발급월 내에서 다시 사용할 수 있습니다.' end,b.id);
 if u.role='member' then insert into ss_admin.member_notifications(recipient,message,booking_id) select id,u.name||'님이 예약 요청을 취소했습니다.',b.id from ss_admin.people where role='admin'; end if;
 return to_jsonb(b);
exception when unique_violation then raise exception 'DUPLICATE';
end $$;
revoke all on function public.ss_admin_gateway(text,jsonb) from public,anon,authenticated;
grant execute on function public.ss_admin_gateway(text,jsonb) to service_role;


create or replace function ss_admin.sc_enqueue() returns trigger language plpgsql set search_path=pg_catalog,ss_admin as $$
declare wanted text;
begin
 if new.space<>'on' then return new; end if;
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
revoke all on function ss_admin.sc_enqueue() from public,anon,authenticated;

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
  if not found or b.space<>'on' then raise exception 'INVALID_ENTRY'; end if;
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
