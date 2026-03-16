# 安全审计报告 — Claude Relay Service

**日期：** 2026-02-26
**审计范围：** 完整代码库（`src/`、`config/`、`cli/`、`scripts/`、`web/`、`package.json`、`Dockerfile`）
**审计工具：** Claude Opus 4.6（自动化静态分析）
**提交版本：** `af0a73b`（分支：`fix/allow-opus-for-free-accounts`）

---

## 审计摘要

本次审计从**数据外泄**、**后门与认证绕过**、**凭证窃取与 Token 处理**、**混淆代码与供应链安全**四个维度对代码库进行了全面分析。共检查了 150+ 个 JavaScript 源文件、所有配置文件、构建脚本及 Docker 相关文件。

**审计结论：未发现恶意行为。**
项目中不存在后门、隐藏的数据外泄通道，也没有任何旨在窃取用户账户或凭证的代码。审计过程中发现了若干安全卫生问题，详见下文。

---

## 审计维度与覆盖范围

| 维度 | 检查文件 | 检查手段 |
|------|----------|----------|
| 数据外泄 | `src/`、`config/`、`scripts/`、`cli/` 全部文件 | 追踪所有 HTTP/HTTPS 调用，检查硬编码 URL/IP、base64 编码端点、DNS 外泄模式 |
| 后门与认证绕过 | `src/middleware/auth.js`、所有路由文件、`apiKeyService.js`、`config.js`、`data/init.json` | 搜索硬编码凭证、认证绕过逻辑、隐藏路由、eval/Function 动态执行 |
| 凭证窃取 | 所有 service 文件、`logger.js`、`tokenMask.js`、`oauthHelper.js` | 验证加密实现、检查日志中的 Token 泄露、验证哈希逻辑 |
| 混淆代码与供应链 | `package.json`、`Dockerfile`、`docker-entrypoint.sh`、`Makefile`、git hooks | 检查 npm 生命周期脚本、child_process 调用、动态代码执行、依赖合法性 |

---

## 一、恶意行为分析

### 1.1 数据外泄 — 未发现

所有对外网络请求均指向合法的上游 API：

| 目标地址 | 用途 |
|----------|------|
| `api.anthropic.com` | Claude API |
| `generativelanguage.googleapis.com` | Google Gemini API |
| `api.openai.com` | OpenAI API |
| `api.github.com` | 版本检查 |
| `api.telegram.org` | 用户自行配置的 Telegram 通知 |
| `api.day.app` | 用户自行配置的 Bark 通知 |
| `api.workos.com` | WorkOS 认证（Droid 账户） |
| `api.factory.ai` | Factory AI（Droid 账户） |
| `cloudcode-pa.googleapis.com` | Antigravity（Anthropic 合法服务） |

- 无硬编码的可疑 URL 或 IP 地址
- 无 base64 编码的隐藏端点
- 无 DNS 外泄模式
- 无 beacon、追踪或分析代码
- 无隐藏的后台数据收集行为

### 1.2 后门与认证绕过 — 未发现

- 所有管理员路由均要求 `authenticateAdmin` 中间件
- 所有 API 路由均要求 `authenticateApiKey` 中间件
- 无硬编码的主密钥或绕过令牌
- 无隐藏管理路由或未文档化的端点
- 启动时不会创建默认隐藏用户账户
- JWT 验证实现正确

### 1.3 混淆/恶意代码 — 未发现

- 无 `eval()` 或 `new Function()` 调用
- 无混淆的变量名或代码块
- 无远程脚本下载和执行
- 无恶意 npm 生命周期钩子（`postinstall`、`preinstall`、`prepare`）
- 所有 git hooks 均为禁用状态（`.sample` 文件）
- 无指向未知服务器的 WebSocket 连接
- 所有 `setInterval`/`setTimeout` 调用均服务于合法用途（缓存清理、限流重置、健康检查）

### 1.4 供应链安全 — 无问题

所有依赖均为知名合法包：
- `express`、`axios`、`ioredis`、`helmet`、`cors`、`winston`、`nodemailer`、`bcryptjs`、`jsonwebtoken`、`google-auth-library`、`@aws-sdk/*` 等
- 无混淆工具、反向 shell、挖矿程序或数据外泄包

