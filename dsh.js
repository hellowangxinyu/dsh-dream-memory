/**
 * dsh-dream-memory — DeepSeek Harness / Cordis 宿主适配器
 *
 * 存储与算法全部在 src/ 中，宿主无关；本文件只负责：
 *   DSH 事件翻译、会话作用域识别、上下文注入、工具注册、梦境调度。
 *
 * 设计目标（硬性）：
 *   1. 记忆库永远在上下文之外，按需召回
 *   2. 身份卡 ≤ identityMaxChars（默认 750 字符），召回块 ≤ recallMaxChars（默认 1500 字符）
 *   3. 梦境抽取异步运行，不挤占对话上下文
 *   4. 跨时间（时间戳）、跨会话（source_refs）、跨项目（scope + RELATED 边）
 */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { openDb, getMeta, setMeta } from './src/db.js'
import {
  upsertMemory, getMemory, listMemories, saveMessageOnce, getStats, setStatus, touchMemory,
  resolveProjectId, projectLabel, getUnextracted,
  analyzeMemoryQuality, archiveMemoryWithReason, updateMemorySummary,
  getDashboardStats, getRecallPerf,
} from './src/store.js'
import { recall, markAccessed } from './src/recall.js'
import { buildIdentityCard, formatRecall, formatList } from './src/inject.js'
import { runDream } from './src/dream.js'
import { importLegacy, legacyDirDefault, importHermesWorkspace } from './src/migrate.js'
import { loadSettings, saveSettings, settingsView, defaultDbPath } from './src/settings.js'

export const name = 'dsh-dream-memory'
export const inject = ['tools', 'systemPrompt', 'llm', 'sessions', 'webServer']

const HOST = 'dsh'

function sessionKey(id) {
  return `${HOST}:${String(id)}`
}

function textBlocks(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') {
      if (typeof block.text === 'string') parts.push(block.text)
    } else if (block.type === 'tool-result') {
      parts.push(textBlocks(block.content))
    }
  }
  return parts.join('\n').trim()
}

function messageText(message) {
  return textBlocks(message?.content)
}

function eventMessage(event) {
  if (event?.type === 'user/message') {
    // 插件自己注入的消息不参与抽取，避免自我强化循环
    if (event.data?.source?.kind !== 'user') return
    return { role: 'user', message: event.data }
  }
  if (event?.type === 'assistant/message') {
    return { role: 'assistant', message: event.data?.message }
  }
  if (event?.type === 'tool/result') {
    return { role: 'tool', message: event.data?.message }
  }
  return
}

function routeFromEvent(event) {
  if (event?.type !== 'request/header') return
  const provider = event.data?.header?.config?.provider
  const model = event.data?.header?.config?.model
  return typeof provider === 'string' && provider && typeof model === 'string' && model
    ? { provider, model }
    : undefined
}

function gitBranch(cwd) {
  if (!cwd) return undefined
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const branch = String(result.stdout ?? '').trim()
    return branch || undefined
  } catch {
    return undefined
  }
}

function stringOutput(title) {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: () => ({ title }),
  }
}

function agentOf(exec) {
  const agent = exec?.agent?.agent ?? exec?.agent ?? null
  return agent
}

function cwdOf(agent) {
  return agent?.session?.header?.cwd ?? agent?.session?.cwd ?? undefined
}

