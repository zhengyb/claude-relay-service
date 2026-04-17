/**
 * 备用账户调度器集成测试
 * 覆盖关键路径：共享池过滤、会话映射撤销、时间窗口切换
 */

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/utils/dateHelper', () => ({
  getISOStringWithTimezone: jest.fn(() => '2026-04-17T12:00:00+08:00')
}))

// Mock upstream helpers
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/utils/modelHelper', () => ({
  parseVendorPrefixedModel: jest.fn((m) => ({ vendor: null, model: m })),
  isOpus45OrNewer: jest.fn(() => false)
}))

// Minimal commonHelper stub matching production semantics for fields we touch
jest.mock('../src/utils/commonHelper', () => {
  const isSchedulable = (v) => v !== false && v !== 'false'
  const sortAccountsByPriority = (arr) =>
    [...arr].sort((a, b) => (parseInt(a.priority) || 50) - (parseInt(b.priority) || 50))
  return { isSchedulable, sortAccountsByPriority, isTruthy: (v) => v === true || v === 'true' }
})

// Mock Redis client
const mockRedisClient = {
  getClaudeAccount: jest.fn(),
  getAllClaudeAccounts: jest.fn().mockResolvedValue([])
}
jest.mock('../src/models/redis', () => mockRedisClient)

// Mock account services
const mockClaudeAccountService = {
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  isAccountOpusRateLimited: jest.fn().mockResolvedValue(false),
  isAccountOverloaded: jest.fn().mockResolvedValue(false),
  clearExpiredOpusRateLimit: jest.fn().mockResolvedValue(undefined),
  getAccountRateLimitInfo: jest.fn().mockResolvedValue(null)
}
jest.mock('../src/services/account/claudeAccountService', () => mockClaudeAccountService)

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([]),
  isAccountBlocked: jest.fn().mockResolvedValue(false),
  isSubscriptionExpired: jest.fn(() => false),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  isAccountQuotaExceeded: jest.fn().mockResolvedValue(false),
  isAccountOverloaded: jest.fn().mockResolvedValue(false),
  checkQuotaUsage: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue({ success: true, data: [] })
}))

