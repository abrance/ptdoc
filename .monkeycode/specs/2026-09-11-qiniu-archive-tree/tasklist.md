 # Implementation Tasks

 Feature: qiniu-archive-tree

 1. db schema: docs.archive_path, archive_folders, shares.source_content_sha256
 2. db CRUD: ensureArchivePath, listArchive, folders, updateArchivePath, stale hash
 3. HTTP: GET /api/archive, archive-path, folder create/rename/delete
 4. sidebar tabs: 草稿 | 归档, tree ops, empty state, stale badge
 5. share html_url write triggers ensureArchivePath and sidebar refresh
 6. tests in db.test.ts (9 cases)
