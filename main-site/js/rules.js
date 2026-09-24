// Word Rain's rules. Shared by the game (js/game.js) and the leaderboard API
// (api/leaderboard/submit.js), so a score the server checks was made under
// the same rules the page plays by. Pure: no DOM, no fetch, no storage.

export const LEVEL_SECONDS = 20;

export const WATER_PER_MISS = 0.025;
export const WATER_PER_HIT = 0.05;
export const DOUBLE_MISS_WEIGHT = 1.3;
export const DOUBLE_HIT_WEIGHT = 1.25;

// The first drop of a game arrives this soon, rather than after a full
// spawn interval of looking at an empty screen.
export const FIRST_SPAWN_MS = 800;

/* Difficulty per input method. Fall speed is in play heights per second, not
   pixels per second, so a drop gives the same time to type it on a phone as
   on a monitor. The old fixed pixel speed gave a phone, whose play area sits
   above an on-screen keyboard, about a third of the time per word, which is
   why the water rose so quickly there. Touch also spawns less often at its
   fastest, since tapping keys is slower than typing. */
export const PROFILES = {
  keyboard: { fallSeconds: 36, spawnStartMs: 5000, spawnFloorMs: 500, spawnRamp: 1 },
  touch: { fallSeconds: 42, spawnStartMs: 5000, spawnFloorMs: 1400, spawnRamp: 0.6 },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function levelAt(seconds) {
  return 1 + Math.floor(seconds / LEVEL_SECONDS);
}

export function spawnIntervalMs(profile, seconds, level) {
  return Math.max(profile.spawnFloorMs, profile.spawnStartMs - profile.spawnRamp * (seconds * 20 + level * 80));
}

// How much faster than the base fall speed a drop spawned now falls.
export function speedMultiplier(seconds, level) {
  return 1 + (level - 1) * 0.1 + Math.min(0.5, seconds * 0.01);
}

// Chance a new drop is a double: twice the size, twice the points.
export function doubleChance(seconds, level) {
  return clamp(0.12 + seconds * 0.008 + level * 0.02, 0.12, 0.62);
}

export function levelMultiplier(level) {
  return 1 + (level - 1) * 0.2;
}

export function wordScore(length, isDouble, level) {
  return Math.floor(length * (isDouble ? 2 : 1) * levelMultiplier(level));
}

/* ---- Checking a finished game (server side) ---- */

// A leaderboard run can be submitted for this long after it started.
export const RUN_TTL_MS = 3 * 60 * 60 * 1000;

// The fewest misses that can fill the water: no hits at all, every miss a
// double. A game submitted with fewer did not end.
export const MIN_MISSES_TO_END = Math.ceil(1 / (WATER_PER_MISS * DOUBLE_MISS_WEIGHT));

// Generous upper bounds. Well past world record typing speed, and longer
// than any word in the list.
export const MAX_CHARS_PER_SECOND = 20;
export const MAX_WORD_LENGTH = 24;

// Vercel's clock and Supabase's, and a slow request, all in one allowance.
export const CLOCK_SLACK_MS = 15000;

// The most drops a game this long can have spawned: the keyboard schedule,
// which is the quicker one, from a first drop at zero. The game fires a
// spawn once the time since the last one reaches the interval at the time
// of firing, and the interval only shrinks, so each gap is solved for that
// rather than taken from where it started.
export function maxSpawns(durationMs) {
  const profile = PROFILES.keyboard;
  let at = 0;
  let count = 0;
  while (at <= durationMs && count < 100000) {
    count += 1;
    let gap = spawnIntervalMs(profile, at / 1000, levelAt(at / 1000));
    for (let i = 0; i < 20; i += 1) {
      const next = at + gap;
      const shorter = spawnIntervalMs(profile, next / 1000, levelAt(next / 1000));
      if (shorter >= gap) break;
      gap = shorter;
    }
    at += gap;
  }
  return count;
}

// null when a finished game's numbers could have come from real play in
// the time the server saw pass, or a short reason when they could not.
// Bounds cheating rather than preventing it: a patient cheat who types at
// a plausible pace for a plausible time gets through.
export function checkResult({ score, level, words, misses, durationMs }, elapsedMs) {
  for (const n of [score, level, words, misses, durationMs]) {
    if (!Number.isInteger(n) || n < 0) return "bad_numbers";
  }
  if (durationMs > elapsedMs + CLOCK_SLACK_MS) return "too_long";
  if (misses < MIN_MISSES_TO_END) return "not_finished";

  const seconds = durationMs / 1000;
  if (Math.abs(level - levelAt(seconds)) > 1) return "wrong_level";
  if (words + misses > maxSpawns(durationMs) + 2) return "too_many_drops";

  // Every word scores at most its length, doubled, times the level bonus of
  // the level it was popped in, which is never above the last one.
  const perChar = 2 * levelMultiplier(level);
  const byTyping = Math.floor(seconds * MAX_CHARS_PER_SECOND) * perChar;
  const byWords = words * MAX_WORD_LENGTH * perChar;
  if (score > Math.min(byTyping, byWords)) return "score_too_high";

  return null;
}
