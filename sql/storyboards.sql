-- Shared storyboards. Paste this once into the Supabase SQL editor and run it.
-- Running it twice is safe.
--
-- WHAT SECURES THIS
--
-- Row-level security, and the fact that the Supabase project is the boundary.
-- Only people you invite can have an account here, so "signed in" and "on the
-- team" are the same statement — which is why there is no teams table.
--
-- An earlier version had `teams` and `team_members` and a membership function.
-- That is the right shape for a product with many customers and the wrong shape
-- for one company's tool: it bought nothing over `to authenticated` and cost a
-- uuid somebody had to copy out of the database and paste into a config file
-- before anything worked at all.
--
-- If this ever does serve two clients who must not see each other's boards, add
-- the team column back — but add it because that day arrived, not in advance.
--
-- `board` is one jsonb column rather than normalised tables because the merge is
-- arithmetic that has to match `mergeBoards` in lib/storyboard.mjs exactly.
-- Splitting ratings into their own table would put a second, subtly different
-- merge in SQL, where it could not be tested against the first. Postgres stores
-- an already-merged document; it does not do the merging.
--
-- Never give the Studio a secret key (`sb_secret_…`, formerly `service_role`).
-- It bypasses every policy below. The Studio uses the publishable key, which
-- grants nothing on its own.

create table if not exists public.storyboards (
  project_id  text primary key,
  board       jsonb not null,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

alter table public.storyboards enable row level security;

-- `to authenticated` is the whole access model: it excludes the anon role, so
-- the publishable key on its own reaches nothing. Somebody must have signed in.
drop policy if exists storyboards_read on public.storyboards;
create policy storyboards_read on public.storyboards
  for select to authenticated using (true);

drop policy if exists storyboards_insert on public.storyboards;
create policy storyboards_insert on public.storyboards
  for insert to authenticated with check (true);

drop policy if exists storyboards_update on public.storyboards;
create policy storyboards_update on public.storyboards
  for update to authenticated using (true) with check (true);

-- No delete policy, so no delete. That is the correct default for the only copy
-- of a record of decisions, and the Studio never asks to remove one.

-- ── check it ──
--
-- The policy is not tested until it has REFUSED something. With the publishable
-- key and nobody signed in, this must come back empty — not an error: PostgREST
-- reports an RLS refusal as an empty result, so "no rows" is what a working
-- policy looks like from outside.
--
--   curl "$SUPABASE_URL/rest/v1/storyboards?select=project_id" -H "apikey: $KEY"
