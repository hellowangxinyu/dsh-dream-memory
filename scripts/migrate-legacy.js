#!/usr/bin/env node
/**
 * 手动执行旧记忆迁移（插件启动时也会自动执行一次）。
 *
 * 用法：
 *   node scripts/migrate-legacy.js [--dry-run] [--force]
 *   node scripts/migrate-legacy.js --legacy-dir "D:\\path\\memories" --db "D:\\path\\memory.db"
 *   node scripts/migrate-legacy.js --hermes-root "D:\\Harness"
 *
 * 只读旧文件，不删除任何东西；幂等（相同内容不会重复导入）。
 */

import { openDb } from '../src/db.js'
import { importLegacy, legacyDirDefault, importHermesWorkspace } from '../src/migrate.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const dbPath = arg('--db', process.env.DREAM_MEMORY_DB || join(homedir(), '.dsh', 'dream-memory', 'memory.db'))
const legacyDir = arg('--legacy-dir', legacyDirDefault())

const db = openDb(dbPath)
const summary = importLegacy(db, legacyDir, {
  force: has('--force'),
  dryRun: has('--dry-run'),
  log: (msg) => console.error(msg),
})

const hermesRoot = arg('--hermes-root', process.env.DREAM_MEMORY_HERMES_ROOT)
if (hermesRoot) {
  summary.hermes = importHermesWorkspace(db, hermesRoot, {
    force: has('--force'),
    dryRun: has('--dry-run'),
    log: (msg) => console.error(msg),
  })
}

console.log(JSON.stringify(summary, null, 2))
db.close()

if (summary.alreadyImported) {
  console.log('已迁移过（可用 --force 重新扫描，内容哈希会防止重复导入）。')
}
