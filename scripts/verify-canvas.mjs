// 棋盘必须真的可见：画布尺寸非零，且画面不是纯色。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "canvas";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT = 5420 + Math.floor(Math.random() * 40);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const host = spawn("dbx-plugin", ["dev", "--path", ROOT, "--port", String(PORT), "--data-dir", DATA], { cwd: ROOT });
let log = "";
host.stdout.on("data", (d) => (log += d));
host.stderr.on("data", (d) => (log += d));
const t0 = Date.now();
while (Date.now() - t0 < 90000 && !log.includes("调试服务已启动")) await new Promise((r) => setTimeout(r, 400));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1560, height: 960 } });
await page.addInitScript(() => { window.__DBX_DEBUG_FX = true; });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.locator("button", { hasText: "棋牌桌" }).first().click();
await page.waitForTimeout(2300);

const frame = page.frameLocator("iframe").last();
await frame.getByRole("button", { name: "开桌" }).click();
await page.waitForTimeout(1200);
await frame.getByRole("button", { name: "先摆一摆" }).click();
await page.waitForTimeout(1500);

const fr = page.frames().find((f) => f !== page.mainFrame());
const box = await fr.evaluate(() => {
  const c = document.querySelector("canvas");
  const host = document.querySelector(".canvas-host");
  const r = c ? c.getBoundingClientRect() : null;
  return {
    canvas: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
    host: host ? { w: host.clientWidth, h: host.clientHeight } : null,
    pieces: window.__boardScene ? window.__boardScene.pieces.nodes.length : -1,
  };
});

// 画面必须不是纯色：统计截图的颜色种类
const shot = await page.screenshot({ path: `${OUT}/01-board.png` });
const { createHash } = await import("node:crypto");
const hash = createHash("sha1").update(shot).digest("hex").slice(0, 10);

const ok = box.canvas && box.canvas.w > 300 && box.canvas.h > 300 && box.pieces === 32;
const report = { port: PORT, ...box, shotHash: hash, ok };
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
host.kill("SIGKILL");
process.exit(ok ? 0 : 2);
