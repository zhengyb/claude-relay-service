# Claude Code Statusline 插件：上游账号 OAuth 用量展示

## 1. 背景

管理后台「账号管理 → 会话窗口」列已能展示 Claude OAuth 账号的官方配额利用率（5h / 7d / sonnet 三窗口），数据来自 relay 服务端主动调用 `https://api.anthropic.com/api/oauth/usage`。

但**下游用户**（用 Claude Code 接入本 relay）看不到这些信息——他们在使用共享账号池，却无法得知当前所用上游账号的配额还剩多少。当账号接近 5h 限流时，用户往往只能在请求失败后才察觉。

**目标**：为 Claude Code 开发一个 statusline 插件，脚本向 relay 查询「当前 API Key 所用上游 Claude 账号」的 oauth/usage，并实时显示在状态栏：

```
Usage: upstream 5h 42% (2h13m), 7d 18% (4d), sonnet 9% (4d); Daily $1.23/$10
```

## 2. 可行性分析

**结论：可行。** relay 侧所需能力已全部存在，只需新增一个 API Key 认证端点对外暴露。

### 2.1 已具备的能力

| 能力 | 位置 |
|------|------|
| 拉取上游 oauth/usage | `claudeAccountService.fetchOAuthUsage()` — `src/services/account/claudeAccountService.js:2051` |
| 构建三窗口快照（含 `remainingSeconds` 实时计算） | `claudeAccountService.buildClaudeUsageSnapshot()` — `:2123` |
| 写回快照到 Redis | `claudeAccountService.updateClaudeUsageSnapshot()` — `:2170` |
| 300 秒缓存机制（admin 用量页已落地，可复刻） | `src/routes/admin/claudeAccounts.js:540-578` |
| API Key 认证中间件，`req.apiKey` 含 `claudeAccountId` | `authenticateApiKey` — `src/middleware/auth.js` |

### 2.2 关键问题：如何确定「当前会话绑定的上游账号」

粘性会话绑定存于 Redis `unified_claude_session_mapping:{sessionHash}`，值为 `{"accountId":"...","accountType":"..."}`，TTL = `session.stickyTtlHours`（默认 1 小时）。

关键发现——**statusline 脚本可以拿到精确的会话标识**：

- Claude Code 渲染 statusline 时，会把一段 JSON 通过 stdin 传给脚本，其中含 `session_id`（当前会话 UUID）。
- relay 端 `generateSessionHash()` 在请求体含 `metadata.user_id` 时（现代 Claude Code 均会发送），**直接返回**其中嵌入的 `session_id`，不做任何 hash 或转换（`sessionHelper.js:17-24`）；且 `isValidSessionHash()` 全代码库未被调用，没有「必须 32 位 hex」的约束。
- 因此粘性映射的 key 后缀 = `metadata.user_id` 里的 `session_id` 原样。只要它与 statusline 输入的 `session_id` 是同一个会话 UUID，脚本把 `session_id` 传给端点即可精确直查。

**解决方案：分层解析，精确会话优先 + 兜底**

1. **精确会话直查**：脚本传 `?session=<session_id>` → 端点 `GET unified_claude_session_mapping:<session_id>` → 命中则用其 `{accountId, accountType}`。
2. **专属账号**：未命中 / 无 session 参数 → 若 API Key 绑定专属账号 `req.apiKey.claudeAccountId`，调度器对该 Key 永远使用此账号（`unifiedClaudeScheduler` 选账号优先级第 2 位），结果确定。
3. **最近用量记录兜底**：再未命中 → 读该 Key 最近一条 usage record。每次请求完成后 relay 会把 `accountId` / `accountType` 写入 Redis List `usage:records:{keyId}`（`LPUSH`，index 0 即最新，见 `src/models/redis.js:1758-1798`）。
4. 都没有 → 端点返回 `supported: false`。

精确路命中即按会话准确解析；未命中时优雅降级到原有逻辑，任何情况都不会出错。

> **必须先实测验证**：Claude Code 传给 statusline 的 `session_id`，是否等于它发 `/v1/messages` 时塞进 `metadata.user_id` 的 `session_id`。二者形状一致（小写带横线 UUID，见 `metadataUserIdHelper.js:11` 的 `_session_([a-f0-9-]+)$`），且 relay 的 metadata-session 特性本就是为跟踪 Claude Code 真实会话而设计，极可能相等——但这是客户端行为，需按第 10 节办法实测确认。若不相等，精确路失效、自动退回第 2/3 级，功能不受影响。