### 1.5 已观察到的良好安全实践

- AES-256-CBC 加密敏感数据静态存储（OAuth Token、凭证）
- `scryptSync` 派生加密密钥
- `bcryptjs`（10 轮）哈希管理员密码
- SHA-256 哈希 API Key
- Token 脱敏工具（`tokenMask.js`）用于日志清理
- 客户端断开时通过 `AbortController` 清理资源
- `helmet` 安全响应头
- CORS 跨域配置
- 基于 Redis 的并发请求控制
- 自动清理过期并发计数器

---

## 二、安全卫生问题

虽未发现恶意行为，但发现以下安全改进项。

### 2.1 【高危】OAuth Token 明文写入日志

**位置：** `src/utils/logger.js:420-439`
**受影响调用：**
- `src/services/account/claudeAccountService.js:316` — `logger.authDetail('Token refresh response', response.data)`
- `src/utils/oauthHelper.js:205` — `logger.authDetail('OAuth token exchange response', response.data)`
- `src/utils/oauthHelper.js:425` — `logger.authDetail('Setup Token exchange response', response.data)`

**描述：** `logger.authDetail()` 函数将完整的 `response.data` 对象（包括未脱敏的 `access_token` 和 `refresh_token`）写入 `logs/claude-relay-auth-detail-YYYY-MM-DD.log`。任何拥有日志目录访问权限的人都可以提取有效的 OAuth Token。

**建议：** 彻底移除 `authDetail` 日志记录器，或在记录前对所有敏感字段应用 `tokenMask` 脱敏处理。建议将此日志设为通过环境变量手动开启。

### 2.2 【高危】加密 Salt 硬编码

**位置：** `src/services/account/claudeAccountService.js:55`

**描述：** AES 加密使用的 salt 硬编码为字符串 `'salt'`，而非每次加密操作生成的随机值。结合可能较弱的 `ENCRYPTION_KEY` 环境变量，这降低了加密的有效安全性。

**建议：** 每次加密操作使用随机 salt（与密文一同存储），或至少将 salt 改为可通过环境变量配置。

### 2.3 【高危】管理员密码明文存储于 init.json

**位置：** `src/routes/web.js:226`

**描述：** 修改管理员密码时，新密码以明文形式写入 `data/init.json`。虽然 Redis 中存储的是 bcrypt 哈希值，但 init.json 文件在磁盘上保留了明文密码。

**建议：** 仅在 `init.json` 中存储 bcrypt 哈希值，或在初始设置完成后完全移除文件中的密码持久化。

### 2.4 【中危】API Key 哈希使用静态 Salt

**位置：** `src/services/apiKeyService.js:2116-2121`

**描述：** API Key 使用 `SHA-256 + config.security.encryptionKey` 作为静态 salt 进行哈希。这弱于按 Key 生成的随机 salt 或专用算法（bcrypt、argon2）。若 `encryptionKey` 泄露，离线暴力破解将成为可能。

**建议：** 考虑使用 bcrypt 或 argon2 进行 API Key 哈希，或至少使用按 Key 生成的随机 salt。

### 2.5 【中危】CSP 包含 `unsafe-eval` 和 `unsafe-inline`

**位置：** `src/middleware/auth.js:1891`

**描述：** 内容安全策略（CSP）头中对脚本源包含 `'unsafe-eval'` 和 `'unsafe-inline'`（用于支持 Tailwind CSS 编译），这显著降低了管理界面的 XSS 防护能力。

**建议：** 在构建时预编译 Tailwind CSS 以消除对 `unsafe-eval` 的需求；对内联脚本使用基于 nonce 的 CSP。

### 2.6 【中危】余额脚本 VM 沙箱

**位置：** `src/services/balanceScriptService.js`

**描述：** 用户提供的余额脚本通过 Node.js `vm.Script` 执行，但这并非真正的安全沙箱。虽然该功能默认关闭（需显式设置 `BALANCE_SCRIPT_ENABLED=true`）且包含 SSRF 防护，但有决心的攻击者在获得管理员权限后可能实现沙箱逃逸。

