/**
 * API Key 邮箱字段测试
 * 覆盖：generateApiKey email存储、updateApiKey email更新、getApiKeyEmails 去重/过滤
 */

// --- top-level mocks (apply to all tests in file) ---

jest.mock(
  '../config/config',
  () => ({
    security: { apiKeyPrefix: 'cr_', encryptionKey: 'test-encryption-key-32-chars-xx' },
    server: { port: 3000 },
    redis: {},
    userManagement: { maxApiKeysPerUser: 10 }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

// Pipeline mock — used by getApiKeyEmails
const mockPipelineExec = jest.fn()
const mockPipeline = {
  hmget: jest.fn().mockReturnThis(),
  exec: mockPipelineExec
}
const mockClient = { pipeline: jest.fn().mockReturnValue(mockPipeline) }

jest.mock('../src/models/redis', () => ({
  setApiKey: jest.fn().mockResolvedValue(undefined),
  getApiKey: jest.fn(),
  getAllApiKeys: jest.fn(),
  scanApiKeyIds: jest.fn(),
  getClientSafe: jest.fn().mockReturnValue(mockClient),
  findApiKeyByHash: jest.fn(),
  getConcurrency: jest.fn(),
  getUsageStats: jest.fn(),
  getCostStats: jest.fn()
}))

jest.mock('../src/services/costRankService', () => ({ addKeyToIndexes: jest.fn() }))
jest.mock('../src/services/apiKeyIndexService', () => ({
  addToIndex: jest.fn(),
  updateIndex: jest.fn(),
  getStatus: jest.fn()
}))
jest.mock('../src/services/serviceRatesService', () => ({
  getServiceRates: jest.fn().mockResolvedValue({})
}))

const redis = require('../src/models/redis')
const svc = require('../src/services/apiKeyService')

describe('generateApiKey — email field', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.setApiKey.mockResolvedValue(undefined)
  })

  test('stores email in keyData when provided', async () => {
    await svc.generateApiKey({ name: 'test', email: 'foo@example.com' })
    const savedData = redis.setApiKey.mock.calls[0][1]
    expect(savedData.email).toBe('foo@example.com')
  })

  test('stores empty string when email not provided', async () => {
    await svc.generateApiKey({ name: 'test' })
    const savedData = redis.setApiKey.mock.calls[0][1]
    expect(savedData.email).toBe('')
  })

  test('returns email in response object', async () => {
    const result = await svc.generateApiKey({ name: 'test', email: 'bar@example.com' })
    expect(result.email).toBe('bar@example.com')
  })
})

describe('updateApiKey — email field', () => {
  const baseKeyData = {
    id: 'key-1',
    name: 'Test Key',
    apiKey: 'hashed',
    isActive: 'true',
    tokenLimit: '0',
    concurrencyLimit: '0',
    rateLimitWindow: '0',
    rateLimitRequests: '0',
    rateLimitCost: '0',
    permissions: '[]',
    enableModelRestriction: 'false',
    restrictedModels: '[]',
    enableClientRestriction: 'false',
    allowedClients: '[]',
    dailyCostLimit: '0',
    totalCostLimit: '0',
    weeklyOpusCostLimit: '0',
    tags: '[]',
    serviceRates: '{}',
    email: ''
  }

  beforeEach(() => {
    jest.clearAllMocks()
    redis.setApiKey.mockResolvedValue(undefined)
  })

  test('updates email field when in allowedUpdates', async () => {
    redis.getApiKey.mockResolvedValue({ ...baseKeyData })
    await svc.updateApiKey('key-1', { email: 'updated@example.com' })
    const saved = redis.setApiKey.mock.calls[0][1]
    expect(saved.email).toBe('updated@example.com')
  })

  test('clears email when empty string passed', async () => {
    redis.getApiKey.mockResolvedValue({ ...baseKeyData, email: 'old@example.com' })
    await svc.updateApiKey('key-1', { email: '' })
    const saved = redis.setApiKey.mock.calls[0][1]
    expect(saved.email).toBe('')
  })

  test('typo field "emails" is NOT updated (whitelist enforcement)', async () => {
    redis.getApiKey.mockResolvedValue({ ...baseKeyData })
    await svc.updateApiKey('key-1', { emails: 'should-be-ignored@example.com' })
    const saved = redis.setApiKey.mock.calls[0][1]
    expect(saved.emails).toBeUndefined()
  })
})

describe('getApiKeyEmails', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClient.pipeline.mockReturnValue(mockPipeline)
    mockPipeline.hmget.mockReturnThis()
    redis.getClientSafe.mockReturnValue(mockClient)
  })

  test('returns empty arrays when no keys exist', async () => {
    redis.scanApiKeyIds.mockResolvedValue([])
    const result = await svc.getApiKeyEmails()
    expect(result).toEqual({ all: [], active: [] })
  })

  test('deduplicates emails case-insensitively', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1', 'k2'])
    mockPipelineExec.mockResolvedValue([
      [null, ['Foo@Example.com', 'true', 'false']],
      [null, ['foo@example.com', 'true', 'false']]
    ])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toEqual(['foo@example.com'])
    expect(result.all).toHaveLength(1)
  })

  test('separates active vs all emails correctly', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1', 'k2'])
    mockPipelineExec.mockResolvedValue([
      [null, ['active@example.com', 'true', 'false']],
      [null, ['inactive@example.com', 'false', 'false']]
    ])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toContain('active@example.com')
    expect(result.all).toContain('inactive@example.com')
    expect(result.active).toContain('active@example.com')
    expect(result.active).not.toContain('inactive@example.com')
  })

  test('excludes deleted keys', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1'])
    mockPipelineExec.mockResolvedValue([[null, ['deleted@example.com', 'true', 'true']]])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toHaveLength(0)
  })

  test('excludes keys with empty email', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1'])
    mockPipelineExec.mockResolvedValue([[null, ['', 'true', 'false']]])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toHaveLength(0)
  })

  test('excludes keys with null email (legacy keys without email field)', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1'])
    mockPipelineExec.mockResolvedValue([[null, [null, 'true', 'false']]])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toHaveLength(0)
  })

  test('trims whitespace from email values', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1'])
    mockPipelineExec.mockResolvedValue([[null, ['  spaced@example.com  ', 'true', 'false']]])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toContain('spaced@example.com')
  })

  test('returns sorted arrays', async () => {
    redis.scanApiKeyIds.mockResolvedValue(['k1', 'k2', 'k3'])
    mockPipelineExec.mockResolvedValue([
      [null, ['zoo@example.com', 'true', 'false']],
      [null, ['alpha@example.com', 'true', 'false']],
      [null, ['middle@example.com', 'true', 'false']]
    ])
    const result = await svc.getApiKeyEmails()
    expect(result.all).toEqual(['alpha@example.com', 'middle@example.com', 'zoo@example.com'])
  })
})
