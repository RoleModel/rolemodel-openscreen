-- Comments on stickers, for the Studio and for the published sheet pages.
--
-- Run as the database owner, once:
--   psql "$OWNER_URL" -f sql/sticker-comments.sql
--
-- Two readers: the Studio, as studio_app; and the published page, through
-- Neon's Data API, as the anonymous role — anyone with the page's address.
-- Row-level security keeps the anonymous side to reading everything and
-- adding a comment of sane size; nothing is updated or removed from there.
create table if not exists public.sticker_comments (
  id          uuid primary key default gen_random_uuid(),
  project     text not null,
  sticker     text not null,
  author      text,
  body        text not null,
  created_at  timestamptz not null default now(),
  constraint sticker_comments_body_size check (char_length(body) between 1 and 2000),
  constraint sticker_comments_author_size check (author is null or char_length(author) <= 80)
);
create index if not exists sticker_comments_sticker on public.sticker_comments (project, sticker, created_at);

grant usage on schema public to studio_app;
grant select, insert, delete on public.sticker_comments to studio_app;

-- The Data API's roles. Created by Neon when the Data API is turned on; the
-- `do` block keeps this file runnable before that, when they do not exist yet.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    grant usage on schema public to anonymous;
    grant select, insert on public.sticker_comments to anonymous;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema public to authenticated;
    grant select, insert on public.sticker_comments to authenticated;
  end if;
end $$;

alter table public.sticker_comments enable row level security;
drop policy if exists sticker_comments_read on public.sticker_comments;
create policy sticker_comments_read on public.sticker_comments for select using (true);
drop policy if exists sticker_comments_add on public.sticker_comments;
create policy sticker_comments_add on public.sticker_comments for insert with check (char_length(body) between 1 and 2000);
drop policy if exists sticker_comments_tidy on public.sticker_comments;
create policy sticker_comments_tidy on public.sticker_comments for delete to studio_app using (true);
