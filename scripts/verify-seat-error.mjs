// 验证：房主独自开桌后点「开始对局」，提示必须是「还差一位对手」，不能是「满了」。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "seat";
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
if (!log.includes("调试服务已启动")) {
  console.error("host failed to start:\n" + log);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.locator("button", { hasText: "棋牌桌" }).first().click();
await page.waitForTimeout(2200);

const frame = page.frameLocator("iframe").last();
await frame.getByRole("button", { name: "开桌" }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/01-lobby-alone.png` });

// 房间里只有房主一个人，此时点「开始对局」
await frame.getByRole("button", { name: "开始对局" }).click();
await page.waitForTimeout(800);
const err = (await frame.locator("p.error").innerText().catch(() => "")).trim();
await page.screenshot({ path: `${OUT}/02-start-alone.png` });

const saysFull = /满/.test(err);
const saysNeedOpponent = /还差一位对手/.test(err);
const ok = saysNeedOpponent && !saysFull;

console.log(JSON.stringify({ port: PORT, error: err, saysFull, saysNeedOpponent, ok }, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ port: PORT, error: err, saysFull, saysNeedOpponent, ok }, null, 2));

await browser.close();
host.kill("SIGKILL");
process.exit(ok ? 0 : 2);
