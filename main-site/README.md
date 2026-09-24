# main-site

What Vercel deploys, served at <https://wordrain.uwuapps.org>. No build step:
these files are served as they are, and `api/` holds the serverless
functions.

| Path | What it is |
|---|---|
| `index.html` | The game page. Its `<head>` is the template every other page copies. |
| `404.html`, `404.css` | Not-found page, still on the template's own styles. |
| `sw.js` | Service worker: offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `wordlist.json` | The words, bucketed by length: `{ "4": [...], "5": [...] }`. A flat `{ "words": [...] }` works too. |
| `api/` | The leaderboard API, below. Vercel does not route `api/_lib/`. |
| `css/` | `theme.css` is the uwuapps theme system verbatim; `style.css` is this app's layout. |
| `js/` | ES modules. `app.js` is the entry point; every file must be in `PRECACHE` in `sw.js`. `rules.js` is also imported by `api/`, so keep it free of anything browser only. |
| `fonts/` | Jua, self-hosted, with its licence. |
| `images/` | Manifest screenshots. |

**The game screen:** the game starts as soon as the page opens. Words fall on
teardrops; typing the start of one rings it, and finishing it pops it. Level,
misses and score float top left. The pause button floats top right, and under
it a tray of leaderboard, settings and theme buttons that slides off the edge
behind an arrow tab. The typing box floats at the bottom, with a button to
clear it. On phones and tablets an on-screen keyboard takes the bottom of the
screen, the typing box moves into its head, and drops stop at its top edge.

**Keys:** `1` pause, `2` restart, `Backspace` edit, `Esc` clear. Letters that
match no falling word are ignored, and the typing box shakes.

**Game over:** the finished game can be added to the leaderboard under a
name, which is remembered in this browser. Four boards: best score, total
points, highest level, and most words in one game.

**Settings**, kept in this browser's local storage:

| Setting | Default | What it does |
|---|---|---|
| Leaderboard name | not set | Checked by `/api/leaderboard/name`; also saved by every successful submit. |
| Add finished games automatically | off | Submits every finished game under the saved name. Needs a name; clearing it turns this off. |
| Ignore letters that match no word | on | Off, a wrong letter stays in the typing box until `Backspace` or `Esc`, as in the old game. |
| Splash effects | on | The splashes when a word pops or lands. Always off with reduced motion. |
| On-screen keyboard | auto | Auto shows it on phones and tablets; Always and Never override that. |

**Offline:** the page, its scripts, the word list and the font are precached,
so the game plays with no connection. The leaderboard needs the network, and
nothing under `/api/` is ever cached. A game that started offline cannot be
added, since its run never started. A game that started online and finished
offline keeps its Add button, and can be added once the connection is back.

**Updates:** a new service worker installs and waits. The update bar at the
top of the page offers Reload or Not now, and nothing reloads until the
player asks. See `update-bar-spec.md` at the repo root.

Bump `VERSION` in `sw.js` on every change to anything in this directory.

## Leaderboard API

All JSON. `client_key` is a random id the browser keeps in local storage; a
run can only be submitted with the key that started it.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/run/start` | `client_key` | `run_id, expires_in` |
| `POST /api/leaderboard/submit` | `run_id, client_key, name, score, level, words, misses, duration_ms` | the name's best, total, level and words, and its rank on each board |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` (default), `total`, `level` or `words` | `board, entries`, cached 30 s |

Errors are `{ "error": code, "message"? }`: `400` bad input, `404` no such
run for this browser, `409` already submitted, `410` run older than three
hours, `422` numbers real play could not have made. The numbers come from the
page, so submit checks them with `checkResult` in `js/rules.js` against the
run's server-side start time; the reason a game was refused goes to the logs,
not the caller. There is no login and there are no rate limits.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
