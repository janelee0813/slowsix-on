-- New crew requests: 15% off and three monthly coupons.
-- Existing bookings retain their stored prices and coupon usage.
begin;
alter table ss_admin.bookings drop constraint if exists bookings_coupon_slot_check;
alter table ss_admin.bookings add constraint bookings_coupon_slot_check check(coupon_slot between 1 and 3);
do $migration$
declare definition text; old_rule text; new_rule text;
begin
 old_rule := 'pct:=case tier when ''crew'' then 20 else 12 end;';
 new_rule := 'pct:=case tier when ''crew'' then 15 else 12 end;';
 definition := pg_get_functiondef('ss_admin.booking_price(timestamptz,timestamptz,integer,text,boolean)'::regprocedure);
 if strpos(definition,old_rule)=0 and strpos(definition,new_rule)=0 then raise exception 'Unexpected booking price definition'; end if;
 execute replace(definition,old_rule,new_rule);
 old_rule := 'quota:=case m.tier when ''crew'' then 2 else 1 end;';
 new_rule := 'quota:=case m.tier when ''crew'' then 3 else 1 end;';
 definition := pg_get_functiondef('ss_admin.gateway_before_alimtalk(text,jsonb)'::regprocedure);
 if strpos(definition,old_rule)=0 and strpos(definition,new_rule)=0 then raise exception 'Unexpected membership gateway definition'; end if;
 execute replace(definition,old_rule,new_rule);
end $migration$;
commit;