### 2.3 已知限制

- 精确会话直查仅在以下条件成立时有效：① Claude Code 发送了 `metadata.user_id`（现代版本均会发，旧版/裸 API 调用可能不发，此时 relay 退回内容 hash，脚本无法复现）；② 会话距上次请求未超过粘性映射 TTL（默认 1 小时，注意它短于 5h 用量窗口，长时间空闲后映射会过期）；③ 该会话至少已发过一次请求（首次请求前映射尚未创建）。不满足时自动降级到专属账号 / 最近用量记录。
- 降级到「最近用量记录」时，若同一 API Key 被**多个并发会话共享**且各自落到不同上游账号，结果只反映「最后一次请求」的账号。
- 仅 **Claude OAuth 账号**有 oauth/usage 数据；Setup Token 账号、Claude Console 账号无此数据，端点会明确返回「不支持」。

## 3. 整体架构

```
┌──────────────────────────┐         ┌────────────────────────────────────────┐
│  Claude Code (客户端)     │         │        Claude Relay Service            │
│                          │         │                                        │
│  statusLine 命令:         │  HTTPS  │  GET /v1/session-usage?session=…       │
│  node claude-statusline  │ ──────► │  (authenticateApiKey)                  │
│   .js                    │         │   │                                    │
│   - 读 stdin session_id  │         │   ├─ 解析账号(分层):                   │
│   - 读 env (BASE/KEY)    │         │   │   ① session 映射直查              │
│   - 本地缓存 60s          │ ◄────── │   │   ② API Key 专属账号              │
│   - 打印状态栏一行        │  JSON   │   │   ③ 最近 usage record             │
│                          │         │   ├─ 校验 OAuth 账号 (scopes)          │
│                          │         │   └─ 300s 缓存 → fetchOAuthUsage       │
│                          │         │                  → Anthropic API       │
└──────────────────────────┘         └────────────────────────────────────────┘
```

两个组件：

1. **relay 新端点** `GET /api/v1/session-usage` — 修改 `src/routes/api.js`
2. **客户端 statusline 脚本** `scripts/claude-statusline.js` — 新建（Node 单文件，零依赖）

## 4. 组件一：Relay 端点

### 4.1 路由

文件 `src/routes/api.js`，紧挨现有 `GET /v1/usage`（约 1670 行）新增：

```js
router.get('/v1/session-usage', authenticateApiKey, async (req, res) => { ... })
```

由于 `apiRoutes` 同时挂载在 `/api` 与 `/claude`（`src/app.js:336-338`），端点对客户端表现为 `/api/v1/session-usage`。

### 4.2 处理逻辑

1. **配置开关**：`config.statusLineUsage.enabled` 为 `false` → 返回 `404`（与未注册路由一致，不暴露端点存在）。
2. **解析目标账号（分层，命中即止）**：
   1. **精确会话**：若有 query 参数 `session`，读 `unified_claude_session_mapping:{session}`（逻辑同 `unifiedClaudeScheduler._getSessionMapping()`，`unifiedClaudeScheduler.js:1282`）。命中且 `accountType === 'claude-official'` → 用其 `accountId`，`resolvedBy = 'session'`。
   2. **专属账号**：未命中 → `req.apiKey.claudeAccountId` 非空**且不以 `group:` 开头** → 用之，`resolvedBy = 'dedicated'`。（`group:<id>` 是项目统一的组绑定语法，不是真实 accountId，传给 `getClaudeAccount` 会取空；这种情况下让 path 3 从最近 usage record 取实际命中的账号。）
   3. **最近用量记录**：仍未命中 → `redis.getUsageRecords(req.apiKey.id, 1)` 取 `[0]`，若 `accountType === 'claude-official'` → 用其 `accountId`，`resolvedBy = 'recent'`。
   4. 都没有 → `200 { supported: false, reason: 'no_account' }`。
   - `session` 参数需做基本校验（仅允许 `[a-f0-9-]`、长度上限如 64）；它只会拼接到固定前缀 `unified_claude_session_mapping:` 之后，无法越权读取其他键。
