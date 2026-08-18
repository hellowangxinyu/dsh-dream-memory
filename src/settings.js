/**
 * dsh-dream-memory — 运行时设置（面板可改，立即生效，不用重启）
 *
 * 持久化到 <dream-memory>/settings.json；宿主 apply 的 input 作为初始值，
 * 面板保存后覆盖。每次读取都从文件刷新（毫秒级，无性能问题）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { resolvePath } from './db.js'

/** 可通过面板修改的字段及范围 */
export const SETTING_FIELDS = {
  recallEnabled: { type: 'boolean', label: '自动召回', hint: '用户消息时自动检索相关记忆注入上下文', default: true },
  dreamEnabled: { type: 'boolean', label: '梦境整理', hint: '后台 LLM 提炼对话为长期记忆', default: true },
  legacyImport: { type: 'boolean', label: '旧格式导入', hint: '启动时导入 dsh-memory-evolve / Hermes 旧文件', default: true },
  recallMaxNodes: { type: 'number', label: '召回条数', hint: '每次注入的最大记忆条数（3-10）', default: 6, min: 3, max: 10, step: 1 },
  recallMaxDepth: { type: 'number', label: '图扩展深度', hint: '从命中节点沿知识图谱扩展几跳（0-3）', default: 1, min: 0, max: 3, step: 1 },
  dreamInterval: { type: 'number', label: '梦境间隔（回合）', hint: '每 N 个回合自动触发一次梦境（与最小小时间隔共同生效）', default: 6, min: 3, max: 30, step: 1 },
  minDreamMessages: { type: 'number', label: '梦境最小事件数', hint: '积攒多少条未处理事件才开始做梦', default: 10, min: 1, max: 50, step: 1 },
  dreamMinIntervalHours: { type: 'number', label: '梦境最小间隔（小时）', hint: '距上次梦境不足 N 小时不触发，默认一天一次', default: 20, min: 1, max: 168, step: 1 },
  dreamMaxCards: { type: 'number', label: '梦境输入卡片上限', hint: '单次梦境最多处理多少条事件（每条截 500 字）', default: 20, min: 5, max: 50, step: 1 },
  dreamMaxTokens: { type: 'number', label: '梦境输出预算（token）', hint: '梦境 LLM 单次输出上限', default: 1024, min: 256, max: 4096, step: 128 },
  dreamReasoningEffort: { type: 'string', label: '梦境推理强度', hint: '梦境 LLM 的推理强度（low/medium/high/max）', default: 'low' },
  identityMaxChars: { type: 'number', label: '身份卡字符上限', hint: '会话开头注入的 profile+key 总字符数', default: 750, min: 200, max: 3000, step: 50 },
  recallMaxChars: { type: 'number', label: '召回块字符上限', hint: '每次注入的召回内容总字符数', default: 1500, min: 300, max: 6000, step: 100 },
}

const SETTING_KEYS = Object.keys(SETTING_FIELDS)

function settingsFilePath(dbPath) {
  return join(dirname(resolvePath(dbPath)), 'settings.json')
}

function coerce(key, value) {
  const spec = SETTING_FIELDS[key]
  if (!spec) return undefined
  if (spec.type === 'boolean') return value === true || value === 'true' || value === 1
  if (spec.type === 'string') return typeof value === 'string' ? value : spec.default
  if (spec.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return spec.default
    return Math.max(spec.min ?? 0, Math.min(spec.max ?? 100, n))
  }
  return undefined
}

/**
 * 读取当前设置（从文件实时刷新；文件不存在时用 apply input + 默认值）。
 */
export function loadSettings(dbPath, input = {}) {
  const file = settingsFilePath(dbPath)
  const result = {}
  for (const key of SETTING_KEYS) {
    result[key] = SETTING_FIELDS[key].default
  }
  // apply input 覆盖默认值（cordis.patch.yml 里的 config）
  for (const key of SETTING_KEYS) {
    if (input[key] !== undefined) result[key] = coerce(key, input[key]) ?? result[key]
  }
  // 文件覆盖（面板保存的值）
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      for (const key of SETTING_KEYS) {
        if (parsed[key] !== undefined) result[key] = coerce(key, parsed[key]) ?? result[key]
      }
    } catch {}
  }
  return result
}

/**
 * 保存设置到文件（面板调用），返回保存后的完整设置。
 */
export function saveSettings(dbPath, patch) {
  const file = settingsFilePath(dbPath)
  const current = loadSettings(dbPath)
  for (const key of SETTING_KEYS) {
    if (patch[key] !== undefined) {
      const v = coerce(key, patch[key])
      if (v !== undefined) current[key] = v
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
  return current
}

/**
 * 面板需要的元数据（字段定义 + 当前值）。
 */
export function settingsView(dbPath, input = {}) {
  const values = loadSettings(dbPath, input)
  return { fields: SETTING_FIELDS, values, keys: SETTING_KEYS }
}

export function defaultDbPath() {
  return process.env.DREAM_MEMORY_DB || join(homedir(), '.dsh', 'dream-memory', 'memory.db')
}