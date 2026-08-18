/**
 * dsh-dream-memory — 存储与查询层
 *
 * 职责：记忆条目的 upsert/去重/归档、FTS 检索、图边、原始事件、向量。
 * 所有函数同步执行（node:sqlite 同步 API），由 DSH 插件 fiber 串行调用。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { getMeta, setMeta } from './db.js'
export { getMeta, setMeta }

const VALID_KINDS = new Set([
  'profile', 'key', 'log', 'task', 'skill', 'event', 'fact', 'preference', 'decision',
])
const VALID_EDGE_TYPES = new Set([
  'USED_SKILL', 'SOLVED_BY', 'REQUIRES', 'PATCHES', 'CONFLICTS_WITH', 'RELATED',
])

export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

export function projectHash(cwd) {
  if (!cwd) return null
  return createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
}

export function projectLabel(cwd) {
  if (!cwd) return null
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const base = parts[parts.length - 1]
  if (base.length < 3 || /^\d+$/.test(base)) {
    return parts.length > 1 ? parts.slice(-2).join('/') : base
  }
  return base
}

// ─── 项目身份（兼容 dsh-memory-evolve 的记忆同步目录规则） ──
// 有 git 主 remote 的项目用「归一化仓库地址」做跨设备稳定身份；
// 否则回退 sha1(cwd) 前 12 位。这样迁移旧项目目录后仍能在新会话对上号。

function runGit(args, cwd) {
  try {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const out = String(result.stdout ?? '').trim()
    return out === '' ? undefined : out
  } catch {
    return undefined
  }
}

export function normalizeRemoteUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return undefined
  const trimmed = url.trim()
  const isScpLike = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    && !/^[a-zA-Z]:[\\/]/.test(trimmed)
    && /^[^@\s]+@[^:/\s]+:/.test(trimmed)
  if (isScpLike) {
    const host = trimmed.slice(trimmed.indexOf('@') + 1, trimmed.indexOf(':'))
    const path = trimmed.slice(trimmed.indexOf(':') + 1)
    return normalizeUrlCore(`ssh://${host}/${path}`)
  }
  if (/^file:\/\//.test(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return undefined
  }
  return normalizeUrlCore(trimmed)
}

function normalizeUrlCore(input) {
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) return undefined
  let path = parsed.pathname.replace(/\/+$/, '')
  if (path === '') return undefined
  path = path.replace(/\.git$/, '')
  if (path === '') return undefined
  const defaultPort = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' }[parsed.protocol]
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : ''
  return `${parsed.hostname.toLowerCase()}${port}${path}`
}

const gitRemoteCache = new Map() // cwd -> remote url（进程级缓存，避免重复 spawn git）

function mainRemote(cwd) {
  if (gitRemoteCache.has(cwd)) return gitRemoteCache.get(cwd)
  const url = runGit(['remote', 'get-url', 'origin'], cwd) ?? runGit(['config', '--get', 'remote.origin.url'], cwd)
  if (url) {
    gitRemoteCache.set(cwd, url)
    return url
  }
  const names = runGit(['remote'], cwd) ?? ''
  const first = names.split('\n').map((n) => n.trim()).filter(Boolean)[0]
  if (!first) {
    gitRemoteCache.set(cwd, undefined)
    return undefined
  }
  const result = runGit(['remote', 'get-url', first], cwd) ?? runGit(['config', '--get', `remote.${first}.url`], cwd)
  gitRemoteCache.set(cwd, result)
  return result
}

export function resolveProjectId(cwd) {
  if (!cwd) return { id: null, kind: 'none', displayName: null }
  const remoteUrl = mainRemote(cwd)
  const key = remoteUrl ? normalizeRemoteUrl(remoteUrl) : undefined
  if (key) {
    return {
      id: createHash('sha1').update(key).digest('hex').slice(0, 12),
      kind: 'remote',
      displayName: projectLabel(cwd) ?? key,
      key,
    }
  }
  return { id: projectHash(cwd), kind: 'fallback', displayName: projectLabel(cwd) ?? String(cwd), key: null }
}

/**
 * 内容哈希包含作用域维度：同一句话记在不同项目里不算重复。
 */
