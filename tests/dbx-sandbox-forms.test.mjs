import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/App.vue", import.meta.url), "utf8");
const settingsSource = await readFile(
  new URL("../src/components/SettingsDrawer.vue", import.meta.url),
  "utf8",
);

test("DBX workbench inputs do not depend on sandboxed form submission", () => {
  assert.doesNotMatch(source, /<form\b/);
  assert.doesNotMatch(settingsSource, /<form\b/);
  assert.match(settingsSource, /@keydown\.enter\.prevent="emit\('save'\)"/);
  assert.match(settingsSource, /@click="emit\('save'\)"/);
  assert.match(source, /@keydown\.enter\.prevent="submitJoinPassword"/);
  assert.match(source, /@click="submitJoinPassword"/);
});
