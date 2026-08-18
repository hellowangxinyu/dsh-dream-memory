import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.js'
import { upsertMemory, getMemory, searchMemories, upsertLink, graphWalk, saveMessageOnce, getUnextracted, markExtracted, getStats, analyzeMemoryQuality, archiveMemoryWithReason, updateMemorySummary, decayStaleMemories, mergeSimilarMemories, getDashboardStats, touchMemory } from '../src/store.js'
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

// "无感" 原则：dm_remember 不再触发 Jaccard 自检，避免每次写入 1ms 延迟
// Jaccard 逻辑只在 dm_consolidate audit 时跑（明确触发），不污染写入路径
// 这里不再测试 jaccardHelper；保留 consolidation 路径的测试

// ─── consolidation helpers ─────────────────────────────────────────

test('analyzeMemoryQuality：label-only 与模糊摘要识别', () => {
  // 制造 1 条 label-only（短 + 不在 content 中）
  upsertMemory(db, {
    kind: 'fact', scope: 'global',
    summary: '偏好',
    content: '中文回复要详细,技术说明先给结构图示再展开论据',
  })
  // 制造 1 条低 jaccard 模糊摘要（>8 字避开 label-only 路径）
  upsertMemory(db, {
    kind: 'decision', scope: 'global',
    summary: '老大对回复风格的一贯要求',
    content: '中文回复要详细,技术说明先给结构图示再展开论据',
  })
  // 制造 1 条高质量摘要（不应被命中）
  upsertMemory(db, {
    kind: 'skill', scope: 'global',
    summary: '中文回复详细+技术说明先结构图示',
    content: '中文回复要详细,技术说明先给结构图示再展开论据',
  })
  const r = analyzeMemoryQuality(db, { jaccardThreshold: 0.1, labelMaxLen: 8 })
  assert.ok(r.labels.length >= 1, `label-only 应至少 1 条 实际 ${r.labels.length}`)
  assert.ok(r.vague.length >= 1, `模糊摘要应至少 1 条 实际 ${r.vague.length}`)
})

test('analyzeMemoryQuality：高质量摘要不进入 candidates', () => {
  upsertMemory(db, {
    kind: 'skill', scope: 'global',
    summary: '中文回复详细+技术说明先结构图示',
    content: '中文回复要详细,技术说明先给结构图示再展开论据',
  })
  const r = analyzeMemoryQuality(db, { jaccardThreshold: 0.1, labelMaxLen: 8 })
  // 高质量摘要不应出现在 labels 或 vague 里
  const matched = [...r.labels, ...r.vague].find((x) => x.summary.includes('中文回复详细'))
  assert.equal(matched, undefined)
})

test('archiveMemoryWithReason：归档后 status 变 archived 且 reason 写入 source_refs', () => {
  const a = upsertMemory(db, { kind: 'fact', scope: 'global', content: '归档测试内容' })
  assert.equal(a.memory.status, 'active')
  const r = archiveMemoryWithReason(db, a.memory.id, 'test:archive')
  assert.equal(r.ok, true)
  const after = db.prepare('SELECT status, source_refs FROM memories WHERE id=?').get(a.memory.id)
  assert.equal(after.status, 'archived')
  assert.ok(after.source_refs.includes('test:archive'))
  // 重复归档应失败
  const r2 = archiveMemoryWithReason(db, a.memory.id, 'test:dup')
  assert.equal(r2.ok, false)
})

test('updateMemorySummary：重写 summary 保留 content 不变', () => {
  const a = upsertMemory(db, {
    kind: 'skill', scope: 'global',
    summary: '原始摘要',
    content: '中文回复要详细,技术说明先给结构图示再展开论据',
  })
  const r = updateMemorySummary(db, a.memory.id, '中文回复详细+技术说明先结构图示')
  assert.equal(r.ok, true)
  const after = db.prepare('SELECT summary, content FROM memories WHERE id=?').get(a.memory.id)
  assert.equal(after.summary, '中文回复详细+技术说明先结构图示')
  assert.equal(after.content, '中文回复要详细,技术说明先给结构图示再展开论据')
})

test('updateMemorySummary：拒绝空字符串', () => {
  const a = upsertMemory(db, { kind: 'fact', scope: 'global', content: '测试内容' })
  const r = updateMemorySummary(db, a.memory.id, '')
  assert.equal(r.ok, false)
})

// ─── decayStaleMemories 防止库膨胀 ──────────────────────────────────

