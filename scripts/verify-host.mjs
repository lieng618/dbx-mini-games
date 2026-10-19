/**
 * Verifies the six effects against the real DBX dev host.
 *
 * Unlike capture-effects.mjs (which drives the local preview stand-in), this connects to
 * `dbx-plugin dev` so the positions come from the Go sidecar and its scenario fixtures. That
 * is the only way to know an effect fires on a position a real game can reach.
 *
 * Usage: node scripts/verify-host.mjs <port> <tag>
 */

import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const port = process.argv[2] || "5401";
const tag = process.argv[3] || "host";
const OUT = resolve(import.meta.dirname, "out", tag);
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForTimeout(1200);
// The dev host starts on its own shell, not on the plugin: open the workbench first. The
// plugin itself then renders inside an about:srcdoc iframe, so every locator has to go
// through the frame or it will never match.
await page.locator("button", { hasText: "棋牌桌" }).first().click();
await page.waitForTimeout(2200);
const frame = page.frameLocator("iframe[srcdoc], iframe").last();
await page.screenshot({ path: join(OUT, "00-lobby.png") });

const log = [];
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};

// Open a room for the requested game and switch to the practice board.
const openPractice = async (game) => {
  const select = frame.locator("select");
  if (game === "gomoku" && (await select.count())) await select.selectOption("gomoku");
  await frame.getByRole("button", { name: "开桌" }).click();
  await page.waitForTimeout(1200);
  await frame.getByRole("button", { name: "先摆一摆" }).click();
  await page.waitForTimeout(1300);
};

await openPractice("xiangqi");
// The dev host persists the profile in --data-dir, so a previous run that left low-motion
// checked would silently turn every capture below into the calm path. Force it off.
const lowToggle = frame.getByRole("checkbox", { name: "低动效模式" });
if (await lowToggle.isChecked()) {
  await lowToggle.uncheck();
  await page.waitForTimeout(500);
}
await shot("01-practice");

const runScenario = async (label, name, frames) => {
  const button = frame.getByRole("button", { name: label, exact: true });
  await button.click();
  const start = Date.now();
  for (const [i, ms] of frames.entries()) {
    const wait = ms - (Date.now() - start);
    if (wait > 0) await page.waitForTimeout(wait);
    await shot(`${name}-${i}`);
  }
  await page.waitForTimeout(1800);
  log.push({ scenario: name, frames: frames.length });
};

await runScenario("开局", "02-landing", [110, 260, 560]);
await runScenario("吃子", "03-capture", [80, 220, 480]);
await runScenario("将军", "04-check", [90, 280, 660]);

await frame.getByRole("checkbox", { name: "低动效模式" }).check();
await page.waitForTimeout(400);
await runScenario("将军", "05-check-lowmotion", [90, 320]);
await frame.getByRole("checkbox", { name: "低动效模式" }).uncheck();
await page.waitForTimeout(300);

// Rebuild the room for gomoku so 连五 runs against the sidecar's own fixture.
await frame.getByRole("button", { name: "结束练习" }).click();
await page.waitForTimeout(500);
await frame.getByRole("button", { name: "结束房间" }).click();
await page.waitForTimeout(600);
await openPractice("gomoku");
await shot("06-gomoku-opening");
await runScenario("连五", "07-gomoku-win", [140, 700, 1100, 1500]);

await writeFile(join(OUT, "report.json"), JSON.stringify({ port, log, errors }, null, 2));
console.log(JSON.stringify({ out: OUT, log, errors }, null, 2));

await browser.close();
