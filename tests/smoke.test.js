import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../src/db.js'
import { upsertMemory, getMemory, searchMemories, upsertLink, graphWalk, saveMessageOnce, getUnextracted, markExtracted, getStats, analyzeMemoryQuality, archiveMemoryWithReason, updateMemorySummary, decayStaleMemories, mergeSimilarMemories, getDashboardStats, touchMemory, recordRecallPerf, getRecallPerf, listMemories, cleanupExtractedMessages, findFossilMemories, getLastRecallReason, recordRecallReason } from '../src/store.js'
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

  const r = decayStaleMemories(db, { tierDays: { knowledge: 90 }, maxBatch: 100 })
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
  const r = decayStaleMemories(db, { tierDays: { knowledge: 90 }, maxBatch: 2 })
  assert.equal(r.decayed, 2, `应只归档 2 条，实际 ${r.decayed}`)
})

// ─── Tier 分层：profile → identity，不会被 knowledge 的 decay 误伤 ───────

test('decayStaleMemories：profile (identity tier) 默认 1825 天不归档', () => {
  // 1 条 profile 记忆 200 天前创建，importance 0.5
  const profile = upsertMemory(db, {
    kind: 'profile', scope: 'global',
    summary: '老大在山东临沂',
    content: '老大在山东临沂',
    importance: 0.5,
  })
  assert.equal(profile.memory.tier, 'identity', `kind=profile 应自动 tier=identity，实际 ${profile.memory.tier}`)
  const old_ms = Date.now() - 200 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, profile.memory.id)

  // 200 天前的 knowledge fact 应当被归档
  const fact = upsertMemory(db, {
    kind: 'fact', scope: 'global',
    content: 'should decay',
    importance: 0.5,
  })
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, fact.memory.id)

  // 默认参数：knowledge=90, working=14, identity=1825
  const r = decayStaleMemories(db, { maxBatch: 100 })
  const profileAfter = db.prepare('SELECT status FROM memories WHERE id=?').get(profile.memory.id)
  const factAfter = db.prepare('SELECT status FROM memories WHERE id=?').get(fact.memory.id)
  assert.equal(profileAfter.status, 'active', '200 天的 profile 应仍 active（identity=1825d）')
  assert.equal(factAfter.status, 'archived', '200 天的 fact 应被归档（knowledge=90d）')
})

test('decayStaleMemories：task (working tier) 14 天就归档', () => {
  const task = upsertMemory(db, {
    kind: 'task', scope: 'global',
    content: '短期任务',
    importance: 0.5,
  })
  assert.equal(task.memory.tier, 'working', `kind=task 应自动 tier=working`)
  const old_ms = Date.now() - 30 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, task.memory.id)

  const r = decayStaleMemories(db, { maxBatch: 100 })
  const taskAfter = db.prepare('SELECT status FROM memories WHERE id=?').get(task.memory.id)
  assert.equal(taskAfter.status, 'archived', '30 天的 task 应被归档（working=14d）')
})

test('upsertMemory：kind 自动推断 tier', () => {
  const profile = upsertMemory(db, { kind: 'profile', scope: 'global', content: 'p' })
  assert.equal(profile.memory.tier, 'identity')
  const task = upsertMemory(db, { kind: 'task', scope: 'global', content: 't' })
  assert.equal(task.memory.tier, 'working')
  const event = upsertMemory(db, { kind: 'event', scope: 'global', content: 'e' })
  assert.equal(event.memory.tier, 'working')
  const log = upsertMemory(db, { kind: 'log', scope: 'global', content: 'l' })
  assert.equal(log.memory.tier, 'working')
  const fact = upsertMemory(db, { kind: 'fact', scope: 'global', content: 'f' })
  assert.equal(fact.memory.tier, 'knowledge')
  const pref = upsertMemory(db, { kind: 'preference', scope: 'global', content: 'p2' })
  assert.equal(pref.memory.tier, 'knowledge')
  // 显式覆盖
  const override = upsertMemory(db, { kind: 'profile', scope: 'global', content: 'o', tier: 'working' })
  assert.equal(override.memory.tier, 'working', '显式 tier 应覆盖推断')
})