test('decayStaleMemories：90 天以上未访问且 importance<0.7 自动归档', () => {
  // 制造 1 条 100 天前创建、未访问、importance 0.3 的记忆
  const old = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    content: '老记忆 100 天前',
    importance: 0.3,
  })
  const old_ms = Date.now() - 100 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, old.memory.id)

  // 制造 1 条 importance 0.9（高价值，不该被归档）
  const important = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    content: '高价值记忆',
    importance: 0.9,
  })
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, important.memory.id)

  // 制造 1 条 30 天前（新鲜，不该被归档）
  const fresh = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    content: '新鲜记忆',
    importance: 0.3,
  })
  const fresh_ms = Date.now() - 30 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(fresh_ms, fresh_ms, fresh.memory.id)

  const r = decayStaleMemories(db, { staleDays: 90, maxBatch: 100 })
  assert.ok(r.decayed >= 1, `至少归档 1 条，实际 ${r.decayed}`)

  // 验证：老记忆被归档
  const oldAfter = db.prepare('SELECT status FROM memories WHERE id=?').get(old.memory.id)
  assert.equal(oldAfter.status, 'archived')
  // 验证：高价值记忆没被归档
  const impAfter = db.prepare('SELECT status FROM memories WHERE id=?').get(important.memory.id)
  assert.equal(impAfter.status, 'active')
  // 验证：新鲜记忆没被归档
  const freshAfter = db.prepare('SELECT status FROM memories WHERE id=?').get(fresh.memory.id)
  assert.equal(freshAfter.status, 'active')
})

test('decayStaleMemories：被访问过的记忆不被归档', () => {
  const m = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    content: '曾被访问',
    importance: 0.3,
  })
  // 强制 old + 标记访问
  const old_ms = Date.now() - 100 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, last_accessed_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, old_ms, m.memory.id)

  const r = decayStaleMemories(db, { staleDays: 90, maxBatch: 100 })
  const after = db.prepare('SELECT status FROM memories WHERE id=?').get(m.memory.id)
  assert.equal(after.status, 'active')
})

test('decayStaleMemories：maxBatch 限制单次归档数', () => {
  // 造 5 条满足条件的记忆
  const ids = []
  for (let i = 0; i < 5; i++) {
    const m = upsertMemory(db, {
      kind: 'fact', scope: 'global',
      content: `stale-${i}`,
      importance: 0.3,
    })
    const old_ms = Date.now() - 100 * 86400 * 1000
    db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, m.memory.id)
    ids.push(m.memory.id)
  }
  const r = decayStaleMemories(db, { staleDays: 90, maxBatch: 2 })
  assert.equal(r.decayed, 2, `应只归档 2 条，实际 ${r.decayed}`)
})

// ─── mergeSimilarMemories 让库保持高效简洁 ─────────────────────────────

test('mergeSimilarMemories：Jaccard > 阈值的相似记忆合并', () => {
  // 造 2 条非常相似的 fact
  const a = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    summary: '中文回复详细+技术说明先结构图示',
    content: '中文回复要详细,技术说明先给结构图示再展开论据（A）',
    importance: 0.7,
  })
  const b = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    summary: '中文回复详细+技术说明先结构图示',
    content: '中文回复要详细,技术说明先给结构图示再展开论据（B）',
    importance: 0.7,
  })
  const r = mergeSimilarMemories(db, { similarityThreshold: 0.5, maxBatch: 50 })
  assert.ok(r.merged >= 1, `应至少合并 1 对，实际 ${r.merged}`)
  // 应该有一条被归档
  const archived = db.prepare("SELECT id FROM memories WHERE status='archived' AND (id=? OR id=?)").all(a.memory.id, b.memory.id)
  assert.ok(archived.length >= 1, '应至少一条被归档')
})

test('mergeSimilarMemories：Jaccard < 阈值不合并', () => {
  // 造 2 条完全不同的
  upsertMemory(db, {
    kind: 'skill', scope: 'global',
    summary: '侧边栏设置面板 async render',
    content: 'DSH 插件侧边栏设置面板一直 loading 的修复方法',
  })
  upsertMemory(db, {
    kind: 'skill', scope: 'global',
    summary: 'PowerShell 单文件依赖追踪',
    content: '用 PowerShell 追踪 .exe 依赖的 .dll',
  })
  const r = mergeSimilarMemories(db, { similarityThreshold: 0.5, maxBatch: 50 })
  // 这 2 条 Jaccard 很低，0 合并是正常（不要求 0，但应没有 false merge）
  // 看下实际
  assert.ok(r.merged <= 0, `不应合并，实际合并 ${r.merged}`)
})

