# Anyone IM

独立部署、移动优先的房间聊天室。前端 React + Vite + Tailwind/Radix，后端 Bun + Hono + Socket.IO，持久化使用 Prisma。生产复用现有 MySQL，使用独立数据库与账号；本地开发和测试默认 SQLite。

[![CI](https://github.com/sansan-mei/anyone-im/actions/workflows/ci.yml/badge.svg)](https://github.com/sansan-mei/anyone-im/actions/workflows/ci.yml)

## 第一版范围

- 服务端签发访客身份，另有用户名/密码注册和登录；HttpOnly 会话 Cookie，不把 Token 放进 URL 或 localStorage。
- 公共/私有房间、邀请链接与失效、房主移除成员、离开房间。
- 实时文本/图片、分页历史、未读位置、断线补拉、幂等重试、删除消息。
- 图片走有房间权限的 HTTP 上传/读取，不公开暴露磁盘上传目录。
- Google / Material 3 方向的蓝白界面、柔和圆角和清晰字体层级；桌面会话列表 + 聊天区，手机单屏聊天，成员/设置按需展开；浅/深色模式。

不是完整的微信式 IM：第一版不包含好友系统、私聊、音视频、端到端加密、旧 ChatGPT 站点 SSO 或历史消息导入。这些都没有接触旧站数据库。

## 端口

- **正式服务：4100**，同一端口提供网页、HTTP API 和 Socket.IO。
- 开发页面：4101；真实 E2E 临时服务：4190。
- 镜像为 `1596944197/anyone-im`；简化 Compose 不创建 MySQL、不声明 networks，沿用生产 `default` 项目的默认网络。
- 默认只把应用发布到宿主机 `127.0.0.1:4100`。部署前仍应检查端口，不能假定某个端口永远空闲。

## 本地运行

需要 Bun 1.4.4。命令从仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run db:generate
bun run db:push
bun run dev
```

打开 `http://127.0.0.1:4101`。开发页面代理 `/api` 和 `/socket.io` 到本地 4100。数据默认写入仓库 `.data`；访客和聊天记录都是真实持久化数据，不会注入示例聊天。

如需用单个端口查看生产前端构建：

```sh
bun run build
bun run start
# http://127.0.0.1:4100
```

不要让本地开发或测试指向现有生产数据库。设置 `DB_PROVIDER=mysql` 时必须显式提供独立数据库的 `DATABASE_URL`，切换 provider 后重新生成客户端。

## 验证

```sh
bun run typecheck
bun run test
bun run build
bun audit
bunx playwright install chromium
bun run test:e2e
```

根目录的 E2E 使用真实后端、真实 SQLite 和浏览器，不是假聊天 API。测试进程会创建隔离临时目录，结束时清理，并禁止复用已有的测试服务。默认不会继承外部 `DATABASE_URL`；MySQL E2E 必须显式选择，并只允许 loopback 上的 `anyone_ci` / `anyone_test_*` 测试库。

CI 分别验证 SQLite/浏览器、真实 MySQL/浏览器以及 Docker 镜像构建和临时容器运行。容器烟测使用隔离网络与新命名卷，检查非 root、生产 Cookie、MySQL、图片写入和容器重启后的持久化；烟测脚本拒绝在 GitHub Actions 以外直接运行。后端测试还有真实 Socket.IO、权限隔离、重启持久化和故障注入验证。详见 [后端说明](apps/server/README.md)。

## 二级域名部署

见 **[docs/deployment.md](docs/deployment.md)**：`im.mh33.top`、现有 Docker MySQL 的独立库/账号、简化 Compose、HTTPS/WebSocket、首次建表与备份。

仓库不会自动部署到生产服务器，不会改旧站路由、现有 Nginx、DNS 或已有 Docker 服务。上线需要另行配置二级域名和证书。

## 安全与运行边界

- 一次消息写入先提交数据库，再确认/广播；重连从数据库补拉。没有声称实现跨进程事务消息队列。
- V1 为单应用进程：在线人数、速率限制和订阅协调在内存中。多实例必须先引入分布式适配器和统一限制，不可直接横向复制。
- 当前图片检查大小、声明 MIME 与文件签名，不做病毒扫描或解码重编码。未引用图片、过期会话/邀请和删除后的文件需要后续保留策略/清理任务。
- 反向代理后的 IP 限制默认按直接对端计算，不信任任意 `X-Forwarded-For`；公网入口还应设置连接/请求限制。
- 根 `deepmerge-ts:8.0.2` override 修补 Prisma 6 CLI 的递归合并漏洞（GHSA-ggr8-5vv4-36mx）；保留 Prisma 6 的生成/运行接口，并通过 generate/push 和集成测试验证兼容性，不忽略告警。

项目 workspace 统一使用 `@anyone-im/*`，会话 Cookie 为 `anyone_session`，测试开关为 `ANYONE_E2E_MYSQL`。
