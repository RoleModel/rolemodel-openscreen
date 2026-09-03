-- The team's shared tables.
--
-- Apply once, as the database owner:
--
--   psql "$OWNER_URL" -v studio_password="<new password>" -f sql/studio.sql
--
-- WHAT SECURES THIS
--
-- The `studio_app` role and its password, and nothing in the app. Every Studio
-- connects as that role; it may read and write these three tables and nothing
-- else — no delete, no DDL, no other schema. The owner's login never leaves the
-- machine of the person applying this file.
--
-- The role's connection string is baked into each release by
-- .github/workflows/release.yml from the RM_DATABASE_URL secret, so whoever can
-- install a release can reach these tables. That is the deliberate trade: one
-- shared credential for a small team, no per-machine setup. Rotate it by
-- re-running this file with a new password and re-cutting a release.
--
-- There is no teams table, deliberately. Holding the release IS the boundary,
-- so "signed in" is attribution — whose rating this is — and not access.
--
-- `updated_by` is the GitHub login of whoever wrote the row, as text. Not a
-- foreign key to anything: there is no users table to point at, and a board
-- must not become unwritable because somebody left.

-- Storyboards: one row per project, the whole board as jsonb.
create table if not exists public.storyboards (
  project_id  text primary key,
  board       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- Team settings: a handful of small jsonb values keyed by a short string.
--
-- SECURITY NOTE: a Slack bot token stored here is readable by every Studio that
-- can reach the database. That is the point — one person sets it up, everyone
-- posts — and also the cost.
create table if not exists public.studio_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- Shared skills: the original zip plus the editable SKILL.md text.
create table if not exists public.studio_skills (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name          text not null,
  description   text,
  skill_md      text not null,
  bundle_base64 text not null,
  entry_path    text not null default 'SKILL.md',
  version       integer not null default 1 check (version > 0),
  created_by    text,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The brand collage generator's library: every picture made, and the teammates
-- whose photos can be placed in one. Pictures are also copied into the library's
-- Style folder on the machine that made them; `url` is where they came from.
create table if not exists public.style_images (
  id          uuid primary key default gen_random_uuid(),
  subject     text not null,
  prompt      text,
  model       text,
  aspect      text,
  url         text not null,
  file        text,
  -- The project a picture was made in, and where it landed there. Any Studio
  -- that opens the project copies the picture into place if it is missing.
  project_id  text,
  project_rel text,
  created_by  text,
  created_at  timestamptz not null default now()
);
alter table public.style_images add column if not exists project_id text;
alter table public.style_images add column if not exists project_rel text;

create table if not exists public.style_people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  photo       text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);

-- The Creator's saved looks: a name and the look string that is the whole
-- design, plus a small preview the machine that saved it rendered.
create table if not exists public.looks (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  look          text not null,
  preview_file  text,
  project_id    text,
  created_by    text,
  created_at    timestamptz not null default now()
);

-- The role every Studio connects as. Created once; the password comes from the
-- psql variable so it is never written into this file. `\gexec` runs the
-- statement the select builds — a psql variable cannot be read inside a DO block.
select format('create role studio_app login password %L', :'studio_password')
  where not exists (select 1 from pg_roles where rolname = 'studio_app') \gexec
select format('alter role studio_app with login password %L', :'studio_password')
  where exists (select 1 from pg_roles where rolname = 'studio_app') \gexec

-- What the role may reach at all. No `delete` on the boards, settings or
-- skills — nothing in the app deletes those, so the role cannot either.
grant usage on schema public to studio_app;
grant select, insert, update on public.storyboards     to studio_app;
grant select, insert, update on public.studio_settings to studio_app;
grant select, insert, update on public.studio_skills   to studio_app;
-- The one exception to "no delete": a bad generation is noise in a shared
-- library, and a teammate who left should be removable from the people list.
grant select, insert, update, delete on public.style_images to studio_app;
grant select, insert, update, delete on public.style_people to studio_app;
grant select, insert, update, delete on public.looks to studio_app;
