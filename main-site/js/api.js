// Calls to the leaderboard API. The game itself runs in the page and works
// offline; only runs and the leaderboard need the network.

const KEY_STORAGE = "wordrain.clientKey";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A random id tying this browser's requests to its own runs. Not an
// identity: it grants nothing and is never shown.
function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let memoryKey = null;

export function clientKey() {
  try {
    let key = localStorage.getItem(KEY_STORAGE);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key ?? "")) {
      key = makeKey();
      localStorage.setItem(KEY_STORAGE, key);
    }
    return key;
  } catch {
    // Storage blocked: runs still work for this page view.
    memoryKey ??= makeKey();
    return memoryKey;
  }
}

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "This needs a connection.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from the platform, or the service worker's
    // offline reply, not the API.
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? "server", data?.message);
  }
  return data;
}

export const api = {
  startRun: () => call("POST", "/api/run/start", { client_key: clientKey() }),
  checkName: (name) => call("POST", "/api/leaderboard/name", { name }),
  submit: (runId, name, result) =>
    call("POST", "/api/leaderboard/submit", {
      run_id: runId,
      client_key: clientKey(),
      name,
      score: result.score,
      level: result.level,
      words: result.words,
      misses: result.misses,
      duration_ms: result.durationMs,
    }),
  leaderboard: (board) => call("GET", `/api/leaderboard?board=${encodeURIComponent(board)}`),
};