// ─── Tier-aware recall injection ──────────────────────────────

test('formatRecall：identity tier 不重复注入（已走 identity card）', async () => {
  // 用 import() 拿 inject 模块（独立导入避免污染测试全局）
  const { formatRecall } = await import('../src/inject.js')
  const entries = [
    { id: 'ID-ID-001', kind: 'profile', tier: 'identity', importance: 0.85, summary: '老大在山东临沂' },
    { id: 'KN-FACT-001', kind: 'fact', tier: 'knowledge', importance: 0.7, summary: '中文回复详细+技术说明先结构图示' },
    { id: 'WK-TASK-001', kind: 'task', tier: 'working', importance: 0.6, summary: '当前调研 ERP 财务模块' },
  ]
  const r = formatRecall(entries, [], { recallMaxChars: 1500 })
  // identity 不应出现在 recall block（已在 identity card）
  assert.ok(!r.text.includes('ID-ID-001'), 'identity tier 不应注入 recall block')
  assert.ok(r.text.includes('KN-FACT-001'), 'knowledge tier 应注入')
  assert.ok(r.text.includes('WK-TASK-001'), 'working tier score 够高时应注入')
})

test('formatRecall：working tier score 低时不注入', async () => {
  const { formatRecall } = await import('../src/inject.js')
  const entries = [
    { id: 'a', kind: 'task', tier: 'working', importance: 0.6, summary: '弱相关 task', score: 0.3 },
  ]
  const r = formatRecall(entries, [], { recallMaxChars: 1500 })
  assert.equal(r.text, '', 'working tier score<0.5 应被过滤')
})

test('listMemories：tier 过滤', () => {
  upsertMemory(db, { kind: 'profile', scope: 'global', content: 'i1' })
  upsertMemory(db, { kind: 'fact', scope: 'global', content: 'k1' })
  upsertMemory(db, { kind: 'task', scope: 'global', content: 'w1' })
  const identities = listMemories(db, { tier: 'identity', status: 'active', limit: 10 })
  const knowledge = listMemories(db, { tier: 'knowledge', status: 'active', limit: 10 })
  const working = listMemories(db, { tier: 'working', status: 'active', limit: 10 })
  assert.ok(identities.every((m) => m.tier === 'identity'))
  assert.ok(knowledge.every((m) => m.tier === 'knowledge'))
  assert.ok(working.every((m) => m.tier === 'working'))
  assert.ok(identities.length >= 1)
  assert.ok(knowledge.length >= 1)
  assert.ok(working.length >= 1)
})

test('buildIdentityCard：用 tier=identity 而不是 kind=profile', async () => {
  const { buildIdentityCard } = await import('../src/inject.js')
  upsertMemory(db, { kind: 'profile', scope: 'global', content: '老大住在临沂', importance: 0.9 })
  upsertMemory(db, { kind: 'fact', scope: 'global', content: '山东临沂是中国涂料产业集中地', importance: 0.9 })
  const card = buildIdentityCard(db, { projectId: null, branch: null, label: null }, { identityMaxChars: 1500, identityMaxEntries: 5 })
  assert.ok(card.includes('临沂'), 'identity card 应包含 profile 记忆')
  assert.ok(!card.includes('涂料产业'), 'identity card 不应包含 knowledge fact（避免污染）')
})

// ─── messages retention (item 1) ───────────────────────────────

