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

生产 Hono 白名单明确提供 `/sw.js`、`/manifest.webmanifest`、三个安装图标、专用 Apple touch 图标、SVG/ICO/16/32px favicon 与 `/offline.html`（具体路径见下表）。worker 位于根路径，作用域 `/`，JavaScript MIME，`Cache-Control: no-cache`；注册使用 `updateViaCache: none`。

缓存名 `anyone-shell-v2`，只预缓存离线说明页与三个公开图标。不缓存首页 HTML、JS/CSS、任何 API/Socket.IO、聊天、会话、认证或附件响应；应用仍依赖网络和服务端 ACL。离线导航只给出真实离线说明，不重建已登录账户或伪造聊天。升级离线页/图标时递增缓存版本，激活后只删除本应用旧 shell 缓存，保留其他应用缓存。新 worker 等旧页面自然关闭后激活，不强制 `skipWaiting` / 刷新，避免丢草稿。

## 图标设计与再生成

图形直接参考 2FA 项目的「粗体字母 + 圆环」印章式家族：中央清晰的 `IM` 大写字母，与 FileControl 的 `FC` 对应。不使用对话气泡、圆点、彩色点缀或预烘焙的外层圆角；暖白 `#f8faf9` 铺满整个正方形，石墨黑 `#202a2b` 为唯一前景色。512 画布中圆环中心 `(256, 256)`、半径 187、线宽 18；字形范围 x=143…374、y=174…338，使用原创几何路径而非系统字体。包括标准图标在内，圆环和字母均在中心半径 40% 的安全圆内，系统可自行裁成圆形或 squircle。应用原有主题色与 manifest 身份不变。

唯一矢量母版是 `apps/web/public/favicon.svg`；`scripts/generate-icons.py` 从它生成所有栅格资产，4 倍超采样后缩小，输出不透明 RGB PNG。`any` 与 `maskable` 使用同一安全构图，但保留独立文件和各自的 manifest purpose。

| 用途 | 公开路径 | 尺寸 |
| --- | --- | --- |
| Manifest 标准图标 / 通知 icon | `/icons/icon-192.png` | 192 × 192 |
| Manifest 标准图标 | `/icons/icon-512.png` | 512 × 512 |
| Manifest maskable | `/icons/maskable-512.png` | 512 × 512 |
| Apple touch | `/icons/apple-touch-icon.png` | 180 × 180 |
| 标签页 PNG | `/icons/favicon-32.png`, `/icons/favicon-16.png` | 32、16 |
| 标签页矢量 / 母版 | `/favicon.svg` | viewBox 512 × 512 |
| 传统浏览器回退 | `/favicon.ico` | 内含 16、32、48 |

仅再生成时需要 Python、系统 Cairo 库、Pillow 与 CairoSVG；服务器、Bun 安装和 CI 不依赖这些工具，提交生成资产即可。

```sh
# 独立、被 git 忽略的开发虚拟环境；不改变应用运行时依赖。
python3 -m venv .data-icons-venv
.data-icons-venv/bin/pip install Pillow==13.0.0 CairoSVG==2.9.0
.data-icons-venv/bin/python scripts/generate-icons.py --preview .data-icons-preview/contact-sheet.png
bun test scripts/pwa-icons.test.ts apps/server/tests/pwa-icons.test.ts apps/server/tests/pwa-worker.test.ts
```

可选预览是 1080 × 840 PNG，包含 512px 原图、64/32/16px 实际尺寸、圆形与 squircle 裁切；不是实际系统安装截图。每次修改母版后重新生成，并递增 `sw.js` 的 shell 版本。公开图标仍用稳定路径和 `no-cache` 重新验证，通知/manifest/Apple/favicon 不引入彼此不一致的 query 版本；v2 worker 激活后替换 v1 静态图标缓存，未扩大缓存范围。

**已安装的主屏幕图标由浏览器/操作系统单独缓存**，worker 激活不等于桌面图标立即更新。先保存草稿并关闭所有旧应用窗口，再重新打开；移动系统仍显示旧图时可能需要等待系统刷新，或由用户自行移除快捷方式后重新添加。不要为了刷新图标清空站点数据（可能丢失访客身份）。本地自动化只证明构建资产、浏览器解码、metadata 与缓存行为；未验证真实 Android/iOS 安装后的图标更新。

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
