#!/usr/bin/env node
/**
 * 把 SQLite 记忆导出为 Markdown（给人看 / git 备份），不是数据源。
 *
 * 用法：node scripts/export-md.js [--db path] [--out dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openDb } from '../src/db.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const dbPath = arg('--db', process.env.DREAM_MEMORY_DB || join(homedir(), '.dsh', 'dream-memory', 'memory.db'))
const outDir = arg('--out', join(homedir(), '.dsh', 'dream-memory', 'export'))
const db = openDb(dbPath)
mkdirSync(outDir, { recursive: true })

const day = new Date().toISOString().slice(0, 10)
const groups = {}
for (const row of db.prepare("SELECT * FROM memories WHERE status='active' ORDER BY scope, kind, created_at").all()) {
  const key = row.scope === 'global' ? 'global' : `project:${row.project_label ?? row.project_id ?? 'unknown'}`
  groups[key] = groups[key] || []
  groups[key].push(row)
}

const out = []
for (const [scope, rows] of Object.entries(groups)) {
  out.push(`# ${scope}\n`)
  for (const m of rows) {
    out.push(`## [${m.id}|${m.kind}|${new Date(m.created_at).toISOString().slice(0, 10)}] ${m.summary}`)
    out.push(m.content)
    out.push('')
  }
  out.push('')
}

const file = join(outDir, `${day}.md`)
writeFileSync(file, out.join('\n'), 'utf8')
console.log(`已导出 ${Object.keys(groups).reduce((n, k) => n + groups[k].length, 0)} 条记忆 -> ${file}`)
db.close()
