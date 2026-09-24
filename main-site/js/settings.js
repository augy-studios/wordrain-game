// Player settings, kept in this browser. The game reads them through
// getSettings() and hears about changes on the "wordrain:settings" event.

import { api } from "./api.js";
import { openModal } from "./ui.js";

const STORAGE = "wordrain.settings";

const DEFAULTS = {
  name: null,
  auto_submit: false,
  keyboard: "auto",
  ignore_wrong: true,
  splashes: true,
};
const KEYBOARD = ["auto", "always", "never"];

let current = null;

function load() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}") ?? {};
  } catch {
    // Unreadable or blocked storage: the defaults.
  }
  const out = { ...DEFAULTS };
  if (typeof saved.name === "string" && saved.name.trim()) out.name = saved.name.trim();
  out.auto_submit = saved.auto_submit === true;
  if (KEYBOARD.includes(saved.keyboard)) out.keyboard = saved.keyboard;
  // On unless turned off, so a missing key keeps the default.
  out.ignore_wrong = saved.ignore_wrong !== false;
  out.splashes = saved.splashes !== false;
  // Adding games automatically needs a name to add them under.
  if (!out.name) out.auto_submit = false;
  return out;
}

export function getSettings() {
  current ??= load();
  return { ...current };
}

export function saveSettings(changes) {
  current = { ...getSettings(), ...changes };
  if (!current.name) current.auto_submit = false;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(current));
  } catch {
    // Kept for this page view only.
  }
  render();
  document.dispatchEvent(new CustomEvent("wordrain:settings", { detail: getSettings() }));
  return getSettings();
}

const $ = (id) => document.getElementById(id);

function render() {
  const s = getSettings();
  $("clearNameBtn").classList.toggle("hidden", !s.name);
  $("savedName").textContent = `Now: ${s.name ?? "Not set"}`;

  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    const on = s[el.dataset.setting];
    el.setAttribute("aria-checked", String(on));
    el.querySelector(".switch-state").textContent = on ? "On" : "Off";
  });
  const auto = document.querySelector('[data-setting="auto_submit"]');
  auto.disabled = !s.name;
  $("autoNote").classList.toggle("hidden", Boolean(s.name));

  document.querySelectorAll("#keyboardToggle [data-keyboard]").forEach((el) => {
    const on = el.dataset.keyboard === s.keyboard;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

async function onSaveName(event) {
  event.preventDefault();
  const input = $("settingsName");
  const msg = $("nameMsg");
  const name = input.value.trim();
  if (!name) {
    msg.textContent = "Enter a name.";
    input.focus();
    return;
  }
  $("saveNameBtn").disabled = true;
  msg.textContent = "";
  try {
    // The API cleans and checks it, the same check a submission gets.
    const result = await api.checkName(name);
    saveSettings({ name: result.name });
    input.value = "";
    msg.textContent = "Saved.";
  } catch (err) {
    msg.textContent =
      err.code === "offline"
        ? "Checking a name needs a connection."
        : err.message || "That did not go through. Try again in a moment.";
  } finally {
    $("saveNameBtn").disabled = false;
  }
}

export function openSettings() {
  $("nameMsg").textContent = "";
  $("settingsName").value = "";
  render();
  openModal("settingsModal");
}

export function initSettings() {
  $("nameForm").addEventListener("submit", onSaveName);
  $("clearNameBtn").addEventListener("click", () => {
    saveSettings({ name: null });
    $("nameMsg").textContent = "Name cleared.";
  });
  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    el.addEventListener("click", () => saveSettings({ [el.dataset.setting]: !getSettings()[el.dataset.setting] }));
  });
  $("keyboardToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-keyboard]");
    if (btn) saveSettings({ keyboard: btn.dataset.keyboard });
  });
  render();
}