**建议：** 如需此功能，使用 `isolated-vm` 或具有受限权限的 worker threads。

### 2.7 【中危】Redis 连接默认未启用 TLS

**位置：** `config/config.js`

**描述：** Redis 连接默认不启用 TLS。在共享网络中，传输中的凭证和加密数据可能被截获。

**建议：** 在生产环境中启用 Redis TLS 连接（`enableTLS: true`），或将此作为部署要求写入文档。

### 2.8 【中危】管理员登录无速率限制

**位置：** `src/routes/web.js`（登录端点）

**描述：** 管理员登录端点未实现速率限制，容易遭受暴力破解攻击。

**建议：** 为管理员登录端点添加速率限制（例如每分钟每 IP 最多 5 次尝试）。

### 2.9 【低危】默认配置值较弱

**位置：** `config/config.example.js:14-18`

**描述：** 默认密钥值如 `'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION'` 被用作回退值。若环境变量未正确设置，服务将使用可预测的密钥运行。

**建议：** 当关键密钥（`JWT_SECRET`、`ENCRYPTION_KEY`）未显式配置时，拒绝启动服务并输出明确的错误信息。

### 2.10 【低危】用户邮箱出现在 Info 级别日志中

**位置：** `src/services/account/claudeAccountService.js:2107-2112`

**描述：** 在获取用户配置文件时，用户邮箱地址出现在标准 info 级别日志中。若日志泄露，可能有助于账户枚举攻击。

**建议：** 在 info 级别日志中脱敏或省略邮箱地址。

### 2.11 【低危】使用已弃用的 Crypto API

**位置：** `src/services/account/claudeAccountService.js:1221`

**描述：** 用于向后兼容的遗留代码使用了已弃用的 `crypto.createDecipher()`（无 IV）。这在密码学上较弱，且在较新的 Node.js 版本上将会失败。

**建议：** 将所有遗留加密数据迁移到基于 IV 的 `createDecipheriv` 格式，然后移除已弃用的回退逻辑。

---

## 三、问题汇总表

| 编号 | 严重级别 | 类别 | 问题描述 | 是否恶意 |
|------|----------|------|----------|----------|
| 2.1 | 高危 | 凭证泄露 | OAuth Token 明文写入日志 | 否 |
| 2.2 | 高危 | 密码学 | 加密 Salt 硬编码 | 否 |
| 2.3 | 高危 | 凭证存储 | 管理员密码明文存于 init.json | 否 |
| 2.4 | 中危 | 密码学 | API Key 哈希使用静态 Salt | 否 |
| 2.5 | 中危 | Web 安全 | CSP 允许 unsafe-eval | 否 |
| 2.6 | 中危 | 沙箱安全 | vm.Script 非真正安全沙箱 | 否 |
| 2.7 | 中危 | 网络安全 | Redis 默认未启用 TLS | 否 |
| 2.8 | 中危 | 身份认证 | 管理员登录无速率限制 | 否 |
| 2.9 | 低危 | 配置安全 | 默认密钥值较弱 | 否 |
| 2.10 | 低危 | 信息泄露 | 用户邮箱出现在日志中 | 否 |
| 2.11 | 低危 | 密码学 | 使用已弃用的 Crypto API | 否 |

---

## 四、结论

**Claude Relay Service 代码库不包含恶意代码。** 不存在后门、数据外泄机制、隐藏的凭证窃取行为，也没有供应链安全问题。项目整体展现了良好的安全实践，包括静态数据加密、完善的认证中间件、Token 脱敏及安全响应头配置。

上述 11 项发现属于生产环境 Node.js 应用中常见的安全卫生问题，最需优先处理的是：

1. **移除或脱敏明文 Token 日志记录**（发现 2.1）
2. **使用随机 Salt 进行加密**（发现 2.2）
3. **停止明文存储管理员密码**（发现 2.3）

以上问题均不表明存在恶意意图——它们是工程实践层面的改进机会。

---

*本报告通过自动化静态分析生成，不能替代人工渗透测试或运行时安全评估。*
