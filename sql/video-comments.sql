-- Notes on shared videos, for the published share pages and the Studio.
--
-- Run as the database owner, once:
--   psql "$OWNER_URL" -f sql/video-comments.sql
--
-- The same shape as sticker_comments, plus the moment: `at_ms` is where in the
-- video the note belongs, or null for a note about the whole thing. Anyone with
-- the page's address reads and adds through the Data API as the anonymous
-- role; nothing is changed or removed from there.
create table if not exists public.video_comments (
  id          uuid primary key default gen_random_uuid(),
  project     text not null,
  video       text not null,
  at_ms       integer,
  author      text,
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint video_comments_body_size check (char_length(body) between 1 and 2000),
  constraint video_comments_author_size check (author is null or char_length(author) <= 80),
  constraint video_comments_at check (at_ms is null or at_ms >= 0)
);
create index if not exists video_comments_video on public.video_comments (project, video, created_at);

grant usage on schema public to studio_app;
grant select, insert, delete on public.video_comments to studio_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    grant usage on schema public to anonymous;
    grant select, insert on public.video_comments to anonymous;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema public to authenticated;
    grant select, insert on public.video_comments to authenticated;
  end if;
end $$;

alter table public.video_comments enable row level security;
drop policy if exists video_comments_read on public.video_comments;
create policy video_comments_read on public.video_comments for select using (true);
drop policy if exists video_comments_add on public.video_comments;
create policy video_comments_add on public.video_comments for insert with check (char_length(body) between 1 and 2000);
drop policy if exists video_comments_tidy on public.video_comments;
create policy video_comments_tidy on public.video_comments for delete to studio_app using (true);
