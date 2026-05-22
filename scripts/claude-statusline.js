#!/usr/bin/env node
/**
 * Claude Code statusline 插件
 *
 * 向 Claude Relay Service 查询「当前 API Key 所用上游 Claude 账号」的 oauth/usage，
 * 在状态栏显示 5h / 7d / sonnet 三个窗口的利用率与重置剩余时间，例如：
 *   5h 42% (2h13m) · 7d 18% (4d) · sonnet 9%
 *
 * 安装：在 ~/.claude/settings.json 中添加
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "node /绝对路径/claude-relay-service/scripts/claude-statusline.js"
 *     }
 *   }
 *
 * 依赖 Claude Code 进程已设置的环境变量：
 *   ANTHROPIC_BASE_URL                       —— relay 地址（约定带 /api 后缀）
 *   ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY —— cr_ 前缀 API Key
 *
 * 零依赖，仅使用 Node 内置模块；任何错误都不抛出，保证 statusline 始终可渲染。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')

const LOCAL_CACHE_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 2000

// 读取 stdin（Claude Code 传入的 JSON），失败时返回空对象
function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch (_err) {
    return {}
  }
}

// 按会话分文件，避免多个并发会话互相覆盖缓存
function cacheFilePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(os.tmpdir(), `claude-relay-statusline-${safe || 'default'}.json`)
}

function readCache(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (obj && typeof obj.line === 'string' && typeof obj.ts === 'number') {
      return obj
    }
  } catch (_err) {
    /* 缓存不存在或损坏，忽略 */
  }
  return null
}

function writeCache(file, line) {
  try {
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), line }))
  } catch (_err) {
    /* 写缓存失败不影响展示 */
  }
}

// 请求 relay 的 session-usage 端点，返回 { status, data }
function fetchUsage(baseUrl, apiKey, sessionId) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(`${baseUrl}/v1/session-usage`)
    } catch (err) {
      reject(err)
      return
    }
    if (sessionId) {
      url.searchParams.set('session', sessionId)
    }

    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null })
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'))
    })
    req.on('error', reject)
    req.end()
  })
}

// 利用率 → 百分比整数（兼容 0-1 比例与 0-100 两种单位）
function toPercent(utilization) {
  if (utilization === null || utilization === undefined) {
    return null
  }
  const n = Number(utilization)
  if (Number.isNaN(n)) {
    return null
  }
  return Math.round(n <= 1 ? n * 100 : n)
}

