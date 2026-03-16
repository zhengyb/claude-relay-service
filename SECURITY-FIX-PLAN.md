# 安全漏洞修复技术方案

**日期：** 2026-02-26
**分支：** `fix/security-audit-findings`
**基于：** `main` (commit `6aa416e`)
**关联审计报告：** `SECURITY-AUDIT-REPORT-CN.md` 编号 2.1、2.2、2.3

---

## 一、修复概览

| 编号 | 漏洞 | 严重级别 | 改动文件数 | 向后兼容 |
|------|------|----------|-----------|---------|
| 2.1 | OAuth Token 明文写入日志 | 高危 | 1 | 是 |
| 2.2 | 加密 Salt 硬编码 | 高危 | 12 | 是 |
| 2.3 | 管理员密码明文存储于 init.json | 高危 | 4 | 是（自动迁移） |

**核心原则：** 所有修复向后兼容，不设新环境变量时行为与修复前完全一致，现有加密数据和部署流程不受影响。

---

## 二、漏洞 2.1 — OAuth Token 明文写入日志

### 问题描述

`logger.authDetail()` 函数（`src/utils/logger.js:420-439`）将 OAuth 响应对象直接写入 `logs/claude-relay-auth-detail-YYYY-MM-DD.log`，其中包含明文的 `access_token` 和 `refresh_token`。任何拥有日志文件读取权限的人都可以提取有效 Token 进行账户冒用。

**受影响调用点：**
- `src/utils/oauthHelper.js:205` — OAuth Token 交换
- `src/utils/oauthHelper.js:425` — Setup Token 交换
- `src/services/account/claudeAccountService.js:316` — Token 刷新

### 修复方案

在 `logger.authDetail()` 内部应用已有的 `maskTokensInObject()` 脱敏函数，**仅修改 1 个文件**，所有调用点自动受益。

**修改文件：** `src/utils/logger.js`

1. 文件顶部新增引入：
   ```js
   const { maskTokensInObject } = require('./tokenMask')
   ```

2. `logger.authDetail()` 函数中，将第 434-435 行：
   ```js
   // 修改前
   authDetailLogger.info(message, { data })
   ```
   改为：
   ```js
   // 修改后 — 对 Token 字段进行脱敏
   const maskedData = maskTokensInObject(data)
   authDetailLogger.info(message, { data: maskedData })
   ```

`maskTokensInObject` 默认脱敏字段为 `['accessToken', 'refreshToken', 'access_token', 'refresh_token']`，恰好覆盖 Claude OAuth 响应中的敏感字段。脱敏后 Token 仅显示 70% 内容，其余用 `*` 替代。

### 验证方法

1. 启动服务并触发一次 Token 刷新
2. 检查 `logs/claude-relay-auth-detail-*.log`，确认 `access_token` 和 `refresh_token` 值已被部分遮盖（如 `sk-ant-xxxxx******xxx`）

---

## 三、漏洞 2.2 — 加密 Salt 硬编码

### 问题描述

所有账户服务使用硬编码的 salt 字符串进行 `crypto.scryptSync()` 密钥派生。已知的固定 salt 降低了加密安全性，理论上允许预计算攻击。

**受影响的 11 个 Salt 实例：**

| 类别 | 文件 | 行号 | 当前硬编码值 |
|------|------|------|-------------|
| Pattern A | `claudeAccountService.js` | 55 | `'salt'` |
| Pattern A | `bedrockAccountService.js` | 14 | `'salt'` |
| Pattern A | `geminiApiAccountService.js` | 13 | `'gemini-api-salt'` |
| Pattern A | `openaiResponsesAccountService.js` | 13 | `'openai-responses-salt'` |
| Pattern A | `claudeConsoleAccountService.js` | 14 | `'claude-console-salt'` |
| Pattern A | `azureOpenaiAccountService.js` | 13 | 已支持 config 回退 |
| Pattern B | `commonHelper.js` | 89 | `'claude-relay-salt'` |
| Pattern B | `droidAccountService.js` | 30 | `'droid-account-salt'` |
| Pattern B | `geminiAccountService.js` | 94 | `'gemini-account-salt'` |
| Pattern B | `ccrAccountService.js` | 15 | `'ccr-account-salt'` |
| Pattern B | `openaiAccountService.js` | 20 | `'openai-account-salt'` |

