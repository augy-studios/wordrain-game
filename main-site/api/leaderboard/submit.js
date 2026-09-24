// POST /api/leaderboard/submit
//   { run_id, client_key, name, score, level, words, misses, duration_ms }
//   -> { name, best_score, best_rank, total, games, total_rank,
//        best_level, level_rank, best_words, words_rank }
//
// The game runs in the browser, so unlike a server-held round the numbers
// here come from the page. They are checked against the run's server-side
// start time with the rules in js/rules.js, the same module the game plays
// by. That bounds cheating; it does not prevent it.

import { clientKey, endpoint, HttpError, runId } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest, rpc } from "../_lib/supabase.js";
import { checkResult, CLOCK_SLACK_MS, RUN_TTL_MS } from "../../js/rules.js";

const REFUSALS = {
  not_found: [404, "That game is not one this browser started."],
  already_submitted: [409, "That game is already on the leaderboard."],
  expired: [410, "That game is more than three hours old."],
  implausible: [422, "That game's numbers do not add up, so it was not added."],
};

const refuse = (reason) => {
  const [status, message] = REFUSALS[reason] ?? [500, "Could not submit."];
  return new HttpError(status, REFUSALS[reason] ? reason : "server", message);
};

export default endpoint("POST", async ({ body }) => {
  const id = runId(body.run_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const result = {
    score: body.score,
    level: body.level,
    words: body.words,
    misses: body.misses,
    durationMs: body.duration_ms,
  };

  const [run] =
    (await rest(
      `wordrain_runs?select=created_at,submitted&id=eq.${id}&client_key=eq.${encodeURIComponent(key)}&limit=1`
    )) ?? [];
  if (!run) throw refuse("not_found");
  if (run.submitted) throw refuse("already_submitted");

  const elapsed = Date.now() - Date.parse(run.created_at);
  if (elapsed > RUN_TTL_MS) throw refuse("expired");

  const reason = checkResult(result, elapsed);
  if (reason) {
    // The reason stays in the logs. Telling the caller which bound it hit
    // would only help tune the next attempt.
    console.warn(`implausible run ${id}: ${reason}`, result, { elapsed });
    throw refuse("implausible");
  }

  // The function repeats the ownership, submitted, expiry and timing checks
  // under a row lock, so two submits at once cannot both go through.
  const [row] =
    (await rpc("wordrain_submit", {
      p_run_id: id,
      p_client_key: key,
      p_name: name,
      p_score: result.score,
      p_level: result.level,
      p_words: result.words,
      p_misses: result.misses,
      p_duration_ms: result.durationMs,
      p_slack_ms: CLOCK_SLACK_MS,
      p_ttl_ms: RUN_TTL_MS,
    })) ?? [];
  if (row?.status !== "ok") throw refuse(row?.status);

  return {
    name,
    best_score: row.best_score,
    best_rank: Number(row.best_rank),
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
    best_level: row.best_level,
    level_rank: Number(row.level_rank),
    best_words: row.best_words,
    words_rank: Number(row.words_rank),
  };
});
