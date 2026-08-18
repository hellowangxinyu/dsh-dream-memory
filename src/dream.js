/**
 * dsh-dream-memory — 梦境整理（异步增量抽取）
 *
 * 借鉴 OpenClaw dream + graph-memory extractor：
 *  - 只处理上次梦境之后的新事件（dream_cursor 之后的 messages）
 *  - 独立 LLM 调用，输入/输出都有上限，不挤占对话上下文
 *  - 输出严格 JSON，落库前做 schema/边方向校验
 */

import { uid, normalizeName, upsertMemory, upsertLink, findByName, getMeta, setMeta, decayStaleMemories } from './store.js'
import { getUnextracted, markExtracted, listMemories } from './store.js'
import { computeGlobalPageRank, detectCommunities } from './graph.js'

const NODE_KINDS = new Set(['TASK', 'SKILL', 'EVENT', 'FACT', 'PREFERENCE', 'DECISION'])
const EDGE_TYPES = new Set(['USED_SKILL', 'SOLVED_BY', 'REQUIRES', 'PATCHES', 'CONFLICTS_WITH', 'RELATED'])
const EDGE_FROM = {
  USED_SKILL: new Set(['TASK']),
  SOLVED_BY: new Set(['EVENT', 'SKILL', 'TASK']),
  REQUIRES: new Set(['SKILL']),
  PATCHES: new Set(['SKILL', 'FACT', 'DECISION']),
  CONFLICTS_WITH: new Set(['SKILL', 'FACT']),
  RELATED: new Set(['TASK', 'SKILL', 'EVENT', 'FACT', 'PREFERENCE', 'DECISION']),
}
const EDGE_TO = {
  USED_SKILL: new Set(['SKILL']),
  SOLVED_BY: new Set(['SKILL']),
  REQUIRES: new Set(['SKILL']),
  PATCHES: new Set(['SKILL', 'FACT', 'DECISION']),
  CONFLICTS_WITH: new Set(['SKILL', 'FACT']),
  RELATED: new Set(['TASK', 'SKILL', 'EVENT', 'FACT', 'PREFERENCE', 'DECISION']),
}

const EXTRACT_SYS = `你是 dsh-dream-memory 的梦境整理引擎，从 AI Agent 对话中提炼可复用的长期记忆。
这些记忆将在未来的对话中被按需召回。你看到的只是增量事件卡片，不是全部历史。

输出严格 JSON：{"nodes":[...],"edges":[...]}，不要任何额外文字。

1. 节点类型（type 只允许这 6 个）：
   - TASK：用户要求完成的任务或讨论/分析/对比的主题
   - SKILL：可复用的方法，有具体工具/命令/API、触发条件和可执行步骤
   - EVENT：报错、踩坑、一次性事件，记录现象、原因、解决
   - FACT：稳定的环境/技术事实（会跨会话长期成立）
   - PREFERENCE：用户的稳定偏好或工作习惯（需明显、非单次偶发）
   - DECISION：用户拍板或双方确认的决策
2. 节点字段（缺一不可）：
   { "type": "...", "name": "kebab-case 规范名，全小写，可含中文", "description": "一句话触发场景", "content": "按类型用纯文本模板写清楚，≤300字" }
   已有节点列表会给出，同一事物必须复用已有 name，不得创建重复节点。
   description 必须是「可被中文 trigram FTS 命中」的具体词组合，禁止：
   - 抽象标题（如「持久性优先」「中文优先」单独使用，无具体名词）
   - 2 字以下的主题词（如「偏好」「习惯」会被判定为标签型记忆）
   - 不出现在 content 中的关键词
   自检：写完 description 后，用 description 做 query 能否召回本条 content？若不能，重写。
3. 边类型（只允许这 6 个，且遵守方向）：
   USED_SKILL: TASK -> SKILL（任务用了某技能）
   SOLVED_BY: EVENT|SKILL|TASK -> SKILL（问题被某技能解决）
   REQUIRES: SKILL -> SKILL（技能前置依赖）
   PATCHES: SKILL|FACT|DECISION -> SKILL|FACT|DECISION（新修正旧）
   CONFLICTS_WITH: SKILL|FACT -> SKILL|FACT（互斥/矛盾）
   RELATED: 任意 -> 任意（跨主题/跨项目关联）
   边字段：{"from":"节点name","to":"节点name","type":"...","instruction":"具体可执行说明","condition":"可选触发条件"}
4. 纪律（宁缺毋滥）：
   - 禁止记录密钥、token、密码等敏感信息
   - 禁止记录一次性寒暄、纯聊天、代码现状描述（代码会变）
   - PREFERENCE 需要明确信号才记录；可疑的写 FACT 并把 importance 调低
   - 没有知识产出就输出 {"nodes":[],"edges":[]}
   - 每类节点最多 8 条，边最多 12 条，优先级：可复用 > 重要 > 新
5. 只返回 JSON。禁止 markdown 代码块、禁止解释。`;

