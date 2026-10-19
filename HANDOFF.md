# 交接说明（给下一个会话）

写于 2026-10-19。上一轮会话因上下文过大（单轮输入达 469 万 token）被模型侧以
`INVALID_REQUEST` 拒收，无法继续，故开新会话。读这份文件即可接手，不需要复述历史。

## 一分钟了解

一个 DBX 插件：局域网中国象棋 + 五子棋，含观战、复盘、练习模式、国风特效。

- 源码：https://github.com/southernMortals/dbx-board-games
- 目录：https://github.com/southernMortals/dbx-plugins
- catalog（填进 DBX 插件中心）：
  `https://raw.githubusercontent.com/southernMortals/dbx-plugins/main/catalog/index.json`

本地工作区：`/Users/jzj/Documents/MyWorkspace/ai_study/dbxplugin/`
（`dbx-board-games/` 源码仓，`dbx-plugins/` 目录仓）

## 必读文件

| 文件 | 作用 |
| --- | --- |
| `CONTEXT.md` | 领域词表：房间、座位、观战、复盘、练习模式等术语的精确含义 |
| `docs/adr/` | 4 份架构决策：房主权威、座位不轮转、单包双游戏、目录分仓 |
| `docs/PLAN.md` | 里程碑 M0–M5 |
| `docs/VALIDATION.md` | **已经真实验证过什么、怎么验的、哪些还没验** |

## 当前状态

后端 110 项测试全绿。`dbx-plugin package` 可产出可安装 `.dbxp`，已签名并发布。

代码结构：

```
backend/internal/game/       两个棋种规则引擎（纯逻辑，无网络无时钟）
backend/internal/replay/     棋谱、回放游标、中文与坐标记谱
backend/internal/room/       房间、座位、观战、对局生命周期、练习模式
backend/internal/lan/        TLS 1.3 传输、Ed25519 握手、访客请求通道
backend/internal/discovery/  mDNS 广播与解析
backend/internal/app/        宿主 RPC 面、会话、时钟、场景夹具
src/                         Vue 3 + PixiJS 8 前端
```

## 开发命令

```bash
cd backend && go test ./...                 # 后端全量测试
npm run build                               # 构建 UI 到 ui/
dbx-plugin dev --path . --port 5190 \
  --data-dir /tmp/dbxbg-dev                 # 官方开发宿主（会同时起 Go 后端）
dbx-plugin package .                        # 产出 dist/*.dbxp
```

注意：`dbx-plugin dev` 会持久化上次会话状态到 `--data-dir`。复测界面时用**全新
`--data-dir`**，否则上一次的房间会恢复，界面不在初始页。

## 已完成且验证过

- 象棋：走吃、将军、将死、困毙、将帅照面、自陷将军过滤、六十回合和棋、三次重复
- 五子棋：自由规则、五连与长连胜、满盘和棋
- 复盘：棋谱校验、游标翻步、中文记谱（炮八平五、前车/后车消歧）、坐标记谱、导出
- 房间：先进先坐、8 人上限、手动离座才让位、对局中冻结、掉线判负、悔棋需双方同意
- 局域网：TLS 1.3 自签 + 公钥固定 + Ed25519 挑战应答 + 重连票据
- **访客操作通道**：访客可坐下、开局、落子，请求经房主仲裁（本轮刚补完并测试）
- 六类特效：落子墨涟漪、提子墨尘、将军震屏、最后一步金边、连五连线与印章、低动效降级
- 练习模式：单人自由走子 + `dev.scenario` 特效预演（开局/吃子/将军/连五）

## 待办（按价值排序）

### 1. 「特效很一般」—— 用户明确提出的改进项，尚未开始

现状是能跑通、但观感平。可考虑：

- 落子涟漪目前是两层同心圆，可换成真正的墨滴扩散（不规则边缘、中心浓外缘淡）
- 提子墨尘粒子只有 22 个且是纯色圆点，可增加不规则墨点、拖尾、淡出曲线
- 将军缺少用户点名要的「书法大字炸开」——`CheckEffect` 里只画了红色光晕，没有字形
- 连五的连线是直线，可改为沿棋子逐颗生长的墨线，印章可加纸面压痕与轻微旋转
- 缺少落子音效与触感反馈
- 可加「最后一手」在棋盘上的呼吸高亮，而不是只靠金边

### 2. 未验证项（`docs/VALIDATION.md` 里也列了）

- 真实双机 mDNS 发现：集成测试走 loopback，广播已实现但未跨物理设备验证
- Windows / Linux 目标：只构建测过 darwin-x64
- 长时间对局的内存与特效泄漏

### 3. 发布自动化

`.github/workflows/plugin-release.yml` 被排除在 git 之外（`.gitignore`），因为推送
需要 `workflow` scope，当前 token 没有。要恢复自动发版需先给 token 补该权限。

## 已知坑（踩过，别重踩）

1. **插件 ID 与仓库 ID 必须全小写**。manifest schema 强制；`southernMortals` 里的
   大写 `M` 会被拒。当年写成 `io.github.southernMortals.*` 打包直接失败。
2. **sidecar 里的插件 ID 必须与 manifest 完全一致**，否则 DBX 报
   `Sidecar identity or protocol does not match manifest` 并拒绝启动。已有测试
   `TestSidecarIdentityMatchesManifest` 守着。
3. **DBX 的 CSP 只允许内联与 blob 脚本**。Vite 默认分包会让 Pixi 的动态 import 被
   拦截。必须单文件 bundle（`inlineDynamicImports: true`）。
4. **Pixi 会探测 eval**，沙箱禁止。必须 `import "pixi.js/unsafe-eval"`。
5. **自建仓库的公钥要手动加入**，且 **Key ID 是签名用的 ID**（
   `southernMortals-plugins.release`），不是仓库 ID（`southernmortals-plugins`）。
   填错会报 `untrusted key`。本机信任库在
   `~/Library/Application Support/com.dbx.app/plugins/.trust/keys.json`。
6. **mDNS 会按网卡重复上报**，且代理软件（Clash）的 fake-ip 网段（198.18.0.0/15）
   不可达。地址枚举已过滤，去重已按房间 ID 归并。
7. **`go.work` 版本**：`dbx-plugin dev` 内部以 `go 1.22` 生成，依赖若要求更高
   会构建失败。当前 `backend/go.mod` 保持 `go 1.22` 且依赖已固定到兼容版本。

## 签名与发布

仓库签名密钥（**私钥不在仓库里**）：

- Key ID：`southernMortals-plugins.release`
- 公钥：`niyPPbiaadjs6VIRE6NU51gBBaNULahIKN+9eZQxsws=`
- 公钥文件：`dbx-plugins/keys/southernMortals-plugins.release.pub`

签名流程（官方 packager，需 Rust）：

```bash
cd /tmp/packager_db/plugins/sdk/packager      # 官方 dbx 仓库的 packager
source /tmp/repo-signing2.env                 # 私钥环境文件，仅本机
cargo run --release --quiet -- sign \
  <候选包>.dbxp <签名包>.dbxp \
  --key-id "$DBX_PLUGIN_SIGNING_KEY_ID" \
  --artifact-metadata <元数据>.json \
  --target darwin-x64 \
  --artifact-url <发布后的 HTTPS 地址>
```

若 `/tmp/repo-signing2.env` 已丢失，需重新 `dbx-plugin keygen` 生成新密钥并换新
Key ID（**不可复用旧 Key ID 配新公钥**），同时更新 catalog 与公钥文档。
