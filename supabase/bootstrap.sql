-- Run AFTER schema installation and Edge Function deployment.
-- Outputs a private one-use setup URL for slowsix. Never publish/copy it into chat.
-- Re-running revokes prior unused setup links. Does not modify an existing admin.
with disabled as (
 update ss_admin.links set revoked_at=now() where kind='bootstrap' and used_at is null returning id
), secret as (
 select encode(extensions.gen_random_bytes(32),'hex') as token
), created as (
 insert into ss_admin.links(token_hash,kind,expires_at)
 select encode(extensions.digest(token,'sha256'),'hex'),'bootstrap',now()+interval '24 hours' from secret
 where not exists(select 1 from ss_admin.people where role='admin') returning id
)
select 'https://slowsixon.com/admin.html#setup='||token as "관리자_비밀번호_설정_링크"
from secret where exists(select 1 from created);
