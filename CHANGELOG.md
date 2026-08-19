# Changelog

All notable changes to `dsh-dream-memory` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

所有 `dsh-dream-memory` 的显著变更都记录在这里。
格式基于 [Keep a Changelog]，版本遵循 [Semantic Versioning]。

---

## [0.3.1] - 2026-08-18

### Added / 新增
- **Messages retention** / 消息保留
  - `cleanupExtractedMessages(db, opts)` deletes `extracted=1` messages older than N days
  - Wired into dream end (0 LLM, 0 token, pure SQL DELETE)
  - New setting `messagesRetentionDays` (default 30, set 0 to disable)
  - **Safety guarantee**: `extracted=0` messages are NEVER deleted (dream still needs them)
- **Identity card content fingerprint** / 身份卡内容指纹
  - Replaces fragile `projectId:branch` fingerprint with sha1(projectId + branch + identity rows hash)
  - Any change to identity tier memories (insert/update/delete) invalidates the card within the same session
  - 1 SQL query + 1 hash computation, ~0.5ms cost (only at session start, not in recall hot path)

### Performance / 性能
- No new performance impact on recall (fingerprint is cached per session)
- Messages cleanup is debounced: only runs at end of dream (~every 20h)

### Tests / 测试
- 37 regression tests (was 34)
- +3 cases: messages retention deletes 60d+ old, preserves <30d recent, identity fingerprint changes after new identity

---

## [0.3.0] - 2026-08-18

### Added / 新增
- **3-tier memory model** / 3 层记忆模型
  - `identity` (user profile, 1825-day decay)
  - `knowledge` (long-term knowledge, 90-day decay)
  - `working` (working memory, 14-day decay)
  - Dream LLM classifies each extracted memory into a tier
  - Recall injects per-tier budgets; decay applies per-tier thresholds
- **Per-tier decay** / 分层衰减
  - `identity` decays only after 1825 days AND importance < 0.85
  - `knowledge` decays after 90 days AND importance < 0.7
  - `working` decays after 14 days AND importance < 0.7
- **Tier-aware recall injection** / 分层召回注入
  - `identity` always injected via identity card (never duplicated in recall block)
  - `working` injected only if relevance score ≥ 0.5
  - `knowledge` injected on demand
- **Per-tier settings** / 分层设置
  - `decayIdentityDays`, `decayKnowledgeDays`, `decayWorkingDays`
- **Recall performance monitoring** / 召回性能监控
  - `recordRecallPerf` + `getRecallPerf` — per-recall timing, P50/P95/P99 in 100-sample window
  - `dm_stats_extended` tool shows recall health (last/avg/P50/P95/P99/count)
- **PRAGMA performance tuning** / PRAGMA 性能优化
  - `cache_size = -20000` (20 MB)
  - `temp_store = MEMORY`
  - `mmap_size = 256 MB`
  - `ANALYZE` at startup
- **Access boost (touchMemory)** / 访问提权
  - Every access +0.05 importance, cap 0.95
  - 1-minute debounce to prevent burst inflation
- **dm_consolidate tool** / dm_consolidate 工具
  - Audit + archive label-only / vague summaries (no LLM)
  - Modes: `audit` / `archive`
- **dm_stats_extended tool** / dm_stats_extended 工具
  - Cross-session dashboard: volume, health, top access, recent activity, recall perf
- **Schema migration m4_tier** / 数据迁移 m4_tier
  - Adds `tier` column to `memories` table
  - Auto-assigns tier based on `kind` (profile → identity, task/event/log → working, others → knowledge)
  - Idempotent (PRAGMA table_info check)

### Changed / 变更
- **Dream prompt stricter** / dream prompt 更严
  - Reject list: chit-chat, repeated info, transient states, speculation, current-code snapshots, one-time events, secrets/PII
  - Decision threshold: user explicit "remember", repeated confirmation, stable workflow, real problem, cross-session reusable
  - Self-check: would I still need this 90 days later?
  - Density cap: ≤ 5 nodes per kind (down from 8)
- **Dream extraction transactional** / dream 抽取事务化
  - BEGIN/TRY/COMMIT/ROLLBACK around the dream INSERT batch
  - Graph maintenance moved outside the transaction
- **Dream runtime tuning** / dream 运行时调参
  - `dreamMaxCards` config (default 20, max 50) replaces hardcoded 50
  - `minDreamMessages` default 3 → 10 to reduce noisy micro-dreams
- **Plugin must be invisible** / 插件无感原则
  - Removed rewrite mode from `dm_consolidate` (was burning tokens)
  - Removed Jaccard soft warning from `dm_remember` (per-write overhead)

### Performance / 性能
- Recall SLA: < 500ms hard cap (100+ entries, regression-tested)
- 200-entries recall: ~13ms average with new PRAGMA tuning
- Live DB (300+ entries): ~6-7ms recall average
- Live migration: 24 profile → identity, 175 knowledge, 101 working in <2s

### Tests / 测试
- 34 regression tests (was 10)
- All pass in ~600ms
- Coverage: upsert, search, graph, recall, decay (per-tier), merge, touch (importance boost), stats, perf, dream parsing

---

## [0.2.0] - 2026-08-15

### Added / 新增
- Web settings panel under Settings → General Settings
- Memory browser (browse, read full content)
- Bilingual README (English + Chinese side-by-side)
- Settings API with 9 runtime-adjustable options
- Loopback-only HTTP API (settings.status, settings.update)

### Changed / 变更
- UI moved to "Memory" section in settings
- Memory browser UI added

---

## [0.1.0] - 2026-08-13

### Added / 新增
- Initial release
- SQLite + FTS5 (trigram) storage
- Knowledge graph (links, PageRank, communities)
- Dream consolidation (LLM-driven memory extraction)
- `dm_remember`, `dm_recall`, `dm_read`, `dm_status`, `dm_dream` tools
- Identity card injection (per session)
- Recall block injection (per turn)
- Context budget hard limits (750/1500/0 chars)
- Migration from dsh-memory-evolve (auto, idempotent)
- Migration from Hermes-style workspace (auto, idempotent)
- Cleanup script (`cleanup-legacy.js`)
- Markdown export (`export-md.js`)
- Optional vector semantic retrieval (env vars, no LLM cost when unused)

### Design
- "Remember more, remember longer, never blow the context"
- Cross-session, cross-project, cross-time
- SQLite is single source of truth; Markdown is human-readable view
- 9 memory kinds: profile / key / log / task / skill / event / fact / preference / decision

---

## How to Upgrade / 如何升级

Within DSH web profile:

```bash
dsh plugin --profile web update dsh-dream-memory
```

Manual (re-install from source):

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-dream-memory
git pull
# restart DSH web to pick up new plugin code
dsh web
```

---

## Migration Notes / 迁移注意

### 0.2.0 → 0.3.0

- Schema migration `m4_tier` runs automatically on first open
- Existing memories are assigned tier based on `kind`:
  - `profile` → `identity`
  - `task` / `event` / `log` → `working`
  - `fact` / `preference` / `decision` / `skill` / `key` → `knowledge`
- **No data loss** — only adds `tier` column
- DSH restart picks up new plugin code (old in-memory module is replaced)

### 0.1.0 → 0.2.0

- Settings UI moved from sidebar to General Settings
- No data migration required

---

[Unreleased]: https://github.com/hellowangxinyu/dsh-dream-memory/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/hellowangxinyu/dsh-dream-memory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/hellowangxinyu/dsh-dream-memory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hellowangxinyu/dsh-dream-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hellowangxinyu/dsh-dream-memory/releases/tag/v0.1.0