### 修复方案

**策略：** 在 `config/config.js` 集中管理所有 salt，通过环境变量覆盖，旧硬编码值作为默认回退。

#### 步骤 1 — 修改 `config/config.js`

在 `security` 配置块新增 `encryptionSalts`：

```js
encryptionSalts: {
  claude: process.env.CLAUDE_ENCRYPTION_SALT || 'salt',
  bedrock: process.env.BEDROCK_ENCRYPTION_SALT || 'salt',
  geminiApi: process.env.GEMINI_API_ENCRYPTION_SALT || 'gemini-api-salt',
  openaiResponses: process.env.OPENAI_RESPONSES_ENCRYPTION_SALT || 'openai-responses-salt',
  claudeConsole: process.env.CLAUDE_CONSOLE_ENCRYPTION_SALT || 'claude-console-salt',
  azureOpenai: process.env.AZURE_OPENAI_ENCRYPTION_SALT || 'azure-openai-account-default-salt',
  claudeRelay: process.env.CLAUDE_RELAY_ENCRYPTION_SALT || 'claude-relay-salt',
  droid: process.env.DROID_ENCRYPTION_SALT || 'droid-account-salt',
  gemini: process.env.GEMINI_ENCRYPTION_SALT || 'gemini-account-salt',
  ccr: process.env.CCR_ENCRYPTION_SALT || 'ccr-account-salt',
  openai: process.env.OPENAI_ENCRYPTION_SALT || 'openai-account-salt',
}
```

#### 步骤 2 — 修改各账户服务

将硬编码 salt 替换为 `config.security.encryptionSalts.xxx`。

**Pattern A（6 个文件）——** 示例：
```js
// 修改前
this.ENCRYPTION_SALT = 'salt'
// 修改后
this.ENCRYPTION_SALT = config.security.encryptionSalts.claude
```

**Pattern B（5 个文件）——** 示例：
```js
// 修改前
const defaultEncryptor = createEncryptor('claude-relay-salt')
// 修改后
const defaultEncryptor = createEncryptor(config.security.encryptionSalts.claudeRelay)
```

#### 步骤 3 — 启动安全提示

在 `src/app.js` 启动流程中添加检查，使用默认 salt 时输出警告。

### 验证方法

1. **不设环境变量启动** → 行为与修复前完全一致，现有加密数据正常解密
2. **设置 `CLAUDE_ENCRYPTION_SALT=my-custom-salt` 启动** → 启动日志中无默认 salt 警告（该服务），但注意：**更改 salt 后旧加密数据将无法解密**，需要重新加密

---

## 四、漏洞 2.3 — 管理员密码明文存储于 init.json

### 问题描述

`data/init.json` 以明文存储管理员密码（字段 `adminPassword`）。写入端：`scripts/setup.js`、`cli/index.js`、`src/routes/web.js`。读取端：`src/app.js`（启动）、`src/routes/web.js`（登录回退）。

### 修复方案

**策略：** 写入端改为存储 bcrypt hash（新字段名 `adminPasswordHash`），读取端兼容新旧格式并自动迁移。

#### 步骤 1 — 修改写入端（3 个文件）

**`scripts/setup.js`：**
- 新增 `const bcrypt = require('bcryptjs')`
- 写入 init.json 前先 hash：`adminPasswordHash: await bcrypt.hash(adminPassword, 10)`
- 不再写入 `adminPassword` 字段
- 控制台输出仍显示明文密码供用户记录（不变）

**`cli/index.js`：**
- bcrypt 已导入，修改 init.json 写入逻辑同上

