-- Shared Studio settings. Apply this after sql/storyboards.sql.
-- Paste it once into the Supabase SQL editor and run it. Running it twice is safe.
--
-- WHAT THIS IS FOR
--
-- Connection details that belong to the team rather than to a laptop. The Slack
-- bot token is the first: it is one credential for one workspace, and keeping it
-- in `~/.config` meant every person set it up again, and a machine that was
-- reimaged lost it.
--
-- WHAT SECURES THIS
--
-- The same model as storyboards: row-level security, `to authenticated`, and the
-- Supabase project as the boundary. Only people you invite can have an account,
-- so "signed in" and "on the team" are the same statement.
--
-- READ THIS BEFORE STORING A TOKEN HERE
--
-- A Slack bot token in this table is readable by every signed-in teammate. That
-- is the point — it is how the setting persists for other people — but it means
-- the blast radius of one compromised Studio account now includes posting to
-- Slack as the app. That is an acceptable trade for a `files:write` +
-- `chat:write` bot scoped to one channel, and it would NOT be acceptable for a
-- token that could read message history or administer the workspace. Keep the
-- app's scopes to what lib/slack.mjs actually calls.
--
-- The local 0600 file remains the fallback and the override: a value in the
-- environment or in ~/.config wins over this table, so one person can point at a
-- different channel without changing it for everybody.
--
-- Never give the Studio a secret key (`sb_secret_…`, formerly `service_role`).
-- It bypasses every policy below. The Studio uses the publishable key, which
-- grants nothing on its own.

create table if not exists public.studio_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

alter table public.studio_settings enable row level security;

-- `to authenticated` is the whole access model: it excludes the anon role, so
-- the publishable key on its own reaches nothing. Somebody must have signed in.
drop policy if exists studio_settings_read on public.studio_settings;
create policy studio_settings_read on public.studio_settings
  for select to authenticated using (true);

drop policy if exists studio_settings_insert on public.studio_settings;
create policy studio_settings_insert on public.studio_settings
  for insert to authenticated with check (true);

drop policy if exists studio_settings_update on public.studio_settings;
create policy studio_settings_update on public.studio_settings
  for update to authenticated using (true) with check (true);
