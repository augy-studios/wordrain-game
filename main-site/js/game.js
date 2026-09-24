// Word Rain: words fall, the reader types them, missed words raise the water.
// Rules are in rules.js, shared with the leaderboard API. Every colour on the
// canvas comes from the theme tokens, so it follows the swatch and the mode.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { openLeaderboard } from "./leaderboard.js";
import { getSettings, saveSettings } from "./settings.js";
import {
  DOUBLE_HIT_WEIGHT,
  DOUBLE_MISS_WEIGHT,
  FIRST_SPAWN_MS,
  PROFILES,
  WATER_PER_HIT,
  WATER_PER_MISS,
  doubleChance,
  levelAt,
  spawnIntervalMs,
  speedMultiplier,
  wordScore,
} from "./rules.js";
import { FALLBACK_WORDS, createWordPicker, normalizeWords } from "./words.js";

const WORDLIST_URL = "/wordlist.json";

const MAX_DROPS = 100;
const WATER_EASE_SECONDS = 0.8;
const BASE_RADIUS = 18;
const PILL_HEIGHT = 24;
const PILL_GAP = 4;
const PILL_PAD = 8;
const WORD_FONT = '15px "Jua", "Segoe UI", sans-serif';
const BADGE_FONT = '12px "Jua", "Segoe UI", sans-serif';

const KEY_LAYOUT = [
  [..."QWERTYUIOP"],
  [..."ASDFGHJKL"],
  ["ESC", ..."ZXCVBNM", "DEL"],
];