3. **校验 OAuth 账号**：`redis.getClaudeAccount(accountId)`，`scopes` 同时包含 `user:profile` 与 `user:inference`（判定逻辑同 `claudeAccounts.js:547`）。否则 → `200 { supported: false, reason: 'not_oauth' }`。
4. **取 usage（复刻 300s 缓存，参考 `claudeAccounts.js:556-578`）**：
   - `buildClaudeUsageSnapshot(accountData)`；若 `claudeUsageUpdatedAt` 距今 < `config.statusLineUsage.cacheTtlSeconds`（默认 300）→ 直接用；
   - 否则 `fetchOAuthUsage(accountId)` → `updateClaudeUsageSnapshot()` → 重新 `getClaudeAccount` + `buildClaudeUsageSnapshot`；
   - 若 `fetchOAuthUsage` 失败但 Redis 仍有旧快照 → 返回旧快照并标 `stale: true`；无任何快照 → `200 { supported:false, reason:'usage_unavailable' }`。
5. **附带 API Key 当日费用**：每个响应（仅 404 除外）都返回 `apiKey` 块 —— `dailyCostLimit` 取自 `req.apiKey`，`dailyCost` 由 `redis.getDailyCost(req.apiKey.id)` 实时读取（与限额同口径的倍率成本）。与上游账号解析无关，`supported:false` 时也照常返回。

### 4.3 请求 / 响应

**请求**
```
GET /api/v1/session-usage?session={claude_code_session_id}
Authorization: Bearer cr_xxxxxxxx
```

`session` 为可选参数（Claude Code 会话 UUID）：带上则走精确会话直查，省略则从专属账号 / 最近用量记录解析。

**响应（成功）**
```json
{
  "supported": true,
  "resolvedBy": "session",
  "cached": true,
  "stale": false,
  "usage": {
    "fiveHour":     { "utilization": 0.42, "resetsAt": "2026-05-22T18:00:00Z", "remainingSeconds": 7980 },
    "sevenDay":     { "utilization": 0.18, "resetsAt": "2026-05-26T09:00:00Z", "remainingSeconds": 345600 },
    "sevenDayOpus": { "utilization": 0.09, "resetsAt": "2026-05-26T09:00:00Z", "remainingSeconds": 345600 }
  },
  "apiKey": { "dailyCost": 1.23, "dailyCostLimit": 10 },
  "timestamp": "2026-05-22T15:46:00Z"
}
```

**响应（不支持）**
```json
{ "supported": false, "reason": "not_oauth", "apiKey": { "dailyCost": 1.23, "dailyCostLimit": 0 } }
```

`reason` 取值：`no_account`（API Key 无可解析账号）、`not_oauth`（账号是 Setup Token / Console，无 oauth/usage）、`usage_unavailable`（账号正常但本次取上游用量失败且无旧快照）。
`resolvedBy` 标明账号由哪一级解析得出：`session`（精确会话）/ `dedicated`（专属账号）/ `recent`（最近用量记录），便于排查精确路是否生效。
`apiKey` 块为该 API Key 的当日费用：`dailyCost` 已用、`dailyCostLimit` 限额（`0` 表示不限额）；所有响应分支均返回。

**设计取舍**：响应体仅返回用量数据、`resolvedBy` 与本 Key 费用，**不暴露 accountId / 账号名**，降低信息泄露面。`usage` 三窗口结构由 `buildClaudeUsageSnapshot` 原样产出；`utilization` 透传上游原值，单位归一化交给脚本端处理。

### 4.4 配置

端点**直接读环境变量**，不经 `config/config.js` —— 该文件被 gitignore、不随代码部署，新增配置项无法到达已有的生产环境；改用环境变量后，部署只需在服务器 `.env` 加一行。

- `STATUSLINE_USAGE_ENABLED` —— 不为 `'true'` 即视为关闭（默认关闭），关闭时端点返回 404。
- `STATUSLINE_USAGE_CACHE_TTL` —— oauth usage 服务端缓存秒数，默认 300。

`.env.example` 已登记这两项：

```
# Statusline 用量端点：允许下游 API Key 查询其上游 Claude 账号的 oauth/usage
# 注意：开启后下游可见上游账号的配额利用率（5h/7d/sonnet）
STATUSLINE_USAGE_ENABLED=false
STATUSLINE_USAGE_CACHE_TTL=300
```

### 4.5 复用清单