test('cleanupExtractedMessages：删除 extracted=1 且超过 retention 天', () => {
  // 灌 5 条：3 条 extracted=1 老 + 2 条 extracted=0
  for (let i = 0; i < 3; i++) {
    const old = Date.now() - 60 * 86400 * 1000
    db.prepare(`
      INSERT INTO messages (id, session_id, seq, turn_index, role, content, extracted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(`m-old-${i}`, 's1', i, i, 'user', `old-${i}`, old)
  }
  for (let i = 0; i < 2; i++) {
    db.prepare(`
      INSERT INTO messages (id, session_id, seq, turn_index, role, content, extracted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(`m-new-${i}`, 's1', 10 + i, 10 + i, 'user', `new-${i}`, Date.now())
  }
  const r = cleanupExtractedMessages(db, { retentionDays: 30 })
  assert.equal(r.deleted, 3, '应删 3 条 extracted=1 老消息')
  const remaining = db.prepare('SELECT id, extracted FROM messages').all()
  const newRemaining = remaining.filter((m) => m.id.startsWith('m-new-'))
  assert.ok(newRemaining.length === 2, 'extracted=0 永远不删')
})

test('cleanupExtractedMessages：30 天内的 extracted=1 不删', () => {
  db.prepare(`
    INSERT INTO messages (id, session_id, seq, turn_index, role, content, extracted, created_at)
    VALUES ('m-recent', 's1', 1, 1, 'user', 'recent', 1, ?)
  `).run(Date.now() - 10 * 86400 * 1000)
  const r = cleanupExtractedMessages(db, { retentionDays: 30 })
  assert.equal(r.deleted, 0, '10 天内的 extracted=1 不该删')
})

// ─── identity fingerprint (item 2) ─────────────────────────

test('computeIdentityFingerprint：内容变化指纹就变', async () => {
  const { createHash } = await import('node:crypto')
  const fp = (await import('../dsh.js')).default // not available; test via internal API path
  // 直接调 SQL 等价逻辑测试
  const compute = () => {
    const rows = db.prepare(`
      SELECT id, importance, summary, updated_at
      FROM memories WHERE tier='identity' AND status='active' ORDER BY id
    `).all()
    const payload = 'project||' + rows.map((r) => `${r.id}:${r.importance}:${r.updated_at}:${r.summary}`).join('|')
    return createHash('sha1').update(payload).digest('hex').slice(0, 16)
  }
  upsertMemory(db, { kind: 'profile', scope: 'global', content: 'v1' })
  const fp1 = compute()
  // 加 1 条 identity
  upsertMemory(db, { kind: 'profile', scope: 'global', content: 'v2' })
  const fp2 = compute()
  assert.notEqual(fp1, fp2, '新增 identity 后指纹应变化')
})

// ─── 化石记忆（item 3）+ Recall reason 记录（item 2） ───────────────────

test('findFossilMemories：列出即将被 decay 的 active 记忆', () => {
  // 造 1 条 80 天前、importance 0.5、从未访问的知识记忆
  const m = upsertMemory(db, { kind: 'fact', scope: 'global', content: '化石测试', importance: 0.5 })
  const old_ms = Date.now() - 80 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, m.memory.id)

  // 1 条 50 天前的（未到 80% 阈值）
  const fresh = upsertMemory(db, { kind: 'fact', scope: 'global', content: '近的', importance: 0.5 })
  const mid_ms = Date.now() - 50 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(mid_ms, mid_ms, fresh.memory.id)

  // 默认 knowledge=90d, threshold=0.8 → 72d 起视为化石
  const fossils = findFossilMemories(db, { tierDays: { knowledge: 90 }, threshold: 0.8 })
  assert.ok(fossils.length >= 1, `应至少 1 条化石，实际 ${fossils.length}`)
  assert.ok(fossils.some((f) => f.id === m.memory.id), '80 天前那条应在化石列表')
  assert.ok(!fossils.some((f) => f.id === fresh.memory.id), '50 天前那条不应在')
  // 化石应带 decayInDays 字段
  assert.ok(fossils[0].decayInDays >= 0)
})

test('findFossilMemories：高 importance 不会被标记为化石', () => {
  const m = upsertMemory(db, { kind: 'fact', scope: 'global', content: '高价值', importance: 0.9 })
  const old_ms = Date.now() - 100 * 86400 * 1000
  db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(old_ms, old_ms, m.memory.id)
  const fossils = findFossilMemories(db, { tierDays: { knowledge: 90 } })
  assert.ok(!fossils.some((f) => f.id === m.memory.id), 'importance 0.9 不应是化石')
})

test('recordRecallReason + getLastRecallReason：记录和读取', () => {
  recordRecallReason(db, '测试 query', ['m-001', 'm-002', 'm-003'])
  const r = getLastRecallReason(db)
  assert.equal(r.lastQuery, '测试 query')
  assert.deepEqual(r.lastTrajectory, [{ id: 'm-001' }, { id: 'm-002' }, { id: 'm-003' }])
  assert.ok(r.lastAt > 0, 'lastAt 应被设')
  // 更新：被覆盖
  recordRecallReason(db, '第二次 query', ['m-100'])
  const r2 = getLastRecallReason(db)
  assert.equal(r2.lastQuery, '第二次 query')
  assert.deepEqual(r2.lastTrajectory, [{ id: 'm-100' }])
  // 边界：空 ids
  recordRecallReason(db, '', [])
  const r3 = getLastRecallReason(db)
  assert.equal(r3.lastQuery, '')
  assert.deepEqual(r3.lastTrajectory, [])
})

test('recordRecallReason：完整 trajectory（score/tier/fromGraph/rank）', () => {
  recordRecallReason(db, 'trajectory test', [
    { id: 'm-A', score: 0.95, importance: 0.9, tier: 'knowledge', fromGraph: false, rank: 1 },
    { id: 'm-B', score: 0.72, importance: 0.6, tier: 'working', fromGraph: true, rank: 2 },
    { id: 'm-C', score: 0.45, importance: 0.85, tier: 'identity', fromGraph: false, rank: 3 },
  ])
  const r = getLastRecallReason(db)
  assert.equal(r.lastQuery, 'trajectory test')
  assert.equal(r.lastTrajectory.length, 3)
  const a = r.lastTrajectory[0]
  assert.equal(a.id, 'm-A')
  assert.equal(a.score, '0.9500')
  assert.equal(a.importance, '0.900')
  assert.equal(a.tier, 'knowledge')
  assert.equal(a.fromGraph, false)
  assert.equal(a.rank, 1)
  const b = r.lastTrajectory[1]
  assert.equal(b.fromGraph, true, 'graph 路径应被标记')
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

// ─── 方案 A: Recall 性能监控 ─────────────────────────────────

test('recordRecallPerf + getRecallPerf：每次写入 last/count/sum/window', () => {
  // 干净初始
  db.prepare("DELETE FROM meta WHERE key IN ('recall.ms.last','recall.ms.count','recall.ms.sum','recall.ms.window')").run()
  recordRecallPerf(db, 12)
  recordRecallPerf(db, 24)
  recordRecallPerf(db, 36)
  const p = getRecallPerf(db)
  assert.equal(p.count, 3)
  assert.equal(p.sum, 72)
  assert.equal(p.last, 36)
  assert.equal(p.avg, 24)
  assert.equal(p.windowSize, 3)
  assert.ok(p.p50 >= 12 && p.p50 <= 36)
  assert.ok(p.p95 >= 12)
})

test('recordRecallPerf：失败不影响主流程（错误 meta 被吞）', () => {
  // 不应抛错
  recordRecallPerf(db, 50)
  recordRecallPerf(db, 100)
  assert.ok(true)
})

test('recall SLA 100ms < 50ms with 200 entries + perf recorded', () => {
  // 灌 200 条
  for (let i = 0; i < 200; i++) {
    upsertMemory(db, {
      kind: 'fact', scope: 'global',
      content: `perf 测试 ${i}：数据库表、API 接口、用户偏好、稳定版本、编程框架、虚拟机`,
      importance: 0.6,
    })
  }
  // 跑 10 次
  const samples = []
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now()
    recall(db, { recallMaxNodes: 6, recallMaxDepth: 1 }, '数据库表 API', {}, null)
    samples.push(Date.now() - t0)
  }
  const max = Math.max(...samples)
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  console.log(`  200 条 recall 平均 ${avg.toFixed(1)}ms, 最大 ${max}ms`)
  // 检查 perf 记录器收集到了
  const p = getRecallPerf(db)
  assert.ok(p.count >= 10, `perf 记录 ≥ 10 次 实际 ${p.count}`)
  assert.ok(max < 50, `200 条 recall 最大 ${max}ms 应 < 50ms`)
})

test.after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
