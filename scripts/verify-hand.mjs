// 抓一张手正在搬棋子的画面，并确认它从正确的座位侧伸入。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "hand";
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
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
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
  const r = c.getBoundingClientRect();
  const strips = Array.from(document.querySelectorAll(".seat-strip")).map((e) => {
    const b = e.getBoundingClientRect();
    return { cls: e.className, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  });
  return { canvas: { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }, strips };
});

const tapCell = async (cell) => {
  await fr.evaluate((c) => {
    const s = window.__boardScene;
    const rank = Math.floor(c / 9);
    const file = c % 9;
    const x = s.lay.originX + file * s.lay.step;
    const y = s.lay.originY + rank * s.lay.step;
    s.onPointer({ getLocalPosition: () => ({ x, y }) });
  }, cell);
};

// 走一手红兵（下方座位）
// Central squares: a piece at the board edge gets its shadow cropped by the paper margin,
// which tells you nothing about whether the shape reads.
await tapCell(64);
await page.waitForTimeout(200);
await tapCell(46);

let side = null;
let peakShot = false;

// Wait for the hand to appear, then freeze the renderer. A full-page screenshot takes about
// a second inside this sandboxed iframe, which is longer than the whole carry — sampling a
// live frame is how the hand "disappeared" in an earlier check.
for (let i = 0; i < 30 && !side; i++) {
  const st = await fr.evaluate(() => {
    const s = window.__boardScene;
    return s && s.hand ? { side: s.hand.cursor.side } : null;
  });
  if (st) side = st.side;
  else await page.waitForTimeout(30);
}

const frozen = await fr.evaluate(() => {
  const s = window.__boardScene;
  if (!s || !s.hand) return { ok: false };
  s.app.ticker.stop();
  const cur = s.hand.cursor;
  // Put the hand at the moment of the grip: fully arrived, fingers closed.
  cur.age = Math.max(cur.lead, cur.age);
  const node = s.hand.node;
  cur.view.position.set(node.container.x, node.container.y);
  cur.view.alpha = cur.restAlpha * 1.5;
  s.app.render();
  return { ok: true, x: cur.view.x, y: cur.view.y, alpha: cur.view.alpha, w: s.app.screen.width };
});

if (frozen.ok) {
  await page.screenshot({ path: `${OUT}/01-hand.png` });
  peakShot = true;
}

const report = {
  port: PORT,
  canvas: box.canvas,
  strips: box.strips.map((s) => `${s.cls.includes("near") ? "near" : "far"}@y${s.y} w${s.w}`),
  handSide: side,
  peakShot,
  ok: box.canvas.h > 400 && peakShot && side === "near",
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
host.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
