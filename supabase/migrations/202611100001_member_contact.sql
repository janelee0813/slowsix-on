-- Expose the stored phone only in the existing administrator-only member list.
begin;
do $migration$
declare
  definition text := pg_get_functiondef('ss_admin.gateway_before_alimtalk(text,jsonb)'::regprocedure);
  old_columns constant text := 'profile.age_group,profile.purposes,profile.version from ss_admin.members profile';
  new_columns constant text := 'profile.age_group,profile.purposes,profile.version,profile.phone from ss_admin.members profile';
begin
  if strpos(definition, new_columns) > 0 then
    return;
  end if;
  if strpos(definition, old_columns) = 0 then
    raise exception 'Unexpected membership list definition';
  end if;
  execute replace(definition, old_columns, new_columns);
end
$migration$;
commit;
