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
  /** Ids of the levels the player has got out of (see LEVELS in main.ts), for the lobby's pads. */
  beaten: [] as string[],
};

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (typeof saved.mouseSpeed === 'number') settings.mouseSpeed = saved.mouseSpeed;
  if (typeof saved.invertY === 'boolean') settings.invertY = saved.invertY;
  if (typeof saved.startLevel === 'number') settings.startLevel = saved.startLevel;
  if (typeof saved.sound === 'boolean') settings.sound = saved.sound;
  if (Array.isArray(saved.beaten)) settings.beaten = saved.beaten.filter((n: unknown) => typeof n === 'string');
} catch {
  // No storage: defaults it is.
}

/** Remembers that the player got out of the level with this id. */
export function markBeaten(id: string) {
  if (settings.beaten.includes(id)) return;
  settings.beaten.push(id);
  saveSettings();
}

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, but still applied for this session.
  }
}
