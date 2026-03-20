/**
 * metadata.user_id 统一解析/构建工具
 *
 * 兼容两种格式：
 * - 旧格式 (pre-v2.1.78): user_{deviceId}_account_{accountUuid}_session_{sessionId}
 * - 新格式 (v2.1.78+):    {"device_id":"...","account_uuid":"...","session_id":"..."}
 *
 * 纯函数，无外部依赖。
 */

const OLD_FORMAT_REGEX = /^user_([a-fA-F0-9]{64})_account_(.*?)_session_([a-f0-9-]+)$/

/**
 * 解析 metadata.user_id 字符串
 * @param {*} userId - user_id 值
 * @returns {{ deviceId: string, accountUuid: string, sessionId: string, isJsonFormat: boolean } | null}
 */
function parse(userId) {
  if (typeof userId !== 'string' || !userId) {
    return null
  }

  // 尝试 JSON 格式
  if (userId.startsWith('{')) {
    try {
      const obj = JSON.parse(userId)
      const deviceId = obj.device_id
      const sessionId = obj.session_id
      if (
        typeof deviceId !== 'string' ||
        !deviceId ||
        typeof sessionId !== 'string' ||
        !sessionId
      ) {
        return null
      }
      return {
        deviceId,
        accountUuid: typeof obj.account_uuid === 'string' ? obj.account_uuid : '',
        sessionId,
        isJsonFormat: true
      }
    } catch {
      return null
    }
  }

  // 尝试旧格式
  const match = userId.match(OLD_FORMAT_REGEX)
  if (match) {
    return {
      deviceId: match[1],
      accountUuid: match[2],
      sessionId: match[3],
      isJsonFormat: false
    }
  }

  return null
}

/**
 * 便捷方法：提取 sessionId
 * @param {*} userId - user_id 值
 * @returns {string | null}
 */
function extractSessionId(userId) {
  const parsed = parse(userId)
  return parsed ? parsed.sessionId : null
}

/**
 * 根据解析结果重建 user_id 字符串，保留原始格式
 * @param {{ deviceId: string, accountUuid: string, sessionId: string, isJsonFormat: boolean }} parts
 * @returns {string}
 */
function build(parts) {
  const { deviceId, accountUuid, sessionId, isJsonFormat } = parts

  if (isJsonFormat) {
    return JSON.stringify({
      device_id: deviceId,
      account_uuid: accountUuid || '',
      session_id: sessionId
    })
  }

  return `user_${deviceId}_account_${accountUuid || ''}_session_${sessionId}`
}

/**
 * 检查 user_id 是否为合法格式（旧格式或新 JSON 格式）
 * @param {*} userId - user_id 值
 * @returns {boolean}
 */
function isValid(userId) {
  return parse(userId) !== null
}

/**
 * v2.1.78 引入 JSON 格式 metadata.user_id 的版本分界点。
 * 用于将 user_id 格式与 User-Agent 版本对齐。
 */
const JSON_FORMAT_MIN_VERSION = [2, 1, 78]

/**
 * 将 user_id 格式转换为与 User-Agent 版本匹配的格式。
 * 当统一 User-Agent 与原始客户端版本不一致时，上游可能根据 UA 版本
 * 期望特定的 user_id 格式。此函数确保两者一致。
 *
 * @param {string} userId - 当前 user_id
 * @param {string} userAgent - 将发往上游的 User-Agent
 * @returns {string} 格式对齐后的 user_id，无法解析时返回原值
 */
function normalizeFormat(userId, userAgent) {
  const parsed = parse(userId)
  if (!parsed) {
    return userId
  }

  const shouldBeJson = isVersionJsonFormat(userAgent)
  if (parsed.isJsonFormat === shouldBeJson) {
    return userId // 已经匹配
  }

  return build({ ...parsed, isJsonFormat: shouldBeJson })
}

/**
 * 根据 User-Agent 版本判断应使用 JSON 格式还是旧格式
 * @param {string} userAgent
 * @returns {boolean} true = JSON 格式 (v2.1.78+)
 */
function isVersionJsonFormat(userAgent) {
  if (!userAgent) {
    return false
  }
  const match = userAgent.match(/claude-cli\/([\d.]+)/i)
  if (!match) {
    return false
  }
  const parts = match[1].split('.').map(Number)
  for (let i = 0; i < JSON_FORMAT_MIN_VERSION.length; i++) {
    const v = parts[i] || 0
    const min = JSON_FORMAT_MIN_VERSION[i]
    if (v > min) {
      return true
    }
    if (v < min) {
      return false
    }
  }
  return true // 等于阈值版本也用 JSON
}

module.exports = { parse, extractSessionId, build, isValid, normalizeFormat }
