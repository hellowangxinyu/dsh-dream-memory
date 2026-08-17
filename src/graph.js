/**
 * dsh-dream-memory — 图算法层
 *
 * 借鉴 graph-memory 的做法：
 *  - 个性化 PageRank：按当前问题命中的种子节点重排候选节点
 *  - Label Propagation：无外部依赖的社区检测，几千节点毫秒级
 */

import { getMemory } from './store.js'

/**
 * 个性化 PageRank（候选子图上的轻量实现）。
 * @returns {Map<string, number>} nodeId -> ppr score
 */
export function personalizedPageRank(db, seedIds, candidateIds, { damping = 0.85, iterations = 20 } = {}) {
  const ids = new Set(candidateIds)
  const adjacency = new Map()
  const incoming = new Map()
  for (const id of ids) {
    adjacency.set(id, [])
    incoming.set(id, [])
  }

  const edgeRows = db.prepare(`
    SELECT from_id, to_id FROM links
    WHERE from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(candidateIds), JSON.stringify(candidateIds))

  for (const edge of edgeRows) {
    if (!ids.has(edge.from_id) || !ids.has(edge.to_id)) continue
    adjacency.get(edge.from_id).push(edge.to_id)
    incoming.get(edge.to_id).push(edge.from_id)
    if (!ids.has(edge.to_id)) ids.add(edge.to_id)
    if (!ids.has(edge.from_id)) ids.add(edge.from_id)
  }

  const n = ids.size
  if (n === 0) return new Map()
  let scores = new Map()
  for (const id of ids) scores.set(id, 1 / n)

  const seed = new Set(seedIds)
  const seedIdsInGraph = [...ids].filter((id) => seed.has(id))
  const alpha = seedIdsInGraph.length ? 0.6 : 0 // 有种子时做个性化，无种子退化为均匀

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map()
    for (const id of ids) {
      let rank = (1 - damping) / n
      if (alpha > 0 && seed.has(id)) rank += alpha / seedIdsInGraph.length
      const neighbors = incoming.get(id) ?? []
      for (const src of neighbors) {
        const out = adjacency.get(src) ?? []
        if (out.length > 0) rank += damping * (scores.get(src) ?? 0) / out.length
      }
      next.set(id, rank)
    }
    scores = next
  }
  return scores
}

/**
 * 对全图计算 PageRank 并写回 memories.pagerank。
 */
export function computeGlobalPageRank(db, { damping = 0.85, iterations = 20 } = {}) {
  const nodes = db.prepare("SELECT id FROM memories WHERE status='active'").all().map((r) => r.id)
  if (nodes.length === 0) return new Map()
  const ids = new Set(nodes)
  const incoming = new Map(nodes.map((id) => [id, []]))
  const outDegree = new Map(nodes.map((id) => [id, 0]))

  const edges = db.prepare('SELECT from_id, to_id FROM links').all()
  for (const edge of edges) {
    if (!ids.has(edge.from_id) || !ids.has(edge.to_id)) continue
    incoming.get(edge.to_id).push(edge.from_id)
    outDegree.set(edge.from_id, outDegree.get(edge.from_id) + 1)
  }

  const n = nodes.length
  let scores = new Map(nodes.map((id) => [id, 1 / n]))
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map()
    for (const id of nodes) {
      let rank = (1 - damping) / n
      for (const src of incoming.get(id) ?? []) {
        rank += damping * (scores.get(src) ?? 0) / Math.max(1, outDegree.get(src) ?? 1)
      }
      next.set(id, rank)
    }
    scores = next
  }

  const stmt = db.prepare('UPDATE memories SET pagerank=? WHERE id=?')
  db.exec('BEGIN')
  try {
    for (const [id, score] of scores) stmt.run(score, id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return scores
}

/**
 * Label Propagation 社区检测，写回 memories.community_id。
 * 社区编号按成员数排序（c-1 为最大社区）。
 */
export function detectCommunities(db, { maxIter = 50 } = {}) {
  const nodes = db.prepare("SELECT id FROM memories WHERE status='active'").all().map((r) => r.id)
  if (nodes.length === 0) return { communities: new Map(), count: 0 }
  const ids = new Set(nodes)
  const adjacency = new Map(nodes.map((id) => [id, []]))

  for (const edge of db.prepare('SELECT from_id, to_id FROM links').all()) {
    if (!ids.has(edge.from_id) || !ids.has(edge.to_id)) continue
    adjacency.get(edge.from_id).push(edge.to_id)
    adjacency.get(edge.to_id).push(edge.from_id)
  }

  const label = new Map(nodes.map((id) => [id, id]))
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    const shuffled = [...nodes]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    for (const id of shuffled) {
      const neighbors = adjacency.get(id) ?? []
      if (!neighbors.length) continue
      const freq = new Map()
      for (const nb of neighbors) {
        const l = label.get(nb)
        freq.set(l, (freq.get(l) ?? 0) + 1)
      }
      let bestLabel = label.get(id)
      let bestCount = 0
      for (const [l, c] of freq) {
        if (c > bestCount || (c === bestCount && l < bestLabel)) {
          bestLabel = l
          bestCount = c
        }
      }
      if (label.get(id) !== bestLabel) {
        label.set(id, bestLabel)
        changed = true
      }
    }
    if (!changed) break
  }

  const communities = new Map()
  for (const [id, communityId] of label) {
    if (!communities.has(communityId)) communities.set(communityId, [])
    communities.get(communityId).push(id)
  }
  const sorted = [...communities.entries()].sort((a, b) => b[1].length - a[1].length)
  const rename = new Map()
  sorted.forEach(([old], i) => rename.set(old, `c-${i + 1}`))

  const stmt = db.prepare('UPDATE memories SET community_id=? WHERE id=?')
  db.exec('BEGIN')
  try {
    for (const [id, oldLabel] of label) stmt.run(rename.get(oldLabel) ?? oldLabel, id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { communities: sorted, count: sorted.length }
}

export function getCommunityPeers(db, memoryId, limit = 3) {
  const mem = getMemory(db, memoryId)
  if (!mem?.communityId) return []
  return db.prepare(`
    SELECT id FROM memories
    WHERE community_id=? AND id != ? AND status='active'
    ORDER BY validated_count DESC, updated_at DESC LIMIT ?
  `).all(mem.communityId, memoryId, limit).map((r) => r.id)
}
