# Privacy / 隐私说明

Last updated: 2026-10-22

## English

DBX Mini Games is an anonymous online board-game lobby. It does not provide
accounts, passwords, chat, advertising, analytics, telemetry, or payments.

### Data sent to the game service

When you open the plugin, the client sends:

- a randomly generated client identifier;
- a randomly generated nickname;
- the room, seating, move, undo, chat-free game action, and timing data needed
  to play.

The public game service processes this data in memory. Rooms, seats, matches,
move history, and connected-member state are discarded when the service
restarts. The service does not intentionally create a database of users,
accounts, games, or replay archives.

### Local browser storage

The plugin stores a generated client identifier and display preferences in the
current browser's `localStorage`. It does not set authentication cookies.

### Network and security logs

The hosting reverse proxy may record standard connection metadata such as IP
address, timestamp, request path, user agent, response status, and transferred
bytes in rotating operational logs for reliability and abuse prevention. These
logs are not connected to a user account and are not used for advertising.

### Third parties

The plugin communicates directly with the publisher-operated game service at
the HTTPS origin declared in `manifest.json`. The project does not include
third-party analytics or advertising SDKs. GitHub processes data when users
visit the source repository or open an Issue.

### Contact

For privacy questions, open an Issue in the project repository:

https://github.com/lieng618/dbx-mini-games/issues

## 中文

棋牌小馆是一个匿名在线棋牌大厅，不提供账号、密码、聊天、广告、统计分析、
遥测或支付功能。

打开插件后，客户端会向游戏服务发送随机生成的客户端 ID、随机昵称，以及创建
房间、入座、走子、悔棋和计时所需的状态。服务只把这些数据保存在内存中；
服务重启后，房间、座位、对局、走子历史和在线成员信息都会消失。服务不会主动
建立账号、用户、棋谱或回放数据库。

插件会在当前浏览器的 `localStorage` 中保存随机客户端 ID 和显示偏好，不设置
登录 Cookie。服务器的反向代理可能在轮转的运行日志中记录 IP、时间、路径、
User-Agent、响应状态和流量大小，用于稳定性和防滥用；这些日志不关联账号，
也不用于广告。

插件只访问 `manifest.json` 声明的发布者游戏服务器，不包含第三方广告或统计
SDK。如有隐私问题，请通过项目 Issues 联系：

https://github.com/lieng618/dbx-mini-games/issues
