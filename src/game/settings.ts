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
};

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (typeof saved.mouseSpeed === 'number') settings.mouseSpeed = saved.mouseSpeed;
  if (typeof saved.invertY === 'boolean') settings.invertY = saved.invertY;
  if (typeof saved.startLevel === 'number') settings.startLevel = saved.startLevel;
} catch {
  // No storage: defaults it is.
}

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not remembered, but still applied for this session.
  }
}
