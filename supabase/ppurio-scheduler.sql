-- The existing, configured server-to-server scheduler credential stays in Vault.
-- No key is printed, replaced or copied into a query.
create or replace function ss_admin.ppurio_dispatch() returns void language plpgsql security definer set search_path=pg_catalog,ss_admin as $$
declare secret text;
begin
 if not exists(select 1 from ss_admin.alimtalk_jobs where (state='pending' and available_at<=now() and attempts<3) or (state='sending' and lease_until<=now())) then return;end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='slowsix_spacecloud_sync';
 if secret is null then raise exception 'SCHEDULER_NOT_CONFIGURED';end if;
 perform net.http_post(url:='https://slowsixon.com/api/ppurio-worker',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),body:='{}'::jsonb,timeout_milliseconds:=60000);
end $$;
revoke all on function ss_admin.ppurio_dispatch() from public,anon,authenticated;
select cron.schedule('slowsix-alimtalk','* * * * *','select ss_admin.ppurio_dispatch()');
