# Railway 部署

本项目在 Railway 使用根目录 `Dockerfile`。运行时是单实例 Bun 服务，数据存入 SQLite。Railway 上必须为 `/app/data` 挂载 Volume；Redis 不需要，也不能替代 SQLite Volume。

## 1. 创建服务

1. 在 Railway 新建 Project，选择 **Deploy from GitHub repo**，授权并选择本仓库。
2. Railway 会读取 `railway.json`，以 Dockerfile 构建并用 `/health` 判断就绪。
3. 在服务的 **Settings > Networking** 生成公开域名。
4. 保持一个副本。SQLite 不支持多个副本同时写同一个 Volume。

## 2. 创建持久化存储

在项目画布中为该服务创建 Volume，Mount Path 必须填写：

```text
/app/data
```

Railway Variables 中必须设置 `REQUIRE_PERSISTENT_STORAGE=true`。

不要挂载到 `/app`，否则会覆盖应用文件。Volume 创建后 Railway 会注入 `RAILWAY_VOLUME_MOUNT_PATH=/app/data`。数据库路径应保持 `/app/data/postman2api.db`。

## 3. 配置 Variables

以下为 Railway 推荐值。三个密钥必须分别随机生成，不能留空、不能相同、不能使用示例值。

| 变量 | Railway 值 | 必需 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` | 是 | 启用生产安全校验 |
| `HOST` | `0.0.0.0` | 是 | Railway 外部流量需要 |
| `PORT` | Railway 自动提供 | 否 | 不要固定覆盖平台的 `PORT` |
| `ADMIN_KEY` | 32 字符以上随机值 | 是 | Dashboard 和 `/api/*` 管理认证 |
| `API_KEY` | 32 字符以上随机值 | 是 | OpenAI/Anthropic 兼容接口认证 |
| `ENCRYPTION_KEY` | 64 位十六进制 | 是 | 加密账号 token 和代理凭据；丢失后无法解密 |
| `DATABASE_PATH` | `/app/data/postman2api.db` | 是 | SQLite 位于 Volume 内 |
| `REQUIRE_PERSISTENT_STORAGE` | `true` | 是 | 未正确挂载 Volume 时让 `/health` 返回 503，阻止错误切流 |
| `ENABLE_BROWSER_LOGIN` | `false` | 推荐 | Railway 无交互式桌面；使用 Dashboard 手工导入账号 token |
| `CAMOUFOX_HEADLESS` | `true` | 否 | 仅启用浏览器登录时使用 |
| `PROXY_BOOTSTRAP` | 私密多行代理文本 | 否 | 首次启动自动导入，重复部署会去重 |
| `PROXY_BOOTSTRAP_FILE` | 留空 | 否 | 容器内文件路径；Railway 通常使用上一个变量 |
| `PROXY_TEST_URL` | `https://api.ipify.org?format=json` | 否 | 代理连通性测试目标 |
| `PROXY_TEST_TIMEOUT_MS` | `10000` | 否 | 单个代理测试超时 |
| `REQUEST_TIMEOUT_MS` | `120000` | 否 | 普通请求总超时 |
| `STREAM_FIRST_BYTE_TIMEOUT_MS` | `30000` | 否 | 流式请求首字节超时 |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | 否 | 流式请求空闲超时 |
| `WARMUP_ENABLED` | `true` | 否 | 周期检查账号健康和配额 |
| `WARMUP_INTERVAL_MS` | `900000` | 否 | 健康检查间隔，最小值由应用校验 |

PowerShell 可生成密钥：

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

对 `ADMIN_KEY`、`API_KEY`、`ENCRYPTION_KEY` 分别执行一次。将结果直接放入 Railway Variables，不要写入仓库、构建参数或日志。

## 4. 首次验证

部署完成后依次检查：

```text
GET https://你的域名/livez
GET https://你的域名/health
```

`/livez` 只证明进程存活。`/health` 只有在迁移完成、数据库可写、生产配置有效且 Volume 正确挂载时才返回 200。若 `/health` 为 503，先查看 JSON 中的检查项，不要改成虚假的固定 200。

打开域名后输入 `ADMIN_KEY` 进入 Dashboard。调用 `/v1/chat/completions` 使用 `Authorization: Bearer <API_KEY>`；Anthropic 客户端也可使用 `x-api-key: <API_KEY>`。

## 5. 代理一次性导入

推荐将代理放在 Railway 的私密多行变量 `PROXY_BOOTSTRAP` 中，每行一个。应用每次启动都会解析，但按标准化 URL 去重，因此可安全重部署。例如：

```text
http://user:password@host.example:8080
host.example:8081
host.example:8082:user:password
```

也可以在 Dashboard 的 **Proxies** 页面粘贴同样内容并批量导入、测试和自动分配。Bun 当前仅可靠支持 HTTP/HTTPS 上游代理；SOCKS4/SOCKS5 会明确拒绝，而不是显示导入成功后静默直连。

公共代理可能记录目标地址、注入故障或随时失效。不要在不受信任的代理上承载敏感账号；代理密码只应存在 Railway Variables 或 Dashboard 导入请求中，服务会加密后写入 Volume。

## Redis 与扩容

Redis 在当前架构中不需要。账号池、代理轮询和请求状态都在单个 Bun 进程内，持久数据在 SQLite。增加 Redis 既不能替代 `/app/data` Volume，也不能让 SQLite 自动支持多副本。

如果将来需要多副本，应先把 SQLite 迁移到 PostgreSQL，并为账号租约/并发计数设计跨实例协调；完成之前保持 `numReplicas: 1`。
