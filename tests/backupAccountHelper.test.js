const {
  isBackupAccount,
  isAccountInBackupWindow,
  normalizeBackupSchedule,
  validateBackupSchedule,
  serializeBackupFields,
  readBackupFields,
  describeBackupSchedule
} = require('../src/utils/backupAccountHelper')

describe('backupAccountHelper', () => {
  describe('isBackupAccount', () => {
    it('returns false for null/undefined', () => {
      expect(isBackupAccount(null)).toBe(false)
      expect(isBackupAccount(undefined)).toBe(false)
    })

    it('treats missing flag as not backup', () => {
      expect(isBackupAccount({})).toBe(false)
      expect(isBackupAccount({ isBackupAccount: false })).toBe(false)
      expect(isBackupAccount({ isBackupAccount: 'false' })).toBe(false)
    })

    it('accepts boolean true or string "true"', () => {
      expect(isBackupAccount({ isBackupAccount: true })).toBe(true)
      expect(isBackupAccount({ isBackupAccount: 'true' })).toBe(true)
    })
  })

  describe('normalizeBackupSchedule', () => {
    it('returns null for empty inputs', () => {
      expect(normalizeBackupSchedule(null)).toBeNull()
      expect(normalizeBackupSchedule(undefined)).toBeNull()
      expect(normalizeBackupSchedule('')).toBeNull()
    })

    it('parses JSON strings', () => {
      const s = JSON.stringify({ timezone: 'UTC', windows: [{ start: '09:00', end: '17:00' }] })
      const out = normalizeBackupSchedule(s)
      expect(out).toEqual({ timezone: 'UTC', windows: [{ start: '09:00', end: '17:00' }] })
    })

    it('drops invalid windows silently', () => {
      const out = normalizeBackupSchedule({
        timezone: 'UTC',
        windows: [
          { start: '09:00', end: '17:00' },
          { start: 'bogus', end: '18:00' },
          { start: '22:00', end: '22:00' }, // zero-length
          { start: '23:00', end: '01:00' } // cross-day valid
        ]
      })
      expect(out.windows).toEqual([
        { start: '09:00', end: '17:00' },
        { start: '23:00', end: '01:00' }
      ])
    })

    it('defaults to UTC for invalid timezone', () => {
      const out = normalizeBackupSchedule({ timezone: 'Not/A/Zone', windows: [] })
      expect(out.timezone).toBe('UTC')
    })
  })

  describe('validateBackupSchedule', () => {
    it('accepts null/undefined as valid (feature disabled)', () => {
      expect(validateBackupSchedule(null).valid).toBe(true)
      expect(validateBackupSchedule(undefined).valid).toBe(true)
    })

    it('rejects invalid timezone', () => {
      const r = validateBackupSchedule({ timezone: 'Bad/Zone', windows: [] })
      expect(r.valid).toBe(false)
      expect(r.error).toMatch(/timezone/)
    })

    it('rejects invalid HH:MM format', () => {
      const r = validateBackupSchedule({
        timezone: 'UTC',
        windows: [{ start: '25:00', end: '18:00' }]
      })
      expect(r.valid).toBe(false)
    })

    it('rejects empty windows (start === end)', () => {
      const r = validateBackupSchedule({
        timezone: 'UTC',
        windows: [{ start: '09:00', end: '09:00' }]
      })
      expect(r.valid).toBe(false)
      expect(r.error).toMatch(/empty/)
    })
  })

  describe('isAccountInBackupWindow', () => {
    it('returns true for non-backup accounts regardless of schedule', () => {
      const acc = { isBackupAccount: false }
      expect(isAccountInBackupWindow(acc)).toBe(true)
      expect(isAccountInBackupWindow({})).toBe(true)
      expect(isAccountInBackupWindow(null)).toBe(true)
    })

    it('returns false for backup accounts without configured windows', () => {
      expect(isAccountInBackupWindow({ isBackupAccount: true })).toBe(false)
      expect(
        isAccountInBackupWindow({
          isBackupAccount: true,
          backupSchedule: { timezone: 'UTC', windows: [] }
        })
      ).toBe(false)
    })

    it('honors single same-day window at UTC', () => {
      // Fixed point: 2026-04-17 12:00 UTC
      const now = new Date(Date.UTC(2026, 3, 17, 12, 0))
      const acc = {
        isBackupAccount: true,
        backupSchedule: { timezone: 'UTC', windows: [{ start: '09:00', end: '17:00' }] }
      }
      expect(isAccountInBackupWindow(acc, now)).toBe(true)

      const beforeStart = new Date(Date.UTC(2026, 3, 17, 8, 59))
      expect(isAccountInBackupWindow(acc, beforeStart)).toBe(false)

      const atEnd = new Date(Date.UTC(2026, 3, 17, 17, 0)) // end is exclusive
      expect(isAccountInBackupWindow(acc, atEnd)).toBe(false)
    })

    it('honors cross-day window (22:00-06:00 UTC)', () => {
      const acc = {
        isBackupAccount: true,
        backupSchedule: { timezone: 'UTC', windows: [{ start: '22:00', end: '06:00' }] }
      }
      const lateNight = new Date(Date.UTC(2026, 3, 17, 23, 30))
      const earlyMorning = new Date(Date.UTC(2026, 3, 17, 5, 30))
      const afternoon = new Date(Date.UTC(2026, 3, 17, 14, 0))
      expect(isAccountInBackupWindow(acc, lateNight)).toBe(true)
      expect(isAccountInBackupWindow(acc, earlyMorning)).toBe(true)
      expect(isAccountInBackupWindow(acc, afternoon)).toBe(false)
    })

    it('respects configured timezone (Asia/Shanghai = UTC+8)', () => {
      // 09:00 Shanghai == 01:00 UTC same day
      const acc = {
        isBackupAccount: true,
        backupSchedule: {
          timezone: 'Asia/Shanghai',
          windows: [{ start: '09:00', end: '17:00' }]
        }
      }
      // 01:30 UTC == 09:30 Shanghai → in window
      expect(isAccountInBackupWindow(acc, new Date(Date.UTC(2026, 3, 17, 1, 30)))).toBe(true)
      // 00:30 UTC == 08:30 Shanghai → outside
      expect(isAccountInBackupWindow(acc, new Date(Date.UTC(2026, 3, 17, 0, 30)))).toBe(false)
    })

    it('handles JSON-string schedule input', () => {
      const acc = {
        isBackupAccount: 'true',
        backupSchedule: JSON.stringify({
          timezone: 'UTC',
          windows: [{ start: '00:00', end: '23:59' }]
        })
      }
      expect(isAccountInBackupWindow(acc, new Date(Date.UTC(2026, 3, 17, 12, 0)))).toBe(true)
    })
  })

  describe('serializeBackupFields / readBackupFields roundtrip', () => {
    it('survives full roundtrip through Redis-like strings', () => {
      const original = {
        isBackupAccount: true,
        backupSchedule: {
          timezone: 'Asia/Shanghai',
          windows: [{ start: '22:00', end: '06:00' }]
        }
      }
      const serialized = serializeBackupFields(original)
      expect(serialized.isBackupAccount).toBe('true')
      expect(typeof serialized.backupSchedule).toBe('string')

      const restored = readBackupFields(serialized)
      expect(restored.isBackupAccount).toBe(true)
      expect(restored.backupSchedule).toEqual(original.backupSchedule)
    })

    it('serializes false flag and drops invalid schedule', () => {
      const serialized = serializeBackupFields({
        isBackupAccount: false,
        backupSchedule: 'not json'
      })
      expect(serialized.isBackupAccount).toBe('false')
      expect(serialized.backupSchedule).toBe('')
    })
  })

  describe('describeBackupSchedule', () => {
    it('returns empty string for unconfigured', () => {
      expect(describeBackupSchedule({})).toBe('')
      expect(describeBackupSchedule({ backupSchedule: null })).toBe('')
    })

    it('summarizes windows with timezone', () => {
      const out = describeBackupSchedule({
        backupSchedule: {
          timezone: 'UTC',
          windows: [
            { start: '09:00', end: '12:00' },
            { start: '14:00', end: '18:00' }
          ]
        }
      })
      expect(out).toBe('UTC 09:00-12:00,14:00-18:00')
    })
  })
})
