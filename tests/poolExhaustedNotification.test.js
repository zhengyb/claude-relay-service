/**
 * 共享帐号池耗尽通知功能测试
 * 测试 _notifyPoolExhausted 的冷却防抖、通知发送、错误隔离
 */

// Mock logger to avoid console output during tests
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

const mockSendAccountAnomalyNotification = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: mockSendAccountAnomalyNotification
}))

jest.mock('../src/utils/dateHelper', () => ({
  getISOStringWithTimezone: jest.fn(() => '2026-04-17T12:00:00+08:00')
}))

// Mock dependencies that scheduler requires at load time
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/ccrAccountService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/modelHelper', () => ({
  parseVendorPrefixedModel: jest.fn(),
  isOpus45OrNewer: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn(),
  sortAccountsByPriority: jest.fn()
}))

// Require scheduler AFTER all mocks are set up (singleton captures mocked references)
const scheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

describe('UnifiedClaudeScheduler - Pool Exhausted Notification', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset cooldown state for each test
    scheduler._lastPoolExhaustedNotifyAt = 0
  })

  describe('_notifyPoolExhausted', () => {
    it('should send notification when cooldown has expired', () => {
      scheduler._notifyPoolExhausted('CLAUDE_SHARED_POOL_EXHAUSTED', '共享帐号池所有帐号不可用')

      expect(mockSendAccountAnomalyNotification).toHaveBeenCalledTimes(1)
      expect(mockSendAccountAnomalyNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'shared-pool',
          accountName: '共享帐号池',
          platform: 'claude',
          status: 'pool_exhausted',
          errorCode: 'CLAUDE_SHARED_POOL_EXHAUSTED',
          reason: '共享帐号池所有帐号不可用'
        })
      )
    })

    it('should not send duplicate notifications within cooldown period', () => {
      scheduler._notifyPoolExhausted('CLAUDE_SHARED_POOL_EXHAUSTED', '第一次')
      scheduler._notifyPoolExhausted('CLAUDE_SHARED_POOL_EXHAUSTED', '第二次')

      expect(mockSendAccountAnomalyNotification).toHaveBeenCalledTimes(1)
    })

    it('should send notification again after cooldown expires', () => {
      scheduler._notifyPoolExhausted('CLAUDE_SHARED_POOL_EXHAUSTED', '第一次')

      // Simulate cooldown expiry
      scheduler._lastPoolExhaustedNotifyAt =
        Date.now() - scheduler._poolExhaustedNotifyCooldownMs - 1

      scheduler._notifyPoolExhausted('CLAUDE_SHARED_POOL_EXHAUSTED', '第二次')

      expect(mockSendAccountAnomalyNotification).toHaveBeenCalledTimes(2)
    })

    it('should not throw when notification fails', () => {
      mockSendAccountAnomalyNotification.mockRejectedValueOnce(new Error('webhook down'))

      expect(() => {
        scheduler._notifyPoolExhausted('CLAUDE_SHARED_POOL_EXHAUSTED', '通知失败不影响')
      }).not.toThrow()
    })

    it('should pass different errorCode for Console concurrency full', () => {
      scheduler._notifyPoolExhausted('CLAUDE_CONSOLE_CONCURRENCY_FULL', '所有 Console 帐号并发已满')

      expect(mockSendAccountAnomalyNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: 'CLAUDE_CONSOLE_CONCURRENCY_FULL',
          reason: '所有 Console 帐号并发已满'
        })
      )
    })
  })
})
