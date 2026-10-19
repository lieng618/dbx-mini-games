/**
 * Runs one verification pass against a freshly started DBX dev host.
 *
 * The host persists room state in --data-dir, so a second run against the same directory
 * opens with a room already in it and the lobby buttons are gone. Every pass therefore owns
 * a throwaway data directory and its own port.
 *
 * Usage: node scripts/verify-round.mjs <tag>
 */

import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const tag = process.argv[2] || "round";
const PORT = 5420 + Math.floor(Math.random() * 40);
const DATA = `/tmp/dbxbg-verify-${tag}`;
const OUT = resolve(import.meta.dirname, "out", tag);
const ROOT = resolve(import.meta.dirname, "..");

await rm(DATA, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const host = spawn("dbx-plugin", ["dev", "--path", ROOT, "--port", String(PORT), "--data-dir", DATA], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let hostLog = "";
host.stdout.on("data", (d) => (hostLog += d));
host.stderr.on("data", (d) => (hostLog += d));

/** Waits for the dev server to announce its port. */
async function waitForHost(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hostLog.includes("调试服务已启动") || hostLog.includes("Plugin dev host")) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`dev host did not start:\n${hostLog.slice(-2000)}`);
}

const md5 = (buf) => createHash("md5").update(buf).digest("hex").slice(0, 10);

try {
  await waitForHost();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.locator("button", { hasText: "棋牌桌" }).first().click();
  await page.waitForTimeout(2200);
  const frame = page.frameLocator("iframe").last();

  const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
  const canvasBox = () => frame.locator("canvas").boundingBox();

  await shot("00-lobby");

  await frame.getByRole("button", { name: "开桌" }).click();
  await page.waitForTimeout(1000);
  await frame.getByRole("button", { name: "先摆一摆" }).click();
  await page.waitForTimeout(1300);
  await shot("01-practice");

  // The dev host restores the profile, so a previous pass could leave low-motion checked.
  const lowMotion = frame.getByRole("checkbox", { name: "低动效模式" });
  const lowMotionLabel = frame.locator("label.toggle", { hasText: "低动效模式" });
  if (await lowMotion.isChecked()) {
    await lowMotionLabel.click();
    await page.waitForTimeout(400);
  }

  // Motion check: a move must produce distinct composite frames, not one static picture.
  const box = await canvasBox();
  await frame.getByRole("button", { name: "开局", exact: true }).click();
  const frameHashes = [];
  for (let i = 0; i < 12; i++) {
    frameHashes.push(md5(await page.screenshot({ clip: box })));
    await page.waitForTimeout(25);
  }

  const runScenario = async (label, name, frames) => {
    await frame.getByRole("button", { name: label, exact: true }).click();
    const start = Date.now();
    for (const [i, ms] of frames.entries()) {
      const wait = ms - (Date.now() - start);
      if (wait > 0) await page.waitForTimeout(wait);
      await shot(`${name}-${i}`);
    }
    await page.waitForTimeout(1900);
  };

  await runScenario("开局", "02-landing", [160, 320, 620]);
  await runScenario("吃子", "03-capture", [140, 300, 560]);
  await runScenario("将军", "04-check", [120, 340, 720]);

  await lowMotionLabel.click();
  await page.waitForTimeout(400);
  await runScenario("将军", "05-check-lowmotion", [120, 380]);
  await lowMotionLabel.click();
  await page.waitForTimeout(400);

  // Gomoku needs its own room.
  await frame.getByRole("button", { name: "结束练习" }).click();
  await page.waitForTimeout(500);
  await frame.getByRole("button", { name: "结束房间" }).click();
  await page.waitForTimeout(700);
  await frame.locator("select").selectOption("gomoku");
  await frame.getByRole("button", { name: "开桌" }).click();
  await page.waitForTimeout(1000);
  await frame.getByRole("button", { name: "先摆一摆" }).click();
  await page.waitForTimeout(1200);
  await shot("06-gomoku-opening");
  await runScenario("连五", "07-gomoku-win", [160, 720, 1150, 1600]);

  const report = {
    port: PORT,
    motion: {
      distinctFrames: new Set(frameHashes).size,
      sampled: frameHashes.length,
      hashes: frameHashes,
    },
    errors,
  };
  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: OUT, motion: report.motion, errorsCount: errors.length }, null, 2));

  await browser.close();
} finally {
  host.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 600));
}
