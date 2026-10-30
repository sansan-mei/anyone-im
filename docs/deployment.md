# 生产接入：现有 Docker MySQL + Nginx

正式入口：`https://im.mh33.top`。镜像：`1596944197/anyone-im:latest`。

## 简化 Compose

`compose.yaml` 只运行 IM，不创建 MySQL，也不声明 `networks`。`name: default` 与现有生产 Compose 项目一致，因此自动使用已经存在的 `default_default` 网络，容器通过 `mysql:3306` 访问数据库，Nginx 通过 `anyone-im:4100` 反代。

- 不要执行整个生产项目的 `down`，不要使用 `--remove-orphans`。
- 仅操作新服务：`docker compose up -d --no-deps anyone-im`。
- `127.0.0.1:4100` 只作为宿主机诊断入口；公网走现有 Nginx 的 443。
- 数据卷是 `default_anyone-im-data`，映射 `/data`；镜像的非 root 用户拥有初始目录。
- 应用内存上限 384MiB；第一版保持单实例。

## 配置

独立使用本仓库 Compose 时，将 `.env.example` 复制为 `.env` 并填写 `DATABASE_URL`。合入旧站生产 Compose 时，服务从 `/anyone-im.env` 读取同样的环境配置，该文件权限应为 `0600`，不得提交到 Git。

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=4100
DB_PROVIDER=mysql
PUBLIC_ORIGIN=https://im.mh33.top
DATA_DIR=/data
DATABASE_URL=mysql://anyone_im:URL编码后的独立随机密码@mysql:3306/anyone_im
```

只填写新建的 `anyone_im` 数据库专用账号，不复用其他业务库或 root 账号。建库和首次建表是显式管理员步骤；不要执行 reset、force-reset 或 accept-data-loss。首次建表只需要在新库临时授权 CREATE/ALTER/INDEX/REFERENCES，完成后撤销，运行账号仅保留 SELECT/INSERT/UPDATE/DELETE。后续 schema 升级也必须经管理员审查和备份。

## 镜像和启动

以下构建和推送命令**只在用户构建机执行，不在生产服务器执行**。生产服务器只拉取、运行镜像。

```sh
# 在用户构建机发布 amd64 镜像及 latest（生产机是 x86_64）。
docker buildx build --platform linux/amd64 -t 1596944197/anyone-im:latest --push .

# 以下命令才在生产服务器执行；不创建或重启 mysql/nginx。
docker compose -f /docker-compose.yaml -p default pull anyone-im
docker compose -f /docker-compose.yaml -p default up -d --no-deps anyone-im
```

MySQL schema 初始化必须使用生成了 MySQL Prisma client 的正式镜像，只对新库运行 `bun run db:push`。运行账号撤销 DDL 权限后不能直接用它升级 schema。

## HTTPS 与 Nginx

旧站配置仓库位置：`sansan-mei/my-chatgpt-site` 的 `dev` 分支，`docker-compose/my-docker-compose.yml` 和 `docker-compose/nginx/t_nginx.conf`。生产实际入口是 `/docker-compose.yaml` 与单文件 bind mount `/mnginx.conf`。

- 为 `im.mh33.top` 单独申请证书，使用 `/etc/letsencrypt/live/im.mh33.top/`，不覆盖旧域名证书。
- HTTP 保留 `/.well-known/acme-challenge/`，其余跳转 HTTPS。
- HTTPS 同域转发网页、`/api`、`/socket.io/`；设置 WebSocket Upgrade、75 秒代理读取超时、6MiB 请求限制。
- upstream 使用 Docker DNS `127.0.0.11` 动态解析 `anyone-im:4100`，容器更新后不依赖旧 IP。
- 修改前备份，先运行 `nginx -t`，然后平滑 reload，不重建其他容器。
- 单文件 bind mount 的配置必须原地写入，保留 inode；原子替换宿主机文件可能使容器继续读取旧文件。

新域名证书可独立续期；使用现有 certbot 配置和 webroot，不更改旧证书：

```sh
docker compose -f /docker-compose.yaml -p default run --rm --no-deps certbot renew --cert-name im.mh33.top
# 实际续期成功后 nginx -t，再平滑 reload。
```

## 验证与回滚

检查 HTTPS 证书、`/readyz`，再以真实浏览器验证访客进入、私密房间邀请、双向消息、受授权图片与 WebSocket。正式 Secure Cookie 需要 HTTPS，不能为明文公网登录而关闭。

备份新库、上传卷和受保护配置。回滚只切回上一版 IM 镜像及新增 Nginx 配置，不删除数据卷，不停止既有 MySQL，不对旧业务库执行结构更改。旧站 SSO、历史消息导入及 `/groupChat` 路由切换不属于此次接入。