**`src/routes/web.js`（密码修改处理）：**
- 写入 `adminPasswordHash: await bcrypt.hash(newPassword, 10)`
- 删除旧 `adminPassword` 字段：`delete initData.adminPassword`

#### 步骤 2 — 修改读取端，兼容新旧格式（2 个位置）

**检测逻辑：** bcrypt hash 以 `$2a$`、`$2b$` 或 `$2y$` 开头，用 `startsWith('$2')` 可靠区分 hash 与明文。

**`src/app.js` 的 `initializeAdmin()`：**
```js
let passwordHash

if (initData.adminPasswordHash && initData.adminPasswordHash.startsWith('$2')) {
  // 新格式：已是 bcrypt hash
  passwordHash = initData.adminPasswordHash
} else if (initData.adminPassword) {
  // 旧格式：明文密码 → hash → 自动迁移 init.json
  passwordHash = await bcrypt.hash(initData.adminPassword, 10)
  try {
    initData.adminPasswordHash = passwordHash
    delete initData.adminPassword
    initData.updatedAt = new Date().toISOString()
    fs.writeFileSync(initFilePath, JSON.stringify(initData, null, 2))
    logger.info('🔒 已自动将 init.json 中的管理员密码从明文迁移为 bcrypt hash')
  } catch (e) {
    logger.warn('⚠️ 无法自动迁移 init.json:', e.message)
  }
} else {
  logger.warn('⚠️ init.json 中未找到管理员密码')
  return
}
```

**`src/routes/web.js` 登录回退：**
```js
let passwordHash
if (initData.adminPasswordHash && initData.adminPasswordHash.startsWith('$2')) {
  passwordHash = initData.adminPasswordHash
} else if (initData.adminPassword) {
  passwordHash = await bcrypt.hash(initData.adminPassword, 10)
}
```

### 向后兼容与自动迁移

| 场景 | 行为 |
|------|------|
| 旧 init.json（`adminPassword` 明文） | 首次启动自动迁移：hash 化并写回，删除明文字段 |
| 新 init.json（`adminPasswordHash`） | 直接使用，跳过 hash 计算 |
| 迁移失败（如文件只读） | 警告日志，仍使用运行时 hash，不影响服务 |

### 验证方法

1. 运行 `npm run setup` → 检查 `data/init.json`：无 `adminPassword` 字段，`adminPasswordHash` 以 `$2b$` 开头
2. 手动构造旧格式 init.json（含明文 `adminPassword`）→ 启动服务 → 检查 init.json 自动迁移为新格式
3. 使用管理员账户登录，验证密码校验正常

---

## 五、生产环境部署指南

### 前置条件

- Node.js >= 14
- 当前已安装 `bcryptjs` 依赖（无需新增依赖）

### 部署步骤

#### 1. 停服更新

```bash
# 拉取修复代码
git fetch origin
git checkout fix/security-audit-findings
# 或合并到 main 后拉取

# 安装依赖（本次无新增依赖，但建议确认）
npm install

# 重启服务
npm start
```

#### 2. 自动迁移（init.json）

首次启动时，系统会自动检测 `data/init.json` 中的明文密码并迁移为 bcrypt hash。日志中会出现：

```
🔒 已自动将 init.json 中的管理员密码从明文迁移为 bcrypt hash
```

**无需手动操作。** 如果因文件权限问题迁移失败，会出现警告日志，服务仍可正常运行（使用运行时 hash），此时需手动确保 init.json 可写后重启。

#### 3. 配置自定义加密 Salt（推荐但非必须）

启动日志若出现以下警告：

```
⚠️ 部分加密 salt 仍使用默认值，建议通过环境变量配置自定义 salt 以提升安全性
```

可按需配置环境变量（`.env` 文件或容器环境变量）：

```env
# 加密 Salt 配置（可选，不设置则使用默认值，向后兼容）
CLAUDE_ENCRYPTION_SALT=your-random-string-here
BEDROCK_ENCRYPTION_SALT=your-random-string-here
GEMINI_API_ENCRYPTION_SALT=your-random-string-here
# ... 更多见 .env.example
```

