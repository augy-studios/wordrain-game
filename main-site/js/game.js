// Word Rain: words fall, the reader types them, missed words raise the water.
// Rules are in rules.js, shared with the leaderboard API. Every colour on the
// canvas comes from the theme tokens, so it follows the swatch and the mode.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { openLeaderboard } from "./leaderboard.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  FIRST_SPAWN_MS,
  PROFILES,
  WATER_EASE_SECONDS,
  WATER_FULL,
  doubleChance,
  levelAt,
  spawnIntervalMs,
  speedMultiplier,
  waterAfter,
  wordScore,
} from "./rules.js";
import { Recording } from "./replay.js";
import { cleanSeed, makeSeed, seededRandom } from "./seed.js";
import { FALLBACK_WORDS, createWordPicker, normalizeWords } from "./words.js";

const WORDLIST_URL = "/wordlist.json";

const MAX_DROPS = 100;
const SPACE_RESTART_DELAY_MS = 800;
const AUTOPLAY_KEY_MS = 25;
const AUTOPLAY_WORD_MS = 75;
const TRIPLE_TAP_MS = 400;
const BASE_RADIUS = 18;
const PILL_HEIGHT = 24;
const PILL_GAP = 4;
const PILL_PAD = 8;
const WORD_FONT = '15px "Nova Round", "Segoe UI", sans-serif';
const BADGE_FONT = '12px "Jua", "Segoe UI", sans-serif';

const KEY_LAYOUT = [
  [..."QWERTYUIOP"],
  [..."ASDFGHJKL"],
  ["ESC", ..."ZXCVBNM", "DEL"],
];

// Math.random is for what only looks different, the splashes and autoplay's
// pace. What a game deals comes from its seed.
const between = (random, a, b) => a + random() * (b - a);
const rand = (a, b) => between(Math.random, a, b);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---- Colours, read from the theme tokens ---- */

