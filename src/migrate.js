/**
 * dsh-dream-memory — 从 dsh-memory-evolve 迁移记忆
 *
 * 兼容 dsh-memory-evolve 的 § 分隔 MD 格式（其 lib/store.js 的存储布局）：
 *   <dshHome>/memories/MEMORY.md                 -> kind=fact   scope=global
 *   <dshHome>/memories/USER.md                   -> kind=profile scope=global
 *   <dshHome>/memories/MEMORY-archive.md 等      -> status=archived
 *   <dshHome>/memories/projects/<hash>/KEY.md    -> kind=key scope=project:<hash>
 *   <dshHome>/memories/projects/<hash>/MEMORY.md -> kind=log（项目日志）
 *   <dshHome>/memories/daily/YYYY-MM-DD.md       -> kind=log（每日日志）
 *   <dshHome>/memories/SUGGESTIONS.jsonl         -> status=candidate（待确认）
 *
 * 迁移是只读 + 幂等的：不改动旧文件，不删除任何东西。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getMeta, setMeta } from './db.js'
import { contentHashFor } from './store.js'

export const ENTRY_DELIMITER = '\n§\n'

export function legacyDirDefault(env = process.env) {
  if (env.DSH_HOME) return join(env.DSH_HOME, 'memories')
  return join(homedir(), '.dsh', 'memories')
}

export function parseEntries(text) {
  return String(text ?? '')
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter(Boolean)
}

const DATE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\s*/
const DATETIME_RE = /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/
const TIME_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/
const BRANCH_RE = /\[branch:([^\]]*)\]/
const GIT_RE = /^\[git ([^\]]+)\]\s*/

function dateMs(dateStr) {
  const ms = Date.parse(dateStr)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 解析旧条目头部元数据，返回 { createdAt, branch, body }。
 */
export function parseLegacyEntry(entry, target) {
  let rest = String(entry ?? '').trim()
  let createdAt = null
  let branch = null
  let gitTags = []

  const branchMatch = BRANCH_RE.exec(rest)
  if (branchMatch) branch = branchMatch[1].split(',').map((b) => b.trim()).filter(Boolean).join(',')

  if (target === 'project') {
    const m = DATETIME_RE.exec(rest)
    if (m) { createdAt = dateMs(m[1]); rest = rest.replace(DATETIME_RE, '') }
  } else if (target === 'daily') {
    const m = TIME_RE.exec(rest)
    if (m) rest = rest.replace(TIME_RE, '')
  } else {
    const m = DATE_RE.exec(rest)
    if (m) { createdAt = dateMs(m[1]); rest = rest.replace(DATE_RE, '') }
  }

  // 剥离程序生成的 [git ...] 标签，但保留为溯源信息
  for (;;) {
    const m = GIT_RE.exec(rest)
    if (!m) break
    gitTags.push(m[1])
    rest = rest.replace(GIT_RE, '')
  }
  rest = rest.replace(/^\[branch:[^\]]*\]\s*/, '')
  rest = rest.replace(/^\[dsh-only\]\s*/, '')
  rest = rest.replace(/^\[summary:[^\]]*\]\s*/, '')
  if (target === 'daily') rest = rest.replace(/^\[([^\]]+)\]\s*/, '') // 项目标签

  return {
    createdAt,
    branch,
    gitTags,
    body: rest.trim(),
  }
}

function findEntryByHash(db, hash) {
  return db.prepare('SELECT id FROM memories WHERE content_hash=?').get(hash)
}

