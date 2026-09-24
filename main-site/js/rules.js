// Word Rain's rules. Shared by the game (js/game.js) and the leaderboard API
// (api/leaderboard/submit.js), so a score the server checks was made under
// the same rules the page plays by. Pure: no DOM, no fetch, no storage.

import { LONG_FROM, longChanceAt, longestAt } from "./words.js";

export const LEVEL_SECONDS = 20;

export const WATER_PER_MISS = 0.025;
export const WATER_PER_HIT = 0.05;
export const DOUBLE_MISS_WEIGHT = 1.3;
export const DOUBLE_HIT_WEIGHT = 1.25;

// The water shown eases toward where the misses and hits put it, and the
// game ends once that is full and the water shown is this close to the top.
export const WATER_EASE_SECONDS = 0.8;
export const WATER_FULL = 0.995;

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

// Where the water is headed after a drop is popped or lands. The server
// replays a game through this same function, so the two agree to the bit.
export function waterAfter(water, hit, isDouble) {
  const change = hit
    ? -WATER_PER_HIT * (isDouble ? DOUBLE_HIT_WEIGHT : 1)
    : WATER_PER_MISS * (isDouble ? DOUBLE_MISS_WEIGHT : 1);
  return clamp(water + change, 0, 1);
}

/* ---- Checking a finished game (server side) ---- */

// A leaderboard run can be submitted for this long after it started.
export const RUN_TTL_MS = 3 * 60 * 60 * 1000;

// The fewest misses that can fill the water: no hits at all, every miss a
// double. A game submitted with fewer did not end.
export const MIN_MISSES_TO_END = Math.ceil(1 / (WATER_PER_MISS * DOUBLE_MISS_WEIGHT));

// Sustained typing well past the world record, with a burst of a few words
// on top for a quick run of short ones or a swiped word.
export const MAX_CHARS_PER_SECOND = 20;
export const TYPING_BURST_CHARS = 30;

// Nobody sees a word and starts typing it quicker than this, or types a
// single word faster than this burst. A word popped sooner after it
// appeared than both together is quick, and a game may have only a few
// quick ones: a lucky swipe or a phone's suggestion, not the steady pace of
// a bot, which finishes a seven letter word a fifth of a second after it
// appears, where this allows a third.
export const MIN_REACTION_MS = 100;
export const BURST_CHARS_PER_SECOND = 30;
export const QUICK_POPS_ALLOWED = 3;
export const QUICK_POPS_SHARE = 0.05;

// The longest the water shown can take to reach WATER_FULL once the misses
// have filled it, rising from empty, with room for a slow last frame. Full
// for longer than this and the game would already have ended.
export const FILL_MS = Math.ceil(WATER_EASE_SECONDS * Math.log(1 / (1 - WATER_FULL)) * 1000) + 500;

// How far past its expected count a run of doubles or long words may go
// before it is too lucky to be dealt: this many standard deviations, plus a
// few for short games. Legitimate games essentially never reach it.
const LUCK_SD = 4;
const LUCK_SLACK = 3;

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

const isFlag = (n) => n === 0 || n === 1;

// null when a finished game could have come from real play in the time the
// server saw pass, or a short reason when it could not.
//
// `log` is every drop that was popped or landed, in order, as
// [ms it spawned, ms it went, word, hit 0 or 1, double 0 or 1], in ms into
// the game. The game keeps it (js/game.js) and the server replays it here:
// the score, words and misses must be exactly what the log adds up to,
// every word must be one the game could have dealt when it did, the water
// must have filled only at the end, no one types faster than
// MAX_CHARS_PER_SECOND for long or reacts quicker than MIN_REACTION_MS more
// than now and then, and doubles and long words must not come up more often
// than chance allows.
//
// Bounds cheating rather than preventing it: a patient cheat who forges a
// log of plausible play gets through. What they cannot do any more is claim
// a score no human could have made.
export function checkResult({ score, level, words, misses, durationMs }, log, elapsedMs, isWord) {
  for (const n of [score, level, words, misses, durationMs]) {
    if (!Number.isInteger(n) || n < 0) return "bad_numbers";
  }
  if (durationMs > elapsedMs + CLOCK_SLACK_MS) return "too_long";
  if (misses < MIN_MISSES_TO_END) return "not_finished";

  const seconds = durationMs / 1000;
  if (Math.abs(level - levelAt(seconds)) > 1) return "wrong_level";
  if (words + misses > maxSpawns(durationMs) + 2) return "too_many_drops";
  if (!Array.isArray(log) || log.length !== words + misses) return "bad_log";

  const tally = { score: 0, words: 0, misses: 0 };
  const doubles = { seen: 0, expected: 0, variance: 0 };
  const longs = { seen: 0, expected: 0, variance: 0 };
  const expect = (luck, p, seen) => {
    luck.seen += seen;
    luck.expected += p;
    luck.variance += p * (1 - p);
  };
  let water = 0;
  let fullSince = null;
  let typed = 0; // characters in the bucket, draining at MAX_CHARS_PER_SECOND
  let quick = 0;
  let prev = 0;

  for (const entry of log) {
    if (!Array.isArray(entry) || entry.length !== 5) return "bad_log";
    const [spawned, t, word, hit, dbl] = entry;
    if (!Number.isInteger(spawned) || !Number.isInteger(t) || spawned < 0 || spawned > t) return "bad_log";
    if (t < prev || t > durationMs || !isFlag(hit) || !isFlag(dbl)) return "bad_log";
    if (typeof word !== "string" || !isWord(word)) return "unknown_word";

    const at = t / 1000;
    const lvl = levelAt(at);
    // A drop's word and double are settled when it spawns. Both only get
    // likelier as the game goes on, so a spawn time claimed later than the
    // real one gains nothing that the time it went would not allow.
    const born = spawned / 1000;
    if (word.length > longestAt(born)) return "word_too_long";
    expect(doubles, doubleChance(born, levelAt(born)), dbl);
    expect(longs, longChanceAt(born), word.length >= LONG_FROM ? 1 : 0);

    if (fullSince !== null && t - fullSince > FILL_MS) return "should_have_ended";

    typed = Math.max(0, typed - ((t - prev) / 1000) * MAX_CHARS_PER_SECOND);
    if (hit) {
      // Every letter of a popped word was typed after the one before it
      // popped, since popping clears the typing box.
      typed += word.length;
      if (typed > TYPING_BURST_CHARS) return "typed_too_fast";
      if (t - spawned < MIN_REACTION_MS + (word.length * 1000) / BURST_CHARS_PER_SECOND) quick += 1;
      tally.words += 1;
      tally.score += wordScore(word.length, dbl === 1, lvl);
    } else {
      tally.misses += 1;
    }

    water = waterAfter(water, hit === 1, dbl === 1);
    fullSince = water >= 1 ? fullSince ?? t : null;
    prev = t;
  }

  if (fullSince === null) return "not_finished";
  if (durationMs - fullSince > FILL_MS) return "should_have_ended";
  if (tally.score !== score || tally.words !== words || tally.misses !== misses) return "log_mismatch";
  if (quick > QUICK_POPS_ALLOWED + QUICK_POPS_SHARE * words) return "reacted_too_fast";

  for (const [luck, reason] of [[doubles, "too_many_doubles"], [longs, "too_many_long_words"]]) {
    if (luck.seen > luck.expected + LUCK_SD * Math.sqrt(luck.variance) + LUCK_SLACK) return reason;
  }

  return null;
}
