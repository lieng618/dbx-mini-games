# 棋牌小馆 · DBX Mini Games

一个面向 DBX 的匿名云棋牌大厅。插件是纯前端包，玩家不需要账号，也不需要在本机运行 Sidecar；中国象棋、五子棋、房间、观战和计时由独立 Go 服务统一仲裁。

```text
Publisher: lieng618
Plugin ID: io.github.lieng618.dbx-mini-games
Source:    https://github.com/lieng618/dbx-mini-games
```

## 当前能力

- 公共云端大厅，WebSocket 推送房间变化；
- 创建、加入和观战房间，不需要登录；
- 中国象棋与五子棋；
- 服务器权威走子、计时和超时判负；
- 创建者离开等待房间时自动转移房主；
- 设置保存在浏览器本地；
- 音效保留并默认开启，插件内不提供音效开关；
- 服务器只使用内存，不保存账号、用户、房间或棋谱。

## 结构

```text
src/                         Vue 3 + PixiJS 插件前端
backend/internal/cloud/      匿名大厅、房间协议、WebSocket 和服务器时钟
backend/internal/game/       中国象棋、五子棋规则引擎
backend/internal/replay/     内部走子历史与棋盘重建
backend/internal/room/       房间、座位与对局状态机
deploy/                      Docker、Caddy 和 TLS 部署文件
scripts/cloud-smoke.mjs      三客户端端到端验收
```

插件端不包含原生 Sidecar。`manifest.json` 只声明工作台和云端网络入口；Go 目录只用于部署独立云服务。

## 本地运行

需要 Node.js 22+ 和 Go 1.22+。

```powershell
npm ci
npm run build

cd backend
go run . -addr 127.0.0.1:8787 -ui ..\ui
```

打开：

```text
http://127.0.0.1:8787
```

公网入口、WebSocket 路径和本地开发地址都集中在
[`config/game-server.env`](config/game-server.env)。插件构建会自动把
`PUBLIC_ORIGIN` 同步到 `manifest.json` 和前端产物，不需要再分别修改。

```powershell
npm run build
```

`npm run dev` 使用 `LOCAL_ORIGIN`；生产构建使用 `PUBLIC_ORIGIN` 加
`WEBSOCKET_PATH`。

## 验收

后端单元测试：

```powershell
cd backend
go test ./...
```

三客户端端到端测试会创建一个五子棋房间，让两名玩家完成连五，并由第三人观战和接收终局结果：

```powershell
node scripts/cloud-smoke.mjs
```

## 部署

服务器需要可用的 80/443 端口，并先把唯一一份公网配置改成实际入口：

```text
PUBLIC_ORIGIN=https://play.example.com
WEBSOCKET_PATH=/ws
LOCAL_ORIGIN=http://127.0.0.1:8787
```

然后：

```powershell
cd deploy
docker compose up -d --build
```

Caddy 会自动申请 TLS，WebSocket 走：

```text
wss://play.example.com/ws
```

如果 `PUBLIC_ORIGIN` 使用公网 IP，Caddy 默认只会生成内部自签名证书。
这种方式适合本机或局域网测试；发布给公网玩家时，需要给 Caddy 提供包含
该 IP SAN 的受信任证书，或者改用域名。Manifest 的网络权限只接受 HTTPS
origin，不能写路径或通配符。

正式发布只需执行：

```powershell
npm run package:dbx
```

这个命令会先同步配置、重新构建 UI，再执行 `dbx-plugin package .`。
网络权限会被固化进 `.dbxp`，因此替换入口后必须重新打包并重新安装插件；
已经安装的旧包不会自动读取新的 IP。

## 匿名与数据

- 无账号、Cookie 或用户数据库；
- 房间和成员状态只在 Go 进程内存中；
- 服务重启后房间消失；
- 客户端不保存棋谱或回放数据；
- 不提供聊天，避免匿名内容审核和持久化；
- IP 只用于网络连接和可选的短时限流，不写入业务存储。

## 许可

Apache-2.0