const EXTRACT_USER = (cards, existingNames, scopeHint) => `<Existing Nodes>
${existingNames.length ? existingNames.slice(0, 200).join(', ') : '（无）'}

<Scope Hint>
${scopeHint || 'global'}

<Event Cards>
${cards}
`;

/**
 * 执行一次梦境。
 * @param {object} db
 * @param {object} cfg { minDreamMessages, dreamEnabled }
 * @param {object} scopeInfo { projectId, label, branch, sessionId }
 * @param {Function} complete (system, user) => Promise<string>
 * @param {Function} [log]
 */
export async function runDream(db, cfg, scopeInfo, complete, log = () => {}) {
  if (cfg.dreamEnabled === false) return { ran: false, reason: 'disabled' }
  const maxCards = Math.max(1, Math.min(50, Number(cfg.dreamMaxCards ?? 20)))
  const rows = getUnextracted(db, maxCards)
  const min = Math.max(1, Number(cfg.minDreamMessages ?? 10))
  if (rows.length < min) return { ran: false, reason: 'not-enough-events' }

  const cards = rows.map((m) => {
    const text = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 500)
    return `[t=${m.turn_index} ${m.role}] ${text}`
  }).join('\n')

  const existing = listMemories(db, { status: 'active', limit: 300 })
    .filter((m) => m.name)
    .map((m) => m.name)

  const scopeHint = scopeInfo.projectId
    ? `project:${scopeInfo.projectId} (${scopeInfo.label ?? ''})${scopeInfo.branch ? ' branch:' + scopeInfo.branch : ''}`
    : 'global'

  const raw = await complete(EXTRACT_SYS, EXTRACT_USER(cards, existing, scopeHint))
  const parsed = parseExtract(raw)
  const now = Date.now()
  const nameToId = new Map()
  let ops = 0

  db.exec('BEGIN')
  try {
    for (const node of parsed.nodes) {
    const kind = node.type.toLowerCase()
    const name = normalizeName(node.name)
    const scope = scopeInfo.projectId ? `project:${scopeInfo.projectId}` : 'global'
    const existingByName = name ? findByName(db, name, { kind, scope }) : null
    if (existingByName) nameToId.set(name, existingByName.id)

    const { memory } = upsertMemory(db, {
      kind,
      layer: kind === 'event' || kind === 'task' ? 1 : 2,
      scope,
      projectId: scopeInfo.projectId ?? null,
      projectLabel: scopeInfo.label ?? null,
      branch: scopeInfo.branch ?? null,
      name: name || null,
      description: node.description ?? '',
      summary: node.description ?? '',
      content: node.content ?? '',
      importance: kind === 'skill' || kind === 'decision' ? 0.8 : 0.6,
      confidence: 0.9,
      status: 'active',
      sourceRefs: scopeInfo.sessionId ? [`session:${scopeInfo.sessionId}`] : [],
      createdAt: now,
    }, { sessionRef: scopeInfo.sessionId ? `session:${scopeInfo.sessionId}` : null })
    nameToId.set(name, memory.id)
    ops++
  }

  for (const edge of parsed.edges) {
    const fromName = normalizeName(edge.from)
    const toName = normalizeName(edge.to)
    if (!fromName || !toName) continue
    const scope = scopeInfo.projectId ? `project:${scopeInfo.projectId}` : 'global'
    const fromType = parsed.nameToType.get(fromName) ?? findByName(db, fromName, { scope })?.kind?.toUpperCase()
    const toType = parsed.nameToType.get(toName) ?? findByName(db, toName, { scope })?.kind?.toUpperCase()
    if (fromType && toType && !edgeAllowed(edge.type, fromType, toType)) continue
    const fromId = nameToId.get(fromName) ?? findByName(db, fromName, { scope })?.id
    const toId = nameToId.get(toName) ?? findByName(db, toName, { scope })?.id
    if (!fromId || !toId) continue
    try {
      upsertLink(db, { fromId, toId, type: edge.type, instruction: edge.instruction, condition: edge.condition })
      ops++
    } catch {
      // skip invalid edge
    }
  }

  const maxSeq = Math.max(...rows.map((r) => r.seq))
  markExtracted(db, maxSeq)
  setMeta(db, 'dream_cursor', String(maxSeq))
  db.prepare('INSERT INTO dreams (id, session_id, cursor_seq, input_cards, ops, tokens, at) VALUES (?,?,?,?,?,?,?)')
    .run(uid('d'), scopeInfo.sessionId ?? null, maxSeq, rows.length, ops, Math.ceil(raw.length / 3), now)

  db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // 图维护（自管事务，放在落库事务之外）：每 3 次梦境重算一次 PageRank + 社区
  const dreamCount = Number(db.prepare('SELECT COUNT(*) AS n FROM dreams').get().n ?? 0)
  if (dreamCount % 3 === 0) {
    try {
      computeGlobalPageRank(db)
      detectCommunities(db)
    } catch (err) {
      log(`graph maintenance failed: ${err?.message ?? err}`)
    }
  }

  // 自动归档（decay）：筛选 — 不让库无限膨胀
  // 0-token 0-LLM：纯 SQL 扫描 + UPDATE
  // 默认开启（cfg.decayEnabled !== false），可在 settings 关闭
  let decayed = 0
  if (cfg.decayEnabled !== false) {
    try {
      const staleDays = Math.max(1, Number(cfg.decayStaleDays ?? 90))
      const r = decayStaleMemories(db, { staleDays, maxBatch: 100 })
      decayed = r.decayed
      if (decayed > 0) {
        log(`decay: archived ${decayed} stale memory (${staleDays}d+, importance<0.5, never accessed)`)
      }
    } catch (err) {
      log(`decay failed: ${err?.message ?? err}`)
    }
  }

  log(`dream ran: ${rows.length} cards -> ${ops} ops (cursor=${maxSeq})`)
  return { ran: true, cards: rows.length, ops, cursor: maxSeq, decayed }
}

