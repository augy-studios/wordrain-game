// Choosing the next falling word: first its length, then the word itself.
// Pure, with the random source passed in, so it can be tried out in Node.

// Used when wordlist.json cannot be loaded. Big enough, and spread across
// enough lengths, that the no-repeat rules below still have room to work.
export const FALLBACK_WORDS = [
  "rain", "mist", "wind", "hail", "snow", "pond", "wave", "tide", "leaf", "moss", "reed", "fern",
  "lake", "pool", "drop", "gust", "glow", "haze", "dusk", "dawn", "cloud", "storm", "ocean", "river",
  "flood", "creek", "brook", "shore", "coral", "pearl", "frost", "sleet", "cedar", "maple", "grove",
  "stone", "shell", "light", "field", "cabin", "stream", "letter", "canvas", "breeze", "puddle",
  "drizzle", "thunder", "monsoon", "rainbow", "harbour", "current", "whisper", "morning", "evening",
  "lantern", "blanket", "window", "garden", "meadow", "valley", "forest", "island", "planet",
  "rocket", "signal", "kernel", "vector", "memory", "cipher", "galaxy", "syntax", "binary", "module",
  "umbrella", "raindrop", "overcast", "moonlight", "sunshine", "rainfall", "waterfall", "lighthouse",
  "downpour", "keyboard", "notebook", "starlight", "afternoon", "landscape", "windshield",
  "atmosphere", "horizontal", "thunderclap", "waterproof", "hydrangea", "barometer", "condensation",
  "evaporation", "precipitation", "meteorologist", "cumulonimbus",
];

// Words this long or longer are the occasional long word.
export const LONG_FROM = 10;

// The length band most words come from. It starts short and comfortable and
// widens and lengthens over STAGE_SECONDS of play.
const BAND_START = [4, 6];
const BAND_END = [5, 9];
const STAGE_SECONDS = 240;

// A long word, now and then: rarer at the start, never two at once.
const LONG_CHANCE_START = 0.06;
const LONG_CHANCE_END = 0.16;

// A short throwback from below the band, for a breather.
const SHORT_CHANCE = 0.1;

// Words dealt this recently are held back. More than a minute of drops at
// the fastest spawn rate, so nothing repeats within a minute; capped at half
// the list, so a small one always has something left to deal.
const RECENT_MAX = 300;

const stageAt = (time) => Math.min(1, Math.max(0, time / STAGE_SECONDS));

// The longest word that can be dealt this far into a game. Early long words
// stop at 11 letters; the longest open up as the game goes. Also checked by
// the leaderboard API (rules.js), which is why it is exported.
export function longestAt(time) {
  return LONG_FROM + 1 + Math.round(stageAt(time) * 10);
}

// The chance a word dealt now is a long one, when no long one is falling.
export function longChanceAt(time) {
  return LONG_CHANCE_START + stageAt(time) * (LONG_CHANCE_END - LONG_CHANCE_START);
}

// Buckets by length, from either { "4": [...], "5": [...] } or { words: [...] }.
// Only plain a to z words are kept: the on-screen keyboard has nothing else.
// Duplicates are dropped, so a word listed twice is not twice as likely.
export function normalizeWords(json) {
  const seen = new Set();
  const buckets = {};
  const push = (w) => {
    const clean = String(w ?? "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    (buckets[clean.length] ||= []).push(clean);
  };

  let found = false;
  for (const key of Object.keys(json ?? {})) {
    if (!Number.isNaN(parseInt(key, 10)) && Array.isArray(json[key])) {
      found = true;
      json[key].forEach(push);
    }
  }
  if (!found && Array.isArray(json?.words)) json.words.forEach(push);
  if (!seen.size) FALLBACK_WORDS.forEach(push);
  return buckets;
}

export function createWordPicker(buckets, random = Math.random) {
  let lengths = [];
  let allWords = [];
  let decks = {};
  const recent = [];
  const recentSet = new Set();

  function load(next) {
    buckets = next;
    lengths = Object.keys(buckets)
      .map(Number)
      .filter((L) => buckets[L]?.length)
      .sort((a, b) => a - b);
    allWords = lengths.flatMap((L) => buckets[L]);
    decks = {};
  }

  // A new game: fresh decks and nothing held back, so a seed deals the same
  // words whatever was played before it.
  function reset() {
    decks = {};
    recent.length = 0;
    recentSet.clear();
  }

  const recentLimit = () => Math.min(RECENT_MAX, Math.floor(allWords.length / 2));

  function remember(word) {
    recent.push(word);
    recentSet.add(word);
    while (recent.length > recentLimit()) recentSet.delete(recent.shift());
  }

  function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const pickOne = (list) => list[Math.floor(random() * list.length)];

  function weighted(list, weight) {
    const weights = list.map(weight);
    let r = random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i += 1) {
      r -= weights[i];
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  function chooseLength(time, falling) {
    const stage = stageAt(time);
    const low = Math.round(BAND_START[0] + stage * (BAND_END[0] - BAND_START[0]));
    const high = Math.round(BAND_START[1] + stage * (BAND_END[1] - BAND_START[1]));

    const longest = longestAt(time);
    const longs = lengths.filter((L) => L >= LONG_FROM && L <= longest);
    const longFalling = falling.some((w) => w.length >= LONG_FROM);
    // Mostly the shorter of the long ones: a 10 is three times a 12.
    if (longs.length && !longFalling && random() < longChanceAt(time)) {
      return weighted(longs, (L) => 1 / (L - LONG_FROM + 1));
    }

    if (random() < SHORT_CHANCE) {
      const shorts = lengths.filter((L) => L < low);
      if (shorts.length) return pickOne(shorts);
    }

    const band = lengths.filter((L) => L >= low && L <= high);
    if (band.length) return pickOne(band);
    const middle = (low + high) / 2;
    return lengths.reduce((best, L) => (Math.abs(L - middle) < Math.abs(best - middle) ? L : best));
  }

  // Deals from one length's shuffled deck, so a length's words all come up
  // once before any comes up again. Skips a word dealt recently or already
  // falling, and prefers one whose first letter nothing falling shares, so
  // the first key typed picks out one word. Null when nothing may be dealt.
  function deal(len, falling, firsts) {
    const bucket = buckets[len];
    let clash = null;
    for (let tries = 0; tries < Math.min(bucket.length, 40); tries += 1) {
      if (!decks[len]?.length) decks[len] = shuffled(bucket);
      const word = decks[len].pop();
      if (recentSet.has(word) || falling.has(word)) continue;
      if (firsts.has(word[0])) {
        clash ??= word;
        continue;
      }
      return word;
    }
    return clash;
  }

  function next({ time = 0, falling = [] } = {}) {
    if (!allWords.length) return "word";
    const fallingSet = new Set(falling);
    const firsts = new Set(falling.map((w) => w[0]));
    const want = chooseLength(time, falling);

    // The length wanted, then its neighbours outward, so a small bucket that
    // has run dry borrows from the next length rather than repeating.
    const order = [...lengths].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b);
    for (const L of order) {
      const word = deal(L, fallingSet, firsts);
      if (word) {
        remember(word);
        return word;
      }
    }

    // Everything is recent or falling, which only a tiny list can manage.
    const free = allWords.filter((w) => !fallingSet.has(w));
    const word = pickOne(free.length ? free : allWords);
    remember(word);
    return word;
  }

  load(buckets);
  return { next, load, reset };
}