`authenticateApiKey`、`claudeAccountService.{fetchOAuthUsage, buildClaudeUsageSnapshot, updateClaudeUsageSnapshot}`、`redis.{getClaudeAccount, getUsageRecords, getDailyCost}`。粘性映射读取直接 `redis` GET `unified_claude_session_mapping:{session}`（逻辑同 `unifiedClaudeScheduler._getSessionMapping()`，3 行）。**不新增 service**。

## 5. 组件二：Statusline 脚本

新建 `scripts/claude-statusline.js`：Node 单文件，仅用内置 `https` / `http` / `fs` / `os` 模块，**零依赖、零安装**（所有 Claude Code 用户均已具备 Node 环境）。

### 5.1 行为流程

1. 读取 stdin 的 Claude Code JSON，取出 `session_id`（用于精确会话查询）；`model.display_name` 可选用于拼接前缀。
2. 读取环境变量：`ANTHROPIC_BASE_URL`（去除尾斜杠）、`ANTHROPIC_AUTH_TOKEN || ANTHROPIC_API_KEY`。
3. **本地缓存** `${os.tmpdir()}/claude-relay-statusline-{session_id}.json`（内容 `{ ts, line }`，按会话分文件避免多会话互相覆盖）：若距今 < 60 秒，直接打印缓存行并退出——保证 statusline 秒回，避免每次渲染都打 relay。
4. 否则请求 `GET {BASE}/v1/session-usage?session={session_id}`（`ANTHROPIC_BASE_URL` 按约定已含 `/api` 后缀，故端点绝对路径为 `/api/v1/session-usage`），头 `Authorization: Bearer {key}`，**超时 2 秒**。
5. 格式化输出（三窗口 + 重置时间 + API Key 当日费用）：
   ```
   Usage: upstream 5h 42% (2h13m), 7d 18% (4d), sonnet 9% (4d); Daily $1.23/$10
   ```
   - utilization 单位兼容：值 `<= 1` 视为比例，乘以 100；
   - `remainingSeconds` 格式化为 `Xh Ym` / `Xd` / `<1m`；剩余 ≤0 不显示括号；
   - 费用段 `$已用/$限额` 来自响应 `apiKey` 块；无每日限额（`dailyCostLimit` 为 0）时限额显示 `$NA`；
   - `supported: false` → 打印简短提示（如 `Claude (账号无配额数据)`），费用段仍照常拼接。
6. 写入本地缓存，打印一行。
7. **容错**：任何错误 / 超时 → 打印过期缓存行（若有），否则打印中性占位（如 `Claude —`）。脚本**始终 `exit 0`、永不抛错**，避免拖垮 statusline 渲染。

### 5.2 接入方式

在 `~/.claude/settings.json` 添加：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /绝对路径/claude-relay-service/scripts/claude-statusline.js"
  }
}
```

脚本依赖 Claude Code 进程已设置的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 环境变量。

## 6. 数据流

```
Claude Code 渲染 statusline（stdin 传入 session_id）
  → 执行 node claude-statusline.js
    → 本地缓存命中(<60s)? ── 是 → 打印缓存行
                          └─ 否 ↓
    → GET {relay}/api/v1/session-usage?session={session_id}  (Bearer cr_key, 超时 2s)
        → authenticateApiKey
        → 解析账号(分层): ①session映射直查 → ②专属账号 → ③最近usage记录
        → 校验 OAuth 账号
        → relay 300s 缓存命中? ── 是 → buildClaudeUsageSnapshot
                               └─ 否 → fetchOAuthUsage → Anthropic oauth/usage
                                        → updateClaudeUsageSnapshot (写 Redis)
        → 返回三窗口 JSON (含 resolvedBy)
    → 脚本格式化 → 写本地缓存 → 打印一行
