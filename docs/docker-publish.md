# Docker 镜像构建与发布

工作流：`.github/workflows/docker-publish.yml`，名称 **Docker build and publish**。目标固定为 Docker Hub 的 `1596944197/anyone-im`，登录用户名固定为 `1596944197`，仅构建 `linux/amd64`。

## 触发与发布边界

| 事件 | 构建并烟测本次镜像 | 推送 Docker Hub |
| --- | --- | --- |
| push 到 `ci/docker-publish` | 是 | 否，即使已有凭据 |
| 面向 `main` 的 pull request | 是 | 否，包括同仓库 PR |
| push 到默认分支 `main` | 是 | 仅当 `DOCKERHUB_TOKEN` 非空 |
| 手动 `workflow_dispatch` | 是 | 仅当所选分支为默认分支且令牌非空 |

其他分支的 push 不触发本工作流。不使用 `pull_request_target`；GitHub token 仅授予 `contents: read`。依赖 action 固定完整 commit SHA，任务限时 30 分钟，使用 GitHub Actions BuildKit 缓存和并发控制；默认分支发布不因后续运行而中途取消。

允许发布时只生成两个标签：`latest` 和 `sha-<完整提交 SHA>`。PR、功能分支和缺少令牌的运行不会登录 Docker Hub，也不会推送任何标签。缺少令牌会显示 warning，但仍必须完成镜像构建和烟测。**构建成功不等于推送已验证**；本 PR 的无凭据验证不声称 Docker Hub 发布成功。

## 明天提供凭据时

1. 先审核并合并 PR 到 `main`。本功能分支仅供构建验证，不会发布。
2. 用户在 Docker Hub 为账号 `1596944197` 创建访问令牌，给予 `1596944197/anyone-im` 的写权限（例如 Read & Write），并确认目标仓库存在/可写。不要把令牌贴到聊天、提交到 Git 或写入工作流。
3. 打开本 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret**，名称必须为 `DOCKERHUB_TOKEN`，值为上述令牌。无需配置用户名 secret。
4. 进入 **Actions → Docker build and publish → Run workflow**，选择 `main`；或通过后续 `main` push 触发。只添加 secret 不会自动触发构建。
5. 检查该提交的构建、烟测、登录和发布步骤均成功，再到 Docker Hub 核对 `latest` 与 `sha-<该提交完整 SHA>`。仅看到 build-only 摘要或原有烟测成功不能证明发布成功。

本次不修改仓库凭据，不合并 PR，不改默认分支，不部署生产服务。令牌错误或权限不足会让登录/推送失败，不会静默标为已发布。标签逐个推送并非事务，若中途失败应检查两个标签并重新运行默认分支工作流。

## 发布前验证的是什么

在全新的 GitHub 托管 Ubuntu runner 上用仓库 Dockerfile 构建，将结果加载为 `anyone-im:ci`，**不先推送**。随后执行：

```sh
bash scripts/ci-container-smoke.sh anyone-im:ci
```

脚本需要 runner 自带的 Docker、Bash，拉取临时 `mysql:8.4` 并创建隔离网络与数据库卷；镜像需包含 Bun、Prisma CLI、生成的 MySQL 客户端、contracts 源码和已构建的前端。它会执行 `db:push`，检查非 root、生产 Secure/HttpOnly Cookie、10 MiB 上传及超限拒绝、应用无数据挂载、删除并重建应用容器后会话/消息/图片字节仍保持一致，退出时清理临时容器、网络、卷和会话文件。仅使用一次性测试数据库，不连接现有生产 MySQL；不要在生产机运行或绕过脚本的 GitHub Actions 环境保护。

只有上述烟测成功后才登录 Docker Hub，通过 `docker tag` / `docker push` 发布**同一个已加载并验证的本地镜像**，不二次构建。构建缓存仅用于加速，不跳过烟测。

原 `.github/workflows/ci.yml` 的 SQLite/浏览器、MySQL/浏览器测试保留不变；其手动任务 `published-image-smoke` 仍拉取已发布的 `1596944197/anyone-im:latest`，用于复查旧镜像，不验证当前提交的新构建。新增工作流不取代原有测试，也不会自动部署、重启或改动生产服务。生产部署仍见 [deployment.md](deployment.md)。
