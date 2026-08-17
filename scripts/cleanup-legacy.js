#!/usr/bin/env node
/**
 * 迁移完成后清理旧记忆系统。
 *
 * 安全设计：
 *   1. 默认只 --check，列出将处理的内容，不碰任何文件
 *   2. --move 会把旧记忆目录整体改名为 <memories>.migrated-<时间戳>（可恢复）
 *   3. --delete 才真正删除（先做一次 move 备份再删，或直接删需再传 --really-delete）
 *   4. 只有在确认「新库已导入成功」时才建议执行
 *
 * 用法：
 *   node scripts/cleanup-legacy.js --check
 *   node scripts/cleanup-legacy.js --move
 *   node scripts/cleanup-legacy.js --delete --really-delete
 */

import { existsSync, renameSync, rmSync, statSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openDb, getMeta } from '../src/db.js'
import { legacyDirDefault, listHermesImports } from '../src/migrate.js'

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const dbPath = arg('--db', process.env.DREAM_MEMORY_DB || join(homedir(), '.dsh', 'dream-memory', 'memory.db'))
const legacyDir = arg('--legacy-dir', legacyDirDefault())

const db = openDb(dbPath)
const marker = getMeta(db, 'legacy_import')
const hermesRoots = listHermesImports(db)

if (!marker && hermesRoots.length === 0) {
  console.error('错误：新库还没有任何迁移标记，请先运行 node scripts/migrate-legacy.js')
  process.exit(1)
}

if (existsSync(legacyDir)) {
  const size = statSync(legacyDir).size
  console.log(`旧记忆目录: ${legacyDir} (${(size / 1024).toFixed(1)} KiB)`)
  console.log(`迁移标记:   ${marker}`)
} else {
  console.log(`旧记忆目录不存在: ${legacyDir}`)
}
if (hermesRoots.length) {
  console.log(`Hermes 工作区记忆（已导入）:`)
  for (const root of hermesRoots) console.log(`  - ${root}`)
}

if (has('--check')) {
  console.log('\n[check] 只检查，未做任何修改。')
  const skillsDir = join(homedir(), '.agents', 'skills')
  if (existsSync(skillsDir)) {
    console.log(`\n技能目录 ${skillsDir} 当前内容（仅列出，不会删除）：`)
    for (const entry of readdirSync(skillsDir)) console.log(`  - ${entry}`)
    console.log('说明：dsh-memory-evolve 附带的技能（如 *-cli-calling）与 COI 调度相关，')
    console.log('      不属于记忆数据。是否删除请人工确认；卸载插件不会自动删除这些技能。')
  } else {
    console.log(`\n技能目录不存在：${skillsDir}`)
  }
  for (const root of hermesRoots) {
      const hermesFiles = ['MEMORY.md', 'USER.md', 'SOUL.md', 'AGENTS.md', 'SESSION-STATE.md', 'HEARTBEAT.md', 'ONBOARDING.md', 'TOOLS.md']
      console.log(`\n将移动的 Hermes 文件（${root}）：`)
      for (const f of hermesFiles) if (existsSync(join(root, f))) console.log(`  - ${f}`)
      if (existsSync(join(root, 'memory'))) console.log('  - memory\\ 目录')
    }
    console.log('\n确认无误后执行: node scripts/cleanup-legacy.js --move')
  db.close()
  process.exit(0)
}

const ts = Date.now()
  const backup = `${legacyDir}.migrated-${ts}`

  function moveDir(from, to) { renameSync(from, to) }
  function moveHermesFiles(root, timestamp) {
    const dest = join(root, `.dream-memory-migrated-${timestamp}`)
    mkdirSync(dest, { recursive: true })
    const files = ['MEMORY.md', 'USER.md', 'SOUL.md', 'AGENTS.md', 'SESSION-STATE.md', 'HEARTBEAT.md', 'ONBOARDING.md', 'TOOLS.md']
    const moved = []
    for (const f of files) {
      const src = join(root, f)
      if (existsSync(src)) {
        moveDir(src, join(dest, f))
        moved.push(src)
      }
    }
    const memoryDir = join(root, 'memory')
    if (existsSync(memoryDir)) {
      const destMemory = join(dest, 'memory')
      mkdirSync(destMemory, { recursive: true })
      for (const f of readdirSync(memoryDir)) {
        moveDir(join(memoryDir, f), join(destMemory, f))
      }
      moved.push(memoryDir)
    }
    console.log(`\nHermes 记忆文件已移动到:\n  ${dest}`)
    return moved
  }

if (has('--move')) {
  if (existsSync(legacyDir)) moveDir(legacyDir, backup)
  console.log(`\n已将旧记忆目录移动到备份位置:\n  ${backup}`)
    for (const root of hermesRoots) moveHermesFiles(root, ts)
    console.log('（确认新插件工作正常后，可手动删除这些备份）')
  db.close()
  process.exit(0)
}

if (has('--delete')) {
  if (!has('--really-delete')) {
    console.log('\n拒绝删除：--delete 是破坏性操作，需要同时传 --really-delete。')
    console.log('推荐先 --move（可恢复），或传 --delete --really-delete 确认直接删除。')
    db.close()
    process.exit(1)
  }
  if (existsSync(legacyDir)) moveDir(legacyDir, backup)
  rmSync(backup, { recursive: true, force: true })
  if (existsSync(legacyDir)) console.log(`\n已删除旧记忆目录:\n  ${legacyDir}`)
    for (const root of hermesRoots) {
      for (const moved of moveHermesFiles(root, ts)) {
        rmSync(moved, { recursive: true, force: true })
      }
    }
}

console.log('\n下一步（卸载旧插件，二选一）：')
console.log('  dsh plugin --profile web remove dsh-memory-evolve')
console.log('  或在 profile 的 cordis.patch.yml 中把 dsh-memory-evolve 设为 disabled: true')
db.close()
