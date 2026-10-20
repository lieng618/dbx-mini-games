// 验证陪练：开局 -> 玩家走一手 -> 陪练自己回一手（且是合法的一手）。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "partner";
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
await page.waitForTimeout(1100);

// 开一局对陪练
await frame.getByRole("button", { name: "和陪练下" }).click();
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}/01-partner-start.png` });

const fr = page.frames().find((f) => f !== page.mainFrame());
const readState = () =>
  fr.evaluate(() => {
    const s = window.__boardScene;
    const st = window.__partnerProbe;
    return {
      pieces: s ? s.pieces.nodes.length : -1,
      effects: s ? s.effects.length : -1,
    };
  });

// 用后端快照判断走子数与轮到谁
const snapshot = async () => {
  const r = await fr.evaluate(() =>
    window.dbxPlugin.invoke("room.snapshot", {}).catch((e) => ({ error: String(e) })),
  );
  return r;
};

const before = await snapshot();
const movesBefore = before?.record?.moves?.length ?? 0;
const aiSeat = before?.aiSeat;
const turnBefore = before?.turnSeat;

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

// 玩家走红兵 54 -> 45
await tapCell(54);
await page.waitForTimeout(260);
await tapCell(45);
await page.waitForTimeout(2600); // 等陪练思考 + 回子

const after = await snapshot();
const movesAfter = after?.record?.moves?.length ?? 0;
const partnerMove = after?.record?.moves?.[movesAfter - 1];
await page.screenshot({ path: `${OUT}/02-after-partner.png` });

const report = {
  port: PORT,
  aiSeat,
  turnBefore,
  movesBefore,
  movesAfter,
  partnerMove,
  partnerReplied: movesAfter === movesBefore + 2,
  ok: aiSeat === 1 && movesAfter === movesBefore + 2 && !!partnerMove,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
host.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
