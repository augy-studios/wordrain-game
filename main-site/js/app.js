import { COLOR_THEMES, applyColorTheme, applyMode, getStoredColorTheme, getStoredMode, getModePreference, initTheme } from "./theme.js";
import { hydrateIcons, openModal, closeModal, closeTopModal } from "./ui.js";
import { initUpdateBar } from "./update-bar.js";
import { initGame } from "./game.js";
import { initLeaderboard, openLeaderboard } from "./leaderboard.js";
import { initSettings, openSettings } from "./settings.js";

/* Theme modal, per uwuapps-theme.md section 6. */

function buildThemeModal() {
  const grid = document.getElementById("swatchGrid");
  grid.innerHTML = COLOR_THEMES.map(
    (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
  ).join("");

  syncThemeModalState();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-id]");
    if (!btn) return;
    applyColorTheme(btn.dataset.themeId);
    syncThemeModalState();
  });

  document.getElementById("modeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    applyMode(btn.dataset.mode);
    syncThemeModalState();
  });

  // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
  // modal so the note and pressed state stay in step with the change.
  document.addEventListener("uwu:modechange", syncThemeModalState);
}

function syncThemeModalState() {
  const activeTheme = getStoredColorTheme();
  const activePreference = getModePreference();
  const resolvedMode = getStoredMode();

  document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeId === activeTheme);
  });
  document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
    const isActive = el.dataset.mode === activePreference;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });

  const note = document.getElementById("modeNote");
  if (note) {
    note.hidden = activePreference !== "time";
    if (activePreference === "time") {
      note.textContent = `Following the clock. Currently ${resolvedMode}.`;
    }
  }

  updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
  const span = document.querySelector("#themeBtn [data-icon]");
  span.setAttribute("data-icon", getStoredMode() === "dark" ? "moon" : "sun");
  hydrateIcons(document.getElementById("themeBtn"));
}

/* The menu tray: leaderboard, settings and theme, which slides off the right
   edge and leaves an arrow tab to bring it back. Open until somebody closes
   it; the choice is a per-browser convenience, so storage failing only
   means it opens again next time. */

const TRAY_KEY = "wordrain.trayOpen";

function setTray(open, { save = true } = {}) {
  const tray = document.getElementById("tray");
  const tab = document.getElementById("trayTab");
  tray.classList.toggle("collapsed", !open);
  tab.setAttribute("aria-expanded", String(open));
  tab.setAttribute("aria-label", open ? "Hide menu" : "Show menu");
  // Off screen buttons must not take focus.
  document.getElementById("trayButtons").inert = !open;
  if (save) {
    try {
      localStorage.setItem(TRAY_KEY, open ? "1" : "0");
    } catch {
      // Remembered for this page view only.
    }
  }
}

function initTray() {
  let open = true;
  try {
    open = localStorage.getItem(TRAY_KEY) !== "0";
  } catch {
    // Open, the default.
  }
  setTray(open, { save: false });
  document.getElementById("trayTab").addEventListener("click", () => {
    setTray(document.getElementById("tray").classList.contains("collapsed"));
  });
}

function wireModals(game) {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    // Handled, so the game does not take the same Esc for itself.
    if (e.key === "Escape" && closeTopModal()) e.preventDefault();
  });

  // Every window stops the rain first. Closing it leaves the game paused,
  // so nothing falls while the reader finds their place again.
  const pausing = (open) => () => {
    game.pause();
    open();
  };
  document.getElementById("themeBtn").addEventListener("click", pausing(() => openModal("themeModal")));
  document.getElementById("boardBtn").addEventListener("click", pausing(() => openLeaderboard()));
  document.getElementById("settingsBtn").addEventListener("click", pausing(openSettings));
}

function boot() {
  initTheme();
  hydrateIcons();
  updateThemeButtonIcon();
  buildThemeModal();
  initTray();
  initLeaderboard();
  initSettings();
  const game = initGame();
  wireModals(game);
  initUpdateBar();
}

boot();