```

两级缓存：脚本本地 60 秒 + relay 服务端 300 秒。即使多个 statusline 频繁渲染，对 Anthropic 上游的真实调用上限约为「每账号每 5 分钟一次」。

## 7. 边界情况与错误处理

| 场景 | 端点行为 | 脚本行为 |
|------|----------|----------|
| 配置开关关闭 | `404` | 打印占位 `Claude —` |
| `session` 参数未命中映射（过期 / 该会话未发过请求 / 未发 metadata） | 自动降级到专属账号 / 最近 usage record | 正常显示（`resolvedBy` 非 `session`） |
| API Key 无专属账号且无 usage record（全新 Key） | `200 { supported:false, reason:'no_account' }` | 打印 `Claude (暂无数据)` |
| 账号为 Setup Token / Console | `200 { supported:false, reason:'not_oauth' }` | 打印 `Claude (账号无配额数据)` |
| 上游 oauth/usage 超时，但有旧快照 | `200 { stale:true, ... }` | 正常显示（数据略旧） |
| 上游 oauth/usage 超时，无任何快照 | `200 { supported:false, reason:'usage_unavailable' }` | 打印占位 + 费用段 |
| relay 不可达 / 网络错误 | — | 打印过期缓存或占位，`exit 0` |
| 环境变量缺失 | — | 打印占位，`exit 0` |

## 8. 安全考量

- 端点经 `authenticateApiKey` 全链路认证，仅持有效 `cr_` Key 者可访问。
- 端点默认**关闭**，需管理员显式设置 `STATUSLINE_USAGE_ENABLED=true` 才启用——因为它会让下游用户看到上游账号的配额利用率（属轻度信息披露）。
- 响应体不返回 `accountId` / 账号名，仅返回利用率百分比与重置时间。
- 复用既有 300s 缓存，下游无法借此端点高频触发对 Anthropic 的请求。

## 9. 改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/routes/api.js` | 修改 | 新增 `GET /v1/session-usage` 路由（直读环境变量开关） |
| `.env.example` | 修改 | 新增 `STATUSLINE_USAGE_ENABLED` / `STATUSLINE_USAGE_CACHE_TTL` |
| `scripts/claude-statusline.js` | 新建 | 客户端 statusline 脚本（Node 零依赖） |

## 10. 测试与验证

1. 启动 relay：`STATUSLINE_USAGE_ENABLED=true npm run dev`。
2. **验证 session_id 等价性（精确路前提）**：开启 debug 日志，从 Claude Code 发一次请求，relay 会打印 `📋 Session ID extracted from metadata.user_id: <id>`（`sessionHelper.js:21`）；同时查看该 Claude Code 会话 statusline 输入的 `session_id`（可临时让脚本把 stdin dump 到文件）。两字符串相等 → 精确路可用。亦可在请求后 `redis-cli KEYS 'unified_claude_session_mapping:*'` 比对 key 后缀。
3. **端点 — 精确会话**：用上一步确认的 `session_id`：
   ```
   curl -s "http://127.0.0.1:3000/api/v1/session-usage?session=<id>" -H "Authorization: Bearer cr_xxx" | jq
   ```
   预期 `supported:true`、`resolvedBy:"session"`、三窗口有值；二次调用 `cached:true`。
4. **端点 — 省略 session**：不带 `session` 参数（必要时先发一次 `/api/v1/messages` 产生 usage record），预期由专属账号或最近 usage record 解析，`resolvedBy` 为 `dedicated` / `recent`。
5. **端点 — 开关关闭**：不设 `STATUSLINE_USAGE_ENABLED`，预期 `404`。
6. **端点 — 非 OAuth**：用绑定 Setup Token / Console 账号的 Key，预期 `supported:false, reason:'not_oauth'`。
7. **端点 — 无账号**：用全新、未发过请求且无专属账号的 Key（且不带 session），预期 `supported:false, reason:'no_account'`。
8. **脚本**：
   ```
   echo '{"session_id":"<id>","model":{"display_name":"Sonnet"}}' | \
     ANTHROPIC_BASE_URL=http://127.0.0.1:3000/api ANTHROPIC_AUTH_TOKEN=cr_xxx \
     node scripts/claude-statusline.js
   ```
   预期打印 `5h .. · 7d .. · sonnet ..`；故意改错 URL 时不报错、打印占位。
9. **端到端**：在 `~/.claude/settings.json` 配置 `statusLine`，重启 Claude Code，确认状态栏实时显示。
10. 对修改的后端文件执行 `npx prettier --write` 与 `npm run lint`。

## 11. 后续可选增强

- **合并 Key 维度用量**：在同一端点同时返回 `apiKeyService.getUsageStats()` 的 Key 费用 / Token，使 statusline 一并展示个人用量与上游配额。
- **颜色提示**：脚本根据利用率阈值（如 >80% 标红）输出 ANSI 颜色。