> **重要警告：** 更改 salt 后，使用旧 salt 加密的数据将无法解密。如需更改 salt，必须先导出数据（`npm run data:export`），更改 salt 后重新导入并重新加密。**建议仅在全新部署时使用自定义 salt。**

#### 4. 清理历史日志（强烈建议）

修复后新日志中 Token 已脱敏，但**历史日志中可能仍包含明文 Token**：

```bash
# 备份后删除历史认证详细日志
cp -r logs/claude-relay-auth-detail-*.log /path/to/secure/backup/
rm logs/claude-relay-auth-detail-*.log
```

如果这些 Token 对应的账户仍在使用，**建议轮换（重新刷新）所有 OAuth Token**。

#### 5. 验证部署

```bash
# 检查服务状态
npm run cli status

# 检查 init.json 已迁移
cat data/init.json | grep -c adminPassword     # 应输出 0
cat data/init.json | grep -c adminPasswordHash  # 应输出 1

# 检查日志脱敏（需触发一次 Token 刷新后）
grep "access_token" logs/claude-relay-auth-detail-*.log | head -1
# 应显示脱敏后的 Token（含 * 号）
```

### Docker 部署

Docker 用户通过环境变量配置 salt：

```yaml
# docker-compose.yml
services:
  claude-relay:
    environment:
      - CLAUDE_ENCRYPTION_SALT=your-custom-salt
      # ... 其他 salt 环境变量
```

`data/init.json` 的自动迁移在容器启动时自动完成，确保 `data/` 目录已挂载为可写卷。

### 回滚方案

如需回滚：

1. **漏洞 2.1（日志脱敏）：** 回滚代码即可，无数据影响
2. **漏洞 2.2（Salt 可配置）：** 移除环境变量即可回退到默认 salt，无数据影响
3. **漏洞 2.3（init.json）：** 已迁移的 init.json 无法自动回退到明文（这是期望行为）。如确需回退，从备份恢复 init.json

---

## 六、改动文件清单

| 文件 | 漏洞编号 | 改动说明 |
|------|----------|---------|
| `src/utils/logger.js` | 2.1 | 引入 tokenMask，authDetail 函数添加脱敏 |
| `config/config.js` | 2.2 | 新增 `encryptionSalts` 配置块 |
| `src/services/account/claudeAccountService.js` | 2.2 | Salt 从 config 读取 |
| `src/services/account/bedrockAccountService.js` | 2.2 | Salt 从 config 读取 |
| `src/services/account/geminiApiAccountService.js` | 2.2 | Salt 从 config 读取 |
| `src/services/account/openaiResponsesAccountService.js` | 2.2 | Salt 从 config 读取 |
| `src/services/account/claudeConsoleAccountService.js` | 2.2 | Salt 从 config 读取 |
| `src/services/account/azureOpenaiAccountService.js` | 2.2 | Salt 从 config 读取 |
| `src/utils/commonHelper.js` | 2.2 | 默认加密器 salt 从 config 读取 |
| `src/services/account/droidAccountService.js` | 2.2 | createEncryptor salt 从 config 读取 |
| `src/services/account/geminiAccountService.js` | 2.2 | createEncryptor salt 从 config 读取 |
| `src/services/account/ccrAccountService.js` | 2.2 | createEncryptor salt 从 config 读取 |
| `src/services/account/openaiAccountService.js` | 2.2 | createEncryptor salt 从 config 读取 |
| `src/app.js` | 2.2, 2.3 | Salt 默认值警告 + initializeAdmin 兼容新旧格式 |
| `scripts/setup.js` | 2.3 | 写入 bcrypt hash |
| `cli/index.js` | 2.3 | 写入 bcrypt hash |
| `src/routes/web.js` | 2.3 | 密码修改写 hash + 登录回退兼容 |
