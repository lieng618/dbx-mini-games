// 验证「搜索局域网房间」列表显示的是房间名，不是房间 id。
//
// 广播侧的 mDNS instance 必须保持唯一，所以它带的是房间 id；房间名走 TXT 的 name 字段。
// 旧实现只读 instance，搜索列表里于是显示一串 id——正是玩家唯一认不出来的东西。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "scan-name";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT_A = 5520 + Math.floor(Math.random() * 20);
const PORT_B = PORT_A + 21;
const ROOM_NAME = "老张的棋桌";
rmSync(DATA, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const startHost = (port, dir) => {
  rmSync(dir, { recursive: true, force: true });
  const h = spawn("dbx-plugin", ["dev", "--path", ROOT, "--port", String(port), "--data-dir", dir], { cwd: ROOT });
  h.log = "";
  h.stdout.on("data", (d) => (h.log += d));
  h.stderr.on("data", (d) => (h.log += d));
  return h;
};
const waitUp = async (h) => {
  const t = Date.now();
  while (Date.now() - t < 90000 && !h.log.includes("调试服务已启动")) await new Promise((r) => setTimeout(r, 400));
  if (!h.log.includes("调试服务已启动")) throw new Error("调试服务启动超时");
};

const A = startHost(PORT_A, `${DATA}-a`);
const B = startHost(PORT_B, `${DATA}-b`);
await waitUp(A);
await waitUp(B);

const browser = await chromium.launch();
const frameOf = async (page) => {
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((x) => x !== page.mainFrame());
    if (f) return f;
    await page.waitForTimeout(300);
  }
  throw new Error("插件的 iframe 一直没有出现");
};

const report = { port: PORT_A, roomName: ROOM_NAME, steps: [] };
const step = (name, value) => report.steps.push({ name, value });

// ── 房主开桌，带上可识别的房间名 ──────────────────────────────────────────────────────
const hostPage = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await hostPage.goto(`http://127.0.0.1:${PORT_A}/`, { waitUntil: "load" });
await hostPage.waitForTimeout(1500);
await hostPage.locator("button", { hasText: "棋牌桌" }).first().click();
await hostPage.waitForTimeout(1500);
const hostFr = await frameOf(hostPage);

await hostFr.locator('input[placeholder="我的棋室"]').fill(ROOM_NAME);
await hostFr.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(2000);
step("hostRoomName", await hostFr.evaluate(() => {
  const el = document.querySelector("h2");
  return el ? el.textContent.trim() : "";
}));

// ── 客人搜索 ────────────────────────────────────────────────────────────────────────
const guestPage = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await guestPage.goto(`http://127.0.0.1:${PORT_B}/`, { waitUntil: "load" });
await guestPage.waitForTimeout(1500);
await guestPage.locator("button", { hasText: "棋牌桌" }).first().click();
await guestPage.waitForTimeout(1500);
const guestFr = await frameOf(guestPage);

// 直接调 RPC 看原始字段，再点按钮看渲染结果——两层都要对。
const raw = await guestFr.evaluate(() =>
  window.dbxPlugin.invoke("lobby.scan", { windowMs: 2500 }).then((r) => r && r.rooms).catch((e) => String(e))
);
step("scanRaw", Array.isArray(raw) ? raw.map((r) => ({ name: r.name, roomId: r.roomId, address: r.address })) : String(raw));

await guestFr.getByRole("button", { name: /搜索局域网房间/ }).click();
await guestPage.waitForTimeout(4000);
const rows = await guestFr.evaluate(() =>
  [...document.querySelectorAll(".room-list li")].map((li) => ({
    name: li.querySelector("strong")?.textContent.trim() ?? "",
    detail: li.querySelector("small")?.textContent.trim() ?? "",
  }))
);
step("renderedRows", rows);
await guestPage.screenshot({ path: `${OUT}/01-scan-list.png` });

const foundByName = rows.some((r) => r.name === ROOM_NAME);
step("showsRoomName", foundByName);
// 反过来确认没有退化成 id 显示：房间名不该长得像 uuid/随机串。
const looksLikeId = rows.some((r) => /^[0-9a-f]{8,}$/i.test(r.name));
step("showsRawId", looksLikeId);

report.ok = foundByName && !looksLikeId;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
A.kill("SIGKILL");
B.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
