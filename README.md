# dsh-dream-memory

**Long-term memory for DeepSeek Harness** — SQLite + FTS5(trigram) + knowledge graph + dream consolidation.

**DeepSeek Harness 长期记忆插件** —— SQLite + FTS5(trigram) + 知识图谱 + 梦境整理。

---

## Features / 特性

| English | 中文 |
|---|---|
| Remember more, remember longer, never blow the context | 记得多、记得久，且不撑爆上下文 |
| Memory lives outside the context; relevant pieces injected on demand | 记忆库在上下文之外，按需召回 |
| Cross-session, cross-project, cross-time | 跨会话、跨项目、跨时间 |
| SQLite + FTS5 trigram for reliable Chinese retrieval | SQLite + FTS5 trigram 中文检索可靠 |
| Optional knowledge graph (PageRank + community detection) | 可选知识图谱（PageRank + 社区检测） |
| Async dream consolidation with bounded LLM cost | 异步梦境整理，LLM 成本有上限 |
| Web settings panel, changes apply immediately | Web 设置面板，保存后立即生效 |

---

## Requirements / 环境要求

- Node.js ≥ 22.5 (DSH already requires 22.19+)
- DeepSeek Harness with web profile

## Installation / 安装

```bash
# Run tests (zero runtime dependencies)
node --test tests/smoke.test.js

# Install into the DSH web profile (local directory / git URL / npm package)
dsh plugin --profile web add <path-or-url>

# Restart DSH web
dsh web
```

Default database: `~/.dsh/dream-memory/memory.db`

Uninstall:

```bash
dsh plugin --profile web remove dsh-dream-memory
```

## Settings Panel / 设置面板

After installation, a **Memory** section appears under **Settings → General Settings**. It shows:

- Live stats: memory entries, graph edges, raw events, FTS engine
- Nine personalizable options: recall toggle, dream toggle, legacy import, recall count, graph depth, dream interval, minimum dream messages, identity-card budget, recall-block budget
- A browsable list of memory entries; click any row to read the full content

Changes are saved to `settings.json` and take effect immediately — no restart needed.

---

## Migration / 旧记忆迁移

### dsh-memory-evolve format (automatic)

The plugin automatically and idempotently imports legacy `§`-separated Markdown:

| Old file | Becomes |
|---|---|
| `memories/MEMORY.md` | `fact` / global / active |
| `memories/USER.md` | `profile` / global / active |
| `memories/MEMORY-archive.md`, `USER-archive.md` | status=archived |
| `memories/projects/<hash>/KEY.md` | `key` / project / active |
| `memories/projects/<hash>/MEMORY.md` | `log` |
| `memories/daily/YYYY-MM-DD.md` | `log` |
| `memories/SUGGESTIONS.jsonl` | candidate |

Manual:

```bash
node scripts/migrate-legacy.js --dry-run
node scripts/migrate-legacy.js
```

### Hermes-style workspace (automatic)

If the session working directory contains `MEMORY.md` + `USER.md`, the plugin imports that workspace on first entry. Supported files:

`MEMORY.md / USER.md / SOUL.md / AGENTS.md / SESSION-STATE.md / TOOLS.md / HEARTBEAT.md / ONBOARDING.md / memory/*.md`

Manual:

```bash
node scripts/migrate-legacy.js --hermes-root "/path/to/workspace"
```

### Cleanup

```bash
node scripts/cleanup-legacy.js --check   # preview only
node scripts/cleanup-legacy.js --move    # move old files to a backup directory (recoverable)
```

> Old files are never deleted unless you explicitly use `--delete --really-delete`.

---

## Tools / AI 工具

| Tool | Purpose |
|---|---|
| `dm_remember` | Write a long-term memory |
| `dm_recall` | Hybrid on-demand recall, returns compact memory lines |
| `dm_read` | Read full content or list memories/logs/archives |
| `dm_status` | Database statistics |
| `dm_dream` | Run dream consolidation immediately |

## Context Budget / 上下文预算

| Item | Limit | Note |
|---|---|---|
| Identity card | 750 chars | Injected once per session |
| Recall block | 1500 chars | Injected only when relevant and top-3 changes |
| Tool definitions | 5 short tools | One-line descriptions |
| Logs / evidence | 0 | Never injected; use `dm_read` on demand |

The budget is constant no matter whether the database has 100 or 1,000,000 entries.

## Retrieval / 检索原理

```
query
 ├─ scope: global + current project + RELATED linked projects
 ├─ FTS5 trigram lexical recall (Chinese-friendly; LIKE fallback if unavailable)
 ├─ optional vector cosine (DREAM_MEMORY_EMBEDDING_* enables it)
 ├─ graph expansion: walk one hop along knowledge edges (default depth=1)
 ├─ personalized PageRank + importance/confidence/recency re-ranking
 └─ inject compact lines: [id|kind|imp] summary
```

## Dream Consolidation / 梦境整理

- Triggered automatically on session start/backlog and periodically every N turns
- Input: up to 50 new unprocessed events (each truncated to 500 chars)
- Output: strict JSON nodes (`TASK/SKILL/EVENT/FACT/PREFERENCE/DECISION`) and edges
- Discipline: no secrets, no current-code snapshots, no physical deletion; conflicts become `CONFLICTS_WITH` edges
- Graph maintenance (PageRank + communities) runs every 3 dreams

## Optional Semantic Retrieval / 可选语义检索

```bash
export DREAM_MEMORY_EMBEDDING_API_KEY="..."
export DREAM_MEMORY_EMBEDDING_BASE_URL="https://..."
export DREAM_MEMORY_EMBEDDING_MODEL="text-embedding-v4"
export DREAM_MEMORY_EMBEDDING_DIMENSIONS="1024"
```

Without these variables the plugin uses FTS5 only and remains fully functional.

## Export Markdown / 导出 Markdown

```bash
node scripts/export-md.js
# Output: ~/.dsh/dream-memory/export/YYYY-MM-DD.md
```

Markdown is a human-readable view; SQLite is the single source of truth.

## Architecture / 架构

```
dsh.js                     Cordis host adapter (hooks + tools + web API)
lib/settings-client.js         Web UI: settings.section (general settings) + memory browser
src/db.js                  SQLite schema + FTS5 triggers + migrations
src/store.js               upsert/dedup/search/graph/events/vectors
src/recall.js              hybrid recall + scoring
src/graph.js               PageRank + Label Propagation communities
src/dream.js               dream consolidation prompt + validation
src/inject.js              identity card / compact recall lines (hard budget)
src/settings.js            runtime settings (JSON file, panel editable)
src/migrate.js             legacy + Hermes workspace import
scripts/                   migrate / cleanup / export CLI
```

## Design References / 设计参考

- graph-memory: SQLite graph memory, typed nodes/edges, dual-path recall, PageRank, communities, provenance
- dsh-memory-evolve: track separation, stable-track-only injection, project/git-branch isolation, confirmation queue
- OpenClaw dream: async incremental consolidation with bounded LLM budget

## License

MIT