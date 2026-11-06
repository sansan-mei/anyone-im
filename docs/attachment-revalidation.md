# 私有图片的 HTTP 重新验证

## 用户可见行为与隐私边界

`GET /api/attachments/:id` 成功响应从 `private, no-store` 改为
`Cache-Control: private, no-cache`，附带稳定、不含明文用户/附件标识的 SHA-256
`ETag` 和 `Vary: Cookie, X-Anyone-User-Id`。

这允许浏览器把已下载图片保存在自己的 HTTP 缓存中（**可能落盘**），但每次复用前必须在线向服务端重新验证；不是“禁止保存”的 `no-store`。
相同图片重新显示/页面重载仍可能发送网络请求；命中有效验证器时服务端仅返回无正文的 `304`，浏览器将已有图片正文交给原有 fetch-to-Blob 流程，避免重复传输原图。
不保证零网络、离线可用、所有浏览器都缓存或每次重载一定命中；浏览器缓存驱逐、禁用缓存、隐私模式及不同 Cookie 变体均可能导致重新下载。

- 不允许共享代理/CDN 的公开缓存，不设置正数 `max-age` 或 `immutable`。
- 每个 `200`/`304` 均按 Cookie 和捕获的用户头隔离变体，ETag 本身也按已认证用户、附件 ID、上传版本及响应元数据区分。账号切换不能复用另一账号的验证器取得 `304`。
- Cookie 认证和可选的 `X-Anyone-User-Id` 一致性检查仍由原有路由执行。随后在原有提交/ACL gate 内查询附件元数据，检查房间成员权限、消息删除、未发布附件所有权，以及从上传入库起计的 7 天期限。**所有检查通过之后**才比较 `If-None-Match`。
- 匹配时不查询 `Attachment.bytes`，`304` 正文为空。支持 GET 的弱比较、多个带引号的验证器和单独的 `*`；不匹配/无效验证器退回正常 `200` 原图响应。ETag 不通过读取/哈希原图来生成；前提是附件 ID 对应的原图在过期清理前不可变。
- 无会话、身份错位、无权限、已删除及已过期等失败保持原有状态码和 `Cache-Control: no-store`，不返回 ETag/Last-Modified。已缓存的验证器（包括 `*`）不能绕过这些检查。
- 不把图片加入 Service Worker Cache Storage；本改动不增加应用层持久图片仓库，不改变前端 fetch 的默认缓存模式，也不涉及缩略图、schema 或保留期限变更。

服务器撤销权限、删除消息或到期后，会拒绝后续在线验证，但**无法远程擦除浏览器已经保存、用户已经下载、截图或另行复制的旧字节**。已显示/已解码的图片也不是每个绘制帧都重新授权；原有前端删除/会话/到期处理仍负责界面生命周期。本方案不提供远程擦除或离线撤销保证。共享设备应同时遵循浏览器自身的账户和站点数据管理策略。

## 配置与兼容性

不增加环境变量、数据库迁移、后台任务或部署步骤；只改变已有认证下载接口的成功响应及条件请求处理。错误响应和其他 API 继续使用原有 `no-store` 策略。现有数据库图片保留/清理规则见 [private-room-retention.md](private-room-retention.md)。

## 验证

资源受限主机只运行不连接数据库、不启动服务器/浏览器的 Node 真源码隔离测试（Node >=24；若主机有统一资源 guard，必须经 guard 执行）：

```sh
node --disable-warning=ExperimentalWarning --test scripts/attachment-revalidation.node.mjs
```

本次本地 TDD 的实际结果：

1. 首个测试 RED：原接口没有 ETag，匹配 `^"[a-f0-9]{64}"$` 得到空字符串；实现最小 `200`/`304` 后 1/1 GREEN。
2. 弱比较 RED：`W/"…"` 得到 `200 !== 304`；实现实体标签列表解析后 2/2 GREEN。
3. 路由 RED：真实路由没有转交验证器，得到 `200 !== 304`；接线后 11/11 GREEN（包括认证顺序、账号隔离、过期/删除/未发布/权限保护）。

隔离测试执行真实 `Attachments`、真实保留期限函数和从 `app.ts` 提取的原路由/认证逻辑，只替换数据库与会话查询等外部边界；不是 Hono/Bun、真实数据库或浏览器验收。

CI 专属、此主机不执行的新增验证：

```sh
bun test apps/server/tests/application.test.ts --test-name-pattern 'authenticated attachment revalidation'
bun run test:e2e -- tests/e2e/attachment-revalidation.spec.ts
```

- Bun 应用测试复用既有隔离 SQLite fixture，通过真实 HTTP Cookie 会话验证 `200`/`304`、Vary、无正文、错误不带验证器、成员移除、删除、精确 7 天边界及失效会话；额外用真实 Prisma 查询事件断言匹配验证器没有二进制 SELECT、不匹配恰有一次二进制 SELECT。
- Chromium E2E 经过真实 UI 与 fetch-to-Blob，使用 CDP 的实际线上响应状态和编码正文计数确认重载得到 `304` 且无编码图片正文，显示图片仍可解码；验证缓存不能绕过删除或账号错位。**不使用 page.route/context.route**，因为请求拦截会禁用浏览器 HTTP 缓存。CDP `loadingFinished.encodedDataLength` 包含响应头，不能把它误报为图片正文；断言使用 `dataReceived.encodedDataLength` 的总和。
- 既有 GitHub Actions 自动发现上述应用/E2E 测试，覆盖 SQLite，并在 MySQL E2E job 执行同一浏览器用例。全量类型检查、应用套件、真实浏览器及 SQLite/MySQL 构建均须以实际 CI 结果为准；本地隔离 GREEN 不代表这些已通过。