export function contentHashFor({ kind, scope, projectId, branch, content }) {
  const base = [kind ?? 'fact', scope ?? 'global', projectId ?? '', branch ?? '', String(content ?? '')].join('\u0001')
  return createHash('sha1').update(base).digest('hex')
}

export function toMemory(row) {
  if (!row) return null
  return {
    ...row,
    sourceRefs: safeJson(row.source_refs, []),
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    validatedCount: Number(row.validated_count),
    pagerank: Number(row.pagerank),
    accessCount: Number(row.access_count),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_accessed_at: row.last_accessed_at == null ? null : Number(row.last_accessed_at),
  }
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function autoSummary(content, maxLen = 80) {
  const text = String(content ?? '').trim()
  if (!text) return ''
  const first = text.split('\n')[0].trim()
  return first.length <= maxLen ? first : first.slice(0, maxLen - 1) + '…'
}

/**
 * upsert 一条记忆。
 * 去重优先级：content_hash 精确匹配 > 同 kind+scope 下 name 规范化匹配。
 * 命中已有条目时合并来源、保留更长内容，并 validated_count+1。
 */
export function upsertMemory(db, candidate, { sessionRef = null } = {}) {
  if (!VALID_KINDS.has(candidate.kind)) {
    throw new Error(`dsh-dream-memory: 非法 kind: ${candidate.kind}`)
  }
  const scope = candidate.scope ?? 'global'
  const projectId = candidate.projectId ?? (scope.startsWith('project:') ? scope.slice('project:'.length) : null)
  const content = String(candidate.content ?? '').trim()
  if (!content) throw new Error('dsh-dream-memory: 记忆内容不能为空')

  const name = candidate.name ? normalizeName(candidate.name) : null
  const summary = String(candidate.summary ?? '').trim() || autoSummary(content)
  const contentHash = contentHashFor({ kind: candidate.kind, scope, projectId, branch: candidate.branch ?? null, content })

  let existing = db.prepare('SELECT * FROM memories WHERE content_hash=?').get(contentHash)
  if (!existing && name) {
    existing = db.prepare(
      'SELECT * FROM memories WHERE kind=? AND scope=? AND name=? AND status IN (?,?) LIMIT 1',
    ).get(candidate.kind, scope, name, 'active', 'candidate')
  }

  const now = Date.now()
  if (existing) {
    const refs = Array.from(new Set([...safeJson(existing.source_refs, []), ...(candidate.sourceRefs ?? []), ...(sessionRef ? [sessionRef] : [])]))
    const merged = {
      content: content.length >= String(existing.content).length ? content : existing.content,
      summary: summary.length >= String(existing.summary).length ? summary : existing.summary,
      importance: Math.max(Number(existing.importance), Number(candidate.importance ?? 0.5)),
      confidence: Math.min(1, Math.max(0, Number(candidate.confidence ?? existing.confidence))),
      validatedCount: Number(existing.validated_count) + 1,
      status: candidate.status ?? existing.status,
    }
    db.prepare(`
      UPDATE memories SET content=?, summary=?, importance=?, confidence=?,
        validated_count=?, status=?, source_refs=?, updated_at=?
      WHERE id=?
    `).run(merged.content, merged.summary, merged.importance, merged.confidence,
      merged.validatedCount, merged.status, JSON.stringify(refs), now, existing.id)
    return { memory: toMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(existing.id)), isNew: false }
  }

  const id = uid('m')
  const refs = Array.from(new Set([...(candidate.sourceRefs ?? []), ...(sessionRef ? [sessionRef] : [])]))
  db.prepare(`
    INSERT INTO memories (id, kind, layer, scope, project_id, project_label, branch, name,
      summary, content, importance, confidence, status, validated_count, content_hash,
      source_refs, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    candidate.kind,
    Number.isInteger(candidate.layer) ? candidate.layer : 1,
    scope,
    projectId,
    candidate.projectLabel ?? null,
    candidate.branch ?? null,
    name,
    summary,
    content,
    Number(candidate.importance ?? 0.5),
    Number(candidate.confidence ?? 1),
    candidate.status ?? 'active',
    1,
    contentHash,
    JSON.stringify(refs),
    candidate.createdAt ?? now,
    now,
  )
  return { memory: toMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(id)), isNew: true }
}

export function getMemory(db, id) {
  return toMemory(db.prepare('SELECT * FROM memories WHERE id=?').get(id))
}

export function setStatus(db, id, status) {
  db.prepare('UPDATE memories SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), id)
  return getMemory(db, id)
}

export function archiveMemory(db, id) {
  return setStatus(db, id, 'archived')
}

export function touchMemory(db, id) {
  db.prepare('UPDATE memories SET access_count=access_count+1, last_accessed_at=? WHERE id=?')
    .run(Date.now(), id)
}

export function listMemories(db, { kind, scope, status = 'active', projectId, limit = 50, since, until, filter, recent = false } = {}) {
  const where = []
  const args = []
  if (kind) { where.push('kind=?'); args.push(kind) }
  if (scope) { where.push('scope=?'); args.push(scope) }
  if (projectId) { where.push('project_id=?'); args.push(projectId) }
  if (status) { where.push('status=?'); args.push(status) }
  if (since != null) { where.push('created_at>=?'); args.push(since) }
  if (until != null) { where.push('created_at<=?'); args.push(until) }
  if (filter) { where.push('(content LIKE ? OR summary LIKE ? OR name LIKE ?)'); const like = `%${filter}%`; args.push(like, like, like) }
  const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${recent ? 'created_at DESC' : 'importance DESC, created_at DESC'} LIMIT ?`
  return db.prepare(sql).all(...args, Math.max(1, Math.min(500, Number(limit) || 50))).map(toMemory)
}

export function findByName(db, name, { kind = null, scope = null } = {}) {
  const n = normalizeName(name)
  if (!n) return null
  if (kind && scope) {
    return toMemory(db.prepare('SELECT * FROM memories WHERE name=? AND kind=? AND scope=? LIMIT 1').get(n, kind, scope))
  }
  if (kind) return toMemory(db.prepare('SELECT * FROM memories WHERE name=? AND kind=? LIMIT 1').get(n, kind))
  return toMemory(db.prepare('SELECT * FROM memories WHERE name=? LIMIT 1').get(n))
}

// ─── FTS / LIKE 检索 ──────────────────────────────────────────

function scopeClause(scopeIds) {
  const ids = ['global', ...new Set((scopeIds ?? []).map((s) => String(s)))]
  return { sql: `(${ids.map(() => '?').join(',')})`, args: ids }
}

export function searchMemories(db, query, { scopeIds = [], limit = 30, includeLogs = false } = {}) {
  const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8)
  const scope = scopeClause(scopeIds)
  const kindFilter = includeLogs ? '' : "AND m.kind != 'log'"

  if (!terms.length) {
    return db.prepare(`
      SELECT m.* FROM memories m
      WHERE m.status='active' AND m.scope IN ${scope.sql} ${kindFilter}
      ORDER BY m.importance DESC, m.validated_count DESC, m.updated_at DESC
      LIMIT ?
    `).all(...scope.args, limit).map((r) => ({ memory: toMemory(r), rank: 100, score: 0 }))
  }

  if (getMeta(db, 'fts_mode') && getMeta(db, 'fts_mode') !== 'none') {
    try {
      const ftsQuery = terms.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ')
      const rows = db.prepare(`
        SELECT m.*, rank FROM mem_fts f
        JOIN memories m ON m.rowid = f.rowid
        WHERE mem_fts MATCH ? AND m.status='active' AND m.scope IN ${scope.sql} ${kindFilter}
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, ...scope.args, limit)
      if (rows.length) return rows.map((r) => ({ memory: toMemory(r), rank: r.rank, score: 0 }))
    } catch {
      // FTS query failed -> LIKE fallback below
    }
  }

  const likeWhere = terms.map(() => '(name LIKE ? OR summary LIKE ? OR content LIKE ?)').join(' OR ')
  const likeArgs = terms.flatMap((t) => { const p = `%${t}%`; return [p, p, p] })
  return db.prepare(`
    SELECT * FROM memories m
    WHERE m.status='active' AND m.scope IN ${scope.sql} ${kindFilter} AND (${likeWhere})
    ORDER BY m.importance DESC, m.validated_count DESC, m.updated_at DESC LIMIT ?
  `).all(...scope.args, ...likeArgs, limit).map((r, i) => ({ memory: toMemory(r), rank: i + 1, score: 0 }))
}

// ─── 知识图谱边 ────────────────────────────────────────────────

export function upsertLink(db, { fromId, toId, type, instruction = '', condition, weight = 1 }) {
  if (!VALID_EDGE_TYPES.has(type)) throw new Error(`dsh-dream-memory: 非法边类型 ${type}`)
  if (!fromId || !toId || fromId === toId) return null
  const existing = db.prepare('SELECT * FROM links WHERE from_id=? AND to_id=? AND type=?').get(fromId, toId, type)
  if (existing) {
    db.prepare('UPDATE links SET instruction=?, condition=?, weight=?, created_at=? WHERE from_id=? AND to_id=? AND type=?')
      .run(String(instruction ?? existing.instruction), condition ?? existing.condition, Number(weight ?? existing.weight), Date.now(), fromId, toId, type)
    return db.prepare('SELECT * FROM links WHERE from_id=? AND to_id=? AND type=?').get(fromId, toId, type)
  }
  db.prepare('INSERT INTO links (from_id, to_id, type, instruction, condition, weight, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(fromId, toId, type, String(instruction ?? ''), condition ?? null, Number(weight ?? 1), Date.now())
  return db.prepare('SELECT * FROM links WHERE from_id=? AND to_id=? AND type=?').get(fromId, toId, type)
}

export function linksFor(db, id) {
  return db.prepare('SELECT * FROM links WHERE from_id=? OR to_id=?').all(id, id)
}

export function edgesBetween(db, ids) {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`
    SELECT * FROM links WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
  `).all(...ids, ...ids)
}

/**
 * 从种子节点沿图扩一跳（默认深度 1）。
 * 优先尝试递归 CTE；SQLite 构建不支持时退化为 JS 邻居扩展。
 */
export function graphWalk(db, seedIds, maxDepth = 1) {
  if (!seedIds.length) return []
  try {
    const placeholders = seedIds.map(() => '?').join(',')
    const rows = db.prepare(`
      WITH RECURSIVE walk(node_id, depth) AS (
        SELECT id, 0 FROM memories WHERE id IN (${placeholders}) AND status='active'
        UNION
        SELECT CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END, w.depth + 1
        FROM walk w
        JOIN links e ON (e.from_id = w.node_id OR e.to_id = w.node_id)
        WHERE w.depth < ?
      )
      SELECT DISTINCT node_id FROM walk
    `).all(...seedIds, maxDepth)
    return rows.map((r) => r.node_id)
  } catch {
    const seen = new Set(seedIds)
    const queue = [...seedIds]
    for (let depth = 0; depth < maxDepth && queue.length; depth++) {
      const current = queue.splice(0, queue.length)
      for (const id of current) {
        for (const edge of linksFor(db, id)) {
          const peer = edge.from_id === id ? edge.to_id : edge.from_id
          if (!seen.has(peer)) {
            seen.add(peer)
            queue.push(peer)
          }
        }
      }
    }
    return [...seen]
  }
}

/**
 * 与当前项目显式 RELATED 的其他项目 id（跨项目记忆复用）。
 */
export function relatedProjectIds(db, projectId) {
  if (!projectId) return []
  const rows = db.prepare(`
    SELECT DISTINCT m2.project_id AS pid FROM links e
    JOIN memories m1 ON m1.id = e.from_id
    JOIN memories m2 ON m2.id = e.to_id
    WHERE e.type='RELATED' AND m1.project_id=? AND m2.project_id IS NOT NULL AND m2.project_id != ?
  `).all(projectId, projectId)
  return rows.map((r) => r.pid).filter(Boolean)
}

// ─── 原始事件（供梦境增量抽取） ───────────────────────────────

export function saveMessageOnce(db, id, sessionId, seq, turnIndex, role, content) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, seq, turn_index, role, content, extracted, created_at)
    VALUES (?,?,?,?,?,?,0,?)
  `).run(id, sessionId, Number(seq), Number(turnIndex), role, String(content ?? ''), Date.now())
  return result.changes > 0
}

export function getUnextracted(db, limit = 50) {
  return db.prepare('SELECT * FROM messages WHERE extracted=0 ORDER BY seq LIMIT ?').all(limit)
}

export function markExtracted(db, upToSeq) {
  db.prepare('UPDATE messages SET extracted=1 WHERE seq<=?').run(Number(upToSeq))
}

export function latestMessageSeq(db) {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM messages').get()
  return Number(row?.seq ?? 0)
}

// ─── 向量（可选） ─────────────────────────────────────────────

export function saveVector(db, memoryId, contentHash, embedding) {
  db.prepare(`
    INSERT INTO vectors (memory_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(memory_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding
  `).run(memoryId, contentHash, Buffer.from(new Float32Array(embedding).buffer))
}

export function getVector(db, memoryId) {
  const row = db.prepare('SELECT embedding FROM vectors WHERE memory_id=?').get(memoryId)
  if (!row?.embedding) return null
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
}

export function getVectorsFor(db, memoryIds) {
  if (!memoryIds.length) return []
  const placeholders = memoryIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT memory_id, embedding FROM vectors WHERE memory_id IN (${placeholders})`).all(...memoryIds)
  return rows.map((r) => ({
    memoryId: r.memory_id,
    vector: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  }))
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return Number.NEGATIVE_INFINITY
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9)
}

// ─── 统计 ─────────────────────────────────────────────────────

export function getStats(db) {
  const byKind = {}
  for (const row of db.prepare('SELECT kind, status, COUNT(*) AS n FROM memories GROUP BY kind, status').all()) {
    byKind[row.kind] = byKind[row.kind] || {}
    byKind[row.kind][row.status] = row.n
  }
  return {
    total: Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n ?? 0),
    active: Number(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status='active'").get().n ?? 0),
    candidates: Number(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status='candidate'").get().n ?? 0),
    edges: Number(db.prepare('SELECT COUNT(*) AS n FROM links').get().n ?? 0),
    messages: Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n ?? 0),
    vectors: Number(db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n ?? 0),
    ftsMode: getMeta(db, 'fts_mode') ?? 'none',
    byKind,
  }
}

// ─── 记忆质量分析 + 整理（consolidation）────────────────────────────────

// 中文 trigram tokens + 拉丁词 token，复用 dsh.js 里的 jaccard 算法的纯函数版
function isCjkChar(c) {
  return c >= '\u4e00' && c <= '\u9fff'
}
function tokenizeCjk(text) {
  const out = new Set()
  const s = String(text || '').replace(/\s+/g, '')
  for (let i = 0; i < s.length - 2; i++) {
    const g = s.slice(i, i + 3)
    if (isCjkChar(g[0]) && isCjkChar(g[1]) && isCjkChar(g[2])) out.add(g)
  }
  for (const w of String(text || '').match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []) {
    out.add(w.toLowerCase())
  }
  return out
}
function jaccardTokens(a, b) {
  if (!a.size || !b.size) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// 扫描 active 记忆，返回{
//   labels: 候选 label-only（summary 短且不在 content 中）
//   vague:  候选模糊 summary（jaccard < threshold）
//   archives: 当前 status='archived' 数量
// }
export function analyzeMemoryQuality(db, { jaccardThreshold = 0.1, labelMaxLen = 8, kinds = null } = {}) {
  const scope = kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''
  const params = kinds || []
  const rows = db.prepare(`
    SELECT id, kind, name, summary, content, importance
    FROM memories WHERE status='active' ${scope}
  `).all(...params)

  const labels = []
  const vague = []
  for (const r of rows) {
    const summary = r.summary || ''
    const content = r.content || ''
    // label-only：summary 短 + 全 CJK + 不在 content 中
    if (summary.length > 0 && summary.length <= labelMaxLen
        && !/[^\u4e00-\u9fff]/.test(summary)
        && ![...summary].every((ch) => content.includes(ch))) {
      labels.push({ id: r.id, kind: r.kind, summary, reason: 'label-only' })
      continue
    }
    // 模糊：jaccard < threshold 且 summary 非空
    if (summary && content) {
      const j = jaccardTokens(tokenizeCjk(summary), tokenizeCjk(content))
      if (j < jaccardThreshold) {
        vague.push({ id: r.id, kind: r.kind, summary, jaccard: Number(j.toFixed(3)), reason: 'low-jaccard' })
      }
    }
  }
  const archives = db.prepare("SELECT COUNT(*) n FROM memories WHERE status='archived'").get().n
  return { labels, vague, archives, scanned: rows.length }
}

// 把记忆 status 设为 archived（理由写入 source_refs 末尾）
// 与 file 上半的 archiveMemory(db, id) 共存：这个版本带 reason 字段
// 上面的用于兼容旧调用，新 consolidation 走这个
export function archiveMemoryWithReason(db, id, reason = 'manual') {
  const r = db.prepare('SELECT status, source_refs FROM memories WHERE id=?').get(id)
  if (!r) return { ok: false, error: 'not-found' }
  if (r.status === 'archived') return { ok: false, error: 'already-archived' }
  const refs = (() => {
    try { return JSON.parse(r.source_refs || '[]') } catch { return [] }
  })()
  refs.push({ archive: reason, at: Date.now() })
  db.prepare("UPDATE memories SET status='archived', source_refs=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(refs), Date.now(), id)
  return { ok: true }
}

// 重写 summary，保留 content 自带的 content_hash（不变）
export function updateMemorySummary(db, id, newSummary) {
  if (!newSummary || !String(newSummary).trim()) return { ok: false, error: 'empty-summary' }
  const r = db.prepare('SELECT summary FROM memories WHERE id=?').get(id)
  if (!r) return { ok: false, error: 'not-found' }
  db.prepare('UPDATE memories SET summary=?, updated_at=? WHERE id=?')
    .run(String(newSummary).slice(0, 1000), Date.now(), id)
  return { ok: true }
}

// 暴露给 synchronize 也用
export { tokenizeCjk, jaccardTokens, isCjkChar }

// ─── 自动归档（decay）：让库不无限膨胀 ────────────────────────────────

// 规则：创建 N 天 + 从未访问 + importance < 0.7 → 自动归档
//  - 不动 validated_count > 1（被多次重复验证的）
//  - 不动 importance >= 0.7（被认定为重要）
//  - 不动 90 天内新记忆（给 agent 时间消化）
// 含义：默认 0.6 importance 且从没被引用的记忆——这类恰好是数量膨胀的来源，
//      90 天还没被任何场景召回，说明价值低。
export function decayStaleMemories(db, { staleDays = 90, maxBatch = 100, importanceMax = 0.7 } = {}) {
  const cutoff = Date.now() - staleDays * 86400 * 1000
  const stale = db.prepare(`
    SELECT id, kind, importance, validated_count, last_accessed_at,
           (julianday('now') - julianday(created_at/1000, 'unixepoch')) AS age_days
    FROM memories
    WHERE status='active'
      AND importance < ?
      AND validated_count <= 1
      AND last_accessed_at IS NULL
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(importanceMax, cutoff, maxBatch)

  if (stale.length === 0) return { decayed: 0, scanned: 0 }

  const ids = stale.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`
    UPDATE memories SET status='archived', updated_at=?
    WHERE id IN (${placeholders}) AND status='active'
  `).run(Date.now(), ...ids)

  return { decayed: ids.length, scanned: stale.length, ids }
}

// ─── 合并相似记忆（consolidate）：让库保持"高效简洁" ──────────────────

// 找 summary Jaccard > threshold 的对手对，合并为一条
// 合并规则：保留更高的 (importance + access_count + recency)，
//           把另一条的 content 拼到保留条的 content 末尾，归档另一条
export function mergeSimilarMemories(db, { similarityThreshold = 0.5, maxBatch = 50 } = {}) {
  // 一次拉所有 active、kind 相同、有 summary 的记忆（一次 SQL 拉所有，比循环拉 N 次快）
  const rows = db.prepare(`
    SELECT id, kind, summary, content, importance, access_count, last_accessed_at, created_at
    FROM memories
    WHERE status='active' AND summary != ''
    ORDER BY kind, created_at
  `).all()

  const tokenCache = new Map()
  const tokensOf = (s) => {
    if (!tokenCache.has(s)) tokenCache.set(s, tokenizeCjk(s))
    return tokenCache.get(s)
  }

  const score = (r) => {
    const recency = r.last_accessed_at || r.created_at
    return r.importance * 10 + r.access_count + (recency / 1e12)
  }

  const merged = new Set() // 已合并掉的 id
  let mergeCount = 0
  const errors = []

  // 按 kind 分桶防止跨 kind 误合并
  const byKind = new Map()
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, [])
    byKind.get(r.kind).push(r)
  }

  for (const [, list] of byKind) {
    if (mergeCount >= maxBatch) break
    for (let i = 0; i < list.length; i++) {
      if (merged.has(list[i].id)) continue
      const a = list[i]
      const aTokens = tokensOf(a.summary)
      if (!aTokens.size) continue
      for (let j = i + 1; j < list.length; j++) {
        if (merged.has(list[j].id)) continue
        const b = list[j]
        const bTokens = tokensOf(b.summary)
        if (!bTokens.size) continue
        let inter = 0
        for (const t of aTokens) if (bTokens.has(t)) inter++
        const sim = inter / (aTokens.size + bTokens.size - inter)
        if (sim < similarityThreshold) continue

        // 决定保留哪一条
        const aScore = score(a)
        const bScore = score(b)
        const keep = aScore >= bScore ? a : b
        const drop = aScore >= bScore ? b : a

        if (merged.has(keep.id)) break // keep 已被前面合并掉了，跳出 i 循环

        // 拼接 content（去重已有内容）
        const mergedContent = mergeContent(keep.content, drop.content)
        try {
          db.prepare(`
            UPDATE memories SET content=?, updated_at=? WHERE id=?
          `).run(mergedContent, Date.now(), keep.id)
          // 归档另一条
          db.prepare(`
            UPDATE memories SET status='archived', updated_at=? WHERE id=?
          `).run(Date.now(), drop.id)
          merged.add(drop.id)
          mergeCount++
          if (mergeCount >= maxBatch) break
        } catch (err) {
          errors.push(`${drop.id}: ${err?.message ?? err}`)
        }
      }
    }
  }

  return { merged: mergeCount, errors, scanned: rows.length }
}

function mergeContent(a, b) {
  if (!a) return b || ''
  if (!b) return a || ''
  if (a.includes(b.slice(0, 100))) return a
  if (b.includes(a.slice(0, 100))) return b
  // 简单拼接 + 分隔
  return `${a}\n\n---\n\n${b}`
}