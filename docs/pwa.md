# 桌面安装与系统消息通知

## 使用

在「个人设置 → 应用与通知」选择「安装到桌面」。Chromium 支持 `beforeinstallprompt` 时由用户点击唤起原生安装提示；取消后可用浏览器菜单再次安装。Safari/iOS 不提供该事件：在 Safari 分享菜单选择「添加到主屏幕」，其他浏览器使用安装/快捷方式菜单。独立窗口或 `appinstalled` 事件会显示「已安装到桌面」。已安装应用以 `/` 为身份、启动地址和作用域，使用 standalone 显示模式和独立 PNG / maskable 图标。

「开启消息通知」是唯一请求系统权限的入口，进入网页、登录、收到消息或安装都不会自动请求权限。被拒绝时显示网站设置指引；不支持的浏览器显示说明。iOS 需要支持通知的版本并从主屏幕应用打开。

**这是页面仍在运行时的系统通知，不是关闭页面后的 Web Push。** 切到后台/失去焦点且实时连接仍可运行时，其他成员的新消息会通过真实的 `ServiceWorkerRegistration.showNotification` 提醒。系统省电、浏览器冻结/休眠、断网可能暂停页面；关闭全部页面后不推送。未新增 Push 订阅、VAPID 密钥或接收任意端点的推送后端，避免额外密钥运维及 SSRF/无界队列风险。

通知开关仅在当前页面、当前账户内存中有效；刷新、退出或切换账户后需重新开启，浏览器权限本身由浏览器管理。关闭通知会清理当前账户已显示的通知。应用不在本地持久化通知账户偏好或消息去重清单。

## 隐私和正确性

- 通知固定显示「Anyone IM / 收到一条新消息，打开应用查看。」，不包含正文、发件人、房间名、图片文件名或邀请链接，减少共享设备/锁屏泄露。
- 仅处理实时 `message:new`；房间序号水位忽略历史、重复、回放与重连补拉，自己的消息、删除消息和非成员房间不通知。前台聚焦时不打扰，异步校验期间返回前台也取消提醒。
- 显示前重新校验 Cookie 对应身份，并绑定捕获的 `X-Anyone-User-Id`；异步返回后再次检查会话、权限和通知开关，退出/换号清理与取消旧任务。
- 支持 Web Locks 的浏览器以账户锁串行检查已显示通知；消息 tag 和页面内房间水位抑制重复。非 Web Locks 环境同 tag 替换是降级防重复，不能保证跨标签页严格 exactly-once 提醒。
- 点击通知只聚焦同源应用窗口或打开同源 `/`，不信任通知中的任意 URL。当前 Cookie 身份匹配后才传递房间定位；页面还会校验当前账户和当前房间成员列表。现有窗口用消息定位而非强制刷新，初次打开用 `?room=` 并在加载后清除参数。

## 缓存与更新

生产 Hono 白名单明确提供 `/sw.js`、`/manifest.webmanifest`、三个 `/icons/*.png` 与 `/offline.html`。worker 位于根路径，作用域 `/`，JavaScript MIME，`Cache-Control: no-cache`；注册使用 `updateViaCache: none`。

缓存名 `anyone-shell-v1`，只预缓存离线说明页与三个公开图标。不缓存首页 HTML、JS/CSS、任何 API/Socket.IO、聊天、会话、认证或附件响应；应用仍依赖网络和服务端 ACL。离线导航只给出真实离线说明，不重建已登录账户或伪造聊天。升级离线页/图标时递增缓存版本，激活后只删除本应用旧 shell 缓存，保留其他应用缓存。新 worker 等旧页面自然关闭后激活，不强制 `skipWaiting` / 刷新，避免丢草稿。

## 验证

```sh
DB_PROVIDER=sqlite bun run db:generate
bun run test
bun run typecheck
bun run build
bunx playwright install chromium
bun run test:e2e:artifact
bunx playwright test --workers=1
bunx playwright test --config apps/web/playwright.ui.config.ts --workers=1
```

`bun run test:e2e:artifact` 会先构建前端与服务端，再在独立临时 SQLite / loopback 环境运行 `apps/server/dist/index.js`，验证静态 metadata、图标、worker 和离线缓存；不使用 Docker 或生产服务。默认 E2E 则运行服务端源码并提供已构建前端。

PWA 浏览器用例使用完整 Chromium（`channel: chromium`），不是不支持真实持久通知的 headless-shell。测试真实隔离 SQLite、真实 HTTP/Socket.IO、worker 注册/缓存和原生 `showNotification/getNotifications`；只对自动化强制聚焦行为设置 `document.hasFocus` 测试接缝，安装对话框用 `beforeinstallprompt` 事件接缝，权限由浏览器测试授权。系统托盘外观、真实 Safari/iOS 主屏幕安装和移动系统省电行为需设备验收，未声称已验证。
