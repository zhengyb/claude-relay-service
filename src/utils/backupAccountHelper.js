// 备用账户时间窗口判定
// 备用账户（isBackupAccount=true）仅在指定时段内加入共享池调度
// 非备用账户行为不受影响

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/

const DEFAULT_TIMEZONE = 'UTC'

const parseTimeToMinutes = (str) => {
  if (typeof str !== 'string' || !HHMM_REGEX.test(str)) {
    return null
  }
  const [h, m] = str.split(':').map(Number)
  return h * 60 + m
}

const isValidTimezone = (tz) => {
  if (typeof tz !== 'string' || !tz) {
    return false
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch (_err) {
    return false
  }
}

const isBackupAccount = (account) => {
  if (!account) {
    return false
  }
  const value = account.isBackupAccount
  return value === true || value === 'true'
}

const normalizeBackupSchedule = (input) => {
  if (input === null || input === undefined || input === '') {
    return null
  }
  let obj = input
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input)
    } catch (_err) {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return null
  }
  const timezone = isValidTimezone(obj.timezone) ? obj.timezone : DEFAULT_TIMEZONE
  const rawWindows = Array.isArray(obj.windows) ? obj.windows : []
  const windows = []
  for (const w of rawWindows) {
    if (!w || typeof w !== 'object') {
      continue
    }
    if (!HHMM_REGEX.test(w.start) || !HHMM_REGEX.test(w.end)) {
      continue
    }
    if (w.start === w.end) {
      continue
    }
    windows.push({ start: w.start, end: w.end })
  }
  return { timezone, windows }
}

const validateBackupSchedule = (input) => {
  if (input === null || input === undefined || input === '') {
    return { valid: true, normalized: null }
  }
  let obj = input
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input)
    } catch (_err) {
      return { valid: false, error: 'backupSchedule must be valid JSON' }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, error: 'backupSchedule must be an object' }
  }
  if (obj.timezone !== undefined && !isValidTimezone(obj.timezone)) {
    return { valid: false, error: `backupSchedule.timezone invalid: ${obj.timezone}` }
  }
  if (!Array.isArray(obj.windows)) {
    return { valid: false, error: 'backupSchedule.windows must be an array' }
  }
  for (let i = 0; i < obj.windows.length; i++) {
    const w = obj.windows[i]
    if (!w || typeof w !== 'object') {
      return { valid: false, error: `backupSchedule.windows[${i}] must be an object` }
    }
    if (!HHMM_REGEX.test(w.start)) {
      return {
        valid: false,
        error: `backupSchedule.windows[${i}].start must be HH:MM (got: ${w.start})`
      }
    }
    if (!HHMM_REGEX.test(w.end)) {
      return {
        valid: false,
        error: `backupSchedule.windows[${i}].end must be HH:MM (got: ${w.end})`
      }
    }
    if (w.start === w.end) {
      return {
        valid: false,
        error: `backupSchedule.windows[${i}] is empty (start === end)`
      }
    }
  }
  return { valid: true, normalized: normalizeBackupSchedule(obj) }
}

const getMinutesInTz = (date, timezone) => {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    const parts = fmt.formatToParts(date)
    let h = 0
    let m = 0
    for (const p of parts) {
      if (p.type === 'hour') {
        h = parseInt(p.value, 10) % 24 // 部分 locale 零点会输出 "24"
      } else if (p.type === 'minute') {
        m = parseInt(p.value, 10)
      }
    }
    return h * 60 + m
  } catch (_err) {
    return date.getUTCHours() * 60 + date.getUTCMinutes()
  }
}

const isInWindow = (windowObj, minutesNow) => {
  const start = parseTimeToMinutes(windowObj.start)
  const end = parseTimeToMinutes(windowObj.end)
  if (start === null || end === null || start === end) {
    return false
  }
  if (start < end) {
    return minutesNow >= start && minutesNow < end
  }
  // 跨天窗口（例如 22:00 - 06:00）
  return minutesNow >= start || minutesNow < end
}

// 备用账户是否处于可调度时段
// 非备用账户恒返回 true（不改变现有行为）
// 备用账户无有效窗口配置时返回 false（保守策略）
const isAccountInBackupWindow = (account, now = new Date()) => {
  if (!isBackupAccount(account)) {
    return true
  }
  const schedule = normalizeBackupSchedule(account.backupSchedule)
  if (!schedule || !schedule.windows || schedule.windows.length === 0) {
    return false
  }
  const minutes = getMinutesInTz(now, schedule.timezone)
  return schedule.windows.some((w) => isInWindow(w, minutes))
}

// 描述字符串（用于日志/徽章），如 "UTC 22:00-06:00"
const describeBackupSchedule = (account) => {
  const schedule = normalizeBackupSchedule(account && account.backupSchedule)
  if (!schedule || schedule.windows.length === 0) {
    return ''
  }
  const parts = schedule.windows.map((w) => `${w.start}-${w.end}`)
  return `${schedule.timezone} ${parts.join(',')}`
}

// 将任意输入序列化为 Redis Hash 可写入的 { isBackupAccount, backupSchedule } 字段
// 非法 schedule 会被丢弃为空串；调用方自行决定是否严格校验（用 validateBackupSchedule）
const serializeBackupFields = (input = {}) => {
  const flag = input.isBackupAccount === true || input.isBackupAccount === 'true'
  let scheduleStr = ''
  if (input.backupSchedule !== undefined && input.backupSchedule !== null) {
    const normalized = normalizeBackupSchedule(input.backupSchedule)
    if (normalized) {
      scheduleStr = JSON.stringify(normalized)
    }
  }
  return {
    isBackupAccount: flag.toString(),
    backupSchedule: scheduleStr
  }
}

// 从 Redis Hash（或等价对象）读取并归一化为前端可用结构
const readBackupFields = (raw = {}) => {
  const flag = raw.isBackupAccount === true || raw.isBackupAccount === 'true'
  const schedule = normalizeBackupSchedule(raw.backupSchedule)
  return {
    isBackupAccount: flag,
    backupSchedule: schedule
  }
}

module.exports = {
  isBackupAccount,
  isAccountInBackupWindow,
  normalizeBackupSchedule,
  validateBackupSchedule,
  describeBackupSchedule,
  serializeBackupFields,
  readBackupFields
}
