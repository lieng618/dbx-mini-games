// 验证「加」的三件事：棋子碎裂、屏幕闪白、冲击波幅度。
// 属性名不会被压缩，所以靠 wedges / sheet / amplitude 判定，而不是类名。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "impact";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { window.__DBX_DEBUG_FX = true; });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.locator("button", { hasText: "棋牌桌" }).first().click();
await page.waitForTimeout(2200);

const frame = page.frameLocator("iframe").last();
await frame.getByRole("button", { name: "开桌" }).click();
await page.waitForTimeout(1000);
await frame.getByRole("button", { name: "先摆一摆" }).click();
await page.waitForTimeout(1200);

const fr = page.frames().find((f) => f !== page.mainFrame());
const sample = () =>
  fr.evaluate(() => {
    const s = window.__boardScene;
    if (!s) return { missingScene: true };
    return {
      shatter: s.effects.filter((e) => Array.isArray(e.wedges)).length,
      wedgeCount: s.effects.filter((e) => Array.isArray(e.wedges)).reduce((n, e) => n + e.wedges.length, 0),
      flash: s.effects.filter((e) => e.sheet).length,
      shockAmplitude: s.shock ? Math.round(s.shock.amplitude) : 0,
      total: s.effects.length,
    };
  });

// ── 吃子：走一手真实吃子 ──
// 场景按钮把整条线一次性下发，快照 diff 会判成 rebuild，没有逐手动画。所以这里调用场景
// 自己的指针入口（不是裸 invoke），走的是「选中 -> 走子 -> 快照 -> diff -> 特效」全程。
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

await tapCell(70);                       // 选中红炮
await page.waitForTimeout(260);
await tapCell(7);                        // 炮打马：一手真实吃子

const captureSamples = [];
for (let i = 0; i < 18; i++) {
  captureSamples.push(await sample());
  await page.waitForTimeout(70);
}
await page.screenshot({ path: `${OUT}/01-capture.png` });

const sawShatter = captureSamples.some((s) => s.shatter > 0);
const sawFlash = captureSamples.some((s) => s.flash > 0);
const maxWedges = Math.max(0, ...captureSamples.map((s) => s.wedgeCount));
const maxCaptureShock = Math.max(0, ...captureSamples.map((s) => s.shockAmplitude));

// ── 将军：冲击波幅度应明显更大 ──
await page.waitForTimeout(900);
await frame.getByRole("button", { name: "将军", exact: true }).click();
const checkSamples = [];
for (let i = 0; i < 10; i++) {
  checkSamples.push(await sample());
  await page.waitForTimeout(80);
}
const maxCheckShock = Math.max(0, ...checkSamples.map((s) => s.shockAmplitude));
await page.screenshot({ path: `${OUT}/02-check.png` });

const report = {
  port: PORT,
  sawShatter,
  sawFlash,
  maxWedges,
  maxCaptureShock,
  maxCheckShock,
  ok: sawShatter && sawFlash && maxWedges >= 11 && maxCheckShock > 40,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, captureSamples, checkSamples }, null, 2));
await browser.close();
host.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
