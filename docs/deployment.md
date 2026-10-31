# 生产部署：现有 MySQL，无应用挂载

入口 `https://im.mh33.top`，镜像 `1596944197/anyone-im:latest`。

- 复用 `default` 项目的现有默认网络和 MySQL，不声明 networks，不创建新 MySQL。
- IM 服务没有 volumes 和 env_file；所有变量明确列在 environment：NODE_ENV=production、HOST=0.0.0.0、PORT=4100、DB_PROVIDER=mysql、PUBLIC_ORIGIN=https://im.mh33.top，以及独立账号的 DATABASE_URL。
- GitHub 模板不保存真实生产密码。已填好真实密码、无需再补变量的生产服务片段单独提供，不提交 Git。账号和数据库仍由管理员在首次部署时创建。

## 存储

账号、会话、房间、消息、附件信息和图片字节全部存入独立 anyone_im 数据库。图片最大 **10 MiB**，MySQL 使用 MEDIUMBLOB；消息历史只查询附件信息，不批量读取图片字节。应用容器可删除重建，无需上传目录或应用数据卷。

MySQL max_allowed_packet 应至少为 16 MiB；不擅自修改共享数据库参数。备份独立 IM 数据库和受保护配置。旧磁盘附件版开发数据如需保留应单独导入，不使用 reset/force-reset/accept-data-loss。

## 分工

镜像可由[手动 Docker 发布工作流](docker-publish.md) 在 GitHub 托管 runner 上构建，**生产服务器不安装构建依赖、不构建、不运行 CI 烟测**。先合并工作流到 `main`，再由用户为 Docker Hub 用户 `1596944197` 添加仓库 Actions secret `DOCKERHUB_TOKEN`（具有该镜像仓库写权限的访问令牌）。缺少凭据时任务直接失败；配置后只能在默认分支手动触发 `Manual Docker build and publish`，普通 push / PR 只运行验证 CI，不构建或发布 Docker 镜像。用户也可以自行本地构建推送；无论哪种方式，部署前都须确认具体镜像版本就绪。

确认对应提交的 CI 构建、烟测和 Docker Hub 推送均成功后，管理员再另行安排部署。CI 不自动更新生产容器。首次部署创建独立库/账号；首次建表临时授权 CREATE/ALTER/INDEX/REFERENCES，用正式 MySQL 镜像显式执行 bun run db:push，然后撤销 DDL 权限，仅保留 SELECT/INSERT/UPDATE/DELETE。之后只操作新服务：

```sh
docker compose -f /docker-compose.yaml -p default pull anyone-im
docker compose -f /docker-compose.yaml -p default up -d --no-deps anyone-im
```

不运行项目级 down/--remove-orphans，不重启现有 MySQL 或其他业务容器。

## Nginx

源配置在 my-chatgpt-site/dev 的 docker-compose/my-docker-compose.yml 与 docker-compose/nginx/t_nginx.conf，生产文件为 /docker-compose.yaml 与 /mnginx.conf。

独立 im.mh33.top 证书不覆盖旧域名。HTTP 保留 ACME 校验，其余跳转 HTTPS；Docker DNS 动态解析 anyone-im:4100；转发网页/API/Socket.IO，75 秒超时，**11 MiB 请求上限**为 10 MiB 图片的 multipart 留余量。修改前备份并 nginx -t，成功后平滑 reload；单文件 bind mount 配置原地写入保留 inode。

证书可通过现有 certbot 配置独立续期，成功后检查并平滑加载 Nginx：

```sh
docker compose -f /docker-compose.yaml -p default run --rm --no-deps certbot renew --cert-name im.mh33.top
```

最小上线验证为 HTTPS、readyz、会话、WebSocket，以及无应用卷重建后的图片读取。首版单实例、内存上限 384 MiB；不自动接入旧站 SSO、历史数据或 /groupChat 路由。回滚保留数据库；schema 不兼容时先停止评估，不强行回退或删数据。
