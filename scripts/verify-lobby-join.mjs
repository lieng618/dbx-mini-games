// 验证「朋友加入后，房主看得见对手并开局」这条完整链路。
//
// 旧脚本（verify-invite）只断言客人拿到 role === "guest" 就结束了，所以
// 「客人已坐下、房主界面仍显示空座、对局开不起来」这个卡死问题从没被覆盖。
// 这里把断言推进到房主界面的座位卡片和双方的开局状态。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "lobby-join";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT_A = 5460 + Math.floor(Math.random() * 20);
const PORT_B = PORT_A + 21;
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
const open = async (port) => {
  const p = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  await p.locator("button", { hasText: "棋牌桌" }).first().click();
  await p.waitForTimeout(2200);
  return p;
};

// 插件的界面在 iframe 里，且要点开「棋牌桌」之后才创建，所以这里等它出现而不是直接取。
const frameOf = async (page) => {
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((x) => x !== page.mainFrame());
    if (f) return f;
    await page.waitForTimeout(300);
  }
  throw new Error("插件的 iframe 一直没有出现");
};
const seatNamesOf = (fr) =>
  fr.evaluate(() => [...document.querySelectorAll(".seat-name")].map((el) => el.textContent.trim()));
const phaseOf = (fr) =>
  fr.evaluate(() => window.dbxPlugin.invoke("room.snapshot", {}).then((s) => s && s.phase).catch(() => null));

const report = { port: PORT_A, steps: [] };
const step = (name, value) => report.steps.push({ name, value });

// ── 房主开桌 ────────────────────────────────────────────────────────────────────────
const hostPage = await open(PORT_A);
const hostFr = await frameOf(hostPage);
await hostFr.waitForSelector("button", { timeout: 20000 });
await hostFr.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(1500);

const invite = await hostFr.evaluate(() => {
  const el = document.querySelector("code.invite");
  return el ? el.textContent.trim() : "";
});
step("inviteParts", invite ? invite.split("#").length : 0);
step("hostSeatsBefore", await seatNamesOf(hostFr));
await hostPage.screenshot({ path: `${OUT}/01-host-lobby.png` });

// ── 客人加入 ────────────────────────────────────────────────────────────────────────
const guestPage = await open(PORT_B);
const guestFr = await frameOf(guestPage);
await guestFr.waitForSelector('input[type="text"]', { timeout: 20000 });
await guestFr.locator('input[type="text"]').last().fill(invite);
await guestFr.getByRole("button", { name: "按地址加入" }).click();
await guestPage.waitForTimeout(3000);

step("guestSeats", await seatNamesOf(guestFr));
step("guestErr", (await guestFr.locator("p.error").innerText().catch(() => "")).trim());

// ── 核心断言：房主界面必须看见对手 ───────────────────────────────────────────────────
// 座位卡片里除房主自己以外的那一格，必须不再是「空座」。
await hostPage.waitForTimeout(1200);
const hostSeatsAfter = await seatNamesOf(hostFr);
step("hostSeatsAfterJoin", hostSeatsAfter);
const hostSeesRival = hostSeatsAfter.some((name) => name && name !== "空座");
step("hostSeesRival", hostSeesRival);
await hostPage.screenshot({ path: `${OUT}/02-host-sees-rival.png` });

// ── 房主开局 ────────────────────────────────────────────────────────────────────────
let started = false;
try {
  await hostFr.getByRole("button", { name: "开始对局" }).click({ timeout: 8000 });
  await hostPage.waitForTimeout(2000);
  started = true;
} catch (e) {
  step("startClickError", String(e?.message || e).slice(0, 160));
}

const hostPhase = await phaseOf(hostFr);
const guestPhase = await phaseOf(guestFr);
step("hostPhase", hostPhase);
step("guestPhase", guestPhase);

// 客人界面也要自己走到「对局中」，不能停在「等待开始」。
const guestHint = await guestFr.evaluate(() => {
  const el = document.querySelector("p.hint");
  return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
});
step("guestHint", guestHint);
const guestShowsPlaying = guestHint.includes("对局中");
step("guestShowsPlaying", guestShowsPlaying);

await guestPage.screenshot({ path: `${OUT}/03-guest-playing.png` });
await hostPage.screenshot({ path: `${OUT}/04-host-playing.png` });

report.ok =
  report.steps.find((s) => s.name === "inviteParts")?.value === 3 &&
  hostSeesRival &&
  started &&
  hostPhase === "playing" &&
  guestPhase === "playing" &&
  guestShowsPlaying;

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
A.kill("SIGKILL");
B.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