function importEntries(db, { entries, kind, scope, projectId, projectLabel, status, layer, createdAt, summaryCount = 0 }) {
  let inserted = 0
  let skipped = 0
  for (const entry of entries) {
    const parsed = parseLegacyEntry(entry, kind === 'log' && scope === 'global' ? 'daily' : kind === 'log' ? 'project' : kind)
    if (!parsed.body) continue
    const hash = contentHashFor({ kind, scope, projectId, branch: parsed.branch, content: parsed.body })
    if (findEntryByHash(db, hash)) { skipped++; continue }
    const at = parsed.createdAt ?? createdAt ?? Date.now()
    const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const summary = parsed.body.split('\n')[0].slice(0, 80)
    db.prepare(`
      INSERT INTO memories (id, kind, layer, scope, project_id, project_label, branch, name,
        summary, content, importance, confidence, status, validated_count, content_hash,
        source_refs, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,1,?,?,?,?)
    `).run(
      id, kind, layer, scope, projectId, projectLabel, parsed.branch, summary,
      parsed.body, 0.6, 1.0, status, hash,
      JSON.stringify(parsed.gitTags.length ? parsed.gitTags.map((g) => `git:${g}`) : ['legacy-import']),
      at, at,
    )
    inserted++
  }
  return { inserted, skipped }
}

/**
 * 执行迁移。默认只跑一次（meta.legacy_import 已存在且未 force 则跳过）。
 */
