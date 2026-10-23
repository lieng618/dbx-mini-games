# 棋牌小馆开发交接

## 身份

```text
GitHub publisher: lieng618
Plugin ID:        io.github.lieng618.dbx-mini-games
Workbench ID:     io.github.lieng618.dbx-mini-games.workbench
Go module:        github.com/lieng618/dbx-mini-games/backend
```

插件是纯前端 universal 包，不包含 DBX Sidecar。Go 服务单独部署，双方通过 WebSocket 通信。

## 开发

```powershell
npm ci

cd backend
go test ./...
go run . -addr 127.0.0.1:8787 -ui ..\ui
```

在仓库根目录另开一个终端：

```powershell
npm run dev
```

开发页面使用 Vite 输出的地址（通常是 `http://127.0.0.1:5173`）。

三客户端验收：

```powershell
node scripts/cloud-smoke.mjs
```

## 发布检查

所有公网入口配置都在：

```text
config/game-server.env
```

替换 `PUBLIC_ORIGIN` 后直接打包：

```powershell
npm run package:dbx
```

构建脚本会从 `PUBLIC_ORIGIN` 和 `WEBSOCKET_PATH` 自动生成前端 WebSocket
地址，并同步 `manifest.json` 的 `host.network` 权限。生产构建还会扫描
`ui/`，拒绝包含 `localhost` 或回环地址的构建。Caddy 读取同一文件；
正式发布后检查生成的 Manifest 不再包含 `localhost`。

入口地址会固化进前端产物和 Manifest，替换后必须重新打包并重新安装 `.dbxp`。

## 数据边界

- Go 服务只存内存状态；
- 服务重启后房间消失；
- 客户端不保存棋谱或回放数据；
- 服务器不保存账号、昵称、棋谱或观战记录；
- 音效保留并默认开启，插件内不提供音效开关。