/**
 * 解析 LLM 输出为受控 JSON，清洗 think 标签/代码块，并做字段校验。
 */
export function parseExtract(raw) {
  let text = String(raw ?? '').trim()
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '')
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) text = text.slice(first, last + 1)

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { nodes: [], edges: [], nameToType: new Map() }
  }

  const nameToType = new Map()
  const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
    .filter((n) => n && n.name && n.content && NODE_KINDS.has(n.type))
    .map((n) => ({
      type: n.type,
      name: normalizeName(n.name),
      description: String(n.description ?? '').trim().slice(0, 120),
      content: String(n.content ?? '').trim().slice(0, 600),
    }))
    .filter((n) => n.name && n.content)
  for (const n of nodes) nameToType.set(n.name, n.type)

  const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .filter((e) => e && e.from && e.to && e.type && EDGE_TYPES.has(e.type) && e.instruction)
    .map((e) => ({
      from: normalizeName(e.from),
      to: normalizeName(e.to),
      type: e.type,
      instruction: String(e.instruction ?? '').trim().slice(0, 200),
      condition: e.condition ? String(e.condition).trim().slice(0, 100) : undefined,
    }))
    .filter((e) => e.from && e.to && e.from !== e.to)

  return { nodes, edges, nameToType: mapEntries(nameToType) }
}

function edgeAllowed(type, fromType, toType) {
  return (EDGE_FROM[type]?.has(fromType) ?? true) && (EDGE_TO[type]?.has(toType) ?? true)
}

function mapEntries(map) {
  const out = new Map()
  for (const [k, v] of map) out.set(k, v)
  return out
}

export function hasPendingDream(db, minMessages = 3) {
  return getUnextracted(db, 50).length >= Math.max(1, Number(minMessages ?? 3))
}

export { NODE_KINDS, EDGE_TYPES }