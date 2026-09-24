# Word Rain

Words fall like rain. Type each one before it reaches the water; every miss
raises the water, every word you pop lowers it, and the game ends when the
water reaches the top. Plays offline, with a physical keyboard or the
on-screen one on a phone.

Live at <https://wordrain.uwuapps.org>.

## What runs where

| Part | Runs on |
|---|---|
| `main-site/`, the PWA and the leaderboard API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `wordrain_*` tables | The shared uwuapps Supabase project |

The game itself runs entirely in the browser and needs no server. The server
is only for the leaderboard: it starts a clock when a game begins, and checks
a finished game's numbers against it before adding them.

## Layout

```
README.md
migrations/      SQL to run in the Supabase SQL editor
scripts/         pre-deploy checks
main-site/       the site Vercel deploys, including api/
```

The `uwuapps-*.md` and `update-bar-spec.md` files at the root are the specs
this is built to: the uwuapps theme system with time-based mode, and the
update prompt bar.

## First setup

1. Run every file in `migrations/`, in order, in the Supabase SQL editor.
2. On the Vercel project, set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, from
   the Supabase dashboard's Data API settings. See `main-site/.env.example`.
3. Put the word list at `main-site/wordlist.json`.
4. Deploy `main-site`.

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks:

```
node scripts/check-sw.mjs
node scripts/check-precache.mjs
node scripts/check-theme.mjs
```

## Leaderboard integrity

A browser game cannot prove its score. What the API does instead, in
`main-site/js/rules.js`, is refuse anything real play could not have made:

- a game longer than the time the server saw pass since its run started
- a game that did not end, with fewer misses than it takes to fill the water
- a level that does not match the game's length
- more words and misses than drops could have fallen in that time
- a score above what typing at 20 characters a second could earn

Each run can be submitted once, only from the browser that started it, and
only within three hours. This bounds cheating; it does not prevent it. A
cheat who scripts plausible numbers at a plausible pace gets through.
