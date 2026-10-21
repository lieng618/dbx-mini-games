// 验证「五子棋连五之后，结算画面出现在界面上」。
//
// 结算横幅读的是快照里的 result，而终局是在落子那一步内就把 phase 推到 finished 的。
// 旧实现只在该 phase 为 playing/practice 时输出 result，于是横幅永远不出现——但拖动
// 回放游标读的是棋谱记录，同一局却能看到结果，这种「一处有、一处没有」最容易漏掉。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "result-banner";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT_A = 5580 + Math.floor(Math.random() * 20);
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
const openPage = async (port) => {
  const p = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  await p.locator("button", { hasText: "棋牌桌" }).first().click({ timeout: 30000 });
  await p.waitForTimeout(2500);
  return p;
};
const frameOf = async (page) => {
  await page.waitForSelector("iframe", { timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 80; i++) {
    const f = page.frames().find((x) => x !== page.mainFrame());
    if (f) return f;
    await page.waitForTimeout(300);
  }
  throw new Error("插件的 iframe 一直没有出现");
};

const report = { port: PORT_A, steps: [] };
const step = (name, value) => report.steps.push({ name, value });
const invoke = (fr, method, params) =>
  fr.evaluate(([m, p]) => window.dbxPlugin.invoke(m, p), [method, params]);

// ── 房主开一桌五子棋 ────────────────────────────────────────────────────────────────
const hostPage = await openPage(PORT_A);
const hostFr = await frameOf(hostPage);
await hostFr.locator('input[placeholder="我的棋室"]').fill("结算验证");
await hostFr.locator("select").selectOption("gomoku");
await hostFr.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(1800);
step("hint", await hostFr.evaluate(() => document.querySelector("p.hint")?.textContent.trim() ?? ""));

const invite = await hostFr.evaluate(() => {
  const el = document.querySelector("code.invite");
  return el ? el.textContent.trim() : "";
});
step("inviteParts", invite ? invite.split("#").length : 0);

// ── 客人加入并开局 ──────────────────────────────────────────────────────────────────
const guestPage = await openPage(PORT_B);
const guestFr = await frameOf(guestPage);
await guestFr.locator('input[type="text"]').last().fill(invite);
await guestFr.getByRole("button", { name: "按地址加入" }).click();
await guestPage.waitForTimeout(3000);
step("guestRole", await invoke(guestFr, "room.snapshot", {}).then((s) => s && s.role));

await hostFr.getByRole("button", { name: "开始对局" }).click();
await hostPage.waitForTimeout(1500);
step("hostPhaseAfterStart", await invoke(hostFr, "room.snapshot", {}).then((s) => s && s.phase));

// ── 先手在顶边连成五个，后手在远处浪费走子 ──────────────────────────────────────────
const script = [
  [hostFr, 0], [guestFr, 100],
  [hostFr, 1], [guestFr, 101],
  [hostFr, 2], [guestFr, 102],
  [hostFr, 3], [guestFr, 103],
  [hostFr, 4],
];
for (const [fr, to] of script) {
  await invoke(fr, "game.move", { from: -1, to });
  await hostPage.waitForTimeout(320);
}
await hostPage.waitForTimeout(1600);

const hostPhase = await invoke(hostFr, "room.snapshot", {}).then((s) => s && s.phase);
step("hostPhaseAfterWin", hostPhase);

// 快照里必须带 result，否则横幅没有数据可读。
const snapshotResult = await invoke(hostFr, "room.snapshot", {}).then((s) => s && s.result);
step("snapshotResult", snapshotResult);

// 真正要验的是界面：横幅得出现在两个窗口里。
const bannerOf = (fr) =>
  fr.evaluate(() => {
    const el = document.querySelector(".result-banner");
    return el ? el.innerText.replace(/\s+/g, " ").trim() : "";
  });
const hostBanner = await bannerOf(hostFr);
const guestBanner = await bannerOf(guestFr);
step("hostBanner", hostBanner);
step("guestBanner", guestBanner);

await hostPage.screenshot({ path: `${OUT}/01-host-result.png` });
await guestPage.screenshot({ path: `${OUT}/02-guest-result.png` });

report.ok =
  hostPhase === "finished" &&
  !!snapshotResult &&
  hostBanner.length > 0 &&
  guestBanner.length > 0;

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
A.kill("SIGKILL");
B.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
