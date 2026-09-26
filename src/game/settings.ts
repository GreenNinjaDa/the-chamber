/*
 * Player settings, changed physically in the lobby chamber. Remembered in this browser only
 * (localStorage), and everything still works if storage is unavailable.
 */

const KEY = 'the-chamber-settings';

export const settings = {
  /** Multiplies mouse look speed. */
  mouseSpeed: 1,
  invertY: false,
  /** Which level (1-based) the lobby's START portal leads to. */
  startLevel: 1,
  /** Sound effects on or off. */
  sound: true,
  /** Levels (1-based) the player has got out of, for the lobby's pads. */
  beaten: [] as number[],
};

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (typeof saved.mouseSpeed === 'number') settings.mouseSpeed = saved.mouseSpeed;
  if (typeof saved.invertY === 'boolean') settings.invertY = saved.invertY;
  if (typeof saved.startLevel === 'number') settings.startLevel = saved.startLevel;
  if (typeof saved.sound === 'boolean') settings.sound = saved.sound;
  if (Array.isArray(saved.beaten)) settings.beaten = saved.beaten.filter((n: unknown) => typeof n === 'number');
} catch {
  // No storage: defaults it is.
}

/** Remembers that the player got out of level `n`. */
export function markBeaten(n: number) {
  if (settings.beaten.includes(n)) return;
  settings.beaten.push(n);
  saveSettings();
}

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, but still applied for this session.
  }
}
