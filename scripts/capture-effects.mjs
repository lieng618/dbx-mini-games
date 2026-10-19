/**
 * Captures effect frames from the built UI in a plain browser.
 *
 * The UI's local bridge answers `dev.scenario` without a host, so the six effects can be
 * reviewed from `ui/` alone: serve the directory, drive the preview, and screenshot the
 * canvas at fixed ages after each scenario. Output goes to `scripts/out/`.
 *
 * Usage: node scripts/capture-effects.mjs [tag]
 */

import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "ui");
const OUT = resolve(import.meta.dirname, "out", process.argv[2] || "frames");
const PORT = 5391;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, "00-lobby.png") });

const shot = async (name) => page.screenshot({ path: join(OUT, `${name}.png`) });

// Host a room, then open the solo board that carries the scenario buttons.
await page.getByRole("button", { name: "开桌" }).click();
await page.waitForTimeout(600);
await page.getByRole("button", { name: "先摆一摆" }).click();
await page.waitForTimeout(900);
await shot("01-practice");

const runScenario = async (label, tag, frames) => {
  await page.getByRole("button", { name: label, exact: true }).click();
  const start = Date.now();
  for (const [i, ms] of frames.entries()) {
    const wait = ms - (Date.now() - start);
    if (wait > 0) await page.waitForTimeout(wait);
    await shot(`${tag}-${i}`);
  }
  await page.waitForTimeout(1400);
};

// Frames are chosen at the moments where the effect should look different from before:
// mid-expansion, near peak, and the settle.
await runScenario("开局", "02-landing", [90, 240, 520]);
await runScenario("吃子", "03-capture", [70, 200, 460]);
await runScenario("将军", "04-check", [80, 260, 620]);

await page.getByRole("checkbox", { name: "低动效模式" }).check();
await page.waitForTimeout(400);
await runScenario("将军", "05-check-lowmotion", [80, 300]);

// Gomoku five-in-a-row needs the other game, so rebuild the room for it.
await page.getByRole("checkbox", { name: "低动效模式" }).uncheck();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "结束练习" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "结束房间" }).click();
await page.waitForTimeout(400);
await page.selectOption("select", "gomoku");
await page.getByRole("button", { name: "开桌" }).click();
await page.waitForTimeout(500);
await page.getByRole("button", { name: "先摆一摆" }).click();
await page.waitForTimeout(800);
await runScenario("连五", "06-gomoku-win", [120, 400, 700]);

await writeFile(join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
console.log(JSON.stringify({ out: OUT, errors }, null, 2));

await browser.close();
server.close();