export function apply(ctx, input = {}) {
  const db = openDb(input.dbPath ?? process.env.DREAM_MEMORY_DB ?? defaultDbPath())

  // ── 一次性迁移：dsh-memory-evolve → 本插件 ─────────────────
  if (input.legacyImport !== false) {
    try {
      const summary = importLegacy(db, input.legacyMemoryDir ?? legacyDirDefault())
      if (summary.inserted || summary.alreadyImported) {
        ctx.logger?.info(`[dsh-dream-memory] legacy import: inserted=${summary.inserted} skipped=${summary.skipped} already=${summary.alreadyImported}`)
      }
    } catch (err) {
      ctx.logger?.warn(`[dsh-dream-memory] legacy import failed: ${err?.message ?? err}`)
    }

    const hermesRoot = input.hermesRoot ?? process.env.DREAM_MEMORY_HERMES_ROOT
    if (hermesRoot) {
      try {
        const summary = importHermesWorkspace(db, hermesRoot)
        if (summary.inserted || summary.alreadyImported) {
          ctx.logger?.info(`[dsh-dream-memory] hermes import ${hermesRoot}: inserted=${summary.inserted} skipped=${summary.skipped}`)
        }
      } catch (err) {
        ctx.logger?.warn(`[dsh-dream-memory] hermes import failed: ${err?.message ?? err}`)
      }
    }
  }

  const _dbPath = input.dbPath ?? process.env.DREAM_MEMORY_DB ?? defaultDbPath()

  // 运行时设置：面板保存后立即生效（Proxy 每次读取都从文件刷新）
  const cfg = new Proxy({}, {
    get(_target, prop) {
      return loadSettings(_dbPath, input)[prop]
    },
  })

  const latestRoute = new Map()
  const latestPrompt = new Map()
  const recallCache = new Map()
  const extractChain = new Map()
  const turnCounts = new Map()
  const activeSteps = new Map() // sessionKey -> 进行中的 step 数（主对话活跃检测）
  const sessionMeta = new Map() // sessionKey -> { cwd, projectId, label, branch }
  const identityCache = new Map() // sessionKey -> { fingerprint, text }
  const identityInjected = new Map() // sessionKey -> true（身份卡每会话只注入一次）
  const lastInjected = new Map() // sessionKey -> ids string
  const hermesImported = new Set() // 已尝试导入的工作区根目录
  const dreamQueued = new Set() // 已有梦境在排队/运行的 session
  let closing = false

  function metaFor(id) {
    const key = sessionKey(id)
    let meta = sessionMeta.get(key)
    if (!meta) {
      meta = { cwd: undefined, projectId: null, label: null, branch: undefined }
      sessionMeta.set(key, meta)
    }
    return meta
  }

  function refreshMeta(id, cwd) {
    const meta = metaFor(id)
    if (!cwd) return meta
    // 缓存：cwd 未变化时直接返回，绝不重复解析项目身份
    // （resolveProjectId 内部会 spawn git，逐事件调用会把流式输出卡成逐段停顿）
    if (meta.cwd === cwd) return meta
    const identity = resolveProjectId(cwd)
    meta.cwd = cwd
    meta.projectId = identity.id
    meta.label = projectLabel(cwd) ?? identity.displayName
    meta.branch = gitBranch(cwd)
    return meta
  }

  function scopeInfoOf(id) {
    return metaFor(id)
  }

  // ── LLM 辅助调用（梦境抽取使用当前会话的 provider/model） ──
  async function complete(route, system, user) {
    const selected = route ?? (input.llmProvider && input.llmModel
      ? { provider: input.llmProvider, model: input.llmModel }
      : undefined)
    if (!selected) {
      throw new Error('[dsh-dream-memory] 尚无模型路由；先发一条普通消息，或配置 llmProvider/llmModel')
    }
    const chunks = ctx.llm.stream({
      provider: selected.provider,
      model: selected.model,
      reasoningEffort: cfg.dreamReasoningEffort ?? 'low',
      system,
      temperature: 0.1,
      maxTokens: cfg.dreamMaxTokens ?? 1024,
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: name },
      }],
    })
    let text = ''
    let blockText = ''
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block?.text === 'string') {
        blockText += chunk.block.text
      }
      if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        throw new Error(`[dsh-dream-memory] LLM ${chunk.reason.kind}`)
      }
    }
    const result = text || blockText
    if (!result.trim()) throw new Error('[dsh-dream-memory] LLM 返回空结果')
    return result
  }

  // ── 事件摄入（幂等，DSH event.seq 作为唯一键） ──
  function ingest(sessionId, event) {
    const route = routeFromEvent(event)
    if (route) latestRoute.set(String(sessionId), route)

    const converted = eventMessage(event)
    if (!converted) return false
    return saveMessageOnce(
      db,
      `${HOST}:${String(sessionId)}:${String(event.seq)}`,
      sessionKey(sessionId),
      Number(event.seq ?? 0),
      Number(event.seq ?? 0),
      converted.role,
      messageText(converted.message),
    )
  }

  function backfill(agent) {
    const id = agent?.id ?? agent?.session?.id
    if (id === undefined) return
    const cwd = cwdOf(agent)
    refreshMeta(id, cwd)

    // 首次进入 Hermes 风格工作区（D:\Harness 的 MEMORY.md/USER.md 体系）时自动导入
    if (cwd && !hermesImported.has(cwd)) {
      hermesImported.add(cwd)
      try {
        const summary = importHermesWorkspace(db, cwd)
        if (summary.inserted || summary.alreadyImported) {
          ctx.logger?.info(`[dsh-dream-memory] hermes import ${cwd}: inserted=${summary.inserted} skipped=${summary.skipped}`)
        }
      } catch (err) {
        ctx.logger?.warn(`[dsh-dream-memory] hermes import failed: ${err?.message ?? err}`)
      }
    }

    if (!Array.isArray(agent?.session?.events)) return
    for (const event of agent.session.events) ingest(id, event)
  }

  // 梦境门控：积压 >= minDreamMessages 且 距上次梦境 >= dreamMinIntervalHours（默认一天一次）
  // 且 没有进行中的主对话 step。三者全过才调度，否则保持静默。
  function maybeScheduleDream(sessionId) {
    if (cfg.dreamEnabled === false || closing) return
    const key = String(sessionId)
    if (dreamQueued.has(key)) return

    const minMsgs = Math.max(1, Number(cfg.minDreamMessages ?? 10))
    if (getUnextracted(db, 50).length < minMsgs) return

    const minIntervalMs = Math.max(0, Number(cfg.dreamMinIntervalHours ?? 20)) * 3600000
    const lastDreamAt = getMeta(db, 'last_dream_at')
    if (lastDreamAt !== null && Date.now() - Number(lastDreamAt) < minIntervalMs) return

    if (activeSteps.size > 0) return
    scheduleDream(key)
  }

  function scheduleDream(sessionId) {
    if (cfg.dreamEnabled === false || closing) return
    const key = String(sessionId)
    if (dreamQueued.has(key)) return
      dreamQueued.add(key)
      const previous = extractChain.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      const meta = scopeInfoOf(key)
      const result = await runDream(db, cfg, {
        sessionId: sessionKey(key),
        projectId: meta.projectId,
        label: meta.label,
        branch: meta.branch,
      }, (system, user) => complete(latestRoute.get(key), system, user),
        (msg) => ctx.logger?.info(`[dsh-dream-memory] ${msg}`))
      if (result.ran) setMeta(db, 'last_dream_at', String(Date.now()))
    }).catch((err) => {
      ctx.logger?.warn(`[dsh-dream-memory] dream deferred: ${err?.message ?? err}`)
    })
    extractChain.set(key, next)
    void next.finally(() => {
      if (extractChain.get(key) === next) extractChain.delete(key)
        dreamQueued.delete(key)
    })
  }

  // ── 可选 embedding（OpenAI 兼容接口） ──
  let embedFn = null
  const embCfg = input.embedding ?? {
      apiKeyEnv: process.env.DREAM_MEMORY_EMBEDDING_API_KEY ? 'DREAM_MEMORY_EMBEDDING_API_KEY' : undefined,
      baseURL: process.env.DREAM_MEMORY_EMBEDDING_BASE_URL,
      baseUrl: undefined,
      model: process.env.DREAM_MEMORY_EMBEDDING_MODEL,
      dimensions: process.env.DREAM_MEMORY_EMBEDDING_DIMENSIONS ? Number(process.env.DREAM_MEMORY_EMBEDDING_DIMENSIONS) : undefined,
    }
  const embApiKeyEnv = embCfg?.apiKeyEnv
  if (embCfg?.baseURL || embCfg?.baseUrl || embApiKeyEnv) {
    embedFn = async (text) => {
      const base = embCfg.baseURL ?? embCfg.baseUrl
      const model = embCfg.model ?? 'text-embedding-3-small'
      const apiKey = embApiKeyEnv ? (await ctx.credentials?.resolve(embApiKeyEnv))?.value : undefined
      if (embApiKeyEnv && !apiKey) throw new Error(`embedding 凭据 ${embApiKeyEnv} 不可用`)
      const res = await fetch(`${base.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, input: String(text).slice(0, 2000) }),
      })
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
      const json = await res.json()
      const vec = json?.data?.[0]?.embedding
      if (!Array.isArray(vec)) throw new Error('embedding 返回为空')
      return new Float32Array(vec)
    }
  }

  // ── DSH 生命周期钩子 ──
  ctx.on('agent/session-start', ({ agent }) => backfill(agent))

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    refreshMeta(id, session?.header?.cwd ?? session?.cwd)
    ingest(id, event)
    const key = String(id)
    if (event?.type === 'step/start') {
      // 主对话活跃跟踪：有任何进行中的 step 就不做梦境（避免抢 LLM 并发）
      activeSteps.set(key, (activeSteps.get(key) ?? 0) + 1)
    } else if (event?.type === 'step/end') {
      const c = (activeSteps.get(key) ?? 1) - 1
      if (c <= 0) activeSteps.delete(key)
      else activeSteps.set(key, c)
    } else if (event?.type === 'turn/end') {
      const turns = (turnCounts.get(key) ?? 0) + 1
      turnCounts.set(key, turns)
      maybeScheduleDream(key)
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    const query = messageText(message)
    if (!query) return
    const id = String(agent.id)
    latestPrompt.set(id, query)
    recallCache.delete(id)
  })

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    if (!cfg.recallEnabled || closing) return next()
    const id = context?.agent?.id ?? context?.scope?.agent
    if (id === undefined) return next()
    const key = String(id)
    const query = latestPrompt.get(key)
    if (!query) return next()
    try {
      const meta = scopeInfoOf(key)

      // 身份卡：每个会话只构建一次（内容变化下次会话生效，保护前缀缓存）
      let identity = identityCache.get(key)
      if (!identity) {
        identity = { fingerprint: `${meta.projectId ?? ''}:${meta.branch ?? ''}`, text: buildIdentityCard(db, meta, cfg) }
        identityCache.set(key, identity)
      }

      let cached = recallCache.get(key)
      if (!cached || cached.query !== query) {
        cached = { query, value: recall(db, cfg, query, meta, embedFn) }
        recallCache.set(key, cached)
      }
      context?.signal?.throwIfAborted?.()
      const result = await cached.value

      if (result.entries.length) {
        const ids = result.entries.slice(0, 3).map((m) => m.id).join('|')
        if (lastInjected.get(key) !== ids) {
          const formatted = formatRecall(result.entries, result.edges, { recallMaxChars: cfg.recallMaxChars })
          if (formatted.text) {
            assembly.contexts.push({ name: 'dsh-dream-memory:recall', text: formatted.text })
            markAccessed(db, result.entries)
            lastInjected.set(key, ids)
          }
        }
      }

      if (identity.text && !identityInjected.get(key)) {
        assembly.contexts.push({ name: 'dsh-dream-memory:identity', text: identity.text })
        identityInjected.set(key, true)
      }
    } catch (err) {
      ctx.logger?.warn(`[dsh-dream-memory] recall failed: ${err?.message ?? err}`)
    }
    return next()
  })

  // ── 工具（仅 5 个，描述短） ──
  ctx.tools.register({
    name: 'dm_remember',
    description: '写入一条长期记忆（跨会话/跨项目保存到本地 SQLite）',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆正文，简洁具体，≤300字' },
        kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'skill', 'key', 'log'], description: '类型；key=当前项目关键记忆，profile 类请用 preference' },
        name: { type: 'string', description: '可选：规范化名称，用于图节点去重' },
        summary: { type: 'string', description: '可选：≤80字摘要，检索与注入时显示' },
        importance: { type: 'number', description: '0-1，默认 0.6；重要偏好/决策给 0.8+' },
        branches: { type: 'string', description: '可选：逗号分隔的 git 分支范围，缺省=全部分支' },
        scope: { type: 'string', enum: ['auto', 'global', 'project'], description: 'auto=按当前工作目录' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: stringOutput('记忆写入'),
    execute: async (args, exec) => {
      const agent = agentOf(exec)
      const meta = refreshMeta(agent?.id, cwdOf(agent))
      const kindMap = { procedure: 'skill' }
      const kind = kindMap[args.kind] ?? args.kind ?? 'fact'
      const scope = args.scope === 'project' || (args.scope !== 'global' && meta.projectId)
        ? `project:${meta.projectId}`
        : 'global'
      const { memory, isNew } = upsertMemory(db, {
        kind: kind === 'profile' ? 'preference' : kind,
        layer: kind === 'key' || kind === 'preference' || kind === 'fact' || kind === 'decision' ? 2 : 1,
        scope,
        projectId: scope.startsWith('project:') ? meta.projectId : null,
        projectLabel: meta.label,
        branch: args.branches ? String(args.branches) : null,
        name: args.name,
        summary: args.summary,
        content: args.content,
        importance: args.importance,
        status: 'active',
      }, { sessionRef: agent?.id ? sessionKey(agent.id) : null })
      if (args.evidence) {
        db.prepare('INSERT INTO evidence (id, memory_id, kind, ref, excerpt, created_at) VALUES (?,?,?,?,?,?)')
          .run(`e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            memory.id, 'user_quote', String(args.evidence), String(args.content).slice(0, 300), Date.now())
      }

      return isNew ? `已写入记忆 ${memory.id}（${memory.kind}）` : `合并到已有记忆 ${memory.id}（validated=${memory.validatedCount}）`
    },
  })

  // dm_consolidate：记忆整理（仅 audit + archive）。
  // 设计原则：插件本身不调用 LLM，避免拖累 token 速度。
  // 不暴露 rewrite 模式——重写是 agent / 用户的事，靠单独 dm_remember 写回，
  // 插件只负责"识别哪些需要重写"和"归档不再需要的"。
  ctx.tools.register({
    name: 'dm_consolidate',
    description: '记忆整理：扫描现有 active 记忆，识别标签型（label-only）和模糊摘要（Jaccard<阈值），按 mode 归档。不调用 LLM',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['audit', 'archive'], description: 'audit=只报告; archive=归档 label-only', default: 'audit' },
        dryRun: { type: 'boolean', description: 'true=不实际改动只报告，默认 true', default: true },
        jaccardThreshold: { type: 'number', description: 'Jaccard 阈值，低于此视为模糊', default: 0.1 },
        labelMaxLen: { type: 'number', description: 'label-only 摘要最大长度', default: 8 },
        kinds: { type: 'string', description: '可选：逗号分隔的 kind 过滤', default: '' },
      },
    },
    execute: async (args) => {
      const kindsFilter = args.kinds ? String(args.kinds).split(',').map(s => s.trim()).filter(Boolean) : null
      const analysis = analyzeMemoryQuality(db, {
        jaccardThreshold: args.jaccardThreshold ?? 0.1,
        labelMaxLen: args.labelMaxLen ?? 8,
        kinds: kindsFilter,
      })

      const lines = []
      lines.push(`记忆整理报告`)
      lines.push(` 扫描 active: ${analysis.scanned} 条`)
      lines.push(` 已有 archived: ${analysis.archives} 条`)
      lines.push(` 候选 label-only: ${analysis.labels.length} 条`)
      lines.push(` 候选模糊(J<${args.jaccardThreshold ?? 0.1}): ${analysis.vague.length} 条`)

      if (analysis.labels.length === 0 && analysis.vague.length === 0) {
        return lines.join('\n') + '\n✓ 无需整理'
      }

      if (args.mode === 'audit') {
        lines.push('---')
        lines.push('【label-only 候选】')
        for (const l of analysis.labels.slice(0, 20)) {
          lines.push(`  ${l.id} [${l.kind}] ${JSON.stringify(l.summary)}`)
        }
        lines.push('【模糊摘要 候选 - 需 agent 重写】')
        for (const v of analysis.vague.slice(0, 20)) {
          lines.push(`  ${v.id} [${v.kind}] j=${v.jaccard} ${JSON.stringify(v.summary).slice(0, 60)}`)
        }
        return lines.join('\n') + `\n提示：mode=archive 才会实际改动；模糊摘要需 agent 单独 dm_remember 重写。`
      }

      if (args.mode === 'archive') {
        if (args.dryRun !== false) {
          return lines.join('\n') + `\n[dry-run] 实际未改动，传 dryRun=false 才会执行。`
        }
        let archived = 0
        const errors = []
        for (const l of analysis.labels) {
          const r = archiveMemoryWithReason(db, l.id, 'consolidate:label-only')
          if (r.ok) archived++
          else errors.push(`${l.id}: ${r.error}`)
        }
        lines.push('---')
        lines.push(` 归档: ${archived} 条`)
        if (errors.length) {
          lines.push(` 错误: ${errors.length} 条`)
          for (const er of errors.slice(0, 5)) lines.push(`    - ${er}`)
        }
        return lines.join('\n')
      }

      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'dm_recall',
    description: '按需检索长期记忆（FTS5+图谱混合召回，只返回相关条目）',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '问题或关键词；缺省返回当前项目最重要的记忆' },
        k: { type: 'number', description: '返回条数，默认 6，最多 10' },
        scope: { type: 'string', enum: ['global', 'project'], description: '缺省=global+当前项目+关联项目' },
        include_logs: { type: 'boolean', description: '是否包含项目/每日日志，默认 false' },
      },
      additionalProperties: false,
    },
    output: stringOutput('记忆检索'),
    execute: async (args, exec) => {
      const agent = agentOf(exec)
      const meta = refreshMeta(agent?.id, cwdOf(agent))
      const scopeInfo = args.scope === 'global' ? { projectId: null } : meta
      const result = await recall(db, { ...cfg, recallMaxNodes: Math.min(10, Number(args.k ?? cfg.recallMaxNodes)), includeLogs: args.include_logs === true }, args.query ?? '', scopeInfo, embedFn)
      if (!result.entries.length) return '（没有相关长期记忆）'
      const formatted = formatRecall(result.entries, result.edges, { recallMaxChars: cfg.recallMaxChars, includeEdges: true })
      markAccessed(db, result.entries)
      return `${formatted.text}\n\n（用 dm_read <id> 展开全文）`
    },
  })

  ctx.tools.register({
    name: 'dm_read',
    description: '读取记忆全文或按条件列出记忆（含日志与归档）',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（如 m-xxx），读取全文与证据' },
        kind: { type: 'string', description: '可选：按类型过滤' },
        filter: { type: 'string', description: '可选：关键词' },
        status: { type: 'string', enum: ['active', 'candidate', 'archived', 'superseded'], description: '默认 active' },
        limit: { type: 'number', description: '默认 20' },
      },
      additionalProperties: false,
    },
    output: stringOutput('记忆读取'),
    execute: async (args, exec) => {
      if (args.id) {
        const mem = getMemory(db, String(args.id))
        if (!mem) return `未找到 ${args.id}`
        touchMemory(db, mem.id)
        const evidence = db.prepare('SELECT * FROM evidence WHERE memory_id=?').all(mem.id)
        const head = `[${mem.id}|${mem.kind}|${mem.scope}|${new Date(mem.created_at).toISOString().slice(0, 10)}] ${mem.summary}`
        const ev = evidence.length ? `\n证据: ${evidence.map((e) => `${e.kind}@${e.ref}${e.excerpt ? ' — ' + e.excerpt : ''}`).join(' | ')}` : ''
        return `${head}\n${mem.content}${ev}`
      }
      const agent = agentOf(exec)
      const meta = refreshMeta(agent?.id, cwdOf(agent))
      const rows = listMemories(db, {
        kind: args.kind,
        status: args.status ?? 'active',
        filter: args.filter,
        limit: args.limit ?? 20,
      }).filter((m) => m.scope === 'global' || (meta.projectId && m.scope === `project:${meta.projectId}`))
      return formatList(rows)
    },
  })

  ctx.tools.register({
    name: 'dm_status',
    description: '查看记忆库状态与统计',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput('记忆状态'),
    execute: async () => {
      const stats = getStats(db)
      return `dsh-dream-memory\n库: ${_dbPath}\n` +
          `Hermes 导入: ${getMeta(db, 'hermes_imports') ?? '无'}\n` +
        `条目: ${stats.total}（active ${stats.active} / candidate ${stats.candidates}）\n` +
        `边: ${stats.edges}  原始事件: ${stats.messages}  向量: ${stats.vectors}\n` +
        `FTS: ${stats.ftsMode}\n` +
        `类型分布: ${JSON.stringify(stats.byKind)}\n` +
        `旧记忆迁移: ${getMeta(db, 'legacy_import') ?? '无'}`
    },
  })

  // 跨会话记忆统计仪表盘（更详细）
  ctx.tools.register({
    name: 'dm_stats_extended',
    description: '跨会话仪表盘：库体量、健康度、Top 访问、Top 重要、最近 7 天新增、知识图谱统计',
    parameters: {
      type: 'object',
      properties: {
        topLimit: { type: 'number', description: 'Top N 访问/重要各显示多少条', default: 10, min: 1, max: 50 },
        recentDays: { type: 'number', description: '最近多少天的新增统计', default: 7, min: 1, max: 90 },
      },
    },
    execute: async (args) => {
      const top = Math.max(1, Math.min(50, Number(args.topLimit ?? 10)))
      const days = Math.max(1, Math.min(90, Number(args.recentDays ?? 7)))
      const s = getDashboardStats(db, { topLimit: top, recentDays: days })
      const p = getRecallPerf(db)
      const lines = []
      lines.push(`=== 跨会话仪表盘 ===`)
      lines.push(`· 体量`)
      lines.push(`  active ${s.totals.active} / archived ${s.totals.archived} / candidate ${s.totals.candidate} / total ${s.totals.total}`)
      lines.push(`  图：${s.graph.edges} 边, ${s.graph.communities} 社区`)
      lines.push(`· 健康度`)
      lines.push(`  从未访问: ${s.health.neverAccessPct}%`)
      lines.push(`  最近 ${days} 天活跃: ${s.health.recentlyActivePct}%`)
      lines.push(`  平均 importance: ${s.health.avgImportance}`)
      lines.push(`  待审判 (candidate): ${s.health.candidatesPending}`)
      lines.push(`· Recall 性能 (${p.windowSize} 样本)`)
      lines.push(`  last=${p.last}ms avg=${p.avg}ms P50=${p.p50}ms P95=${p.p95}ms P99=${p.p99}ms`)
      lines.push(`  累计 ${p.count} 次`)
      lines.push(`· Top ${top} 访问频率`)
      for (const m of s.topAccessed) {
        lines.push(`  [${m.kind}|acc=${m.access_count}|imp=${m.importance.toFixed(2)}] ${m.summary?.slice(0, 40) ?? ''}`)
      }
      lines.push(`· Top ${top} 重要性`)
      for (const m of s.topImportance) {
        lines.push(`  [${m.kind}|imp=${m.importance.toFixed(2)}|acc=${m.access_count}] ${m.summary?.slice(0, 40) ?? ''}`)
      }
      lines.push(`· 最近 ${days} 天新增`)
      for (const r of s.recent) {
        lines.push(`  ${r.d}: +${r.n}`)
      }
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'dm_dream',
    description: '立即运行一次梦境整理（把未处理的对话事件提炼为记忆）',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput('梦境整理'),
    execute: async (_args, exec) => {
      const agent = agentOf(exec)
      const meta = refreshMeta(agent?.id, cwdOf(agent))
      const result = await runDream(db, { ...cfg, minDreamMessages: 1 }, {
        sessionId: agent?.id ? sessionKey(agent.id) : null,
        projectId: meta.projectId, label: meta.label, branch: meta.branch,
      }, (system, user) => complete(latestRoute.get(String(agent?.id)), system, user),
        (msg) => ctx.logger?.info(`[dsh-dream-memory] ${msg}`))
      return result.ran ? `梦境完成：处理 ${result.cards} 张事件卡片，产出 ${result.ops} 个操作` : `本次未执行：${result.reason}`
    },
  })


    // ── Web API：设置面板用的读写路由（loopback-only） ──
    ctx.effect(() => {
      const writeJson = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
        res.end(JSON.stringify(body))
      }
      const isLoopback = (req) => {
        const addr = req.socket?.remoteAddress
        if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
        const host = req.headers?.host
        if (typeof host !== 'string') return false
        try {
          const h = new URL(`http://${host}`).hostname
          return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
        } catch { return false }
      }
      const readBody = (req) => new Promise((resolve) => {
        let data = ''
        req.on('data', (c) => { data += c; if (data.length > 100_000) req.destroy() })
        req.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
      })
      // 用 exact 路由（核心 webServer 已注册 /api 前缀，prefix 会被它抢先匹配导致 404）
      const disposers = ['/api/dsh-dream-memory/settings', '/api/dsh-dream-memory/status', '/api/dsh-dream-memory/memories', '/api/dsh-dream-memory/read'].map((path) =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          const sub = req.url?.split('?')[0]?.replace('/api/dsh-dream-memory', '') || '/'
          try {
            if (sub === '/settings' && req.method === 'GET') {
              return writeJson(res, 200, { ok: true, ...settingsView(_dbPath, input) })
            }
            if (sub === '/settings' && req.method === 'POST') {
              const patch = await readBody(req)
              if (!patch || typeof patch !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid JSON' })
              const values = saveSettings(_dbPath, patch)
              return writeJson(res, 200, { ok: true, values })
            }
            if (sub === '/status' && req.method === 'GET') {
              const stats = getStats(db)
              return writeJson(res, 200, { ok: true, ...stats, dbPath: _dbPath })
            }
            if (sub === '/memories' && req.method === 'GET') {
                const url = new URL(req.url ?? '/', 'http://localhost')
                const rows = listMemories(db, {
                  kind: url.searchParams.get('kind') || undefined,
                  status: url.searchParams.get('status') || 'active',
                  filter: url.searchParams.get('filter') || undefined,
                  limit: Number(url.searchParams.get('limit') || 20),
                })
                return writeJson(res, 200, {
                  ok: true,
                  memories: rows.map((m) => ({
                    id: m.id, kind: m.kind, scope: m.scope, summary: m.summary,
                    importance: m.importance, created_at: m.created_at,
                  })),
                })
              }
              if (sub === '/read' && req.method === 'GET') {
                const url = new URL(req.url ?? '/', 'http://localhost')
                const id = url.searchParams.get('id')
                if (!id) return writeJson(res, 400, { ok: false, error: 'id required' })
                const memory = getMemory(db, id)
                if (!memory) return writeJson(res, 404, { ok: false, error: 'not found' })
                const evidence = db.prepare('SELECT * FROM evidence WHERE memory_id=?').all(id)
                return writeJson(res, 200, { ok: true, memory, evidence })
              }
              return writeJson(res, 404, { ok: false, error: `unknown route: ${req.method} ${sub}` })
          } catch (err) {
            return writeJson(res, 500, { ok: false, error: err?.message ?? String(err) })
          }
        },
        })
      )
      return () => disposers.forEach((dispose) => dispose())
    }, 'dsh-dream-memory: web api')

  ctx.effect(() => async () => {
    closing = true
    await Promise.allSettled([...extractChain.values()])
    db.close()
  }, 'dsh-dream-memory.close')

  ctx.logger?.info(`[dsh-dream-memory] active at ${_dbPath}`)
}