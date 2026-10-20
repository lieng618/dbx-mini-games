// 验证：建房时的时间控制与选边生效、棋盘两侧有座位形象、走子时大手出现。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "setup";
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
await page.waitForTimeout(2200);

const frame = page.frameLocator("iframe").last();

// 设置：5 分钟总时长、30 秒每步、坐后手（seat 1）
const nums = frame.locator('input[type="number"]');
await nums.nth(0).fill("5");
await nums.nth(1).fill("30");
await frame.locator(".side-pick .pick", { hasText: "后手" }).click();
await frame.getByRole("button", { name: "开桌" }).click();
await page.waitForTimeout(1200);

const fr = page.frames().find((f) => f !== page.mainFrame());
const snap = await fr.evaluate(() => window.dbxPlugin.invoke("room.snapshot", {}));
const panelCount = await frame.locator(".seat-strip").count();
const seatTexts = await frame.locator(".seat-panel-name").allInnerTexts();
await page.screenshot({ path: `${OUT}/01-room.png` });

// 练习盘走一手，看手有没有被抓起来
await frame.getByRole("button", { name: "先摆一摆" }).click();
await page.waitForTimeout(1300);

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

await tapCell(54);
await page.waitForTimeout(220);
await tapCell(45);

let handSeen = false;
let maxAlpha = 0;
for (let i = 0; i < 16; i++) {
  const st = await fr.evaluate(() => {
    const s = window.__boardScene;
    return s && s.hand ? { alpha: s.hand.cursor.view.alpha, y: s.hand.cursor.view.y } : null;
  });
  if (st) {
    handSeen = true;
    maxAlpha = Math.max(maxAlpha, st.alpha);
  }
  await page.waitForTimeout(55);
}
await page.screenshot({ path: `${OUT}/02-hand.png` });

const report = {
  port: PORT,
  hostOnSeat1: snap?.seats?.[1] === snap?.selfId,
  budgetMs: snap?.clock?.budget,
  perMoveMs: snap?.clock?.perMove,
  seatPanels: panelCount,
  seatTexts,
  handSeen,
  maxHandAlpha: Number(maxAlpha.toFixed(2)),
  ok:
    snap?.seats?.[1] === snap?.selfId &&
    snap?.clock?.budget === 300000 &&
    snap?.clock?.perMove === 30000 &&
    panelCount === 2 &&
    handSeen &&
    maxAlpha > 0.5,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
host.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
