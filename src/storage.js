const LEGACY_RECORD_DB = "dbx-mini-games";
const SETTINGS_KEY = "dbxmg.settings";
const CREATE_ROOM_SETTINGS_KEY = "dbxmg.createRoom";

export const DEFAULT_SETTINGS = Object.freeze({
  effectsEnabled: true,
  boardSize: "standard",
  theme: "paper",
});

export const DEFAULT_CREATE_ROOM_SETTINGS = Object.freeze({
  game: "xiangqi",
  seat: 0,
  minutes: 0,
  moveSeconds: 0,
  scoring: true,
  passwordEnabled: false,
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw);
    return {
      // Older builds stored a three-way effectsLevel. "off" remains off; the former
      // "reduced" tier now comes from the operating system's motion preference.
      effectsEnabled:
        typeof stored.effectsEnabled === "boolean"
          ? stored.effectsEnabled
          : stored.effectsLevel !== "off",
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

/** Loads the previous create-room rule choices without retaining the password itself. */
export function loadCreateRoomSettings() {
  try {
    const raw = localStorage.getItem(CREATE_ROOM_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_CREATE_ROOM_SETTINGS };
    const stored = JSON.parse(raw);
    return {
      game: stored.game === "gomoku" ? "gomoku" : "xiangqi",
      seat: stored.seat === 1 ? 1 : 0,
      minutes: [0, 10, 20, 30, 60].includes(Number(stored.minutes))
        ? Number(stored.minutes)
        : 0,
      moveSeconds: [0, 15, 30, 60].includes(Number(stored.moveSeconds))
        ? Number(stored.moveSeconds)
        : 0,
      scoring: stored.scoring !== false,
      passwordEnabled: stored.passwordEnabled === true,
    };
  } catch {
    return { ...DEFAULT_CREATE_ROOM_SETTINGS };
  }
}

export function saveCreateRoomSettings(settings) {
  try {
    localStorage.setItem(CREATE_ROOM_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Rule defaults still apply when storage is unavailable.
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
