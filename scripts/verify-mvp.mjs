// 验证结算的 MVP 面板：五子棋连五后，双方窗口都要弹出整活结算。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "mvp";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT_A = 5620 + Math.floor(Math.random() * 20);
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

const hostPage = await openPage(PORT_A);
const hostFr = await frameOf(hostPage);
await hostFr.locator('input[placeholder="我的棋室"]').fill("MVP验证");
await hostFr.locator("select").selectOption("gomoku");
await hostFr.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(1800);

const invite = await hostFr.evaluate(() => document.querySelector("code.invite")?.textContent.trim() ?? "");
const guestPage = await openPage(PORT_B);
const guestFr = await frameOf(guestPage);
await guestFr.locator('input[type="text"]').last().fill(invite);
await guestFr.getByRole("button", { name: "按地址加入" }).click();
await guestPage.waitForTimeout(3000);

await hostFr.getByRole("button", { name: "开始对局" }).click();
await hostPage.waitForTimeout(1500);

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
// 终局后立刻检查：棋盘还在演连线与印章，面板必须还没出来。
await hostPage.waitForTimeout(400);
const mvpBeforeDelay = await hostFr.evaluate(() => !!document.querySelector(".mvp"));
step("mvpBeforeDelay", mvpBeforeDelay);

// 等特效演完（约 2.15s），面板才登场。
await hostPage.waitForTimeout(2600);

const panelOf = (fr) =>
  fr.evaluate(() => {
    const root = document.querySelector(".mvp");
    if (!root) return null;
    return {
      badge: root.querySelector(".mvp-badge")?.textContent.trim() ?? "",
      name: root.querySelector(".mvp-name")?.textContent.trim() ?? "",
      title: root.querySelector(".mvp-title")?.textContent.trim() ?? "",
      reason: root.querySelector(".mvp-reason")?.textContent.trim() ?? "",
      stats: [...root.querySelectorAll(".mvp-stats > div")].map((d) => ({
        label: d.querySelector("dt")?.textContent.trim() ?? "",
        value: d.querySelector("dd")?.textContent.trim() ?? "",
      })),
      // 彩带是面板的兄弟节点（整窗飘），不在面板内部。
      ribbons: document.querySelectorAll(".mvp-confetti i").length,
    };
  });

const hostMvp = await panelOf(hostFr);
const guestMvp = await panelOf(guestFr);
step("hostMvp", hostMvp);
step("guestMvp", guestMvp);

// 面板必须待在左侧栏里，不能盖住棋盘——棋盘上有连线与印章等结算特效。
const geometry = await hostFr.evaluate(() => {
  const mvp = document.querySelector(".mvp");
  const canvas = document.querySelector("canvas");
  if (!mvp || !canvas) return null;
  const m = mvp.getBoundingClientRect();
  const c = canvas.getBoundingClientRect();
  return {
    mvp: { left: Math.round(m.left), right: Math.round(m.right), width: Math.round(m.width) },
    canvas: { left: Math.round(c.left), right: Math.round(c.right), width: Math.round(c.width) },
    overlapsBoard: m.right > c.left + 1,
  };
});
step("geometry", geometry);
await hostPage.screenshot({ path: `${OUT}/01-host-mvp.png` });
await guestPage.screenshot({ path: `${OUT}/02-guest-mvp.png` });

// 关掉面板后横幅应接上，而不是留下一片空白。
await hostFr.getByRole("button", { name: "看看棋盘" }).click();
await hostPage.waitForTimeout(700);
const bannerAfterDismiss = await hostFr.evaluate(
  () => document.querySelector(".result-banner")?.innerText.replace(/\s+/g, " ").trim() ?? ""
);
step("bannerAfterDismiss", bannerAfterDismiss);
await hostPage.screenshot({ path: `${OUT}/03-after-dismiss.png` });

report.ok =
  !!hostMvp && !!guestMvp &&
  hostMvp.badge === "MVP" &&
  hostMvp.name.length > 0 &&
  hostMvp.title.length > 0 &&
  hostMvp.stats.length >= 2 &&
  hostMvp.ribbons > 0 &&
  !!geometry && !geometry.overlapsBoard && geometry.mvp.width <= 340 &&
  mvpBeforeDelay === false &&
  guestMvp.badge === "MVP" &&
  bannerAfterDismiss.length > 0;

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
A.kill("SIGKILL");
B.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
