/**
 * 版本快照迁移（user_version 8）的回滚脚本（FR-21~24「down 可回滚」）。
 *
 * 用法：node --experimental-strip-types scripts/snapshot-migrate-down.ts [db文件]
 * 默认 data/ptdoc.db。先自动备份，再整表重建去掉 doc_versions 新增列并删除 user_settings；
 * 不删任何快照行、不影响 shares/docs。回滚后 user_version=7，服务仍可启动。
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
if (ver < 8) {
  console.log(`当前 user_version=${ver}，无需回滚`);
  d.close();
  process.exit(0);
}

d.exec('PRAGMA foreign_keys = OFF');
d.exec('BEGIN');
try {
  d.exec(`
    CREATE TABLE doc_versions_old (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id     INTEGER NOT NULL REFERENCES docs(id),
      content    TEXT NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO doc_versions_old (id, doc_id, content, label, created_at)
    SELECT id, doc_id, content, label, created_at FROM doc_versions;
    DROP TABLE doc_versions;
    ALTER TABLE doc_versions_old RENAME TO doc_versions;
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(doc_id, created_at DESC);
    DROP INDEX IF EXISTS idx_versions_doc_kind;
    DROP TABLE IF EXISTS user_settings;
  `);
  d.exec('PRAGMA user_version = 7');
  d.exec('COMMIT');
  const n = (d.prepare('SELECT COUNT(*) AS n FROM doc_versions').get() as { n: number }).n;
  console.log(`回滚完成：doc_versions 恢复 5 列，user_settings 已删除，保留 ${n} 条快照。`);
} catch (e) {
  d.exec('ROLLBACK');
  console.error('回滚失败，已回滚事务：' + (e as Error).message);
  d.close();
  process.exit(1);
} finally {
  d.exec('PRAGMA foreign_keys = ON');
}
d.close();
