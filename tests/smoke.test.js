import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.js'
import { upsertMemory, getMemory, searchMemories, upsertLink, graphWalk, saveMessageOnce, getUnextracted, markExtracted, getStats } from '../src/store.js'
import { recall } from '../src/recall.js'
import { importLegacy, parseLegacyEntry, importHermesWorkspace, parseMarkdownSections } from '../src/migrate.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-dream-memory-'))
const db = openDb(join(dir, 'test.db'))

test('upsert：内容哈希去重 + validated_count 递增', () => {
  const a = upsertMemory(db, { kind: 'fact', scope: 'global', content: '部署端口是 8080' })
  const b = upsertMemory(db, { kind: 'fact', scope: 'global', content: '部署端口是 8080' })
  assert.equal(a.isNew, true)
  assert.equal(b.isNew, false)
  assert.equal(b.memory.validatedCount, 2)
  assert.equal(getMemory(db, a.memory.id).id, a.memory.id)
})

test('同一内容在不同项目不是重复', () => {
  const a = upsertMemory(db, { kind: 'key', scope: 'project:aaa', projectId: 'aaa', content: '使用 pnpm' })
  const b = upsertMemory(db, { kind: 'key', scope: 'project:bbb', projectId: 'bbb', content: '使用 pnpm' })
  assert.equal(a.isNew, true)
  assert.equal(b.isNew, true)
})

test('搜索：中文关键词 + 项目作用域过滤', () => {
  upsertMemory(db, { kind: 'skill', scope: 'project:aaa', projectId: 'aaa', name: 'docker-port-expose', content: '容器端口暴露：docker run -p 8080:8080' })
  const hits = searchMemories(db, '端口暴露', { scopeIds: ['project:aaa'], limit: 5 })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].memory.scope, 'project:aaa')
})

test('图：RELATED 边支持跨项目扩展', () => {
  const x = upsertMemory(db, { kind: 'fact', scope: 'global', content: '全局事实：Clash 代理在 7890' })
  const y = upsertMemory(db, { kind: 'fact', scope: 'project:aaa', projectId: 'aaa', content: '项目 aaa 踩坑：代理要配 git config' })
  upsertLink(db, { fromId: x.memory.id, toId: y.memory.id, type: 'RELATED', instruction: '关联' })
  const walked = graphWalk(db, [x.memory.id], 1)
  assert.ok(walked.includes(y.memory.id))
})

test('召回：默认不含日志，返回记忆行', async () => {
  const result = await recall(db, { recallMaxNodes: 6, recallMaxDepth: 1 }, '端口', { projectId: 'aaa' })
  assert.ok(Array.isArray(result.entries))
  assert.ok(result.entries.every((m) => m.kind !== 'log'))
})

test('原始事件：只保存一次 + 增量标记', () => {
  saveMessageOnce(db, 'evt-1', 's1', 1, 1, 'user', '帮我配置 docker')
  saveMessageOnce(db, 'evt-1', 's1', 1, 1, 'user', '重复事件不应入库')
  assert.equal(getUnextracted(db, 10).length, 1)
  markExtracted(db, 1)
  assert.equal(getUnextracted(db, 10).length, 0)
})

test('旧记忆条目解析：日期/分支/正文分离', () => {
  const parsed = parseLegacyEntry('[2026-01-02] [branch:main,dev] 项目决策：用 SQLite', 'key')
  assert.equal(parsed.branch, 'main,dev')
  assert.equal(parsed.body, '项目决策：用 SQLite')
  assert.ok(parsed.createdAt)
})

