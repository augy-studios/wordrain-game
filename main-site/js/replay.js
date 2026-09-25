// Instant replay: what the field looked like through a game, and what
// happened when, kept while it is played so it can be shown again once it
// ends. No DOM here; js/game.js records into it, and draws and steps
// through it.

// A frame at most this often, and at most this many kept: the last quarter
// hour at 60 a second, a few megabytes. A longer game, which in practice
// only autoplay plays, loses its start.
const FRAME_SECONDS = 1 / 60;
const MAX_FRAMES = 60 * 60 * 15;
const TRIM_FRAMES = MAX_FRAMES / 10;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Recording {
  constructor() {
    // Each frame is the game's time, its stats, and every drop falling as
    // [id, x, y, ...], in the coordinates it was drawn in.
    this.frames = [];
    // Each event is a caption for the replay, with `at`, the frame that
    // first shows what it did.
    this.events = [];
    // Every drop dealt, by id, for its word and size.
    this.drops = new Map();
    // Frames trimmed off the start. Events count frames from the very first.
    this.base = 0;
    this.pending = false;
  }

  // Called after every update. Frames closer together than FRAME_SECONDS are
  // skipped, unless something happened since the last one, so every event
  // has a frame of its own to show it.
  addFrame(frame, drops, { force = false } = {}) {
    const last = this.frames[this.frames.length - 1];
    if (last && !force && !this.pending && frame.t - last.t < FRAME_SECONDS * 0.9) return;
    const pos = new Float32Array(drops.length * 3);
    drops.forEach((d, k) => {
      pos[k * 3] = d.id;
      pos[k * 3 + 1] = d.x;
      pos[k * 3 + 2] = d.y;
    });
    this.frames.push({ ...frame, pos });
    this.pending = false;

    if (this.frames.length > MAX_FRAMES) {
      this.frames.splice(0, TRIM_FRAMES);
      this.base += TRIM_FRAMES;
      const keep = this.events.findIndex((e) => e.at >= this.base);
      this.events.splice(0, keep === -1 ? this.events.length : keep);
    }
  }

  // Shown by the next frame recorded, which comes after the update that
  // made it, or the update after a key.
  addEvent(event) {
    this.events.push({ ...event, at: this.base + this.frames.length });
    this.pending = true;
  }

  frameOf(event) {
    return clamp(event.at - this.base, 0, this.frames.length - 1);
  }

  // The last event frame i shows, or -1 before the first.
  lastEventAt(i) {
    const at = this.base + i;
    let lo = 0;
    let hi = this.events.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].at <= at) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // One event forward or back from frame `frame`, where event `ev` is the
  // last one shown. Back from between two events goes to the earlier one,
  // back from an event to the one before it, and back from the first to the
  // start. Several events can share a frame; each is still a step.
  step(frame, ev, dir) {
    if (dir > 0) {
      const next = Math.min(ev + 1, this.events.length - 1);
      if (next < 0) return { frame: this.frames.length - 1, ev };
      return { frame: next > ev ? this.frameOf(this.events[next]) : this.frames.length - 1, ev: next };
    }
    const back = ev >= 0 && frame > this.frameOf(this.events[ev]) ? ev : ev - 1;
    if (back < 0) return { frame: 0, ev: -1 };
    return { frame: this.frameOf(this.events[back]), ev: back };
  }
}
