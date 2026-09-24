// GET /api/leaderboard?board=best|total|level|words
//   best  (default) -> { board, entries: [{ rank, name, score }] }
//   total           -> { board, entries: [{ rank, name, total, games }] }
//   level           -> { board, entries: [{ rank, name, level, score }] }
//   words           -> { board, entries: [{ rank, name, words, score }] }
// Public, no login, one row per name, cached briefly at the edge.

import { endpoint, HttpError } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

const LIMIT = 100;

const BOARDS = {
  best: {
    query: `wordrain_leaderboard_best?select=name,score&order=score.desc,created_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, score: r.score }),
  },
  total: {
    query: `wordrain_leaderboard_total?select=name,total,games&order=total.desc,games.asc,last_at.asc&limit=${LIMIT}`,
    // bigint sums arrive as numbers well within range for this game.
    row: (r) => ({ name: r.name, total: Number(r.total), games: r.games }),
  },
  level: {
    query: `wordrain_leaderboard_level?select=name,level,score&order=level.desc,score.desc,created_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, level: r.level, score: r.score }),
  },
  words: {
    query: `wordrain_leaderboard_words?select=name,words,score&order=words.desc,score.desc,created_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, words: r.words, score: r.score }),
  },
};

export default endpoint("GET", async ({ req, res }) => {
  const board = req.query?.board ?? "best";
  const spec = BOARDS[board];
  if (!spec) throw new HttpError(400, "bad_board", "board is best, total, level or words.");

  const rows = await rest(spec.query);
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  return { board, entries: (rows ?? []).map((r, i) => ({ rank: i + 1, ...spec.row(r) })) };
});
