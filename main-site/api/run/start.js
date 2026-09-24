// POST /api/run/start  { client_key } -> { run_id, expires_in }
// Starts the server's clock on a game. A finished game can only be added to
// the leaderboard under a run, and its length is checked against the time
// the server saw pass since this call.

import { randomInt } from "node:crypto";
import { clientKey, endpoint } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { RUN_TTL_MS } from "../../js/rules.js";

export default endpoint("POST", async ({ body }) => {
  const key = clientKey(body.client_key);

  const [run] = await rest("wordrain_runs", {
    method: "POST",
    body: { client_key: key },
    prefer: "return=representation",
  });

  // Now and then, clear out runs nobody submitted.
  if (randomInt(50) === 0) rpc("wordrain_prune", {}).catch((err) => console.warn("prune failed:", err.message));

  return { run_id: run.id, expires_in: RUN_TTL_MS };
});
