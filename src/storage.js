const LEGACY_RECORD_DB = "dbx-mini-games";
const SETTINGS_KEY = "dbxmg.settings";

export const DEFAULT_SETTINGS = Object.freeze({
  lowMotion: false,
  effectsLevel: "full",
  boardSize: "standard",
  theme: "paper",
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw);
    return {
      lowMotion: stored.lowMotion === true,
      effectsLevel: stored.effectsLevel || DEFAULT_SETTINGS.effectsLevel,
      boardSize: ["compact", "standard", "large"].includes(stored.boardSize)
        ? stored.boardSize
        : DEFAULT_SETTINGS.boardSize,
      theme: stored.theme || DEFAULT_SETTINGS.theme,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A sandbox that disables storage should still allow the current session to work.
  }
}

/**
 * The local archive was intentionally removed. Delete the previous IndexedDB database
 * once so existing users do not keep hidden copies of records the product no longer
 * exposes or maintains.
 */
export function clearLegacyRecords() {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(LEGACY_RECORD_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
