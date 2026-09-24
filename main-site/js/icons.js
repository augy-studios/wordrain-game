// Inline SVG icons. No emoji anywhere in the UI.
// Stroke icons inherit colour through currentColor.

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

export const icons = {
  // sun, moon, close and clock are the theme doc's own paths.
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>`),
  moon: svg(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`),
  close: svg(`<path d="M18 6 6 18M6 6l12 12"/>`),
  clock: svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>`),

  pause: svg(`<rect x="6.5" y="4.5" width="3.5" height="15" rx="1"/><rect x="14" y="4.5" width="3.5" height="15" rx="1"/>`),
  play: svg(`<path d="M7 4.5v15l12-7.5-12-7.5Z"/>`),
  refresh: svg(`<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/>`),
  // One arrow round, for clearing the typing box: not the two-arrow refresh,
  // which means start the game again.
  undo: svg(`<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M18.5 2.5v4.2h-4.2"/>`),
  backspace: svg(`<path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="m17 9-6 6M11 9l6 6"/>`),
  chevron: svg(`<path d="m9 5 7 7-7 7"/>`),
  trophy: svg(
    `<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5.5A1.5 1.5 0 0 0 4 7.5 3.5 3.5 0 0 0 7.5 11H8M16 6h2.5A1.5 1.5 0 0 1 20 7.5a3.5 3.5 0 0 1-3.5 3.5H16"/><path d="M12 13v4M8.5 20h7M10 17h4"/>`
  ),
  settings: svg(
    `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>`
  ),
  coffee: svg(
    `<path d="M4 9h13v5.5A4.5 4.5 0 0 1 12.5 19h-4A4.5 4.5 0 0 1 4 14.5V9Z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M7 4.5c0 1-.9 1.2-.9 2.2 0 .7.45 1 .45 1M11 4.5c0 1-.9 1.2-.9 2.2 0 .7.45 1 .45 1"/>`
  ),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
};

export function icon(name) {
  return icons[name] || "";
}