// 剩余秒数 → 紧凑文本
function formatRemaining(seconds) {
  if (seconds === null || seconds === undefined) {
    return null
  }
  const s = Number(seconds)
  if (Number.isNaN(s) || s <= 0) {
    // 已过重置点或无重置时间：不显示括号
    return null
  }
  if (s >= 86400) {
    return `${Math.floor(s / 86400)}d`
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  if (s >= 60) {
    return `${Math.floor(s / 60)}m`
  }
  return '<1m'
}

// 单个窗口 → "5h 42% (2h13m)"
function formatWindow(label, win) {
  if (!win) {
    return null
  }
  const percent = toPercent(win.utilization)
  if (percent === null) {
    return null
  }
  const remaining = formatRemaining(win.remainingSeconds)
  return remaining ? `${label} ${percent}% (${remaining})` : `${label} ${percent}%`
}

// 金额格式化：整数不带小数，否则两位
function fmtMoney(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// API Key 当日费用 → "$1.23/$10"；无限额时限额显示 $NA；无数据返回 null
function formatCost(apiKey) {
  if (!apiKey || apiKey.dailyCost === null || apiKey.dailyCost === undefined) {
    return null
  }
  const used = Number(apiKey.dailyCost)
  if (Number.isNaN(used)) {
    return null
  }
  const limit = Number(apiKey.dailyCostLimit)
  const limitStr = limit > 0 ? `$${fmtMoney(limit)}` : '$NA'
  return `$${used.toFixed(2)}/${limitStr}`
}

// 毫秒数 → 紧凑文本：ms / s / XmYs / XhYm
function fmtDuration(ms) {
  if (ms === null || ms === undefined) {
    return null
  }
  const n = Number(ms)
  if (Number.isNaN(n) || n < 0) {
    return null
  }
  if (n < 1000) {
    return `${Math.round(n)}ms`
  }
  const totalSec = Math.floor(n / 1000)
  if (totalSec < 60) {
    return `${totalSec}s`
  }
  const totalMin = Math.floor(totalSec / 60)
  const remSec = totalSec % 60
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin}m${remSec}s` : `${totalMin}m`
  }
  const h = Math.floor(totalMin / 60)
  const remMin = totalMin % 60
  return remMin > 0 ? `${h}h${remMin}m` : `${h}h`
}

// Claude Code 传入的 stdin JSON → 顶部一行: "<model> · <cwd-basename> · $<cost> · <duration>"
// 任一字段缺失则不显示该段；全缺则返回 ''（外层会省略整行）。
function formatTopLine(input) {
  if (!input || typeof input !== 'object') {
    return ''
  }
  const segments = []

  const model = input.model && input.model.display_name
  if (typeof model === 'string' && model) {
    segments.push(model)
  }

  const cwd = input.workspace && input.workspace.current_dir
  if (typeof cwd === 'string' && cwd) {
    segments.push(path.basename(cwd) || cwd)
  }

  const cost = input.cost && input.cost.total_cost_usd
  if (typeof cost === 'number' && !Number.isNaN(cost)) {
    segments.push(`$${cost.toFixed(2)}`)
  }

  const durStr = fmtDuration(input.cost && input.cost.total_duration_ms)
  if (durStr) {
    segments.push(durStr)
  }

  return segments.join(' · ')
}

// 接口响应 → 状态栏 Usage 行
// 输出格式: "Usage: upstream 5h x% (...), 7d y% (...), sonnet z% (...); Daily $a/$b"
function formatLine(data) {
  // upstream 段：三窗口或占位
  let upstream
  if (!data || data.supported === false) {
    upstream =
      data && data.reason === 'not_oauth' ? 'upstream (账号无配额数据)' : 'upstream (暂无数据)'
  } else {
    const usage = data.usage || {}
    const windows = [
      formatWindow('5h', usage.fiveHour),
      formatWindow('7d', usage.sevenDay),
      formatWindow('sonnet', usage.sevenDayOpus)
    ].filter(Boolean)
    upstream =
      windows.length > 0
        ? `upstream ${data.stale ? '~' : ''}${windows.join(', ')}`
        : 'upstream (暂无数据)'
  }

  // Daily 段：API Key 当日费用（解析失败则省略）
  const cost = data ? formatCost(data.apiKey) : null
  const segments = [upstream]
  if (cost) {
    segments.push(`Daily ${cost}`)
  }
  return `Usage: ${segments.join('; ')}`
}

async function main() {
  const input = readStdin()
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const file = cacheFilePath(sessionId)

  // 顶部行(model/cwd/cost/duration)每次从 stdin 实时计算；只有 Usage 行走 60s 缓存
  const topLine = formatTopLine(input)
  const print = (usageLine) => {
    process.stdout.write(topLine ? `${topLine}\n${usageLine}` : usageLine)
  }

  // 本地缓存命中（<60s）：直接打印缓存的 Usage 行 + 实时顶部行
  const cache = readCache(file)
  if (cache && Date.now() - cache.ts < LOCAL_CACHE_TTL_MS) {
    print(cache.line)
    return
  }

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (!baseUrl || !apiKey) {
    print(cache ? cache.line : 'Claude —')
    return
  }

  try {
    const { status, data } = await fetchUsage(baseUrl, apiKey, sessionId)
    if (status !== 200) {
      // 端点关闭(404) 或服务端错误：回退到旧缓存或占位
      print(cache ? cache.line : 'Claude —')
      return
    }
    const usageLine = formatLine(data)
    writeCache(file, usageLine)
    print(usageLine)
  } catch (_err) {
    print(cache ? cache.line : 'Claude —')
  }
}

main().catch(() => {
  process.stdout.write('Claude —')
})
