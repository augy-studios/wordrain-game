-- Word Rain leaderboard schema, in the shared uwuapps Supabase project.
-- Paste into the Supabase SQL editor and run once.
-- Safe to run again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions in main-site/api touch these
-- tables, with the service role key. There is no Supabase Auth here. RLS is
-- on with no policies, so an anon key reads nothing.
--
-- The game itself runs in the browser. What the server holds is a run: the
-- moment a game started, by the server's clock, and whether it has been
-- submitted. A finished game's numbers are checked against that start time
-- by the API (js/rules.js) before submit is called.

-- One run is one game. Created by POST /api/run/start when a game begins.
create table if not exists wordrain_runs (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  submitted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists wordrain_runs_created
  on wordrain_runs (created_at);

-- One row per submitted game.
create table if not exists wordrain_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null check (score >= 0),
  level int not null check (level >= 1),
  words int not null check (words >= 0),
  misses int not null check (misses >= 0),
  duration_ms int not null check (duration_ms >= 0),
  run_id uuid not null unique references wordrain_runs(id),
  created_at timestamptz not null default now()
);

create index if not exists wordrain_lb_name
  on wordrain_leaderboard (lower(name));

-- The four boards. One row per name, names compared case-insensitively.

-- Each name's best score. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view wordrain_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, created_at
from wordrain_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game's score added up. The casing shown is the name's most
-- recent submission. Ties go to fewer games, then to whoever got there
-- first, which is the earlier last_at.
create or replace view wordrain_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(created_at) as last_at
from wordrain_leaderboard
group by lower(name);

-- Each name's furthest level. Ties go to the higher score in that game,
-- then to whoever got it first.
create or replace view wordrain_leaderboard_level
with (security_invoker = true) as
select distinct on (lower(name)) name, level, score, created_at
from wordrain_leaderboard
order by lower(name), level desc, score desc, created_at asc;

-- Each name's most words in one game. Ties as for level.
create or replace view wordrain_leaderboard_words
with (security_invoker = true) as
select distinct on (lower(name)) name, words, score, created_at
from wordrain_leaderboard
order by lower(name), words desc, score desc, created_at asc;

alter table wordrain_runs enable row level security;
alter table wordrain_leaderboard enable row level security;

-- Submits a finished game under a name and numbers the API has already
-- checked. Repeats the checks that depend on the run row under a lock, so
-- two submits at once cannot both go through. The slack and time to live
-- come from js/rules.js, so they are set in one place.
--
-- Returns the name's standing on all four boards.
create or replace function wordrain_submit(
  p_run_id uuid,
  p_client_key text,
  p_name text,
  p_score int,
  p_level int,
  p_words int,
  p_misses int,
  p_duration_ms int,
  p_slack_ms int,
  p_ttl_ms int
)
returns table (
  status text,
  best_score int,
  best_rank bigint,
  total bigint,
  games int,
  total_rank bigint,
  best_level int,
  level_rank bigint,
  best_words int,
  words_rank bigint
)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_run wordrain_runs%rowtype;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
  v_level int;
  v_level_score int;
  v_level_at timestamptz;
  v_words int;
  v_words_score int;
  v_words_at timestamptz;
begin
  select * into v_run
  from wordrain_runs r
  where r.id = p_run_id and r.client_key = p_client_key
  for update;

  if not found then
    status := 'not_found';
    return next;
    return;
  end if;
  if v_run.submitted then
    status := 'already_submitted';
    return next;
    return;
  end if;
  if v_run.created_at < now() - make_interval(secs => p_ttl_ms / 1000.0) then
    status := 'expired';
    return next;
    return;
  end if;
  -- A game cannot have lasted longer than the server has known about it.
  if p_duration_ms > extract(epoch from (now() - v_run.created_at)) * 1000 + p_slack_ms then
    status := 'implausible';
    return next;
    return;
  end if;

  update wordrain_runs r set submitted = true where r.id = p_run_id;
  insert into wordrain_leaderboard (name, score, level, words, misses, duration_ms, run_id)
  values (p_name, p_score, p_level, p_words, p_misses, p_duration_ms, p_run_id);

  select l.score, l.created_at into v_best, v_best_at
  from wordrain_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from wordrain_leaderboard l
  where lower(l.name) = lower(p_name);

  select l.level, l.score, l.created_at into v_level, v_level_score, v_level_at
  from wordrain_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.level desc, l.score desc, l.created_at asc
  limit 1;

  select l.words, l.score, l.created_at into v_words, v_words_score, v_words_at
  from wordrain_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.words desc, l.score desc, l.created_at asc
  limit 1;

  status := 'ok';
  best_score := v_best;
  best_rank := (
    select count(*) + 1
    from wordrain_leaderboard_best b
    where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
  );
  total := v_total;
  games := v_games;
  total_rank := (
    select count(*) + 1
    from wordrain_leaderboard_total t
    where lower(t.name) <> lower(p_name)
      and (
        t.total > v_total
        or (t.total = v_total and t.games < v_games)
        -- This name's total was only just reached, so an equal one got there first.
        or (t.total = v_total and t.games = v_games)
      )
  );
  best_level := v_level;
  level_rank := (
    select count(*) + 1
    from wordrain_leaderboard_level b
    where b.level > v_level
      or (b.level = v_level and b.score > v_level_score)
      or (b.level = v_level and b.score = v_level_score and b.created_at < v_level_at)
  );
  best_words := v_words;
  words_rank := (
    select count(*) + 1
    from wordrain_leaderboard_words b
    where b.words > v_words
      or (b.words = v_words and b.score > v_words_score)
      or (b.words = v_words and b.score = v_words_score and b.created_at < v_words_at)
  );
  return next;
end;
$$;

-- Housekeeping, called now and then by /api/run/start: runs nobody
-- submitted that are past any use.
create or replace function wordrain_prune()
returns void
language sql
volatile
as $$
  delete from wordrain_runs r
  where r.created_at < now() - interval '1 day'
    and not r.submitted
    and not exists (select 1 from wordrain_leaderboard l where l.run_id = r.id);
$$;

-- Service role only.
revoke all on function wordrain_submit(uuid, text, text, int, int, int, int, int, int, int) from public, anon, authenticated;
revoke all on function wordrain_prune() from public, anon, authenticated;
grant execute on function wordrain_submit(uuid, text, text, int, int, int, int, int, int, int) to service_role;
grant execute on function wordrain_prune() to service_role;
