-- Shared storyboards.
--
-- Apply this once, in the Supabase SQL editor, before turning sharing on in the
-- Studio. It is idempotent: running it twice is safe.
--
-- WHAT SECURES THIS
--
-- Row-level security, and nothing else. The Studio holds the anon key, which
-- Supabase designs to be public — it identifies the project, not the caller, and
-- it grants nothing on its own. Every decision about who may read or write a
-- board is below, enforced by Postgres, where the client cannot reach it.
--
-- That is why `board` is one jsonb column rather than normalised tables. The
-- merge is arithmetic that has to match `mergeBoards` in lib/storyboard.mjs
-- exactly, and splitting ratings into their own table would put a second,
-- subtly different merge in SQL — where it could not be tested against the
-- first. Postgres stores an already-merged document; it does not do the merging.
--
-- NEVER give the Studio a service_role key. It bypasses every policy here.

-- ─────────────────────────── teams ───────────────────────────

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Membership is the whole access model: you can see a board if you are on the
-- team that owns it. One row per person per team.
create table if not exists public.team_members (
  team_id     uuid not null references public.teams(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'member' check (role in ('member', 'admin')),
  created_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- ─────────────────────────── boards ───────────────────────────

create table if not exists public.storyboards (
  project_id  text primary key,
  team_id     uuid not null references public.teams(id) on delete cascade,
  board       jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists storyboards_team_idx on public.storyboards(team_id);

-- ─────────────────────────── policies ───────────────────────────

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.storyboards  enable row level security;

-- Membership, without recursion.
--
-- The obvious policy on team_members — "you may read rows for teams you are a
-- member of" — queries team_members from inside a team_members policy, and
-- Postgres refuses it as infinite recursion. A security-definer function reads
-- the table with RLS suspended, which is safe here because it answers exactly
-- one question about exactly one caller and returns no rows.
create or replace function public.is_team_member(team uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = team and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_team_member(uuid) from public;
grant execute on function public.is_team_member(uuid) to authenticated;

-- You can see your own memberships, and nobody else's.
drop policy if exists team_members_self on public.team_members;
create policy team_members_self on public.team_members
  for select to authenticated
  using (user_id = auth.uid());

-- You can see a team you belong to.
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select to authenticated
  using (public.is_team_member(id));

-- The one that matters: a board is readable and writable by the team that owns
-- it, and by nobody else. `to authenticated` excludes the anon role outright, so
-- the public key alone reaches nothing.
drop policy if exists storyboards_read on public.storyboards;
create policy storyboards_read on public.storyboards
  for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists storyboards_insert on public.storyboards;
create policy storyboards_insert on public.storyboards
  for insert to authenticated
  with check (public.is_team_member(team_id));

-- `using` AND `with check` on update, deliberately: `using` decides which rows
-- you may change, `with check` decides what they may become. Without the second,
-- a member of team A could update a board they can see and set team_id to team
-- B — moving a board into a team they do not belong to, which is a write they
-- should not have and a board team B did not ask for.
drop policy if exists storyboards_update on public.storyboards;
create policy storyboards_update on public.storyboards
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id));

-- Deleting a board is not something the Studio does. No policy means no delete,
-- which is the correct default for the only copy of a record of decisions.

-- ─────────────────────────── setup ───────────────────────────
--
-- Run once, with your own values:
--
--   insert into public.teams (name) values ('RoleModel') returning id;
--
-- then, for each person (their user_id is in Authentication → Users after they
-- have signed up):
--
--   insert into public.team_members (team_id, user_id)
--   values ('<team-id>', '<user-id>');
--
-- Put the team id into the Studio alongside the project URL and anon key.
--
-- ─────────────────────────── check it ───────────────────────────
--
-- The policy is not tested until it has REFUSED something. With two accounts,
-- one on the team and one not, the second must get zero rows — not an error:
-- PostgREST reports an RLS refusal as an empty result, so "no rows" is what a
-- working policy looks like from outside.
--
--   select * from public.storyboards;   -- as a non-member: 0 rows
