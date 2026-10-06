/**
 * Player preferences that follow you between videos.
 *
 * The modal remounts its `<video>` when it swaps the muted preview for real
 * playback (`key={mode}`), which throws away everything set imperatively —
 * volume and playback rate included. So these live outside the element and
 * get re-applied whenever a new one loads.
 *
 * Every read and write is wrapped: `localStorage` doesn't just return null in
 * some privacy configurations, it throws on access, and an unguarded read
 * here would take the whole modal down.
 */

const VOLUME_KEY = "player-volume";
const RATE_KEY = "player-rate";
const SKIP_KEY = "player-skip-seconds";

/** Rates offered in the speed menu. 1 must be one of them — it's the default. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export const SKIP_OPTIONS = [5, 10, 15, 30] as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do — the preference just won't persist.
  }
}

export function readVolume(): number {
  const stored = read(VOLUME_KEY);
  // The null check has to come first: `Number(null)` is 0, which is a valid
  // volume, so a missing value used to read as "silent" and every video
  // played at zero until the slider was touched.
  if (stored === null) return 1;

  const raw = Number(stored);
  // A stored 0 *is* a real choice, so only values outside the valid range or
  // a non-numeric entry fall back.
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
}

export function writeVolume(volume: number): void {
  write(VOLUME_KEY, String(Math.min(1, Math.max(0, volume))));
}

export function readRate(): number {
  const raw = Number(read(RATE_KEY));
  // Anything outside the offered set falls back to normal speed, so a
  // hand-edited value can't leave playback stuck at an unreachable rate.
  return (PLAYBACK_RATES as readonly number[]).includes(raw) ? raw : 1;
}

export function writeRate(rate: number): void {
  write(RATE_KEY, String(rate));
}

export function readSkipSeconds(): number {
  const raw = Number(read(SKIP_KEY));
  return (SKIP_OPTIONS as readonly number[]).includes(raw) ? raw : 10;
}

export function writeSkipSeconds(seconds: number): void {
  write(SKIP_KEY, String(seconds));
}
