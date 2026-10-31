# 手动 Docker 镜像构建与发布

工作流 `.github/workflows/docker-publish.yml` 名称为 **Manual Docker build and publish**。目标固定为 `1596944197/anyone-im`，用户名 `1596944197`，平台 `linux/amd64`。

## 自动验证、手动发布

- `.github/workflows/ci.yml` 保留 push / PR 的 SQLite、MySQL、浏览器、类型和应用构建验证。
- Docker 发布工作流仅接受手动 `workflow_dispatch`，并且只在默认分支 `main` 执行；普通 push / PR 不再构建或发布 Docker 镜像。
- 需要仓库 Secret `DOCKERHUB_TOKEN`；令牌缺失时直接失败，不把“只构建未发布”当作成功。
- GitHub token 仅授予 `contents: read`，依赖 action 固定完整 commit SHA，任务限时 30 分钟，不因后续任务中途取消正在进行的发布。

手动启动：

```sh
gh workflow run docker-publish.yml --repo sansan-mei/anyone-im --ref main
```

或在 GitHub Actions 页面选择 **Manual Docker build and publish → Run workflow → main**。镜像构建和推送需用户对本次远端任务的明确授权，普通合并或测试请求不作为构建授权。生产机不运行本地 Docker 构建。

## 发布门禁

1. GitHub 托管 runner 使用仓库 Dockerfile 构建并加载为 `anyone-im:ci`，不先推送。
2. 断网检查镜像里的 PWA manifest、worker 和安装图标确实存在。
3. 执行 `bash scripts/ci-container-smoke.sh anyone-im:ci`。该脚本只允许在 GitHub Actions 环境运行，使用一次性 MySQL 8.4、隔离网络和数据库卷，不连接生产 MySQL。
4. 烟测验证非 root、Prisma MySQL 客户端、生产 Secure/HttpOnly Cookie、10 MiB 上传及超限拒绝、应用无数据挂载，以及删除并新建应用容器后会话、消息、图片字节保持一致。退出时清理临时容器、网络、卷及会话文件。
5. 只有烟测成功后，才登录 Docker Hub 并发布同一个已验证镜像，不二次构建。标签为 `latest` 和 `sha-<完整提交SHA>`；部分推送失败会使任务失败，需核对两个标签后重试。

成功状态、目标提交、打包检查、烟测和推送步骤都应读回核验。**构建成功不等于发布成功**；原有手动 `published-image-smoke` 只检查仓库已存在的镜像，不证明当前提交已发布。

本工作流不部署生产、不重启容器、不修改生产数据库。上线需单独明确授权，并按已验证的提交标签或镜像摘要拉取，保留回滚版本。部署架构见 [deployment.md](deployment.md)。
