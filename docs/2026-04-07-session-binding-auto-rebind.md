# 会话绑定自动重绑定（Session Binding Auto-Rebind）

**日期**: 2026-04-07
**分支**: feature/email-notice
**涉及文件**: 3 个（+88 行 / -36 行）

## 背景

系统提供"强制会话绑定"功能（`globalSessionBindingEnabled`），将 Claude Code 客户端的 session 与特定上游 claude-official 账号一对一绑定。同时，`autoStopOnWarning` 功能可在上游返回 `allowed_warning`（5小时窗口使用量接近限制）时自动将账号的 `schedulable` 设为 `false`，阻止后续请求被调度到该账号。

这两个功能在组合使用时存在严重缺陷，导致客户端体验断裂。

## 问题分析

### 问题 1：autoStopOnWarning 在会话绑定路径下形同虚设

`_isAccountAvailableForSessionBinding()` 方法负责检查绑定账号是否可用，但缺少 `schedulable` 检查。当 `autoStopOnWarning` 将账号标记为不可调度后，会话绑定路径仍然认为该账号可用，请求继续发往上游，直到触发真正的 429 限流。

**影响**: `autoStopOnWarning` 的保护机制完全失效，无法提前避免触发上游硬限流。

### 问题 2：绑定账号不可用时直接报错，无法自动恢复

当绑定的账号因任何原因不可用时（限流、停调度、停用、错误），调度器抛出 `SESSION_BINDING_ACCOUNT_UNAVAILABLE`，路由层返回 HTTP 403：

```json
{
  "error": {
    "type": "session_binding_error",
    "message": "你的本地session已污染，请清理后使用。"
  }
}
```

即使池中有其他健康账号，系统也不会自动切换。客户端用户看到"session已污染"的误导性提示，执行 `/clear` 也无法解决问题，只能等待原账号恢复。

### 问题 3：validateNewSession 提前拦截，阻断 rebind 路径

`claudeRelayConfigService.validateNewSession()` 在请求进入调度器之前就调用 `validateBoundAccount()` 检查绑定账号是否健康。当账号被删除、停用或处于 error 状态时，请求在验证阶段就被拦截，根本无法到达调度器的 rebind 逻辑。

## 修复方案

### 修复 1：补充 schedulable 检查

**文件**: `src/services/scheduler/unifiedClaudeScheduler.js`

在 `_isAccountAvailableForSessionBinding()` 中增加 `isSchedulable(account.schedulable)` 检查，使 `autoStopOnWarning` 标记的账号在会话绑定路径下也会被正确识别为不可用。

### 修复 2：自动重绑定替代报错

**文件**: `src/services/scheduler/unifiedClaudeScheduler.js`, `src/routes/api.js`

核心改动：当绑定账号不可用时，不再抛出异常，而是记录旧绑定信息后继续走正常调度池选账号逻辑。

调度器层：
- `selectAccountForApiKey()` 新增局部变量 `rebindFrom`，记录原绑定账号信息
- 绑定账号不可用时，将旧绑定信息存入 `rebindFrom`，不 throw，继续执行后续的正常调度逻辑
- 返回值新增可选字段 `rebind: { previousAccountId, previousAccountType }`

路由层（流式和非流式两条路径）：
- 调度成功后检查 `selection.rebind`，存在则：
  - 调用 `setOriginalSessionBinding()` 将 session 绑定到新账号
  - 仅当新账号类型为 `claude-official` 时才更新绑定（防止跨类型绑定导致后续验证不一致）
  - 通过 `webhookNotifier.sendAccountEvent('account.session_rebind', ...)` 通知管理员
- 移除 `SESSION_BINDING_ACCOUNT_UNAVAILABLE` 的 catch 分支（该错误不再抛出）

### 修复 3：移除 validateNewSession 的提前拦截

**文件**: `src/services/claudeRelayConfigService.js`

在 `validateNewSession()` 中移除 `validateBoundAccount()` 调用。无论绑定账号是否健康，都将绑定信息传递给调度器。调度器的 `_isAccountAvailableForSessionBinding()` 覆盖了所有检查条件（账号存在性、isActive、status、schedulable、rateLimited、tempUnavailable），且在判定不可用时能够触发 rebind。

## 修改前后行为对比

### 绑定账号因 autoStopOnWarning 停止调度

| | 修改前 | 修改后 |
|---|---|---|
| 请求处理 | 绕过 autoStopOnWarning，继续向上游发请求直到 429 | 识别为不可用，自动切换到池中其他账号 |
| 客户端体验 | 先正常 → 突然 429 → 每次 403 "session已污染" | 无感知，请求正常返回 |

### 绑定账号被停用或进入 error 状态

| | 修改前 | 修改后 |
|---|---|---|
| 请求处理 | validateNewSession 阶段直接拦截，返回 403 | 进入调度器，自动切换到池中其他账号 |
| 客户端体验 | 403 "session已污染" | 无感知，请求正常返回 |

### 池中无可用账号

| | 修改前 | 修改后 |
|---|---|---|
| 请求处理 | 403 "session已污染" | 500 "No available Claude accounts" |
| 客户端体验 | 误导性提示 | 准确反映真实原因 |

## 管理员通知

发生自动重绑定时，通过 webhook 发送 `account.session_rebind` 事件，包含：

```javascript
{
  previousAccountId,    // 原绑定账号 ID
  previousAccountType,  // 原绑定账号类型
  newAccountId,         // 新绑定账号 ID
  newAccountType,       // 新绑定账号类型
  apiKeyName,           // 触发重绑定的 API Key
  reason                // 原因说明
}
```

## 验证

- ESLint: 通过
- Prettier: 格式一致
- Jest: 124 测试全部通过（3 个 suite 因环境缺少 config/config.js 失败，与本次改动无关）
