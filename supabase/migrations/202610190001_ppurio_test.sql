-- One-time administrator-authorized test only. Contains no recipient or booking data.
create table if not exists public.ss_ppurio_test_runs (
 id text primary key,
 state text not null check (state in ('attempted','accepted','rejected','unknown')),
 provider_code text,
 message_key text,
 created_at timestamptz not null default now()
);
alter table public.ss_ppurio_test_runs enable row level security;
revoke all on public.ss_ppurio_test_runs from public, anon, authenticated;
grant select, insert, update on public.ss_ppurio_test_runs to service_role;
