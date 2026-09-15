-- Run after migration 008. The result is a private Vercel environment value; never share it.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
create extension if not exists supabase_vault with schema vault;
do $$ begin
 if not exists(select 1 from vault.secrets where name='slowsix_spacecloud_sync') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'slowsix_spacecloud_sync');
 end if;
end $$;
create or replace function ss_admin.sc_dispatch() returns void language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare secret text;
begin
 if not exists(select 1 from ss_admin.sc_settings s where
  s.worker_seen_at is null or s.worker_seen_at<now()-interval '10 minutes' or
  (s.enabled and exists(select 1 from ss_admin.sc_jobs where
    (state in ('pending','error') and retry_at<=now() and attempts<3) or (state='working' and lease_until<=now())))) then return; end if;
 if exists(select 1 from ss_admin.sc_jobs where state='working' and lease_until>now()) then return; end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='slowsix_spacecloud_sync';
 perform net.http_post(url:='https://slowsixon.com/api/spacecloud-sync',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),body:='{}'::jsonb,timeout_milliseconds:=175000);
end $$;
revoke all on function ss_admin.sc_dispatch() from public,anon,authenticated;
-- Jobs run after committed inserts; this wake-up avoids waiting for the minute tick.
create or replace function ss_admin.sc_wake() returns trigger language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
begin
 if new.state='pending' and exists(select 1 from ss_admin.sc_settings where enabled) then perform ss_admin.sc_dispatch(); end if;
 return new;
end $$;
revoke all on function ss_admin.sc_wake() from public,anon,authenticated;
drop trigger if exists sc_wake_job on ss_admin.sc_jobs;
create trigger sc_wake_job after insert or update on ss_admin.sc_jobs for each row execute function ss_admin.sc_wake();
select cron.schedule('slowsix-spacecloud-sync','* * * * *','select ss_admin.sc_dispatch()');
select decrypted_secret as "SPACECLOUD_SYNC_SECRET" from vault.decrypted_secrets where name='slowsix_spacecloud_sync';
