/**
 * dsh-dream-memory — SQLite 数据库层
 *
 * 零运行时依赖：使用 Node 22.5+ 内置的 node:sqlite（同步 API）。
 * 核心表：memories（统一记忆条目） / links（知识图谱边） / messages（原始事件）
 *        evidence（证据） / vectors（可选向量） / meta / dreams（梦境审计）。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

export function resolvePath(p) {
  if (typeof p !== 'string' || p === '') return p
  return p.replace(/^~(?=$|[\\/])/, homedir())
}

function ensureParentDir(filePath) {
  const resolved = resolvePath(filePath)
  const last = Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\'))
  if (last > 0) mkdirSync(resolved.slice(0, last), { recursive: true })
}

/**
 * 打开（必要时创建并迁移）数据库。
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(dbPath) {
  const resolved = resolvePath(dbPath)
  ensureParentDir(resolved)
  const db = new DatabaseSync(resolved)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)')
  const row = db.prepare('SELECT MAX(v) AS v FROM _migrations').get()
  const cur = row?.v ?? 0
  const steps = [m1_core, m2_fts, m3_meta]
  for (let i = cur; i < steps.length; i++) {
    steps[i](db)
    db.prepare('INSERT INTO _migrations (v, at) VALUES (?, ?)').run(i + 1, Date.now())
  }
}

function m1_core(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL CHECK (kind IN
                      ('profile','key','log','task','skill','event',
                       'fact','preference','decision')),
      layer           INTEGER NOT NULL DEFAULT 0,
      scope           TEXT NOT NULL DEFAULT 'global',
      project_id      TEXT,
      project_label   TEXT,
      branch          TEXT,
      name            TEXT,
      summary         TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      importance      REAL NOT NULL DEFAULT 0.5,
      confidence      REAL NOT NULL DEFAULT 1.0,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                      ('active','candidate','archived','superseded')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      content_hash    TEXT NOT NULL,
      source_refs     TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count    INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_hash ON memories(content_hash);
    CREATE INDEX IF NOT EXISTS ix_mem_scope ON memories(scope, status, layer);
    CREATE INDEX IF NOT EXISTS ix_mem_kind ON memories(kind, status);
    CREATE INDEX IF NOT EXISTS ix_mem_project ON memories(project_id, status);
    CREATE INDEX IF NOT EXISTS ix_mem_name ON memories(name);
    CREATE INDEX IF NOT EXISTS ix_mem_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS ix_mem_access ON memories(last_accessed_at);

    CREATE TABLE IF NOT EXISTS links (
      from_id     TEXT NOT NULL REFERENCES memories(id),
      to_id       TEXT NOT NULL REFERENCES memories(id),
      type        TEXT NOT NULL CHECK (type IN
                  ('USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH','RELATED')),
      instruction TEXT NOT NULL DEFAULT '',
      condition   TEXT,
      weight      REAL NOT NULL DEFAULT 1.0,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    );
    CREATE INDEX IF NOT EXISTS ix_links_from ON links(from_id);
    CREATE INDEX IF NOT EXISTS ix_links_to ON links(to_id);

    CREATE TABLE IF NOT EXISTS evidence (
      id         TEXT PRIMARY KEY,
      memory_id  TEXT NOT NULL REFERENCES memories(id),
      kind       TEXT NOT NULL,
      ref        TEXT NOT NULL,
      excerpt    TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      extracted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_msg_session ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS ix_msg_extracted ON messages(extracted, seq);

    CREATE TABLE IF NOT EXISTS vectors (
      memory_id    TEXT PRIMARY KEY REFERENCES memories(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dreams (
      id          TEXT PRIMARY KEY,
      session_id  TEXT,
      cursor_seq  INTEGER NOT NULL DEFAULT 0,
      input_cards INTEGER NOT NULL DEFAULT 0,
      ops         INTEGER NOT NULL DEFAULT 0,
      tokens      INTEGER NOT NULL DEFAULT 0,
      at          INTEGER NOT NULL
    );
  `)
}

/**
 * FTS5：优先 trigram（中文关键词/子串匹配可靠）。
 * 若当前 SQLite 构建不支持，逐级降级到默认 tokenizer，最后关闭 FTS。
 */
function m2_fts(db) {
  let mode = 'none'
  for (const tokenize of ['trigram', '']) {
    const tokenPart2 = tokenize ? `, tokenize='${tokenize}'` : ''
    const tokenPart = tokenize ? `, tokenize='${tokenize}'` : ''
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
          name, summary, content,
          content=memories, content_rowid=rowid${tokenPart}
        );
      `)
      mode = tokenize || 'default'
      break
    } catch {
      // try next
    }
  }

  if (mode !== 'none') {
    try {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS mem_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO mem_fts(rowid, name, summary, content)
          VALUES (NEW.rowid, NEW.name, NEW.summary, NEW.content);
        END;
        CREATE TRIGGER IF NOT EXISTS mem_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO mem_fts(mem_fts, rowid, name, summary, content)
          VALUES ('delete', OLD.rowid, OLD.name, OLD.summary, OLD.content);
        END;
        CREATE TRIGGER IF NOT EXISTS mem_fts_au AFTER UPDATE ON memories BEGIN
          INSERT INTO mem_fts(mem_fts, rowid, name, summary, content)
          VALUES ('delete', OLD.rowid, OLD.name, OLD.summary, OLD.content);
          INSERT INTO mem_fts(rowid, name, summary, content)
          VALUES (NEW.rowid, NEW.name, NEW.summary, NEW.content);
        END;
      `)
    } catch {
      // triggers failed -> FTS unusable
      mode = 'none'
      try { db.exec('DROP TABLE IF EXISTS mem_fts') } catch {}
    }
  }

  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('fts_mode', mode)
}

function m3_meta(db) {
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('dream_cursor', '0')
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('pagerank_at', '0')
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key)
  return row?.value ?? null
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value))
}
