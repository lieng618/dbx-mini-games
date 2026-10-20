// 验证：真对局里时钟会自己走（之前前端没有任何计时器，倒计时是死的）。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "clock";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT = 5420 + Math.floor(Math.random() * 40);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Two independent hosts: one opens the table, the other joins it over the LAN. A single
// host shares one plugin state between pages, so two tabs of the same host are not two
// players.
const startHost = (port, data) => {
  rmSync(data, { recursive: true, force: true });
  const h = spawn("dbx-plugin", ["dev", "--path", ROOT, "--port", String(port), "--data-dir", data], { cwd: ROOT });
  h.log = "";
  h.stdout.on("data", (d) => (h.log += d));
  h.stderr.on("data", (d) => (h.log += d));
  return h;
};
const waitUp = async (h) => {
  const started = Date.now();
  while (Date.now() - started < 90000 && !h.log.includes("调试服务已启动")) {
    await new Promise((r) => setTimeout(r, 400));
  }
};

const PORT_A = PORT;
const PORT_B = PORT + 1;
const hostA = startHost(PORT_A, `${DATA}-a`);
const hostB = startHost(PORT_B, `${DATA}-b`);
await waitUp(hostA);
await waitUp(hostB);

const browser = await chromium.launch();
const openTable = async (port) => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  await page.addInitScript(() => { window.__DBX_DEBUG_FX = true; });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.locator("button", { hasText: "棋牌桌" }).first().click();
  await page.waitForTimeout(2200);
  return page;
};

const hostPage = await openTable(PORT_A);
const hostFrame = hostPage.frameLocator("iframe").last();
await hostFrame.locator('input[type="number"]').nth(0).fill("3"); // 3 分钟
// The per-move limit has to outlast the measurement, or the match ends mid-read and the
// clock freezes for a legitimate reason.
await hostFrame.locator('input[type="number"]').nth(1).fill("120");
await hostFrame.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(1500);

// 第二个玩家：在另一个宿主上搜索并加入
const guestPage = await openTable(PORT_B);
const guestFrame = guestPage.frameLocator("iframe").last();
await guestFrame.getByRole("button", { name: /搜索局域网房间/ }).click();
await guestPage.waitForTimeout(3000);
const roomItem = guestFrame.locator(".room-list li").first();
const found = await roomItem.count();
let joined = false;
if (found > 0) {
  // The list row is not clickable; the 加入 button inside it is what joins.
  await roomItem.getByRole("button", { name: "加入" }).click();
  await guestPage.waitForTimeout(2600);
  const frB2 = guestPage.frames().find((f) => f !== guestPage.mainFrame());
  const after = await frB2.evaluate(() => window.dbxPlugin.invoke("room.snapshot", {}).catch(() => null));
  joined = after?.role === "guest" || after?.role === "host";
}

// 房主开局
await hostFrame.getByRole("button", { name: "开始对局" }).click();
await hostPage.waitForTimeout(1800);

const fr = hostPage.frames().find((f) => f !== hostPage.mainFrame());
const snapA = await fr.evaluate(() => window.dbxPlugin.invoke("room.snapshot", {}).catch((e) => ({ err: String(e) })));
const errText = (await hostFrame.locator("p.error").innerText().catch(() => "")).trim();
const guestErr = (await guestFrame.locator("p.error").innerText().catch(() => "")).trim();
const frB = guestPage.frames().find((f) => f !== guestPage.mainFrame());
const snapB = await frB.evaluate(() => window.dbxPlugin.invoke("room.snapshot", {}).catch((e) => ({ err: String(e) })));
console.log("DIAG host: phase=", JSON.stringify(snapA?.phase), "seats=", JSON.stringify(snapA?.seats),
            "members=", JSON.stringify((snapA?.members || []).map((m) => m.nickname + "@" + m.seat)),
            "clock=", JSON.stringify(snapA?.clock), "err=", JSON.stringify(errText));
console.log("DIAG guest: role=", JSON.stringify(snapB?.role), "seats=", JSON.stringify(snapB?.seats),
            "err=", JSON.stringify(guestErr), "raw=", JSON.stringify(snapB).slice(0, 200));

const sameFrameDom = await fr.evaluate(() =>
  Array.from(document.querySelectorAll(".seat-panel-clock")).map((e) => e.textContent.trim()).join("|"),
);
const clockText = async () => (await hostFrame.locator(".seat-panel-clock").allInnerTexts()).join("|");
const before = await clockText();
const moveBefore = await hostFrame.locator(".move-clock strong").innerText().catch(() => "");
await hostPage.waitForTimeout(3000);
const after = await clockText();
const moveAfter = await hostFrame.locator(".move-clock strong").innerText().catch(() => "");
await hostPage.screenshot({ path: `${OUT}/01-live.png` });

const parse = (s) => s.split("|").map((t) => {
  const [m, sec] = t.split(":").map(Number);
  return m * 60 + sec;
});
const b = parse(before);
const a = parse(after);
const ticked = b.length === a.length && b.some((v, i) => a[i] < v);

const report = {
  port: PORT,
  roomFound: found > 0,
  joined,
  before,
  after,
  moveBefore,
  moveAfter,
  ticked,
  ok: found > 0 && joined && ticked,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
hostA.kill("SIGKILL");
hostB.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
