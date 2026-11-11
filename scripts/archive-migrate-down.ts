/**
 * 归档产物迁移（user_version 7）的回滚脚本（FR-19「回滚」）。
 *
 * 用法：node --experimental-strip-types scripts/archive-migrate-down.ts [db文件]
 * 默认 data/ptdoc.db。先自动备份，再整表重建去掉新增列；不删任何行、不删对象存储文件。
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv[2] || join(process.cwd(), 'data', 'ptdoc.db');
if (!existsSync(file)) {
  console.error('数据库不存在：' + file);
  process.exit(1);
}
const bak = `${file}.down-bak-${Date.now()}`;
copyFileSync(file, bak);
console.log('已备份：' + bak);

const d = new DatabaseSync(file);
const ver = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (ver < 7) {
  console.log(`当前 user_version=${ver}，无需回滚`);
  process.exit(0);
}

d.exec('PRAGMA foreign_keys = OFF');
d.exec('BEGIN');
try {
  d.exec(`
    CREATE TABLE shares_old (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 0,
      doc_key    TEXT,
      share_md   TEXT NOT NULL,
      md_url     TEXT,
      html_url   TEXT,
      created_at INTEGER NOT NULL,
      source_content_sha256 TEXT
    );
    INSERT INTO shares_old (id, user_id, doc_key, share_md, md_url, html_url, created_at, source_content_sha256)
    SELECT id, user_id, doc_key, share_md, md_url, html_url, created_at, source_content_sha256 FROM shares;
    DROP TABLE shares;
    ALTER TABLE shares_old RENAME TO shares;
    CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(doc_key);
    DROP INDEX IF EXISTS ux_shares_active;
    DROP INDEX IF EXISTS ux_docs_archive_token;
  `);

  // docs 去掉 archive_token（SQLite 删列需整表重建）
  d.exec(`
    CREATE TABLE docs_old (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL DEFAULT 0,
      doc_key     TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      filename    TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL DEFAULT 0,
      archive_path TEXT,
      qdrant_sync_share_id INTEGER,
      qdrant_synced_at INTEGER,
      UNIQUE(user_id, doc_key)
    );
    INSERT INTO docs_old (id, user_id, doc_key, title, filename, content, created_at, updated_at,
                          last_opened_at, archive_path, qdrant_sync_share_id, qdrant_synced_at)
    SELECT id, user_id, doc_key, title, filename, content, created_at, updated_at,
           last_opened_at, archive_path, qdrant_sync_share_id, qdrant_synced_at FROM docs;
    DROP TABLE docs;
    ALTER TABLE docs_old RENAME TO docs;
    CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_docs_user ON docs(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_archive_path ON docs(user_id, archive_path) WHERE archive_path IS NOT NULL;
  `);
  d.exec('PRAGMA user_version = 6');
  d.exec('COMMIT');
  console.log('回滚完成：shares 恢复为分享表，docs.archive_token 已移除，未删除任何行。');
} catch (e) {
  d.exec('ROLLBACK');
  console.error('回滚失败，已回滚事务：' + (e as Error).message);
  process.exit(1);
} finally {
  d.exec('PRAGMA foreign_keys = ON');
  d.close();
}