test('mergeSimilarMemories：跨 kind 不合并', () => {
  // 两条 summary 几乎一样，但 kind 不同
  upsertMemory(db, {
    kind: 'fact', scope: 'global',
    summary: '回复偏好详细中文+技术说明',
    content: 'fact content',
  })
  upsertMemory(db, {
    kind: 'preference', scope: 'global',
    summary: '回复偏好详细中文+技术说明',
    content: 'preference content',
  })
  const r = mergeSimilarMemories(db, { similarityThreshold: 0.5, maxBatch: 50 })
  // 跨 kind 不能合并
  assert.equal(r.merged, 0, `跨 kind 应不合并，实际 ${r.merged}`)
})

// ─── SLA 硬约束：recall 必须 0.5s 内返回 ──────────────────────────────

test('recall SLA：100 条记忆下 recall < 500ms', () => {
  // 灌 100 条记忆
  for (let i = 0; i < 100; i++) {
    upsertMemory(db, {
      kind: 'fact', scope: 'global',
      content: `测试记忆 ${i}，包含一些中文关键词如：编程框架、数据库表、API 接口、用户偏好、稳定版本`,
      importance: 0.6,
    })
  }
  // 跑 5 次取平均
  const samples = []
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    recall(db, { recallMaxNodes: 6, recallMaxDepth: 1 }, '编程框架', {}, null)
    samples.push(Date.now() - t0)
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  const max = Math.max(...samples)
  console.log(`  recall 平均 ${avg.toFixed(1)}ms, 最大 ${max}ms`)
  assert.ok(max < 500, `recall 最大耗时 ${max}ms 超过 SLA 500ms`)
  assert.ok(avg < 200, `recall 平均耗时 ${avg.toFixed(1)}ms 偏高`)
})

// ─── 访问重要性递增 ─────────────────────────────────────────

test('touchMemory：每次访问 importance +0.05，cap 0.95', () => {
  const m = upsertMemory(db, { kind: 'fact', scope: 'global', content: '测访问递增', importance: 0.6 })
  // 第一次访问（> 60s 后才能涨）
  db.prepare('UPDATE memories SET last_accessed_at=? WHERE id=?').run(0, m.memory.id)
  touchMemory(db, m.memory.id)
  const after1 = db.prepare('SELECT importance, access_count, last_accessed_at FROM memories WHERE id=?').get(m.memory.id)
  assert.equal(Number(after1.importance.toFixed(3)), 0.65, `第 1 次访问 importance 应 0.65，实际 ${after1.importance}`)
  assert.equal(after1.access_count, 1)

  // 第二次（间隔足够）
  db.prepare('UPDATE memories SET last_accessed_at=? WHERE id=?').run(0, m.memory.id)
  touchMemory(db, m.memory.id)
  const after2 = db.prepare('SELECT importance FROM memories WHERE id=?').get(m.memory.id)
  assert.equal(Number(after2.importance.toFixed(3)), 0.70)

  // 高频防抖动：同一分钟内再次访问，importance 不涨
  touchMemory(db, m.memory.id)
  const after3 = db.prepare('SELECT importance, access_count FROM memories WHERE id=?').get(m.memory.id)
  assert.equal(Number(after3.importance.toFixed(3)), 0.70, '一分钟内重复访问 importance 不涨')
  assert.equal(after3.access_count, 3, '但 access_count 仍然 +1')

  // 验证 cap 0.95
  db.prepare('UPDATE memories SET importance=0.93, last_accessed_at=0 WHERE id=?').run(m.memory.id)
  touchMemory(db, m.memory.id)
  const after4 = db.prepare('SELECT importance FROM memories WHERE id=?').get(m.memory.id)
  assert.equal(after4.importance, 0.95, 'importance 不超过 0.95')
})

// ─── 跨会话仪表盘 ─────────────────────────────────────────

test('getDashboardStats：返回体量+健康+Top+最近', () => {
  // 灌 5 条 active + 1 archived + 1 access > 0
  for (let i = 0; i < 5; i++) {
    upsertMemory(db, { kind: 'fact', scope: 'global', content: `dbstat ${i}`, importance: 0.7 })
  }
  const archived = upsertMemory(db, { kind: 'fact', scope: 'global', content: 'arch', importance: 0.7 })
  db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(archived.memory.id)
  const top = upsertMemory(db, { kind: 'fact', scope: 'global', content: 'top访问', importance: 0.7 })
  for (let i = 0; i < 5; i++) touchMemory(db, top.memory.id)

  const s = getDashboardStats(db, { topLimit: 5, recentDays: 7 })
  assert.ok(s.totals.active > 0)
  assert.ok(s.totals.archived >= 1)
  assert.ok(s.byKind.fact)
  assert.ok(s.health.avgImportance > 0)
  assert.ok(s.topAccessed.length >= 1)
  assert.ok(s.topAccessed[0].access_count >= 1)
  assert.ok(s.recent.length >= 1)
  assert.ok(s.graph.edges !== undefined)
})

test.after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
