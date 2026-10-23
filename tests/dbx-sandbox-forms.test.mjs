import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/App.vue", import.meta.url), "utf8");

test("DBX workbench inputs do not depend on sandboxed form submission", () => {
  assert.doesNotMatch(source, /<form\b/);
  assert.match(source, /@keydown\.enter\.prevent="saveNickname"/);
  assert.match(source, /@click="saveNickname"/);
  assert.match(source, /@keydown\.enter\.prevent="submitJoinPassword"/);
  assert.match(source, /@click="submitJoinPassword"/);
});
