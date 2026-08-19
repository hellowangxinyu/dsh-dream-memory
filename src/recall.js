/**
 * dsh-dream-memory — 混合召回
 *
 * 通道：FTS5（trigram，中文可靠）→ 向量（可选）→ 图邻居扩展 → 重排序。
 * 只召回相关局部子图，永不加载整个记忆库。
 */

import {
  searchMemories,
  graphWalk,
  edgesBetween,
  relatedProjectIds,
  getVectorsFor,
  cosine,
  touchMemory,
  recordRecallPerf,
  recordRecallReason,
} from './store.js'
import { personalizedPageRank } from './graph.js'

const DEFAULT_WEIGHTS = {
  semantic: 0.35,
  lexical: 0.30,
  recency: 0.15,
  importance: 0.10,
  confidence: 0.10,
}

/**
 * @param {object} scopeInfo { projectId, branch }
 * @returns {string[]} 当前会话可见的作用域：global + 当前项目 + 显式关联项目
 */
export function visibleScopes(db, scopeInfo = {}) {
  const scopes = ['global']
  if (scopeInfo.projectId) {
    scopes.push(`project:${scopeInfo.projectId}`)
    for (const pid of relatedProjectIds(db, scopeInfo.projectId)) scopes.push(`project:${pid}`)
  }
  return scopes
}

function branchVisible(memory, branch) {
  if (!memory.branch) return true // 无标记 = 全部分支可见
  if (!branch) return true // 非 git 场景退化为全部
  return memory.branch.split(',').map((b) => b.trim()).includes(branch)
}

/**
 * 计算一条候选记忆的召回得分。
 */
function scoreMemory(memory, { rankIndex, vectorScore, pprScore, now, branch }) {
  const ageDays = (now - memory.updated_at) / 86400000
  const lexical = 1 / (1 + Math.max(0, rankIndex)) // FTS rank 越靠前越高
  const semantic = vectorScore == null ? 0 : Math.max(0, vectorScore)
  const recency = memory.kind === 'event' || memory.kind === 'log'
    ? Math.exp(-ageDays / 30)
    : 0.5 + 0.5 * Math.exp(-ageDays / 180)
  const graph = Math.min(1, (pprScore ?? 0) * 10)
  const scopeBoost = memory.scope === 'global' ? 0.02 : 0.05

  const score =
    DEFAULT_WEIGHTS.semantic * semantic +
    DEFAULT_WEIGHTS.lexical * lexical +
    DEFAULT_WEIGHTS.recency * recency +
    DEFAULT_WEIGHTS.importance * Math.min(1, Math.max(0, memory.importance)) +
    DEFAULT_WEIGHTS.confidence * Math.min(1, Math.max(0, memory.confidence)) +
    graph * 0.05 +
    scopeBoost

  return { score, lexical, semantic, recency, graph }
}

/**
 * 召回入口。
 * @param {object} cfg { recallMaxNodes, recallMaxDepth }
 * @param {string} query 用户消息文本
 * @param {object} scopeInfo { projectId, branch, label }
 * @param {Function|null} embedFn async (text) => Float32Array
 * @returns {Promise<{entries: object[], edges: object[], tokens: number, topScore: number}>}
 */
export async function recall(db, cfg, query, scopeInfo = {}, embedFn = null) {
  const _t0 = Date.now()
  const limit = Math.max(1, Number(cfg.recallMaxNodes ?? 6))
  const depth = Math.max(0, Number(cfg.recallMaxDepth ?? 1))
  const scopes = visibleScopes(db, scopeInfo)
  const now = Date.now()

  // 1) 词法召回（FTS 或 LIKE）
  const lexicalHits = searchMemories(db, query, {
    scopeIds: scopes,
    limit: Math.max(limit * 8, 30),
    includeLogs: cfg.includeLogs === true,
  }).filter((hit) => branchVisible(hit.memory, scopeInfo.branch))

  // 2) 可选语义召回：只在词法候选上算向量（省内存、免全库扫描）
  let queryVector = null
  if (embedFn) {
    try {
      queryVector = await embedFn(query)
    } catch {
      queryVector = null
    }
  }
  const vectorScores = new Map()
  if (queryVector && lexicalHits.length) {
    for (const v of getVectorsFor(db, lexicalHits.map((h) => h.memory.id))) {
      const sim = cosine(queryVector, v.vector)
      if (sim > 0) vectorScores.set(v.memoryId, sim)
    }
  }

  // 3) 图扩展：命中节点沿边扩一跳，拿到局部子图
  const seedIds = lexicalHits.slice(0, limit * 3).map((h) => h.memory.id)
  const expandedIds = graphWalk(db, seedIds, depth)
  const candidateIds = [...new Set([...seedIds, ...expandedIds])]

  let ppr = new Map()
  if (expandedIds.length > seedIds.length) {
    try {
      ppr = personalizedPageRank(db, seedIds, candidateIds)
    } catch {
      ppr = new Map()
    }
  }

  const idSet = new Set(candidateIds)
  const candidates = lexicalHits.map((hit) => hit.memory)
  for (const id of expandedIds) {
    if (!idSet.has(id)) continue
    if (candidates.some((m) => m.id === id)) continue
    const row = db.prepare("SELECT * FROM memories WHERE id=? AND status='active'").get(id)
    if (row) candidates.push({ ...row, sourceRefs: safeJson(row.source_refs, []), pagerank: Number(row.pagerank) })
  }

  // 4) 重排序
  const scored = candidates.map((memory, index) => {
    const s = scoreMemory(memory, {
      rankIndex: index,
      vectorScore: vectorScores.get(memory.id) ?? null,
      pprScore: ppr.get(memory.id) ?? 0,
      now,
      branch: scopeInfo.branch,
    })
    return { memory, ...s }
  }).sort((a, b) => b.score - a.score)

  const selected = scored.slice(0, limit)
  const selectedIds = new Set(selected.map((s) => s.memory.id))
  const edges = edgesBetween(db, [...selectedIds]).filter(
    (e) => selectedIds.has(e.from_id) && selectedIds.has(e.to_id),
  )

  const tokens = selected.reduce((sum, s) => sum + Math.ceil((s.memory.summary.length + 24) / 3), 0)

  // 性能监控（方案 A）：0.5ms 开销，方便 debug 趋势
  recordRecallPerf(db, Date.now() - _t0)
  // Recall reason 记录（debug "为什么召回到这些"）：0 token
  recordRecallReason(db, query, selected.map((s) => s.memory.id))

  return {
    entries: selected.map((s) => s.memory),
    edges,
    tokens,
    topScore: selected.length ? selected[0].score : 0,
    scores: selected.map((s) => s.score),
  }
}

function safeJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

/**
 * 标记召回命中为“已访问”，用于遗忘衰减与统计。
 */
export function markAccessed(db, entries) {
  for (const entry of entries) touchMemory(db, entry.id)
}
