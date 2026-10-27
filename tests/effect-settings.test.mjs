import test from "node:test";
import assert from "node:assert/strict";

import { loadSettings } from "../src/storage.js";

function withStoredSettings(value, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: () => (value == null ? null : JSON.stringify(value)),
      setItem: () => {},
    },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("dynamic effects default to on", () => {
  withStoredSettings(null, () => {
    assert.equal(loadSettings().effectsEnabled, true);
  });
});

test("the removed reduced tier migrates to full effects", () => {
  withStoredSettings({ effectsLevel: "reduced", lowMotion: true, boardSize: "large" }, () => {
    const settings = loadSettings();
    assert.equal(settings.effectsEnabled, true);
    assert.equal(settings.boardSize, "large");
    assert.equal("effectsLevel" in settings, false);
    assert.equal("lowMotion" in settings, false);
  });
});

test("the previous effects-off choice migrates to the calm toggle", () => {
  withStoredSettings({ effectsLevel: "off" }, () => {
    assert.equal(loadSettings().effectsEnabled, false);
  });
});