jest.mock('../src/services/account/ccrAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([]),
  isSubscriptionExpired: jest.fn(() => false),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  isAccountOverloaded: jest.fn().mockResolvedValue(false),
  isAccountQuotaExceeded: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/services/accountGroupService', () => ({}))

const scheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

// Helper to build a Claude OAuth account hash as Redis would return it
const buildClaudeAccount = (overrides = {}) => ({
  id: 'acc-123',
  name: 'Test Account',
  isActive: 'true',
  status: 'active',
  accountType: 'shared',
  schedulable: 'true',
  priority: '50',
  lastUsedAt: '0',
  ...overrides
})

// 2026-04-17 12:00 UTC — afternoon, inside "09:00-17:00 UTC"
const IN_WINDOW_UTC_NOON = new Date(Date.UTC(2026, 3, 17, 12, 0))
// 2026-04-17 20:00 UTC — outside "09:00-17:00 UTC"
const OUT_OF_WINDOW_UTC_EVENING = new Date(Date.UTC(2026, 3, 17, 20, 0))

const dayWindow = {
  timezone: 'UTC',
  windows: [{ start: '09:00', end: '17:00' }]
}

describe('UnifiedClaudeScheduler — backup account integration', () => {
  let realDate
  beforeEach(() => {
    jest.clearAllMocks()
    realDate = global.Date
  })

  afterEach(() => {
    global.Date = realDate
  })

  const freezeTime = (fixedDate) => {
    // Override `new Date()` to return the fixed time; preserve Date.UTC and other statics
    global.Date = class extends realDate {
      constructor(...args) {
        if (args.length === 0) {
          return new realDate(fixedDate)
        }
        return new realDate(...args)
      }
      static now() {
        return fixedDate.getTime()
      }
    }
    Object.setPrototypeOf(global.Date, realDate)
    Object.assign(global.Date, {
      UTC: realDate.UTC,
      parse: realDate.parse
    })
  }

  describe('_isAccountAvailable (session mapping validation)', () => {
    it('returns false when backup account is outside window (session should re-select)', async () => {
      freezeTime(OUT_OF_WINDOW_UTC_EVENING)
      mockRedisClient.getClaudeAccount.mockResolvedValueOnce(
        buildClaudeAccount({
          isBackupAccount: 'true',
          backupSchedule: JSON.stringify(dayWindow)
        })
      )

      const available = await scheduler._isAccountAvailable('acc-123', 'claude-official')
      expect(available).toBe(false)
    })

    it('returns true when backup account is inside window', async () => {
      freezeTime(IN_WINDOW_UTC_NOON)
      mockRedisClient.getClaudeAccount.mockResolvedValueOnce(
        buildClaudeAccount({
          isBackupAccount: 'true',
          backupSchedule: JSON.stringify(dayWindow)
        })
      )

      const available = await scheduler._isAccountAvailable('acc-123', 'claude-official')
      expect(available).toBe(true)
    })

    it('returns false when backup account has no configured windows (fails closed)', async () => {
      freezeTime(IN_WINDOW_UTC_NOON)
      mockRedisClient.getClaudeAccount.mockResolvedValueOnce(
        buildClaudeAccount({
          isBackupAccount: 'true',
          backupSchedule: JSON.stringify({ timezone: 'UTC', windows: [] })
        })
      )

      const available = await scheduler._isAccountAvailable('acc-123', 'claude-official')
      expect(available).toBe(false)
    })

    it('returns true for non-backup account regardless of time (existing behavior preserved)', async () => {
      freezeTime(OUT_OF_WINDOW_UTC_EVENING)
      mockRedisClient.getClaudeAccount.mockResolvedValueOnce(
        buildClaudeAccount({
          isBackupAccount: 'false'
        })
      )

      const available = await scheduler._isAccountAvailable('acc-123', 'claude-official')
      expect(available).toBe(true)
    })
  })

  describe('_getAllAvailableAccounts (shared pool filter)', () => {
    it('excludes backup account from shared pool when outside window', async () => {
      freezeTime(OUT_OF_WINDOW_UTC_EVENING)
      mockRedisClient.getAllClaudeAccounts.mockResolvedValueOnce([
        buildClaudeAccount({
          id: 'backup-1',
          name: 'Night Owl',
          isBackupAccount: 'true',
          backupSchedule: JSON.stringify({
            timezone: 'UTC',
            windows: [{ start: '22:00', end: '06:00' }]
          })
        }),
        buildClaudeAccount({ id: 'normal-1', name: 'Always On' })
      ])

      const accounts = await scheduler._getAllAvailableAccounts({}, null, false)
      const ids = accounts.map((a) => a.accountId)
      expect(ids).toContain('normal-1')
      expect(ids).not.toContain('backup-1')
    })

    it('includes backup account when inside its window', async () => {
      freezeTime(new Date(Date.UTC(2026, 3, 17, 23, 30))) // 23:30 UTC — inside 22:00-06:00
      mockRedisClient.getAllClaudeAccounts.mockResolvedValueOnce([
        buildClaudeAccount({
          id: 'backup-1',
          isBackupAccount: 'true',
          backupSchedule: JSON.stringify({
            timezone: 'UTC',
            windows: [{ start: '22:00', end: '06:00' }]
          })
        })
      ])

      const accounts = await scheduler._getAllAvailableAccounts({}, null, false)
      expect(accounts).toHaveLength(1)
      expect(accounts[0].accountId).toBe('backup-1')
    })
  })

  describe('dedicated binding fallback', () => {
    it('falls back to shared pool when bound account is a backup account outside window', async () => {
      freezeTime(OUT_OF_WINDOW_UTC_EVENING)
      const backupAccount = buildClaudeAccount({
        id: 'bound-backup',
        isBackupAccount: 'true',
        backupSchedule: JSON.stringify(dayWindow)
      })
      const fallbackAccount = buildClaudeAccount({ id: 'fallback-1', name: 'Fallback' })

      mockRedisClient.getClaudeAccount.mockResolvedValueOnce(backupAccount)
      mockRedisClient.getAllClaudeAccounts.mockResolvedValueOnce([fallbackAccount])

      const apiKeyData = { id: 'k1', name: 'k1', claudeAccountId: 'bound-backup' }
      const result = await scheduler.selectAccountForApiKey(apiKeyData, null, null, null)

      // Expect fallback to shared pool instead of using the out-of-window bound account
      expect(result.accountId).toBe('fallback-1')
      expect(result.accountType).toBe('claude-official')
    })
  })
})
