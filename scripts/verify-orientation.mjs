// 验证象棋视角：坐后手（黑方）的人应该看到自己那半边在屏幕下方。
//
// 直接读场景里棋子的屏幕坐标，而不是看截图猜——黑方初始在 rank 0，若视角正确，
// 黑方棋子的平均 y 应当落在棋盘中线以下。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "orientation";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT_A = 5660 + Math.floor(Math.random() * 20);
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
  // 打开场景的调试句柄，才能读到棋子的真实坐标。
  await p.addInitScript(() => { window.__DBX_DEBUG_FX = true; });
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

// 读场景几何：flipped 标志 + 黑方棋子平均纵坐标 + 棋盘中线。
const boardStateOf = (fr) =>
  fr.evaluate(() => {
    const scene = window.__boardScene;
    if (!scene || !scene.lay) return null;
    const lay = scene.lay;
    const nodes = (scene.pieces && scene.pieces.nodes) || [];
    const blacks = nodes.filter((n) => n.code < 0);
    const reds = nodes.filter((n) => n.code > 0);
    const avgY = (list) =>
      list.length ? list.reduce((s, n) => s + n.container.y, 0) / list.length : null;
    return {
      flipped: scene.flipped === true,
      midY: lay.originY + lay.boardHeight / 2,
      blackCount: blacks.length,
      redCount: reds.length,
      blackAvgY: avgY(blacks),
      redAvgY: avgY(reds),
    };
  });

const hostPage = await openPage(PORT_A);
const hostFr = await frameOf(hostPage);
await hostFr.locator('input[placeholder="我的棋室"]').fill("视角验证");
await hostFr.locator("select").selectOption("xiangqi");
await hostFr.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(2000);

const invite = await hostFr.evaluate(() => document.querySelector("code.invite")?.textContent.trim() ?? "");
const guestPage = await openPage(PORT_B);
const guestFr = await frameOf(guestPage);
await guestFr.locator('input[type="text"]').last().fill(invite);
await guestFr.getByRole("button", { name: "按地址加入" }).click();
await guestPage.waitForTimeout(3500);

const hostState = await boardStateOf(hostFr);
const guestState = await boardStateOf(guestFr);
step("host", hostState);
step("guest", guestState);

step("hostSeat", await hostFr.evaluate(() => [...document.querySelectorAll(".seat-name")].map((e) => e.textContent.trim())));
step("guestSeat", await guestFr.evaluate(() => [...document.querySelectorAll(".seat-name")].map((e) => e.textContent.trim())));

await hostPage.screenshot({ path: `${OUT}/01-host-xiangqi.png` });
await guestPage.screenshot({ path: `${OUT}/02-guest-xiangqi.png` });

// 房主坐先手（红），红方应在下方；客人坐后手（黑），黑方应在下方。
const hostOk =
  hostState && hostState.flipped === false && hostState.redAvgY > hostState.midY && hostState.blackAvgY < hostState.midY;
const guestOk =
  guestState && guestState.flipped === true && guestState.blackAvgY > guestState.midY && guestState.redAvgY < guestState.midY;

step("hostRedAtBottom", hostOk);
step("guestBlackAtBottom", guestOk);

report.ok = !!hostOk && !!guestOk;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
A.kill("SIGKILL");
B.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
