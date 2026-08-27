-- Shared Studio skills. Apply this after sql/storyboards.sql.
--
-- Each row keeps the original .zip so the skill's supporting scripts,
-- references, and assets reach every Studio install. `skill_md` is the editable
-- instruction file; the app writes it over the archived SKILL.md at runtime.
-- The publishable key is safe to ship, but RLS ensures it is useless until a
-- teammate has signed in. Do not use a service-role key in Studio.

create table if not exists public.studio_skills (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text not null,
  description text,
  skill_md text not null,
  bundle_base64 text not null,
  entry_path text not null default 'SKILL.md',
  version integer not null default 1 check (version > 0),
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_skills enable row level security;

revoke all on table public.studio_skills from anon;
grant select, insert, update on table public.studio_skills to authenticated;

drop policy if exists studio_skills_read on public.studio_skills;
create policy studio_skills_read on public.studio_skills
  for select to authenticated using (true);

drop policy if exists studio_skills_insert on public.studio_skills;
create policy studio_skills_insert on public.studio_skills
  for insert to authenticated with check (created_by = auth.uid() and updated_by = auth.uid());

drop policy if exists studio_skills_update on public.studio_skills;
create policy studio_skills_update on public.studio_skills
  for update to authenticated using (true) with check (updated_by = auth.uid());