export function importLegacy(db, legacyDir, { force = false, dryRun = false, log = () => {} } = {}) {
  const summary = {
    legacyDir,
    files: [],
    entries: 0,
    inserted: 0,
    skipped: 0,
    alreadyImported: false,
  }

  if (!existsSync(legacyDir)) return summary
  const marker = getMeta(db, 'legacy_import')
  if (marker && !force) {
    summary.alreadyImported = true
    summary.marker = marker
    return summary
  }

  const files = []
  const collect = (file, target, scope, extra = {}) => {
    if (!existsSync(file)) return
    files.push({ file, target, scope, ...extra })
  }

  // 全局轨
  collect(join(legacyDir, 'MEMORY.md'), 'fact', 'global', { kind: 'fact', layer: 2, status: 'active' })
  collect(join(legacyDir, 'USER.md'), 'profile', 'global', { kind: 'profile', layer: 2, status: 'active' })
  collect(join(legacyDir, 'MEMORY-archive.md'), 'fact', 'global', { kind: 'fact', layer: 2, status: 'archived' })
  collect(join(legacyDir, 'USER-archive.md'), 'profile', 'global', { kind: 'profile', layer: 2, status: 'archived' })

  // 项目轨
  const projectsDir = join(legacyDir, 'projects')
  let projectDirs = []
  try {
    projectDirs = readdirSync(projectsDir).filter((name) => {
      try { return statSync(join(projectsDir, name)).isDirectory() } catch { return false }
    })
  } catch {}
  for (const hash of projectDirs) {
    let label = hash
    try {
      const provenance = JSON.parse(readFileSync(join(projectsDir, hash, 'PROVENANCE'), 'utf8'))
      if (provenance.displayName) label = provenance.displayName
    } catch {}
    collect(join(projectsDir, hash, 'KEY.md'), 'key', `project:${hash}`, {
      kind: 'key', layer: 2, status: 'active', projectId: hash, projectLabel: label,
    })
    collect(join(projectsDir, hash, 'MEMORY.md'), 'log', `project:${hash}`, {
      kind: 'log', layer: 0, status: 'active', projectId: hash, projectLabel: label,
    })
    collect(join(projectsDir, hash, 'KEY-archive.md'), 'key', `project:${hash}`, {
      kind: 'key', layer: 2, status: 'archived', projectId: hash, projectLabel: label,
    })
  }

  // 每日日志
  const dailyDir = join(legacyDir, 'daily')
  let dailyFiles = []
  try {
    dailyFiles = readdirSync(dailyDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
  } catch {}
  for (const name of dailyFiles) {
    const day = name.slice(0, 10)
    collect(join(dailyDir, name), 'log', 'global', {
      kind: 'log', layer: 0, status: 'active', createdAt: dateMs(day) ?? Date.now(),
    })
  }

  if (dryRun) {
    for (const f of files) {
      const n = parseEntries(readFileSync(f.file, 'utf8')).length
      summary.files.push(`${f.file} (${n} 条)`)
      summary.entries += n
    }
    return summary
  }

  for (const f of files) {
    try {
      const entries = parseEntries(readFileSync(f.file, 'utf8'))
      const { inserted, skipped } = importEntries(db, {
        entries,
        kind: f.kind,
        scope: f.scope,
        projectId: f.projectId ?? null,
        projectLabel: f.projectLabel ?? null,
        status: f.status,
        layer: f.layer,
        createdAt: f.createdAt ?? null,
      })
      summary.files.push(f.file)
      summary.entries += entries.length
      summary.inserted += inserted
      summary.skipped += skipped
    } catch (err) {
      log(`skip ${f.file}: ${err?.message ?? err}`)
    }
  }

  // SUGGESTIONS.jsonl -> candidate
  const suggestionsFile = join(legacyDir, 'SUGGESTIONS.jsonl')
  if (existsSync(suggestionsFile)) {
    try {
      const lines = readFileSync(suggestionsFile, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        let item
        try { item = JSON.parse(line) } catch { continue }
        const content = String(item.content ?? '').trim()
        if (!content) continue
        const kindMap = { memory: 'fact', user: 'profile', key: 'key' }
        const kind = kindMap[item.target] ?? 'fact'
        const hash = contentHashFor({ kind, scope: 'global', projectId: null, branch: null, content })
        if (findEntryByHash(db, hash)) { summary.skipped++; continue }
        db.prepare(`
          INSERT INTO memories (id, kind, layer, scope, project_id, project_label, branch, name,
            summary, content, importance, confidence, status, validated_count, content_hash,
            source_refs, created_at, updated_at)
          VALUES (?,?,1,'global',NULL,NULL,NULL,NULL,?,?,0.5,0.8,'candidate',1,?,?,?,?)
        `).run(
          `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          kind, content.split('\n')[0].slice(0, 80), content, hash,
          JSON.stringify(['legacy-suggestion']), Date.now(), Date.now(),
        )
        summary.inserted++
        summary.entries++
      }
      summary.files.push(suggestionsFile)
    } catch (err) {
      log(`skip ${suggestionsFile}: ${err?.message ?? err}`)
    }
  }

  if (summary.inserted > 0 || summary.skipped > 0) {
    setMeta(db, 'legacy_import', JSON.stringify({ at: Date.now(), legacyDir, inserted: summary.inserted, skipped: summary.skipped }))
  }

  return summary
}

// ─── Hermes 风格工作区记忆（D:\Harness\MEMORY.md / USER.md / …） ──────

const HERMES_FILE_SPECS = {
  'MEMORY.md': { kind: 'fact', layer: 2, importance: 0.75, scope: 'global' },
  'USER.md': { kind: 'profile', layer: 2, importance: 0.85, scope: 'global' },
  'SOUL.md': { kind: 'profile', layer: 2, importance: 0.8, scope: 'global' },
  'AGENTS.md': { kind: 'fact', layer: 2, importance: 0.7, scope: 'global' },
  'SESSION-STATE.md': { kind: 'key', layer: 2, importance: 0.9, scope: 'global' },
  'TOOLS.md': { kind: 'fact', layer: 2, importance: 0.6, scope: 'global' },
  'HEARTBEAT.md': { kind: 'fact', layer: 2, importance: 0.5, scope: 'global' },
  'ONBOARDING.md': { kind: 'log', layer: 1, importance: 0.4, scope: 'global' },
  'memory/working-buffer.md': { kind: 'log', layer: 0, importance: 0.5, scope: 'global' },
}

export function parseMarkdownSections(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const sections = []
  let heading = ''
  let body = []
  const flush = () => {
    const content = body.join('\n').trim()
    const isTitleOnlyPreamble = heading === '' && content.split('\n').every((l) => /^#\s/.test(l.trim()) || l.trim() === '')
      if (content && !isTitleOnlyPreamble) sections.push({ heading, content })
    heading = ''
    body = []
  }
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+)$/.exec(line)
    if (m) {
      flush()
      heading = m[1].trim()
      continue
    }
    body.push(line)
  }
  flush()
  return sections
}

function hermesHash(root, rel, kind, scope, content) {
  return createHash('sha1').update([root, rel, kind, scope, content].join('\u0001')).digest('hex')
}

function hermesInsertSection(db, { root, rel, heading, content, kind, scope, layer, importance, createdAt }) {
  const hash = hermesHash(root, rel, kind, scope, content)
  if (db.prepare('SELECT id FROM memories WHERE content_hash=?').get(hash)) return false
  const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const summary = (heading || content.split('\n')[0] || rel).slice(0, 80)
  db.prepare(`
    INSERT INTO memories (id, kind, layer, scope, project_id, project_label, branch, name,
      summary, content, importance, confidence, status, validated_count, content_hash,
      source_refs, created_at, updated_at)
    VALUES (?,?,?,?,NULL,NULL,NULL,NULL,?,?,?,1,'active',1,?,?,?,?)
  `).run(
    id, kind, layer, scope, summary, content, importance, hash,
    JSON.stringify([`hermes:${root.replace(/\\/g, '/')}/${rel}`]),
    createdAt ?? Date.now(), Date.now(),
  )
  return true
}

/**
 * 判断目录是否为 Hermes 风格记忆工作区。
 */
export function looksLikeHermesWorkspace(root) {
  return existsSync(root) && existsSync(join(root, 'MEMORY.md')) && existsSync(join(root, 'USER.md'))
}

/**
 * 导入 Hermes 工作区记忆。只读、幂等；按 ## 小节切分以便检索。
 */
export function importHermesWorkspace(db, root, { force = false, dryRun = false, log = () => {} } = {}) {
  const summary = { root, files: [], entries: 0, inserted: 0, skipped: 0, alreadyImported: false }
  if (!looksLikeHermesWorkspace(root)) return summary

  const markerKey = `hermes_import:${root}`
  const marker = getMeta(db, markerKey)
  if (marker && !force) {
    summary.alreadyImported = true
    summary.marker = marker
    return summary
  }

  const jobs = []
  for (const [rel, spec] of Object.entries(HERMES_FILE_SPECS)) {
    const file = join(root, rel)
    if (existsSync(file)) jobs.push({ file, rel, ...spec })
  }

  // 每日日志（memory/YYYY-MM-DD.md）
  const dailyDir = join(root, 'memory')
  let dailyFiles = []
  try {
    dailyFiles = readdirSync(dailyDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
  } catch {}
  for (const name of dailyFiles) {
    const day = name.slice(0, 10)
    jobs.push({
      file: join(dailyDir, name),
      rel: `memory/${name}`,
      kind: 'log',
      layer: 0,
      importance: 0.4,
      scope: 'global',
      createdAt: dateMs(day) ?? Date.now(),
    })
  }

  if (dryRun) {
    for (const job of jobs) {
      summary.files.push(job.file)
      summary.entries += parseMarkdownSections(readFileSync(job.file, 'utf8')).length
    }
    return summary
  }

  for (const job of jobs) {
    try {
      const sections = parseMarkdownSections(readFileSync(job.file, 'utf8'))
      for (const section of sections) {
        const inserted = hermesInsertSection(db, {
          root,
          rel: job.rel,
          heading: section.heading,
          content: section.content,
          kind: job.kind,
          scope: job.scope,
          layer: job.layer,
          importance: job.importance,
          createdAt: job.createdAt ?? null,
        })
        summary.entries++
        if (inserted) summary.inserted++
        else summary.skipped++
      }
      summary.files.push(job.file)
    } catch (err) {
      log(`skip ${job.file}: ${err?.message ?? err}`)
    }
  }

  if (summary.inserted > 0 || summary.skipped > 0) {
    setMeta(db, markerKey, JSON.stringify({ at: Date.now(), root, inserted: summary.inserted, skipped: summary.skipped }))
    setMeta(db, 'hermes_imports', JSON.stringify(listHermesImports(db, root)))
  }
  return summary
}

/**
 * 返回已导入的 Hermes 根目录列表（供清理脚本定位）。
 */
export function listHermesImports(db, addRoot) {
  const seen = new Set()
  const raw = getMeta(db, 'hermes_imports')
  if (raw) {
    try {
      for (const r of JSON.parse(raw)) seen.add(r)
    } catch {}
  }
  if (addRoot) seen.add(addRoot)
  return [...seen]
}