function parseColor(value) {
  const s = (value || "").trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    const n = parseInt(hex.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// t of a, the rest of b, both treated as opaque.
const mix = (a, b, t) => ({
  r: a.r * t + b.r * (1 - t),
  g: a.g * t + b.g * (1 - t),
  b: a.b * t + b.b * (1 - t),
  a: 1,
});

// A translucent colour laid over an opaque one.
const over = (fg, bg) => mix(fg, bg, fg.a);

const rgba = (c, alpha = 1) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;

// The same recipes theme.css uses for the page and its fills, resolved to
// plain colours the canvas can draw with.
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const token = (name) => parseColor(cs.getPropertyValue(name));
  const brand = token("--brand");
  const page = mix(brand, token("--bg"), 0.1);
  const strong = over(token("--surface-strong"), page);
  return {
    page,
    strong,
    fill: mix(brand, strong, 0.55),
    fillStrong: mix(brand, strong, 0.75),
    ink: token("--ink"),
    brandInk: token("--brand-ink"),
    onBrand: token("--on-brand"),
    water: token("--water"),
    waterLine: token("--water-line"),
  };
}

// Works on a phone, a tablet in "desktop" mode, a PWA and an Android WebView.
function isMobileLike() {
  const ua = navigator.userAgent || "";
  const hasTouch = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const uaHit = /(Mobi|Android|iPhone|iPad|iPod)/i.test(ua);
  const narrow = Math.min(window.innerWidth, window.innerHeight) <= 1024;
  return (hasTouch || coarse || uaHit) && narrow;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function teardrop(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.2);
  ctx.bezierCurveTo(x + r, y - r, x + r * 0.9, y + r * 0.2, x, y + r);
  ctx.bezierCurveTo(x - r * 0.9, y + r * 0.2, x - r, y - r, x, y - r * 1.2);
  ctx.closePath();
}

export function initGame() {
  const $ = (id) => document.getElementById(id);
  const canvas = $("game");
  const ctx = canvas.getContext("2d");
  const vk = $("vk");
  const typingRow = $("typingRow");
  const buffer = $("buffer");

  let width = 0;
  let height = 0;
  let palette = readPalette();
  let profile = PROFILES.keyboard;
  let useVK = false;

  // Swapped for each drop's own stream in spawnDrop.
  let wordRandom = Math.random;
  const words = createWordPicker(normalizeWords({ words: FALLBACK_WORDS }), () => wordRandom());

  let nextId = 1;
  let gameNumber = 0;
  const particles = [];
  const play = { top: 0, bottom: 0 };

  const state = {};
  let run = null; // this game's leaderboard run
  let result = null; // the finished game, kept so the submit can be retried
  let autoplay = false; // F2, or three quick taps on the level; deliberately not shown anywhere
  let rec = new Recording(); // this game, for the replay once it ends

  /* ---- Canvas size ---- */

  function resizeCanvas() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    // The element's own size, so the bitmap is never stretched to fit it.
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // The playing field: from under the update bar, when there is one, down to
  // the top of the on-screen keyboard, the device's keyboard, or the bottom
  // of the screen. Drops never fall behind a keyboard, where nobody can read
  // them. The device's keyboard is found through the visual viewport, which
  // shrinks, and on iOS scrolls, when it opens.
  function measurePlayArea() {
    const bar = document.querySelector(".update-notice");
    const vv = window.visualViewport;
    const top = Math.max(bar ? bar.getBoundingClientRect().bottom : 0, vv ? vv.offsetTop : 0);
    let bottom = Math.min(height, vv ? vv.offsetTop + vv.height : height);
    if (useVK) bottom = Math.min(bottom, vk.getBoundingClientRect().top - 6);
    if (bottom - top < 120) bottom = Math.min(height, top + 120);
    play.top = top;
    play.bottom = bottom;
  }

  const playHeight = () => Math.max(1, play.bottom - play.top);
  const waterTop = () => play.bottom - playHeight() * state.waterLevel;

  /* ---- Words ---- */

  // Which word falls next is words.js's call: length by how far into the
  // game it is, no repeats for a good while, and an occasional long one.
  async function loadWords() {
    try {
      const response = await fetch(WORDLIST_URL);
      if (!response.ok) throw new Error(`${response.status}`);
      words.load(normalizeWords(await response.json()));
    } catch (cause) {
      console.warn("word list did not load, using the built in words:", cause);
    }
  }

  /* ---- Drops ---- */

  class Drop {
    constructor(word, isDouble, random) {
      this.id = nextId++;
      this.spawnedAt = Math.floor(state.time * 1000);
      this.word = word;
      this.isDouble = isDouble;
      this.r = BASE_RADIUS * (isDouble ? 2 : 1);
      // Fixed at spawn, so a drop keeps the pace it started with.
      this.mult = speedMultiplier(state.time, state.level) * (isDouble ? 0.95 : 1);
      this.drift = between(random, -10, 10);
      this.dead = false;
      this.measure();
      const half = this.halfWidth();
      // Drawn even on a screen too narrow to use it, so the stream stays in step.
      const across = random();
      this.x = width > half * 2 ? half + across * (width - half * 2) : width / 2;
      this.y = play.top - this.r;
    }

    measure() {
      ctx.font = WORD_FONT;
      this.textWidth = ctx.measureText(this.word).width;
    }

    pillWidth() {
      return this.textWidth + PILL_PAD * 2;
    }

    halfWidth() {
      return Math.max(this.r * 1.1, this.pillWidth() / 2) + 6;
    }

    // The lowest point of the drop and its word, which is what meets the water.
    bottom() {
      return this.y + this.r + PILL_GAP + PILL_HEIGHT;
    }

    update(dt) {
      this.y += (playHeight() / profile.fallSeconds) * this.mult * dt;
      this.x += Math.sin((state.time + this.id) * 0.6) * 10 * dt + this.drift * dt * 0.15;
      const half = this.halfWidth();
      this.x = width > half * 2 ? clamp(this.x, half, width - half) : width / 2;
      if (this.bottom() >= waterTop()) {
        this.dead = true;
        onMiss(this);
      }
    }

    draw(isTarget, typed) {
      const { x, y, r } = this;

      teardrop(ctx, x, y, r);
      ctx.fillStyle = rgba(this.isDouble ? palette.fillStrong : palette.fill);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(palette.brandInk, 0.55);
      ctx.stroke();

      if (this.isDouble) {
        const bx = x + r * 0.62;
        const by = y - r * 0.62;
        ctx.beginPath();
        ctx.arc(bx, by, 10, 0, Math.PI * 2);
        ctx.fillStyle = rgba(palette.brandInk);
        ctx.fill();
        ctx.font = BADGE_FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = rgba(palette.page);
        ctx.fillText("2", bx, by + 1);
      }

      if (isTarget) {
        ctx.beginPath();
        ctx.arc(x, y, r + 7, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(palette.brandInk);
        ctx.stroke();
      }

      // The word, on its own pill so it reads over anything: other drops,
      // the page, the water's edge. The target's pill is a brand fill with
      // --on-brand text, and the letters typed so far are underlined.
      const w = this.pillWidth();
      const px = x - w / 2;
      const py = y + r + PILL_GAP;
      roundRect(ctx, px, py, w, PILL_HEIGHT, PILL_HEIGHT / 2);
      ctx.fillStyle = rgba(isTarget ? palette.fillStrong : palette.strong);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(palette.ink, 0.18);
      ctx.stroke();

      ctx.font = WORD_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = rgba(isTarget ? palette.onBrand : palette.ink);
      ctx.fillText(this.word, px + PILL_PAD, py + PILL_HEIGHT / 2 + 1);

      if (isTarget && typed > 0) {
        const typedWidth = ctx.measureText(this.word.slice(0, typed)).width;
        ctx.fillRect(px + PILL_PAD, py + PILL_HEIGHT - 5, typedWidth, 2);
      }
    }
  }

  // Each drop draws from streams of its own, keyed on the seed and its place
  // in the game, rather than one stream for the whole game. The word picker
  // draws more or fewer numbers depending on what is still falling, which
  // depends on the typing; with one stream, a single word popped sooner would
  // change every drop after it.
  function spawnDrop() {
    if (state.drops.length >= MAX_DROPS) return;
    const n = state.spawned++;
    wordRandom = seededRandom(`${state.seed}/${n}/word`);
    const word = words.next({
      time: state.time,
      falling: state.drops.filter((d) => !d.dead).map((d) => d.word),
    });
    const random = seededRandom(`${state.seed}/${n}`);
    const drop = new Drop(word, random() < doubleChance(state.time, state.level), random);
    state.drops.push(drop);
    rec.drops.set(drop.id, drop);
  }

  const lowest = (drops) => drops.reduce((best, d) => (!best || d.y > best.y ? d : best), null);

  /* ---- Scoring ---- */

  // Every drop popped or landed, for the leaderboard API to replay. The
  // format is rules.js's checkResult. Floored to the millisecond, so the
  // level worked out from it is the level the game was on.
  function record(drop, hit) {
    state.log.push([drop.spawnedAt, Math.floor(state.time * 1000), drop.word, hit ? 1 : 0, drop.isDouble ? 1 : 0]);
  }

  // A line for the replay to show, and to step to.
  function note(kind, text, extra) {
    rec.addEvent({ kind, text, t: state.time, ...extra });
  }

  const named = (drop) => `${drop.isDouble ? "double " : ""}"${drop.word}"`;

  function onMiss(drop) {
    record(drop, false);
    const typing = drop.id === state.targetId && state.input;
    note("miss", `Missed ${named(drop)}${typing ? ` with "${state.input}" typed` : ""}`, {
      bad: true,
      x: drop.x,
      y: waterTop(),
    });
    state.misses += 1;
    state.waterTarget = waterAfter(state.waterTarget, false, drop.isDouble);
    splash(drop.x, waterTop(), true);
    renderStats();
  }

  function pop(drop) {
    record(drop, true);
    const points = wordScore(drop.word.length, drop.isDouble, state.level);
    note("pop", `Popped ${named(drop)}, +${points}`, { x: drop.x, y: drop.y });
    drop.dead = true;
    state.drops = state.drops.filter((d) => d !== drop);
    state.words += 1;
    state.score += points;
    state.waterTarget = waterAfter(state.waterTarget, true, drop.isDouble);
    splash(drop.x, drop.y, false);
    state.input = "";
    state.targetId = null;
    renderBuffer();
    renderStats();
  }

  /* ---- Particles ---- */

  function splash(x, y, isMiss) {
    if (!getSettings().splashes || reducedMotion.matches) return;
    const color = isMiss ? palette.waterLine : palette.brandInk;
    for (let i = 0; i < (isMiss ? 22 : 16); i += 1) {
      particles.push({
        x,
        y,
        r: rand(1, isMiss ? 3.2 : 2),
        vx: rand(-80, 80),
        vy: rand(-160, -40),
        life: rand(0.3, 0.7),
        t: 0,
        color,
      });
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.t += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 320 * dt;
    }
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      if (particles[i].t > particles[i].life) particles.splice(i, 1);
    }
  }

  /* ---- Typing ---- */

  // The target is the lowest drop starting with what has been typed, and its
  // progress is always the length of the buffer. Holding progress on the drop
  // instead is what broke the old game: when the target moved to another
  // drop with the same first letters, its count stayed at nought and the
  // word could never be finished.
  function refreshTarget({ clearIfLost = false } = {}) {
    const hadTarget = state.targetId !== null;
    const best = state.input ? lowest(state.drops.filter((d) => !d.dead && d.word.startsWith(state.input))) : null;
    state.targetId = best ? best.id : null;
    // The word being typed reached the water: start fresh rather than keep a
    // buffer that now matches nothing.
    if (clearIfLost && hadTarget && !best && state.input) {
      state.input = "";
      renderBuffer();
    }
  }

  // What has been typed is now `next`: one more letter from a key, or
  // anything at all from the device's keyboard, which can swipe or suggest
  // a whole word, delete several letters, or autocorrect. A word matched in
  // full pops; a start that matches nothing is refused when the setting says
  // so, and the typing box goes back to what it was.
  function applyTyped(next) {
    if (!state.running || state.over) return;
    const live = state.drops.filter((d) => !d.dead);

    const exact = lowest(live.filter((d) => d.word === next));
    if (exact) {
      pop(exact);
      return;
    }
    if (next && !live.some((d) => d.word.startsWith(next)) && getSettings().ignore_wrong) {
      note("refused", `No word starts "${next}", so it was ignored`, { bad: true });
      rejectKey();
      renderBuffer();
      return;
    }
    noteTyping(next);
    state.input = next;
    refreshTarget();
    renderBuffer();
  }

  // The replay's line for the typing box going from what it holds to
  // `next`. A start no falling word has is a mistake.
  function noteTyping(next) {
    const from = state.input;
    const text = next.startsWith(from)
      ? `Typed "${next}"`
      : from.startsWith(next)
        ? next ? `Deleted back to "${next}"` : `Deleted "${from}"`
        : `Changed "${from}" to "${next}"`;
    const fits = !next || state.drops.some((d) => !d.dead && d.word.startsWith(next));
    note("type", fits ? text : `${text}, which starts no word`, { bad: !fits });
  }

  function typeChar(c) {
    applyTyped(state.input + c);
  }

  // The typing box is a real text field, so tapping it on a phone opens the
  // device's keyboard. Whatever that puts in the field is read back as the
  // whole of what has been typed.
  function onBufferInput() {
    const typed = buffer.value.toLowerCase().replace(/[^a-z]/g, "");
    if (typed !== state.input) applyTyped(typed);
    else renderBuffer();
  }

  function backspace() {
    if (!state.running || state.over || !state.input) return;
    noteTyping(state.input.slice(0, -1));
    state.input = state.input.slice(0, -1);
    refreshTarget();
    renderBuffer();
  }

  function clearInput() {
    if (state.over) return;
    if (state.input) note("type", `Cleared "${state.input}"`);
    state.input = "";
    state.targetId = null;
    renderBuffer();
  }

  function rejectKey() {
    buffer.classList.remove("shake");
    // Restarts the animation when keys come quicker than it lasts.
    void buffer.offsetWidth;
    buffer.classList.add("shake");
  }

  // Only written when it differs, so a keyboard partway through composing a
  // word is not interrupted by the field being set to what it already holds.
  function renderBuffer() {
    if (buffer.value !== state.input) buffer.value = state.input;
  }

  /* ---- Autoplay ---- */

  // Types the lowest drop a letter at a time, far quicker than a person, through
  // the same path as a key. A word already started, by the bot or by hand,
  // is finished first; a start that matches nothing is cleared.
  function updateAutoplay(dt) {
    state.botTimer -= dt * 1000;
    if (state.botTimer > 0) return;
    const live = state.drops.filter((d) => !d.dead);
    let target = live.find((d) => d.id === state.targetId);
    if (!target) {
      target = lowest(live);
      if (!target) return;
      if (state.input) clearInput();
    }
    typeChar(target.word[state.input.length]);
    state.botTimer = (state.targetId === null ? AUTOPLAY_WORD_MS : AUTOPLAY_KEY_MS) * rand(0.7, 1.3);
  }

  // On, it plays the game in hand, or a new one if that one is over. A game
  // it has touched cannot go on the leaderboard.
  function toggleAutoplay() {
    autoplay = !autoplay;
    if (!autoplay) return;
    if (state.over) {
      restart();
      return;
    }
    state.autoplayed = true;
    setPaused(false);
  }

  // A phone has no F2: three taps on the level in quick succession stand in
  // for it. Touch only, and each tap within TRIPLE_TAP_MS of the one before.
  let taps = 0;
  let lastTapAt = 0;

  function onLevelTap(e) {
    if (e.pointerType !== "touch" || replay.on) return;
    // Leaves focus where it was, so the device's keyboard stays open.
    e.preventDefault();
    const now = performance.now();
    taps = now - lastTapAt <= TRIPLE_TAP_MS ? taps + 1 : 1;
    lastTapAt = now;
    if (taps < 3) return;
    taps = 0;
    toggleAutoplay();
  }

  /* ---- The device's keyboard ---- */

  // How much of the screen the device's keyboard covers, for the typing row
  // and the on-screen keyboard's head to sit above, and how far iOS has
  // scrolled the view to show the field, for the top controls to follow.
  let deviceKeyboardOpen = false;
  let lastInset = -1;
  let lastTop = -1;

  function syncViewport() {
    const vv = window.visualViewport;
    const top = vv ? Math.round(vv.offsetTop) : 0;
    const inset = vv ? Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height))) : 0;
    const root = document.documentElement.style;
    if (inset !== lastInset) root.setProperty("--kb-inset", `${inset}px`);
    if (top !== lastTop) root.setProperty("--vv-top", `${top}px`);
    lastInset = inset;
    lastTop = top;

    // Android can hide the keyboard with the back button and leave the
    // field focused. Let go of it, so the game's own keys come back.
    const focused = document.activeElement === buffer;
    if (deviceKeyboardOpen && focused && inset < 80) buffer.blur();
    deviceKeyboardOpen = focused && inset >= 80;
  }

  // Only on a touch screen: a click into the box on a desktop is just a click.
  const onTouchScreen = () => useVK || isMobileLike();

  function onBufferFocus() {
    if (onTouchScreen()) document.body.classList.add("device-keyboard");
  }

  function onBufferBlur() {
    document.body.classList.remove("device-keyboard");
  }

  function renderStats() {
    $("level").textContent = String(state.level);
    $("misses").textContent = String(state.misses);
    $("score").textContent = String(state.score);
  }

  /* ---- The on-screen keyboard ---- */

  function buildKeyboard() {
    $("vkKeys").innerHTML = KEY_LAYOUT.map(
      (row) => `<div class="k-row">${row
        .map((k) => {
          if (k === "DEL") return `<button class="key wide" type="button" data-key="DEL" aria-label="Backspace">${icon("backspace")}</button>`;
          if (k === "ESC") return `<button class="key wide" type="button" data-key="ESC" aria-label="Clear typing">${icon("undo")}</button>`;
          return `<button class="key" type="button" data-key="${k}">${k}</button>`;
        })
        .join("")}</div>`
    ).join("");

    const press = (btn) => {
      btn.classList.add("pressed");
      setTimeout(() => btn.classList.remove("pressed"), 120);
      const k = btn.dataset.key;
      if (k === "DEL") backspace();
      else if (k === "ESC") clearInput();
      else typeChar(k.toLowerCase());
    };

    // Taps act on pointerdown, with no wait for the click and no focus
    // taken. A click with no pointer behind it, from a keyboard or a switch
    // device, still works.
    vk.addEventListener("pointerdown", (e) => {
      const btn = e.target.closest("[data-key]");
      if (!btn) return;
      e.preventDefault();
      press(btn);
    });
    vk.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-key]");
      if (btn && e.detail === 0) press(btn);
    });
    vk.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // Which keyboard is in use, from the setting and the device. The typing
  // row moves into the on-screen keyboard's head when it shows, so the
  // playing field above it stays clear.
  function applyInputMode() {
    const pref = getSettings().keyboard;
    const next = pref === "always" || (pref === "auto" && isMobileLike());
    if (next === useVK && typingRow.parentElement) return;
    useVK = next;
    profile = useVK ? PROFILES.touch : PROFILES.keyboard;
    vk.hidden = !useVK;
    document.body.classList.toggle("vk-on", useVK);
    (useVK ? $("vkHead") : $("typingDock")).append(typingRow);
  }

  /* ---- Pause, restart, game over ---- */

  function setPaused(paused, { focus = true } = {}) {
    if (state.over || state.running === !paused) return;
    state.running = !paused;
    $("pauseOverlay").classList.toggle("hidden", !paused);
    if (paused && focus) $("continueBtn").focus();
    if (!paused) document.activeElement?.blur?.();
  }

  function togglePause() {
    setPaused(state.running);
  }

  // Asks the API for a run to submit this game under. The server's clock
  // starts here, and a finished game's length is checked against it. A game
  // started offline has no run and cannot go on the leaderboard.
  function startRun() {
    const mine = { id: null, failed: false };
    mine.ready = api
      .startRun()
      .then((r) => {
        mine.id = r.run_id;
      })
      .catch(() => {
        mine.failed = true;
      });
    run = mine;
  }

  function newGame(seed = makeSeed()) {
    gameNumber += 1;
    stopReplay();
    rec = new Recording();
    words.reset();
    Object.assign(state, {
      seed,
      spawned: 0,
      running: true,
      over: false,
      overAt: 0,
      score: 0,
      misses: 0,
      words: 0,
      level: 1,
      time: 0,
      input: "",
      targetId: null,
      // Primed so the first drop comes in under a second.
      spawnTimer: spawnIntervalMs(profile, 0, 1) - FIRST_SPAWN_MS,
      waterLevel: 0,
      waterTarget: 0,
      wavePhase: 0,
      drops: [],
      log: [],
      autoplayed: autoplay,
      botTimer: 0,
    });
    particles.length = 0;
    result = null;
    $("pauseOverlay").classList.add("hidden");
    $("gameOverOverlay").classList.add("hidden");
    renderStats();
    renderBuffer();
    renderSeed();
    startRun();
  }

  function restart(seed) {
    newGame(seed);
    document.activeElement?.blur?.();
  }

  /* ---- Seeds ---- */

  // The seed shows on the pause and game over panels, with a button to copy
  // it, and either panel takes one pasted back in to play it.
  function renderSeed() {
    document.querySelectorAll(".seed-code").forEach((el) => {
      el.textContent = state.seed;
    });
    document.querySelectorAll(".seed-form").forEach((form) => {
      form.reset();
      form.querySelector(".seed-msg").textContent = "";
    });
  }

  async function copySeed(btn) {
    const label = btn.querySelector(".copy-label");
    try {
      await navigator.clipboard.writeText(state.seed);
      label.textContent = "Copied";
    } catch {
      // No clipboard, as on a page not served over https: select the seed
      // instead, ready to copy by hand.
      getSelection()?.selectAllChildren(btn.closest(".seed-line").querySelector(".seed-code"));
      label.textContent = "Selected";
    }
    setTimeout(() => {
      label.textContent = "Copy";
    }, 1500);
  }

  function onSeedSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.querySelector(".seed-input");
    const seed = cleanSeed(input.value);
    if (!seed) {
      form.querySelector(".seed-msg").textContent = "Paste a seed first.";
      input.focus();
      return;
    }
    restart(seed);
  }

  function endGame() {
    state.running = false;
    state.over = true;
    state.overAt = performance.now();
    note("end", "The water is full: game over", { bad: true });
    // The next game is the reader's again.
    autoplay = false;
    result = {
      score: state.score,
      level: state.level,
      words: state.words,
      misses: state.misses,
      durationMs: Math.round(state.time * 1000),
      log: state.log,
    };

    $("finalScore").textContent = String(result.score);
    $("finalLevel").textContent = String(result.level);
    $("finalWords").textContent = String(result.words);
    $("finalMisses").textContent = String(result.misses);

    const prefs = getSettings();
    const unavailable = state.autoplayed
      ? "Autoplay played this game, so it cannot go on the leaderboard."
      : run?.failed
      ? "This game started without a connection, so it cannot go on the leaderboard."
      : result.words === 0
        ? "Pop at least one word to go on the leaderboard."
        : "";
    $("submitForm").classList.toggle("hidden", Boolean(unavailable));
    $("submitUnavailable").textContent = unavailable;
    $("submitUnavailable").classList.toggle("hidden", !unavailable);
    $("submitted").classList.add("hidden");
    $("submitMsg").textContent = "";
    $("nameInput").value = prefs.name ?? "";
    $("submitBtn").disabled = false;

    $("gameOverOverlay").classList.remove("hidden");
    $("playAgainBtn").focus();

    if (!unavailable && prefs.auto_submit && prefs.name) submitAs(prefs.name, true);
  }

  // Adds the game under a name, typed or saved. Any name that goes through
  // becomes the saved one. A failure leaves the form in place, so a game
  // that ended offline can be added once the connection is back.
  async function submitAs(name, auto = false) {
    const ticket = gameNumber;
    const mine = run;
    const finished = result;
    const msg = $("submitMsg");
    if (!mine || !finished) return;

    $("submitBtn").disabled = true;
    msg.textContent = auto ? `Adding as ${name}.` : "Adding.";
    await mine.ready;
    if (ticket !== gameNumber) return;

    if (!mine.id) {
      msg.textContent = "This game started without a connection, so it cannot go on the leaderboard.";
      return;
    }

    try {
      const r = await api.submit(mine.id, name, finished);
      if (ticket !== gameNumber) return;
      saveSettings({ name: r.name });
      $("submittedText").textContent =
        `Added as ${r.name}. Ranked ${r.best_rank} for best score, ${r.total_rank} for total points, ` +
        `${r.level_rank} for level and ${r.words_rank} for words.`;
      $("submitForm").classList.add("hidden");
      $("submitted").classList.remove("hidden");
      msg.textContent = "";
    } catch (err) {
      if (ticket !== gameNumber) return;
      const final = ["already_submitted", "expired", "not_found", "implausible"].includes(err.code);
      if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
      else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
      else if (auto && !final) msg.textContent = "This game could not be added automatically. Try the button.";
      else msg.textContent = err.message || "That did not go through. Try again in a moment.";
      $("submitBtn").disabled = final;
    }
  }

  function onSubmit(event) {
    event.preventDefault();
    const name = $("nameInput").value.trim();
    if (!name) {
      $("submitMsg").textContent = "Enter a name.";
      $("nameInput").focus();
      return;
    }
    submitAs(name);
  }

  /* ---- Instant replay ---- */

  // A finished game can be watched again from its recording: played, paused,
  // scrubbed, or stepped through an event at a time, every key, pop, miss and
  // level, each with a line saying what it was. The field is drawn as it was
  // played, shrunk if need be to fit above the replay's controls.
  const replayBar = $("replayBar");
  const seek = $("replaySeek");
  const caption = $("replayCaption");
  const replay = { on: false, playing: false, t: 0, frame: 0, ev: -1 };
  const views = new Map(); // drops as the replay draws them, by id

  const clock = (seconds) => {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Only written when it differs, since the replay renders every frame.
  const put = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };

  function openReplay() {
    if (!state.over || !rec.frames.length) return;
    replay.on = true;
    document.body.classList.add("replaying");
    $("gameOverOverlay").classList.add("hidden");
    replayBar.hidden = false;
    views.clear();
    seek.max = String(rec.frames.length - 1);
    const last = Math.max(1, rec.frames.length - 1);
    $("replayMarks").innerHTML = rec.events
      .filter((e) => e.kind === "miss")
      .map((e) => `<span style="left: ${(rec.frameOf(e) / last) * 100}%"></span>`)
      .join("");
    replayFrom(0);
    setReplayPlaying(true);
    $("replayPlay").focus();
  }

  // Leaves the replay, for newGame on its way to a fresh game.
  function stopReplay() {
    if (!replay.on) return;
    replay.on = false;
    replay.playing = false;
    document.body.classList.remove("replaying");
    replayBar.hidden = true;
    particles.length = 0;
    renderStats();
  }

  // Back to the game over panel, where the game can still be added.
  function closeReplay() {
    stopReplay();
    $("gameOverOverlay").classList.remove("hidden");
    $("replayBtn").focus();
  }

  function setReplayPlaying(playing) {
    // Play from the end starts again from the top.
    if (playing && replay.frame >= rec.frames.length - 1) replayFrom(0);
    replay.playing = playing;
    const btn = $("replayPlay");
    btn.innerHTML = icon(playing ? "pause" : "play");
    btn.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    // Read out while stepping, not forty times a second while playing.
    caption.setAttribute("aria-live", playing ? "off" : "polite");
  }

  // Jumps to frame i, counting the events before it as seen, without their splashes.
  function replayFrom(i) {
    particles.length = 0;
    replay.frame = i;
    replay.t = rec.frames[i].t;
    replay.ev = rec.lastEventAt(i);
    renderReplay();
  }

  function stepReplay(dir) {
    setReplayPlaying(false);
    particles.length = 0;
    const { frame, ev } = rec.step(replay.frame, replay.ev, dir);
    const moved = ev !== replay.ev;
    replay.frame = frame;
    replay.ev = ev;
    replay.t = rec.frames[frame].t;
    if (dir > 0 && moved) splashFor(rec.events[ev]);
    renderReplay();
  }

  function splashFor(event) {
    if (event.kind === "pop") splash(event.x, event.y, false);
    else if (event.kind === "miss") splash(event.x, event.y, true);
  }

  // Game time runs as it did, so the replay goes at the pace the game did.
  function updateReplay(dt) {
    updateParticles(dt);
    if (!replay.playing) return;
    const frames = rec.frames;
    replay.t += dt;
    let i = replay.frame;
    while (i + 1 < frames.length && frames[i + 1].t <= replay.t) i += 1;
    replay.frame = i;
    while (replay.ev + 1 < rec.events.length && rec.frameOf(rec.events[replay.ev + 1]) <= i) {
      replay.ev += 1;
      splashFor(rec.events[replay.ev]);
    }
    if (i === frames.length - 1) setReplayPlaying(false);
    renderReplay();
  }

  function renderReplay() {
    const f = rec.frames[replay.frame];
    const event = rec.events[replay.ev];
    put($("level"), String(f.level));
    put($("misses"), String(f.misses));
    put($("score"), String(f.score));
    const text = event ? event.text : "The game starts";
    put(caption, text);
    caption.classList.toggle("bad", Boolean(event?.bad));
    put($("replayTime"), `${clock(f.t)} / ${clock(rec.frames[rec.frames.length - 1].t)}`);
    seek.value = String(replay.frame);
    const played = (replay.frame / Math.max(1, rec.frames.length - 1)) * 100;
    $("replayMarks").style.setProperty("--played", `${played}%`);
    const valueText = `${clock(f.t)}, ${text}`;
    if (seek.getAttribute("aria-valuetext") !== valueText) seek.setAttribute("aria-valuetext", valueText);
  }

  function viewOf(id) {
    let view = views.get(id);
    if (!view) {
      const d = rec.drops.get(id);
      view = Object.assign(Object.create(Drop.prototype), {
        id,
        word: d.word,
        isDouble: d.isDouble,
        r: d.r,
        textWidth: d.textWidth,
      });
      views.set(id, view);
    }
    return view;
  }

  // The recorded field, as large as fits between the top of the screen and
  // the replay's controls, and never larger than it was played. The water
  // runs on down behind the controls to the foot of the screen.
  function drawReplay() {
    const f = rec.frames[replay.frame];
    ctx.clearRect(0, 0, width, height);
    const room = replayBar.getBoundingClientRect().top - 8 - play.top;
    const fieldHeight = Math.max(1, f.bottom - f.top);
    const s = clamp(Math.min(room / fieldHeight, width / f.width), 0.2, 1);
    const ox = (width - f.width * s) / 2;
    const oy = play.top - f.top * s;
    const depth = fieldHeight * f.water;
    drawWater(oy + (f.bottom - depth) * s, height, depth * s);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    const typed = f.input.length;
    for (let k = 0; k < f.pos.length; k += 3) {
      const view = viewOf(f.pos[k]);
      view.x = f.pos[k + 1];
      view.y = f.pos[k + 2];
      view.draw(view.id === f.target, typed);
    }
    drawParticles();
    ctx.restore();
  }

  // Space plays and pauses, the arrows step, Esc goes back to the result.
  // On the timeline itself the arrows are its own, a frame at a time.
  function onReplayKey(e) {
    const key = e.key;
    const on = e.target instanceof Element ? e.target : null;
    if (key === "Escape") {
      closeReplay();
    } else if (key === "F1") {
      e.preventDefault();
      restart();
    } else if (key === "F2") {
      e.preventDefault();
    } else if (key === " ") {
      if (on?.closest("button, a")) return;
      e.preventDefault();
      if (!e.repeat) setReplayPlaying(!replay.playing);
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !on?.closest("input")) {
      e.preventDefault();
      stepReplay(key === "ArrowRight" ? 1 : -1);
    }
  }

  /* ---- Keys ---- */

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    // A window is open, or somebody is typing their name.
    // Esc that closed a window closes only that.
    if (e.defaultPrevented || document.body.classList.contains("modal-open")) return;
    if (replay.on) {
      onReplayKey(e);
      return;
    }
    const key = e.key;
    // In the typing box, letters and Backspace arrive through its input
    // event instead; Space, Esc, F1 and F2 are still the game's. Any other
    // field is somebody typing their name.
    if (e.target === buffer) {
      if (key !== " " && key !== "Escape" && key !== "F1" && key !== "F2") return;
    } else if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) {
      return;
    }

    if (key === " ") {
      // Paused or over, Space on a focused button presses it: Continue,
      // Restart, Play again. Otherwise Space is the game's, and focus is
      // dropped so no button it was resting on clicks as well.
      if (!state.running && e.target instanceof Element && e.target.closest("button, a")) return;
      e.preventDefault();
      if (e.repeat) return;
      if (state.over) {
        // Play again. Not in the first moment, so a Space meant as a pause
        // just as the water fills does not throw away an unsaved score.
        if (performance.now() - state.overAt < SPACE_RESTART_DELAY_MS) return;
        restart();
        return;
      }
      document.activeElement?.blur?.();
      togglePause();
      return;
    }
    if (key === "F1") {
      // The browser's help, otherwise.
      e.preventDefault();
      restart();
      return;
    }
    if (key === "F2") {
      // Autoplay, on and off. Kept out of every hint on purpose.
      e.preventDefault();
      if (!e.repeat) toggleAutoplay();
      return;
    }
    if (!state.running || state.over) return;
    if (key === "Escape") {
      clearInput();
      return;
    }
    if (key === "Backspace") {
      e.preventDefault();
      backspace();
      return;
    }
    if (key.length !== 1) return;
    const c = key.toLowerCase();
    if (!/^[a-z]$/.test(c)) return;
    e.preventDefault();
    typeChar(c);
  }

  /* ---- The loop ---- */

  function update(dt) {
    state.time += dt;

    const level = levelAt(state.time);
    if (level !== state.level) {
      state.level = level;
      note("level", `Level ${level}`);
      renderStats();
    }

    state.spawnTimer += dt * 1000;
    if (state.spawnTimer >= spawnIntervalMs(profile, state.time, state.level)) {
      state.spawnTimer = 0;
      spawnDrop();
    }

    for (const d of state.drops) d.update(dt);
    state.drops = state.drops.filter((d) => !d.dead);

    const k = 1 - Math.exp(-dt / WATER_EASE_SECONDS);
    state.waterLevel += (state.waterTarget - state.waterLevel) * k;
    if (state.waterTarget >= 1 && state.waterLevel >= WATER_FULL) {
      endGame();
      return;
    }

    refreshTarget({ clearIfLost: true });
    if (autoplay) updateAutoplay(dt);
    updateParticles(dt);
  }

  // Water from `top` down to `bottom`, with waves sized for `depth`: in the
  // replay the water fills to the foot of the screen, deeper than it was.
  function drawWater(top, bottom, depth = bottom - top) {
    if (depth <= 0.5) return;

    const amp = clamp(depth * 0.04, 1, 8);
    const len = 120;
    const surface = [];
    for (let x = 0; x <= width + 6; x += 6) {
      const wave =
        Math.sin((x + state.wavePhase) / len) * amp * 0.5 +
        Math.cos((x * 0.6 + state.wavePhase * 0.6) / (len * 0.85)) * amp * 0.25;
      surface.push([x, Math.min(bottom, top + wave)]);
    }

    // Flat colour and a flat surface line; no gradients.
    ctx.beginPath();
    ctx.moveTo(0, bottom);
    for (const [x, y] of surface) ctx.lineTo(x, y);
    ctx.lineTo(width, bottom);
    ctx.closePath();
    ctx.fillStyle = rgba(palette.water);
    ctx.fill();

    ctx.beginPath();
    surface.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(palette.waterLine);
    ctx.stroke();
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.fillStyle = rgba(p.color, 1 - p.t / p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    drawWater(waterTop(), play.bottom);
    const typed = state.input.length;
    for (const d of state.drops) d.draw(d.id === state.targetId, typed);
    drawParticles();
  }

  // What the game looked like after this update, for the replay.
  function recordFrame() {
    rec.addFrame(
      {
        t: state.time,
        level: state.level,
        misses: state.misses,
        score: state.score,
        input: state.input,
        target: state.targetId,
        water: state.waterLevel,
        top: play.top,
        bottom: play.bottom,
        width,
      },
      state.drops,
      { force: state.over }
    );
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    // Capped, so a tab coming back from the background does not jump.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    measurePlayArea();
    if (replay.on) {
      updateReplay(dt);
    } else if (state.running && !state.over) {
      update(dt);
      recordFrame();
    }
    // The waves keep moving slowly while paused.
    const moving = state.running || replay.playing;
    state.wavePhase += 80 * (1 + state.level * 0.05) * dt * (moving ? 1 : 0.2);
    if (replay.on) drawReplay();
    else draw();
  }

  /* ---- Start ---- */

  resizeCanvas();
  if ("ResizeObserver" in window) new ResizeObserver(resizeCanvas).observe(canvas);
  window.addEventListener("resize", () => {
    resizeCanvas();
    applyInputMode();
  });

  // The canvas redraws in the theme's colours whenever they change.
  new MutationObserver(() => {
    palette = readPalette();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-color-theme", "style"] });

  // The word font arrives after the first words are measured; measure them again.
  document.fonts?.load(WORD_FONT).then(() => state.drops?.forEach((d) => d.measure()));

  buildKeyboard();
  applyInputMode();
  document.addEventListener("wordrain:settings", applyInputMode);

  window.addEventListener("keydown", onKeyDown);
  document.querySelector(".hud-level").addEventListener("pointerdown", onLevelTap);
  $("pauseBtn").addEventListener("click", togglePause);
  $("continueBtn").addEventListener("click", () => setPaused(false));
  // Wrapped, so the click event is not taken for a seed.
  $("restartBtn").addEventListener("click", () => restart());
  $("playAgainBtn").addEventListener("click", () => restart());
  $("replayBtn").addEventListener("click", openReplay);
  $("replayPlay").addEventListener("click", () => setReplayPlaying(!replay.playing));
  $("replayBack").addEventListener("click", () => stepReplay(-1));
  $("replayForward").addEventListener("click", () => stepReplay(1));
  $("replayClose").addEventListener("click", closeReplay);
  // A click or tap on a replay button leaves focus where it was, so Space
  // goes on playing and pausing rather than pressing that button again.
  replayBar.querySelectorAll("button").forEach((btn) => btn.addEventListener("pointerdown", (e) => e.preventDefault()));
  seek.addEventListener("input", () => {
    setReplayPlaying(false);
    replayFrom(Number(seek.value));
  });
  document.querySelectorAll("[data-copy-seed]").forEach((btn) => btn.addEventListener("click", () => copySeed(btn)));
  document.querySelectorAll(".seed-form").forEach((form) => form.addEventListener("submit", onSeedSubmit));
  $("clearBtn").addEventListener("click", () => {
    clearInput();
    $("clearBtn").blur();
  });
  // A tap on the clear button leaves focus where it was, so the device's
  // keyboard stays open.
  $("clearBtn").addEventListener("pointerdown", (e) => e.preventDefault());
  buffer.addEventListener("input", onBufferInput);
  buffer.addEventListener("focus", onBufferFocus);
  buffer.addEventListener("blur", onBufferBlur);
  syncViewport();
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  window.addEventListener("resize", syncViewport);
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("submitForm").addEventListener("submit", onSubmit);
  buffer.addEventListener("animationend", () => buffer.classList.remove("shake"));

  // Pauses the game, or the replay if one is showing.
  function pauseAll() {
    setPaused(true, { focus: false });
    if (replay.on) setReplayPlaying(false);
  }

  // Leaving the tab pauses, so nothing is lost while the reader is away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pauseAll();
  });

  loadWords();
  newGame();
  requestAnimationFrame(frame);

  return {
    pause: pauseAll,
  };
}
