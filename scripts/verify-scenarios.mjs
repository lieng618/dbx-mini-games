// 验证三件事：象棋「开局」不再报错、将军徽章会消失、特效确实在播。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "scen";
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
// 打开场景调试钩子，否则跨域 iframe 里拿不到 scene 句柄
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

const readError = async () => (await frame.locator("p.error").innerText().catch(() => "")).trim();
const hasFlag = async () => await frame.locator("span.check-flag").count() > 0;
const readEffects = async () => {
  const fr = page.frames().find((f) => f !== page.mainFrame());
  return fr.evaluate(() => {
    const s = window.__boardScene;
    if (!s) return { none: true };
    return {
      effects: s.effects.map((e) => e.constructor.name),
      shock: !!s.shock,
      filtersOnRoot: !!(s.root && s.root.filters && s.root.filters.length),
    };
  });
};

// 1) 象棋「开局」
await frame.getByRole("button", { name: "开局", exact: true }).click();
await page.waitForTimeout(1400);
const openingErr = await readError();
await page.screenshot({ path: `${OUT}/01-xiangqi-opening.png` });

// 2) 「将军」：应有特效 + 徽章
await frame.getByRole("button", { name: "将军", exact: true }).click();
await page.waitForTimeout(420);
const duringCheck = await readEffects();
const flagDuring = await hasFlag();
await page.screenshot({ path: `${OUT}/02-check-active.png` });
await page.waitForTimeout(1200);
const checkErr = await readError();

// 3) 回到「开局」：将军状态必须解除，徽章消失
await frame.getByRole("button", { name: "开局", exact: true }).click();
await page.waitForTimeout(1500);
const flagAfter = await hasFlag();
const afterErr = await readError();
await page.screenshot({ path: `${OUT}/03-after-reset.png` });

const report = {
  port: PORT,
  openingErr,
  checkErr,
  afterErr,
  flagDuring,
  flagAfter,
  duringCheck,
  ok: openingErr === "" && checkErr === "" && afterErr === "" && flagDuring === true && flagAfter === false,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
host.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
