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
  src/board/scene.js           场景：分层、快照 diff、特效调度
  src/board/pieces.js          棋子层：持久化视图 + 移动补间（新增）
  src/board/effects.js         六类特效 + pixi-filters 墨晕/压痕
  src/board/sound.js           WebAudio 合成音效 + 触感（新增）
  src/board/layout.js          棋盘几何
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
- 落子/吃子/将军/连五音效与触感反馈（WebAudio 合成，可关）
- 练习模式：单人自由走子 + `dev.scenario` 特效预演（开局/吃子/将军/连五）

## 待办（按价值排序）

### 1. 「特效很一般」—— 已改两轮（2026-10-19）

**第二轮的关键发现**：真实宿主里走子后连拍 5 帧像素完全相同——`drawPieces()` 每次把 32 枚棋子
全销毁重建，全项目零补间。**棋子是瞬移的**，这是"观感平"的真正瓶颈，不是特效不够花。

第二轮做了什么：

- 新增 `src/board/pieces.js`（PieceLayer）：持久化棋子视图 + 快照 diff 识别 move/place/capture，
  easeOutQuint + 正弦弧抬升；吃子改为击飞缩小。已在 iframe 内采样证明补间真实存在
  （y: 568 → 504.8 → 490.7 → 489.3）
- 新增 `scene.schedule()`：特效不再随快照到达就播，而是等棋子真正落地；吃子提前 60ms 与击飞重叠
- `pixi-filters`（已验证在 CSP + 单文件 bundle 下可用）：将军字用 `GlowFilter` 做真湿边墨晕，
  印章用 `DropShadowFilter` 做压痕；只按名导入两个 filter，gzip 共涨 ~4.5 kB
- 印章位置从"正中压住决胜子"改为沿连线推开 0.78 格 + 边界夹取
- 粒子缓存单位多边形 + scratch 复用，数量 34 → 52，bundle 只涨 0.14 kB

**UI 也重做了**（按 premium-ui skill 的审查协议）：

- 完整设计 token（色彩/圆角/阴影/动效/字体五套变量），双色板经 `check_ui.py contrast` 校验，
  主文字 7.10:1、正文 14.29:1，全部过 AA；旧版 `#8a6a3c` 只有 4.11:1，是次要文字发灰的根因
- 触控目标全部 ≥44px，加 `focus-visible` 焦点环，勾选框改自绘 + 隐藏 input
- `reveal` 交错入场、`--ease-spring` 弹性曲线、按钮 hover 位移 + 双层阴影
- `check_ui.py audit` → **0 项违规**

### 1a. 第一轮（同日前半段）

六项都做了，在真实 `dbx-plugin dev` 宿主里逐项抓帧验过（见 `docs/VALIDATION.md`
「特效改版后的验证方式」）。做了的事：

- 落子涟漪改成真墨滴：不规则墨缘（抖动随干涸衰减）+ 致密核心 + 飞溅墨点，
  墨迹颜色随落子方变化
- 提子墨尘改成三类碎屑（墨块 / 拉长的墨丝 / 翻滚的墨屑）+ 冲击环，各自不同质量与
  阻力，淡出曲线前段保持、后段陡降
- 将军补上「书法大字炸开」：书法「将」字砸下、过冲到 1.22 再回弹、带墨晕与红墨飞溅；
  位置按棋盘边界夹取（原来会掉到纸外）
- 连五连线改成逐子生长的 tapered 墨线 + 笔尖光点；印章改成圆角方形墨块、纸色刻框、
  纸色刻字（连五用「五」、象棋用「胜」）、缺墨斑点、轻微旋转与压痕偏移，并移到
  `overlayLayer`（原来被棋子压住）
- 新增 `src/board/sound.js`：WebAudio 合成的落子木击 / 吃子 / 将军磬声 / 胜利双音，
  加 `navigator.vibrate` 触感；界面加「落子音效」开关（存 localStorage，不进协议）
- 最后一手改成呼吸式金色光晕 + 双描边金环 + 渐细墨线拖尾
- 顺带修了三个只有真跑才暴露的坑（`将`字越界、印章在棋子下、五子棋盘冒`将`字），
  和本地预览四个场景跑同一条棋谱的问题

还可以继续做（未做）：

- 纸面质感目前是绘制时的固定散点；换成可平铺的噪声纹理会更耐看，但要先解决 CSP
  下不加载外部资源的限制（可能得把噪声烘进 `assets/`）
- 音效只做了合成音；如果要真录音，需要处理打包体积与 4 种棋子的音色差异

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
7. **棋子必须持久化，不能每帧重建**。`drawPieces` 曾经 `clearPieces()` 后全量重建，
   导致走子瞬移、任何落点特效都像后期贴上去的。现在由 `PieceLayer` 做快照 diff：
   一个空格 + 一个填充 = move，一个填充无空格 = place，其余一律 rebuild。
8. **特效要等棋子落地**。`scene.schedule()` 队列负责这件事；undo / 复盘跳转必须清队列，
   否则会给已经不存在的走法喷墨。
9. **`pixi-filters` 只按名导入**。`import { GlowFilter } from "pixi-filters"` 会把四十多个
   filter 全打进单文件 bundle；用 `pixi-filters/glow` 这类子路径，gzip 只涨 2~2.5 kB。
10. **验证脚本必须每次全新 `--data-dir`**。否则上次的房间会让「开桌」按钮消失，
    `lowMotion` 也会被记住，抓到的全是降级形态。`scripts/verify-round.mjs` 已内置。
11. **`go.work` 版本**：`dbx-plugin dev` 内部以 `go 1.22` 生成，依赖若要求更高
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
