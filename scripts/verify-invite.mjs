// 验证「邀请串」手动加入：房主复制 地址#房间号#公钥，朋友粘贴就能进（不依赖 mDNS 发现）。
import { chromium } from "/Users/jzj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const ROOT = "/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/dbx-board-games";
const TAG = process.argv[2] || "invite";
const OUT = `${ROOT}/scripts/out/${TAG}`;
const DATA = `/tmp/dbxbg-${TAG}-${Date.now()}`;
const PORT_A = 5420 + Math.floor(Math.random() * 20);
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

const hostPage = await open(PORT_A);
const hostFrame = hostPage.frameLocator("iframe").last();
await hostFrame.getByRole("button", { name: "开桌" }).click();
await hostPage.waitForTimeout(1500);

// 房主侧：读出界面上的邀请串
const hostFr = hostPage.frames().find((f) => f !== hostPage.mainFrame());
const invite = await hostFr.evaluate(() => {
  const el = document.querySelector("code.invite");
  return el ? el.textContent.trim() : "";
});

// 客人侧：粘贴整串，走「按地址加入」
const guestPage = await open(PORT_B);
const guestFrame = guestPage.frameLocator("iframe").last();
if (invite) {
  await guestFrame.locator('input[type="text"]').last().fill(invite);
  await guestFrame.getByRole("button", { name: "按地址加入" }).click();
  await guestPage.waitForTimeout(2600);
}
const guestFr = guestPage.frames().find((f) => f !== guestPage.mainFrame());
const after = await guestFr.evaluate(() => window.dbxPlugin.invoke("room.snapshot", {}).catch(() => null));
const guestErr = (await guestFrame.locator("p.error").innerText().catch(() => "")).trim();
await guestPage.screenshot({ path: `${OUT}/01-joined.png` });

const report = {
  port: PORT_A,
  inviteParts: invite ? invite.split("#").length : 0,
  invite: invite.slice(0, 60) + (invite.length > 60 ? "…" : ""),
  guestRole: after?.role,
  guestErr,
  ok: invite.split("#").length === 3 && after?.role === "guest",
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
A.kill("SIGKILL");
B.kill("SIGKILL");
process.exit(report.ok ? 0 : 2);