test('旧记忆迁移：幂等', () => {
  const legacy = join(dir, 'legacy-memories')
  mkdirSync(join(legacy, 'daily'), { recursive: true })
  mkdirSync(join(legacy, 'projects', 'abc123'), { recursive: true })
  writeFileSync(join(legacy, 'MEMORY.md'), '[2026-01-01] 偏好：答案用中文\n')
  writeFileSync(join(legacy, 'projects', 'abc123', 'KEY.md'), '[2026-01-02] 该项目部署在 8080\n')
  writeFileSync(join(legacy, 'daily', '2026-01-03.md'), '[10:00] [项目A] 写了点东西\n')

  const db2 = openDb(join(dir, 'migrate.db'))
  const first = importLegacy(db2, legacy)
  assert.equal(first.inserted, 3)
  const second = importLegacy(db2, legacy)
  assert.equal(second.alreadyImported, true)
  assert.equal(getStats(db2).total, 3)
  db2.close()
})

test('Hermes 工作区迁移：按 ## 小节切分且幂等', () => {
  const root = join(dir, 'hermes-workspace')
  mkdirSync(join(root, 'memory'), { recursive: true })
  writeFileSync(join(root, 'MEMORY.md'), '# MEMORY\n\n## 老大是谁\n- 称呼：老大\n\n## 决策\n- 2026-01-20 决定用 SQLite\n')
  writeFileSync(join(root, 'USER.md'), '# USER\n\n## 偏好\n- 回复语言：中文\n')
  writeFileSync(join(root, 'memory', '2026-01-03.md'), '# 日志\n\n今天做了 A\n')

  const db3 = openDb(join(dir, 'hermes.db'))
  const first = importHermesWorkspace(db3, root)
  assert.equal(first.inserted, 4) // MEMORY 2 节 + USER 1 节 + 日志 1 节
  const second = importHermesWorkspace(db3, root)
  assert.equal(second.alreadyImported, true)
  db3.close()
})

test('Markdown 小节解析', () => {
  const sections = parseMarkdownSections('# T\n\n## A\n1\n\n## B\n2\n')
  assert.deepEqual(sections.map((s) => s.heading), ['A', 'B'])
})

// summary↔content Jaccard 三档：
//  - 高度匹配（具体词全部在 content 里）→ 应 > 0.2
//  - 模糊摘要（label-only）→ 应 < 0.1
//  - 完全空 → 视为 1（无警告）
// 实际函数定义在 dsh.js，由于它依赖 ctx.logger 注入，这里复刻一份测试其纯逻辑
function jaccardHelper(summary, content) {
  if (!summary || !content) return 1
  const isCjk = (c) => c >= '\u4e00' && c <= '\u9fff'
  const tokenize = (text) => {
    const out = new Set()
    const s = String(text).replace(/\s+/g, '')
    for (let i = 0; i < s.length - 2; i++) {
      const g = s.slice(i, i + 3)
      if (isCjk(g[0]) && isCjk(g[1]) && isCjk(g[2])) out.add(g)
    }
    for (const w of String(text).match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []) {
      out.add(w.toLowerCase())
    }
    return out
  }
  const a = tokenize(summary)
  const b = tokenize(content)
  if (!a.size || !b.size) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

test('Jaccard 软警告阈值：模糊摘要触发', () => {
  // 模糊摘要：12 字符的抽象标题，与 content 关键词零重叠
  const j1 = jaccardHelper('老大对回复风格的一贯要求', '中文回复，详细，技术说明先给结构图示再展开论据')
  assert.ok(j1 < 0.1, `模糊摘要应触发警告 j=${j1}`)
})

test('Jaccard 软警告阈值：具体词摘要不触发', () => {
  const j2 = jaccardHelper('中文回复详细技术说明先结构图示', '中文回复，详细，技术说明先结构图示再展开论据')
  assert.ok(j2 > 0.2, `具体词摘要应通过 j=${j2}`)
})

test('Jaccard 软警告阈值：2 字 label 视为无词（不警告）', () => {
  // 2 字符无法生成 trigram，无 token → 返回 1（不警告）
  // 这是 by design：单字词不该误伤
  assert.equal(jaccardHelper('偏好', '任何内容'), 1)
})

test('Jaccard 空输入视为 1（不警告）', () => {
  assert.equal(jaccardHelper('', '任何内容'), 1)
  assert.equal(jaccardHelper('任何摘要', ''), 1)
})

test.after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