const rand = (a, b) => a + Math.random() * (b - a);
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

  const words = createWordPicker(normalizeWords({ words: FALLBACK_WORDS }));

  let nextId = 1;
  let gameNumber = 0;
  const particles = [];
  const play = { top: 0, bottom: 0 };

  const state = {};
  let run = null; // this game's leaderboard run
  let result = null; // the finished game, kept so the submit can be retried

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
  // the top of the on-screen keyboard, or the bottom of the screen. Drops
  // never fall behind the keyboard, where nobody can read them.
  function measurePlayArea() {
    const bar = document.querySelector(".update-notice");
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    let bottom = height;
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
    constructor(word, isDouble) {
      this.id = nextId++;
      this.word = word;
      this.isDouble = isDouble;
      this.r = BASE_RADIUS * (isDouble ? 2 : 1);
      // Fixed at spawn, so a drop keeps the pace it started with.
      this.mult = speedMultiplier(state.time, state.level) * (isDouble ? 0.95 : 1);
      this.drift = rand(-10, 10);
      this.dead = false;
      this.measure();
      const half = this.halfWidth();
      this.x = width > half * 2 ? rand(half, width - half) : width / 2;
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

  function spawnDrop() {
    if (state.drops.length >= MAX_DROPS) return;
    const word = words.next({
      time: state.time,
      falling: state.drops.filter((d) => !d.dead).map((d) => d.word),
    });
    state.drops.push(new Drop(word, Math.random() < doubleChance(state.time, state.level)));
  }

  const lowest = (drops) => drops.reduce((best, d) => (!best || d.y > best.y ? d : best), null);

  /* ---- Scoring ---- */

  function onMiss(drop) {
    state.misses += 1;
    state.waterTarget = clamp(state.waterTarget + WATER_PER_MISS * (drop.isDouble ? DOUBLE_MISS_WEIGHT : 1), 0, 1);
    splash(drop.x, waterTop(), true);
    renderStats();
  }

  function pop(drop) {
    drop.dead = true;
    state.drops = state.drops.filter((d) => d !== drop);
    state.words += 1;
    state.score += wordScore(drop.word.length, drop.isDouble, state.level);
    state.waterTarget = clamp(state.waterTarget - WATER_PER_HIT * (drop.isDouble ? DOUBLE_HIT_WEIGHT : 1), 0, 1);
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

  function typeChar(c) {
    if (!state.running || state.over) return;
    const next = state.input + c;
    const live = state.drops.filter((d) => !d.dead);

    const exact = lowest(live.filter((d) => d.word === next));
    if (exact) {
      pop(exact);
      return;
    }
    if (!live.some((d) => d.word.startsWith(next)) && getSettings().ignore_wrong) {
      rejectKey();
      return;
    }
    state.input = next;
    refreshTarget();
    renderBuffer();
  }

  function backspace() {
    if (!state.running || state.over || !state.input) return;
    state.input = state.input.slice(0, -1);
    refreshTarget();
    renderBuffer();
  }

  function clearInput() {
    if (state.over) return;
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

  function renderBuffer() {
    buffer.textContent = state.input;
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

  function newGame() {
    gameNumber += 1;
    Object.assign(state, {
      running: true,
      over: false,
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
    });
    particles.length = 0;
    result = null;
    $("pauseOverlay").classList.add("hidden");
    $("gameOverOverlay").classList.add("hidden");
    renderStats();
    renderBuffer();
    startRun();
  }

  function restart() {
    newGame();
    document.activeElement?.blur?.();
  }

  function endGame() {
    state.running = false;
    state.over = true;
    result = {
      score: state.score,
      level: state.level,
      words: state.words,
      misses: state.misses,
      durationMs: Math.round(state.time * 1000),
    };

    $("finalScore").textContent = String(result.score);
    $("finalLevel").textContent = String(result.level);
    $("finalWords").textContent = String(result.words);
    $("finalMisses").textContent = String(result.misses);

    const prefs = getSettings();
    const unavailable = run?.failed
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

  /* ---- Keys ---- */

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    // A window is open, or somebody is typing their name.
    if (document.body.classList.contains("modal-open")) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;

    const key = e.key;
    if (key === " ") {
      // Paused or over, Space on a focused button presses it: Continue,
      // Restart, Play again. Otherwise Space is the game's, and focus is
      // dropped so no button it was resting on clicks as well.
      if (!state.running && e.target instanceof Element && e.target.closest("button, a")) return;
      e.preventDefault();
      if (e.repeat) return;
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
    if (state.waterTarget >= 1 && state.waterLevel >= 0.995) {
      endGame();
      return;
    }

    refreshTarget({ clearIfLost: true });
    updateParticles(dt);
  }

  function drawWater() {
    const top = waterTop();
    const depth = play.bottom - top;
    if (depth <= 0.5) return;

    const amp = clamp(depth * 0.04, 1, 8);
    const len = 120;
    const surface = [];
    for (let x = 0; x <= width + 6; x += 6) {
      const wave =
        Math.sin((x + state.wavePhase) / len) * amp * 0.5 +
        Math.cos((x * 0.6 + state.wavePhase * 0.6) / (len * 0.85)) * amp * 0.25;
      surface.push([x, Math.min(play.bottom, top + wave)]);
    }

    // Flat colour and a flat surface line; no gradients.
    ctx.beginPath();
    ctx.moveTo(0, play.bottom);
    for (const [x, y] of surface) ctx.lineTo(x, y);
    ctx.lineTo(width, play.bottom);
    ctx.closePath();
    ctx.fillStyle = rgba(palette.water);
    ctx.fill();

    ctx.beginPath();
    surface.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(palette.waterLine);
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    drawWater();
    const typed = state.input.length;
    for (const d of state.drops) d.draw(d.id === state.targetId, typed);
    for (const p of particles) {
      ctx.fillStyle = rgba(p.color, 1 - p.t / p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    // Capped, so a tab coming back from the background does not jump.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    measurePlayArea();
    if (state.running && !state.over) update(dt);
    // The waves keep moving slowly while paused.
    state.wavePhase += 80 * (1 + state.level * 0.05) * dt * (state.running ? 1 : 0.2);
    draw();
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

  // Jua arrives after the first words are measured; measure them again.
  document.fonts?.load(WORD_FONT).then(() => state.drops?.forEach((d) => d.measure()));

  buildKeyboard();
  applyInputMode();
  document.addEventListener("wordrain:settings", applyInputMode);

  window.addEventListener("keydown", onKeyDown);
  $("pauseBtn").addEventListener("click", togglePause);
  $("continueBtn").addEventListener("click", () => setPaused(false));
  $("restartBtn").addEventListener("click", restart);
  $("playAgainBtn").addEventListener("click", restart);
  $("clearBtn").addEventListener("click", () => {
    clearInput();
    $("clearBtn").blur();
  });
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("submitForm").addEventListener("submit", onSubmit);
  buffer.addEventListener("animationend", () => buffer.classList.remove("shake"));

  // Leaving the tab pauses, so nothing is lost while the reader is away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") setPaused(true, { focus: false });
  });

  loadWords();
  newGame();
  requestAnimationFrame(frame);

  return {
    pause: () => setPaused(true, { focus: false }),
  };
}
