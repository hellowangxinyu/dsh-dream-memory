# dsh-dream-memory

DeepSeek Harness 长期记忆插件：**SQLite + FTS5(trigram) + 知识图谱 + 梦境整理**。

设计目标：记得住、记得多、记得久；**记忆库永远在上下文之外，按需召回**，上下文开销恒定，与记忆条数无关。

- 跨时间：每条记忆带时间戳，日志老化只降权不删除
- 跨会话：`source_refs` 溯源到会话，重启不丢
- 跨项目：`scope = global | project:<hash>` 隔离，`RELATED` 边显式关联跨项目知识
- 按需检索：FTS5 词法召回 + 图邻居扩展 + 个性化 PageRank；向量检索可选
- 最小上下文：身份卡 ≤750 字符、召回块 ≤1500 字符；日志永不注入
- 梦境整理：空闲/每隔 N 轮异步把增量对话提炼成记忆，不挤占对话上下文

---

## 安装

前置：Node.js ≥ 22.5（DSH 本身要求 22.19+，已满足）。

```powershell
cd D:\repos\dsh-dream-memory

# 1. 跑测试（零依赖，无需 npm install）
node --test tests\smoke.test.js

# 2. 安装到 DSH web profile（本地目录 link，与你装 dsh-api-balance 的方式一致）
dsh plugin --profile web add link:D:\repos\dsh-dream-memory

# 3. 重启
dsh web
```

安装后数据库默认在：`~/.dsh/dream-memory/memory.db`

卸载：

```powershell
dsh plugin --profile web remove dsh-dream-memory
```

---

## 旧记忆迁移

### 通道一：dsh-memory-evolve 的 § 分隔 MD（自动）

插件首次启动会**自动、只读、幂等**地导入旧格式：

| 旧文件 | 迁移为 |
|---|---|
| `memories/MEMORY.md` | `fact` / global / active |
| `memories/USER.md` | `profile` / global / active |
| `memories/MEMORY-archive.md`、`USER-archive.md` | status=archived |
| `memories/projects/<hash>/KEY.md` | `key` / `project:<hash>` / active |
| `memories/projects/<hash>/MEMORY.md` | `log`（项目日志） |
| `memories/daily/YYYY-MM-DD.md` | `log`（每日日志） |
| `memories/SUGGESTIONS.jsonl` | status=candidate（待确认） |

也可以手动执行：

```powershell
node scripts\migrate-legacy.js --dry-run   # 先看会导入什么
node scripts\migrate-legacy.js             # 实际导入（幂等）
```

### 通道二：Hermes 风格工作区记忆（自动，如 `D:\Harness`）

当会话工作目录下存在 `MEMORY.md` + `USER.md` 时，插件会在首次进入该目录时自动导入（按 `##` 小节切分，可检索），支持：

`MEMORY.md / USER.md / SOUL.md / AGENTS.md / SESSION-STATE.md / TOOLS.md / HEARTBEAT.md / ONBOARDING.md / memory\*.md`

也可以手动执行：

```powershell
node scripts\migrate-legacy.js --hermes-root "D:\Harness"
```

迁移完成后检查：

```powershell
node scripts\cleanup-legacy.js --check     # 只检查（同时列出 Hermes 根与技能目录）
node scripts\cleanup-legacy.js --move      # 把旧记忆文件移入备份目录（可恢复）
```

最后卸载旧插件（如安装过）：

```powershell
dsh plugin --profile web remove dsh-memory-evolve
```

> 旧记忆文件在 `--move` 前不会被任何代码删除；`--delete --really-delete` 才是真删。

---

## 工具（插件注册给 AI 的能力）

| 工具 | 作用 |
|---|---|
| `dm_remember` | 写入记忆（支持 kind / importance / branches / evidence） |
| `dm_recall` | 按需混合召回，返回压缩记忆行 |
| `dm_read` | 展开全文 / 按条件列出（含日志、候选、归档） |
| `dm_status` | 库统计 |
| `dm_dream` | 立即执行一次梦境整理 |

## 上下文预算（硬限制）

| 项 | 上限 | 说明 |
|---|---|---|
| 身份卡 | 750 字符 | 每会话只注入一次 |
| 召回块 | 1500 字符 | 仅当召回命中且 top-3 变化时注入 |
| 工具定义 | 5 个短工具 | 描述各一行 |
| 日志/证据 | 0 | 永不注入，按需 `dm_read` |

无论库里是 100 条还是 100 万条，以上预算不变。

## 检索原理

```
query
 ├─ 作用域：global + 当前 project + RELATED 关联项目
 ├─ FTS5 trigram 词法召回（中文关键词可靠；FTS 不可用时自动 LIKE 降级）
 ├─ 可选向量 cosine（DREAM_MEMORY_EMBEDDING_* 配置后启用）
 ├─ 图扩展：种子沿知识图谱边扩一跳（默认 depth=1）
 ├─ 个性化 PageRank + 重要性/置信度/新鲜度重排序
 └─ 注入压缩行： [id|kind|imp] 摘要        ← 全文 dm_read 按需展开
```

## 梦境整理

- 触发：每 `dreamInterval`（默认 6）个回合结束、或手动 `dm_dream`
- 输入：上次梦境之后最多 50 条新事件，每条截 500 字
- 输出：严格 JSON 的 `TASK/SKILL/EVENT/FACT/PREFERENCE/DECISION` 节点 + 6 类边
- 纪律：不记录密钥、不记录代码现状、不做物理删除；冲突用 `CONFLICTS_WITH` 边表达
- 图维护：每 3 次梦境重算 PageRank + Label Propagation 社区

## 可选语义检索

```powershell
$env:DREAM_MEMORY_EMBEDDING_API_KEY = "..."
$env:DREAM_MEMORY_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:DREAM_MEMORY_EMBEDDING_MODEL = "text-embedding-v4"
$env:DREAM_MEMORY_EMBEDDING_DIMENSIONS = "1024"
```

未配置时自动使用纯 FTS5，不阻断任何功能。

## 导出 Markdown

```powershell
node scripts\export-md.js
# 输出 ~/.dsh/dream-memory/export/YYYY-MM-DD.md
```

MD 只是给人看和 git 备份的视图，SQLite 是唯一数据源。

## 架构

```
dsh.js                     Cordis 宿主适配器（hooks + 5 个工具）
src/db.js                  SQLite schema + FTS5 触发器 + 迁移
src/store.js               upsert/去重/检索/图边/事件/向量
src/recall.js              混合召回 + 打分
src/graph.js               PageRank + Label Propagation 社区
src/dream.js               梦境：增量抽取 prompt + 校验落库
src/inject.js              身份卡 / 压缩记忆行（硬预算）
src/migrate.js             dsh-memory-evolve 旧格式导入
scripts/                   migrate / cleanup / export 命令行
```

## 设计参考

- graph-memory：SQLite 图记忆、类型化节点/边、双路径召回、PageRank、社区检测、溯源
- dsh-memory-evolve：五轨记忆、只注入稳定轨、项目/git 分支隔离、确认制、渐进披露
- OpenClaw dream：空闲增量整理、独立 LLM 调用、有输入/输出预算

## 发布到 GitHub（开源）

```powershell
.\scripts\publish-github.ps1 -RepoName dsh-dream-memory
```

脚本会依次：跑测试 → git init/commit → `gh repo create --public` → push。
（需要先 `gh auth login`；GitHub 上不要预先建同名仓库。）

## License

MIT
