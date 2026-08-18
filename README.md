# dsh-dream-memory

> Long-term memory for DeepSeek Harness — SQLite + FTS5(trigram) + knowledge graph + dream consolidation.
> DeepSeek Harness 长期记忆插件 —— SQLite + FTS5(trigram) + 知识图谱 + 梦境整理。

[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-blue)]() [![License](https://img.shields.io/badge/license-MIT-green)]() [![DSH](https://img.shields.io/badge/DSH-web--profile-purple)]()

---

## Design Philosophy / 设计哲学

| English | 中文 |
|---|---|
| Remember more, remember longer, never blow the context | 记得多、记得久，且不撑爆上下文 |
| Memory lives outside the context; relevant pieces injected on demand | 记忆库在上下文之外，按需召回 |
| Cross-session, cross-project, cross-time | 跨会话、跨项目、跨时间 |
| **Filter first, then store** — the dream LLM is a strict gate, not a dumping ground | **先筛选再存入** — 梦境 LLM 是严格闸门，不是垃圾桶 |
| Dream system consolidates, archives, and keeps the truly efficient final memory | 梦境系统整理、归档、保存真正高效简洁的最终记忆 |
| Read on demand, not pre-load | 后续需要时再读，不预加载 |
| Plugin must be **invisible** — no LLM on write path, no background token cost | 插件必须**无感** — 写路径不调 LLM，不在后台偷偷花 token |
| Recall must be **instant** (SLA < 500ms) | 召回必须**瞬间**（SLA < 500ms）|

`记住多、记得久、不撑爆上下文、跨会话、跨项目、跨时间。先筛选，再存入。梦境整理归档。后续按需读取。瞬间定位。无感。` — this is the contract.

`这是契约。所有改动必须对齐这 7 条。`

---

## Features / 特性

| English | 中文 |
|---|---|
| **Filter-first entry gate** — dream prompt enforces reject list + decision threshold + self-check (90 days later, would I still need this?) | **先筛选闸门** — dream prompt 强制拒收清单 + 决策门槛 + 自检（90 天后还会需要吗？）|
| **Auto decay** — active memories created 90+ days ago, never accessed, importance < 0.7 → archived automatically | **自动归档** — 创建 90 天 + 从未访问 + importance < 0.7 → 自动归档 |
| **Auto merge** — pairs of memories with summary Jaccard > 0.5 → collapsed into one (0-LLM, pure SQL) | **自动合并** — summary Jaccard > 0.5 的相似记忆对合并为一条（0-LLM 纯 SQL）|
| **Access boost** — every access +0.05 importance (cap 0.95), 1-min debounce to prevent burst inflation | **访问提权** — 每次访问 +0.05 importance（cap 0.95），1 分钟防抖防止高频抖动 |
| **Recall SLA** — hard test guarantees recall < 500ms with 100+ entries | **召回 SLA** — 硬测试保证 100+ 条记忆下 recall < 500ms |
| Cross-session, cross-project, cross-time | 跨会话、跨项目、跨时间 |
| SQLite + FTS5 trigram for reliable Chinese retrieval | SQLite + FTS5 trigram 中文检索可靠 |
| Optional knowledge graph (PageRank + community detection) | 可选知识图谱（PageRank + 社区检测）|
| Async dream consolidation with bounded LLM cost | 异步梦境整理，LLM 成本有上限 |
| Web settings panel, changes apply immediately | Web 设置面板，保存后立即生效 |

---

## Requirements / 环境要求

- Node.js ≥ 22.5 (DSH already requires 22.19+)  /  Node.js ≥ 22.5（DSH 自身要求 22.19+）
- DeepSeek Harness with web profile  /  DeepSeek Harness 需要 web profile

---

## Installation / 安装

```bash
# Run tests (zero runtime dependencies)
node --test tests/smoke.test.js

# Install into the DSH web profile (local directory / git URL / npm package)
dsh plugin --profile web add <path-or-url>

# Restart DSH web
dsh web
```

Default database: `~/.dsh/dream-memory/memory.db`  /  默认数据库：`~/.dsh/dream-memory/memory.db`

Uninstall:  /  卸载：

```bash
dsh plugin --profile web remove dsh-dream-memory
```

---

## Settings Panel / 设置面板

A **Memory** section appears under **Settings → General Settings**, with **live stats** and **12 runtime-adjustable options**. Changes take effect immediately — no restart needed.

在 **Settings → General Settings** 下出现 **Memory** 板块，提供**实时统计**和 **12 个运行时可调参数**。改动立即生效，无需重启。

| English | 中文 | Default | Type |
|---|---|---|---|
| Auto recall | 自动召回 | `true` | boolean |
| Dream consolidation | 梦境整理 | `true` | boolean |
| Legacy import | 旧格式导入 | `true` | boolean |
| Recall K | 召回条数 | `6` | 3-10 |
| Graph depth | 图扩展深度 | `1` | 0-3 |
| Dream interval (turns) | 梦境间隔（回合）| `6` | 3-30 |
| Dream min events | 梦境最小事件数 | `10` | 1-50 |
| Dream min hours | 梦境最小间隔（小时）| `20` | 1-168 |
| Dream max cards | 梦境输入卡片上限 | `20` | 5-50 |
| Dream max tokens | 梦境输出预算（token）| `1024` | 256-4096 |
| Identity card chars | 身份卡字符上限 | `750` | 200-3000 |
| Recall block chars | 召回块字符上限 | `1500` | 300-6000 |
| **Auto decay** | **自动归档** | `true` | boolean |
| **Decay threshold (days)** | **归档阈值（天）** | `90` | 7-365 |
| **Auto merge** | **合并相似记忆** | `false` | boolean |

---

## Tools / AI 工具

| Tool | English | 中文 |
|---|---|---|
| `dm_remember` | Write a long-term memory | 写入一条长期记忆 |
| `dm_recall` | Hybrid on-demand recall (FTS5 + graph), SLA < 500ms | 混合召回（FTS5 + 图谱），SLA < 500ms |
| `dm_read` | Read full content or list memories/logs/archives | 读取完整内容或列出记忆/日志/归档 |
| `dm_status` | Database statistics | 数据库统计 |
| `dm_dream` | Run dream consolidation immediately | 立即运行一次梦境整理 |
| `dm_consolidate` | Audit + archive label-only / vague summaries (no LLM) | 审计 + 归档标签型/模糊摘要（不调 LLM）|
| `dm_stats_extended` | Cross-session dashboard: volume, health, top access, recent activity | 跨会话仪表盘：体量、健康度、Top 访问、最近活动 |

---

## Memory Hygiene / 记忆卫生

The plugin enforces a **zero-maintenance** model: the library is curated by `dream`, not by humans.

插件强制**零维护**模式：库由梦境系统管理，不是由人手动清理。

### 1. Filter-first entry gate / 先筛选再存入

The dream prompt (in `src/dream.js` `EXTRACT_SYS`) enforces:

梦境 prompt（在 `src/dream.js` 的 `EXTRACT_SYS` 中）强制执行：

| Rule | 规则 |
|---|---|
| **Reject list**: chit-chat, repeated info, transient states, speculation, current-code snapshots, one-time events, secrets/PII | **拒收清单**：闲聊、重复信息、临时状态、推测、代码现状、一次性事件、敏感信息 |
| **Decision threshold** (any 1): user explicit "remember", repeated confirmation, part of stable workflow, real problem solved, cross-session reusable | **决策门槛**（任一）：用户明示"记住"、重复确认、稳定工作流的一部分、解决了真实问题、跨会话可复用 |
| **Self-check** before every node: would I still need this 90 days later? | **每个节点前自检**：90 天后还会需要吗？|
| **Density cap**: ≤ 5 nodes per kind (down from 8) | **密度上限**：每类 ≤ 5 个节点（从 8 降低）|

### 2. Auto decay / 自动归档

Enabled by default. Runs at the end of every dream (every ~20h). Pure SQL, 0 tokens.

默认开启。每次梦境跑完时执行（~20h 一次）。纯 SQL，0 token。

Rule  /  规则：

```sql
status='active'
  AND importance < 0.7
  AND validated_count <= 1
  AND last_accessed_at IS NULL
  AND created_at < (now - {decayStaleDays} days)
```

### 3. Auto merge / 自动合并

**Off by default** — opt-in via settings panel. Once enabled, runs at the end of every dream. Pure SQL, 0 tokens.

**默认关闭** — 在设置面板手动开启。开启后每次梦境跑完时执行。纯 SQL，0 token。

Rule  /  规则：merge pairs of active memories with summary Jaccard > 0.5 (same kind, no LLM call). The higher-scored memory keeps its identity, the lower-scored one is archived; their content is merged.

规则：合并 summary Jaccard > 0.5 的同 kind 活跃记忆对（不调 LLM）。高分胜出保留身份，低分归档；content 合并。

### 4. Access boost / 访问提权

When `recall` returns a memory, `touchMemory` is called:

召回命中记忆时调 `touchMemory`：

- `access_count += 1`
- `last_accessed_at = now`
- `importance = min(0.95, importance + 0.05)` — 1 minute debounce to prevent burst inflation
- `importance = min(0.95, importance + 0.05)` — 1 分钟防抖，防止高频抖动

Default 0.6 → 0.65 → 0.70 → ... → 0.95 (7 accesses to saturate).

默认 0.6 → 0.65 → 0.70 → ... → 0.95（7 次访问涨到顶）。

This is the **dual of decay**: accessed memories grow in importance, ignored ones decay.

这是 decay 的**对偶**：被用的记忆涨权重，没被用的衰减。

---

## Recall SLA / 召回 SLA

| Library size | Recall (ms) | SLA |
|---|---|---|
| 100 entries | ~83 (tested) | < 500 |
| 1000 entries | < 200 (estimated) | < 500 |

A regression test in `tests/smoke.test.js` runs 5 recall calls against 100 seeded memories and asserts the **max** is below 500ms. If a future change breaks the SLA, the test fails.

`tests/smoke.test.js` 中有一个回归测试：灌 100 条记忆跑 5 次 recall，断言**最大**耗时 < 500ms。如果未来改动破坏 SLA，测试会失败。

---

## Context Budget / 上下文预算

| Item | English | 中文 | Limit | Note |
|---|---|---|---|---|
| Identity card | 身份卡 | /  身份卡 | 750 chars | Injected once per session  /  每会话注入一次 |
| Recall block | 召回块 | /  召回块 | 1500 chars | Injected only when relevant, top-3 changes  /  仅相关时注入，Top-3 变化时 |
| Tool definitions | 工具定义 | /  工具定义 | 5 short tools | One-line descriptions  /  一行描述 |
| Logs / evidence | 日志/证据 | /  日志/证据 | 0 | Never injected; use `dm_read` on demand  /  从不注入；按需 `dm_read` |

The budget is constant no matter whether the database has 100 or 1,000,000 entries.

预算恒定，不受数据库规模影响（100 条还是 1,000,000 条）。

---

## Migration / 旧记忆迁移

### dsh-memory-evolve format (automatic) / 自动

The plugin automatically and idempotently imports legacy `§`-separated Markdown:

插件自动且幂等地导入旧的 `§`-分隔 Markdown：

| Old file | Becomes |
|---|---|
| `memories/MEMORY.md` | `fact` / global / active |
| `memories/USER.md` | `profile` / global / active |
| `memories/MEMORY-archive.md`, `USER-archive.md` | status=archived |
| `memories/projects/<hash>/KEY.md` | `key` / project / active |
| `memories/projects/<hash>/MEMORY.md` | `log` |
| `memories/daily/YYYY-MM-DD.md` | `log` |
| `memories/SUGGESTIONS.jsonl` | candidate |

Manual:  /  手动：

```bash
node scripts/migrate-legacy.js --dry-run
node scripts/migrate-legacy.js
```

### Hermes-style workspace (automatic) / Hermes 风格工作区（自动）

If the session working directory contains `MEMORY.md` + `USER.md`, the plugin imports that workspace on first entry. Supported files:

如果会话工作目录包含 `MEMORY.md` + `USER.md`，插件首次进入时自动导入。支持的文件：

`MEMORY.md / USER.md / SOUL.md / AGENTS.md / SESSION-STATE.md / TOOLS.md / HEARTBEAT.md / ONBOARDING.md / memory/*.md`

Manual:  /  手动：

```bash
node scripts/migrate-legacy.js --hermes-root "/path/to/workspace"
```

### Cleanup / 清理

```bash
node scripts/cleanup-legacy.js --check   # preview only  /  仅预览
node scripts/cleanup-legacy.js --move    # move old files to a backup directory (recoverable)  /  移到备份目录（可恢复）
```

> Old files are never deleted unless you explicitly use `--delete --really-delete`.
> 除非显式传 `--delete --really-delete`，旧文件永远不会被删除。

---

## Retrieval / 检索原理

```
query
 ├─ scope: global + current project + RELATED linked projects
 ├─ FTS5 trigram lexical recall (Chinese-friendly; LIKE fallback if unavailable)
 ├─ optional vector cosine (DREAM_MEMORY_EMBEDDING_* enables it)
 ├─ graph expansion: walk one hop along knowledge edges (default depth=1)
 ├─ personalized PageRank + importance/confidence/recency re-ranking
 ├─ touchMemory boost: accessed memories get +0.05 importance each
 └─ inject compact lines: [id|kind|imp] summary
```

```
query
 ├─ scope: global + 当前项目 + RELATED 关联项目
 ├─ FTS5 trigram 词法召回（中文友好；不可用时降级 LIKE）
 ├─ 可选向量 cosine（需 DREAM_MEMORY_EMBEDDING_* 环境变量）
 ├─ 图扩展：沿知识边走 1 hop（默认 depth=1）
 ├─ 个性化 PageRank + importance/confidence/recency 重排
 ├─ 访问提权：被召回记忆每次 +0.05 importance
 └─ 注入紧凑行：[id|kind|imp] summary
```

---

## Dream Consolidation / 梦境整理

| English | 中文 |
|---|---|
| Triggered automatically on backlog and periodically every N turns | 事件积压或每 N 回合自动触发 |
| Input: up to `{dreamMaxCards}` new unprocessed events (each truncated to 500 chars) | 输入：最多 `{dreamMaxCards}` 条新未处理事件（每条截 500 字）|
| Output: strict JSON nodes (`TASK/SKILL/EVENT/FACT/PREFERENCE/DECISION`) and edges | 输出：严格 JSON 节点（`TASK/SKILL/EVENT/FACT/PREFERENCE/DECISION`）和边 |
| Discipline: no secrets, no current-code snapshots, no chit-chat; conflicts become `CONFLICTS_WITH` edges | 纪律：禁密钥、禁代码现状、禁闲聊；冲突变 `CONFLICTS_WITH` 边 |
| After extraction: **decay** stale + **merge** similar (if enabled) | 提取后：**归档**过时 + **合并**相似（可启用）|
| Graph maintenance (PageRank + communities) runs every 3 dreams | 图维护（PageRank + 社区）每 3 次梦境重算一次 |

---

## Optional Semantic Retrieval / 可选语义检索

```bash
export DREAM_MEMORY_EMBEDDING_API_KEY="..."
export DREAM_MEMORY_EMBEDDING_BASE_URL="https://..."
export DREAM_MEMORY_EMBEDDING_MODEL="text-embedding-v4"
export DREAM_MEMORY_EMBEDDING_DIMENSIONS="1024"
```

Without these variables the plugin uses FTS5 only and remains fully functional.

未设这些变量时，插件只用 FTS5，依然完全可用。

---

## Export Markdown / 导出 Markdown

```bash
node scripts/export-md.js
# Output: ~/.dsh/dream-memory/export/YYYY-MM-DD.md
```

Markdown is a human-readable view; SQLite is the single source of truth.

Markdown 是给人看的视图，SQLite 是唯一真源。

---

## Architecture / 架构

```
dsh.js                     Cordis host adapter (hooks + tools + web API)
lib/settings-client.js         Web UI: settings.section (general settings) + memory browser
src/db.js                  SQLite schema + FTS5 triggers + migrations
src/store.js               upsert/dedup/search/graph/events/vectors
                            + decayStaleMemories / mergeSimilarMemories
                            + getDashboardStats / archiveMemoryWithReason
src/recall.js              hybrid recall + scoring
src/graph.js               PageRank + Label Propagation communities
src/dream.js               dream consolidation prompt + validation
                            + strict filter (reject list + decision threshold)
src/inject.js              identity card / compact recall lines (hard budget)
src/settings.js            runtime settings (JSON file, panel editable)
src/migrate.js             legacy + Hermes workspace import
scripts/                   migrate / cleanup / export CLI
tests/smoke.test.js        24 regression tests including recall SLA
```

---

## Tests / 测试

```bash
node --test tests/smoke.test.js
```

24 tests covering:  /  24 个测试覆盖：

- upsert / dedup / graph  /  upsert / 去重 / 图
- recall SLA < 500ms
- analyzeMemoryQuality (label-only + vague detection)
- archiveMemoryWithReason / updateMemorySummary
- decayStaleMemories (3 时长场景)
- mergeSimilarMemories (3 隔离场景)
- touchMemory access boost (含 1 分钟防抖 + cap 0.95)
- getDashboardStats (体量 + 健康 + Top + 最近)

---

## Design References / 设计参考

- graph-memory: SQLite graph memory, typed nodes/edges, dual-path recall, PageRank, communities, provenance
- dsh-memory-evolve: track separation, stable-track-only injection, project/git-branch isolation, confirmation queue
- OpenClaw dream: async incremental consolidation with bounded LLM budget

---

## License / 许可

MIT
