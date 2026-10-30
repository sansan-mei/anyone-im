# 用二级域名部署 Anyone IM

本文件是部署说明，不会自动修改当前生产机。下面用 `im.example.com` 举例，换成实际域名。应用默认端口 **4100**；网页、API 和 Socket.IO 共用这个端口。

## 1. 部署前

- DNS 指向服务器，申请覆盖该二级域名的 HTTPS 证书。
- 检查宿主机监听端口和 Docker 端口映射，确认 4100 没有被新服务占用；需要时在 `.env` 修改 `IM_PORT`。
- 检查剩余内存、磁盘和备份空间。默认 Compose 新起独立 MySQL（不映射宿主机 3306），数据库内存上限 768MiB、应用 384MiB；不是容量保证，按实际负载调整。
- 不要直接给应用现有业务库的 root 凭据。如复用已有 MySQL，另建独立数据库和最小权限账号，并另行调整 Compose，不要运行任何 reset 或接受数据丢失的选项。

## 2. 配置与首次启动

```sh
git clone https://github.com/sansan-mei/anyone-im.git
cd anyone-im
cp .env.example .env
```

编辑 `.env`：

```dotenv
PUBLIC_ORIGIN=https://im.example.com
IM_PORT=4100
BIND_ADDRESS=127.0.0.1
MYSQL_PASSWORD=自行生成的随机十六进制密码
MYSQL_ROOT_PASSWORD=另一份随机十六进制密码
```

两份密码应独立生成并妥善保存，例如使用 `openssl rand -hex 24`。这里建议十六进制，避免手写数据库 URL 时的编码歧义。仓库没有默认生产密码，空密码会让 Compose 配置检查失败。不要把 `.env` 提交到 Git。

```sh
docker compose build
docker compose up -d db
# 独立数据库首次建表；生成过 MySQL client 的镜像运行，不触碰其他库。
docker compose run --rm relay-im bun run db:push
docker compose up -d relay-im
```

应用 readiness 会核查所需表，不会因为 MySQL 的 SELECT 1 成功就假装已初始化。首次建表是显式步骤；升级前先备份并审查 schema 变更。`db:push` 不使用 `--force-reset` 或 `--accept-data-loss`；如果需要破坏性更改应停止并设计迁移。

默认入口只绑定在 `127.0.0.1:4100`，不会直接向公网暴露 HTTP。应用运行用户为非 root，上传目录存于独立命名卷。MySQL 只在内部 database 网络，应用还加入 edge 网络。

## 3. Nginx 在宿主机上

参考 [nginx.example.conf](nginx.example.conf)，upstream 使用 `127.0.0.1:4100`（如果改了 IM_PORT，相应调整）。配置里的证书路径和域名都要换成实际值。

先测试配置，再在获得上线授权后进行平滑 reload；不要直接替换整份已有 Nginx 主配置。

## 4. Nginx 本身也在 Docker 里

容器中的 `127.0.0.1` 是 Nginx 自己，不是宿主机，不能原样照抄宿主机 upstream。

- 将反向代理接入这个项目的 **edge** 网络，默认名称 `relay-im_edge`。例如确认现有反向代理容器名确实为 `nginx` 后，授权部署时可执行：

  ```sh
  docker network connect relay-im_edge nginx
  ```

- 将示例 upstream 改成 `relay-im:4100`，这是 Compose 服务名。不要把反向代理接到 database 网络。
- 该连接在 Nginx 容器被重新创建后可能丢失；稳定上线应在反向代理自己的 Compose 中声明外部 edge 网络。修改已有生产 Compose 前先复核影响并获得授权。
- 这种接法不要求将 BIND_ADDRESS 改成 `0.0.0.0`，也不要求开放新的公网端口；只开放 HTTPS 即可。

## 5. 验证

```sh
docker compose ps
curl -f http://127.0.0.1:4100/healthz
curl -f http://127.0.0.1:4100/readyz
curl -I https://im.example.com/
```

再用两个独立浏览器会话实际验证：游客进入、创建私有房间、邀请加入、双向聊天、图片读取、断线恢复、移除成员后的拒绝访问。生产 Secure Cookie 需要 HTTPS；不要为了让明文公网 HTTP 能登录而关闭 Secure。

同域 `/api` 与 `/socket.io/` 必须正确反代。Socket.IO 需要 WebSocket Upgrade 头和足够的读取超时；不要把 `/socket.io/` 发到旧 ChatGPT 服务。

## 6. 运行与备份

- 本版是单应用进程；不要直接加多个应用副本，在线状态、消息通知与限流尚未分布式化。
- 不要将 `NODE_ENV=test` 用作生产配置。正式 PUBLIC_ORIGIN 必须是实际 HTTPS origin。
- 后端不信任任意来源的转发 IP 头；反代后认证限流按直接代理 IP 计算，应按访问规模配置入口限流及应用额度，不要无上限开放匿名注册/图片上传。
- 附件目前验 MIME/签名/大小，不做解码重编码或病毒扫描；应配置容量监控与保留/清理策略。
- 备份必须同时包括 MySQL 逻辑备份、上传数据卷和保管好的配置。需要一致备份时先安排短暂停写，不要在线复制 MySQL 数据目录后宣称备份一致。
- 更新前保留上一版镜像和可恢复备份。不删除数据卷，不运行无审查的清理/覆盖命令。
- 旧站 SSO、历史导入与 `/groupChat` 入口切换没有自动执行，应作为单独迁移步骤安排。
