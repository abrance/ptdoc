import { removeHandle } from './fileHandles';

// ─── 文档树（按 doc_key 的 "/" 分段构建可折叠树）────────────────

interface SidebarDoc {
  id: number;
  doc_key: string;
  title: string;
  filename: string;
}

interface ArchiveEntry {
  id: number;
  doc_key: string;
  title: string;
  archive_path: string;
  share_id: number;
  html_url: string;
  md_url: string | null;
  created_at: number;
  stale: boolean;
}

interface ArchiveFolder {
  id: number;
  path: string;
}

type SidebarMode = 'draft' | 'archive';

interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

type TreeDoc = SidebarDoc & { path: string; html_url?: string; stale?: boolean };
type TreeNode = FolderNode | { type: 'doc'; doc: TreeDoc };

interface SidebarOptions {
  onOpen: (id: number) => void;
  getCurrentKey: () => string;
  onRenamed: (oldKey: string, newKey: string) => void;
  onStatus?: (msg: string, isError?: boolean) => void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (a.type === 'folder' && b.type === 'folder') return a.name.localeCompare(b.name, 'zh');
    const at = (a as { type: 'doc'; doc: TreeDoc }).doc.title;
    const bt = (b as { type: 'doc'; doc: TreeDoc }).doc.title;
    return at.localeCompare(bt, 'zh');
  });
  for (const n of nodes) if (n.type === 'folder') sortTree(n.children);
}

function buildTree(docs: TreeDoc[], extraFolders: string[] = []): TreeNode[] {
  const roots: TreeNode[] = [];
  const folderMap = new Map<string, FolderNode>();
  const getFolder = (path: string): FolderNode => {
    const hit = folderMap.get(path);
    if (hit) return hit;
    const node: FolderNode = {
      type: 'folder',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      children: [],
    };
    folderMap.set(path, node);
    const parentPath = path.lastIndexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parentPath) getFolder(parentPath).children.push(node);
    else roots.push(node);
    return node;
  };
  for (const folderPath of extraFolders) {
    if (folderPath) getFolder(folderPath);
  }
  for (const doc of docs) {
    const segs = doc.path.split('/');
    if (segs.length === 1) roots.push({ type: 'doc', doc });
    else getFolder(segs.slice(0, -1).join('/')).children.push({ type: 'doc', doc });
  }
  sortTree(roots);
  return roots;
}

function renderDoc(doc: TreeDoc, currentKey: string, mode: SidebarMode): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-doc' + (doc.doc_key === currentKey ? ' current' : '');
  li.dataset.docId = String(doc.id);
  if (doc.html_url) li.dataset.htmlUrl = doc.html_url;
  const stale = mode === 'archive' && doc.stale
    ? '<span class="tree-stale" title="草稿已改，尚未重新生成分享版">有未发布改动</span>'
    : '';
  const ops =
    mode === 'archive'
      ? `<button class="tree-op" data-op="move" title="移动" aria-label="移动"><svg class="icon"><use href="#i-pencil"></use></svg></button>
         <button class="tree-op" data-op="open-src" title="打开原稿" aria-label="打开原稿"><svg class="icon"><use href="#i-doc"></use></svg></button>
         <button class="tree-op" data-op="copy" title="复制链接" aria-label="复制链接"><svg class="icon"><use href="#i-link"></use></svg></button>`
      : `<button class="tree-op" data-op="rename" title="重命名" aria-label="重命名"><svg class="icon"><use href="#i-pencil"></use></svg></button>
         <button class="tree-op" data-op="delete" title="删除" aria-label="删除"><svg class="icon"><use href="#i-trash"></use></svg></button>`;
  li.innerHTML = `
    <span class="tree-label" title="${esc(mode === 'archive' ? doc.path : doc.doc_key)}">${esc(doc.title)}</span>
    ${stale}
    <span class="tree-ops">
      ${ops}
    </span>`;
  return li;
}

function renderFolder(folder: FolderNode, currentKey: string, mode: SidebarMode): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-folder open';
  li.dataset.folderPath = folder.path;
  const folderOps =
    mode === 'archive'
      ? `<span class="tree-ops">
           <button class="tree-op" data-op="folder-rename" title="重命名" aria-label="重命名文件夹"><svg class="icon"><use href="#i-pencil"></use></svg></button>
           <button class="tree-op" data-op="folder-delete" title="删除" aria-label="删除文件夹"><svg class="icon"><use href="#i-trash"></use></svg></button>
         </span>`
      : '';
  li.innerHTML = `
    <div class="tree-folder-row">
      <span class="tree-folder-label"><span class="tree-caret">▾</span>${esc(folder.name)}</span>
      ${folderOps}
    </div>`;
  const ul = document.createElement('ul');
  ul.className = 'tree-children';
  for (const c of folder.children) {
    if (c.type === 'folder') ul.appendChild(renderFolder(c, currentKey, mode));
    else ul.appendChild(renderDoc(c.doc, currentKey, mode));
  }
  li.appendChild(ul);
  return li;
}

function renderFlat(docs: TreeDoc[], currentKey: string, mode: SidebarMode): HTMLLIElement[] {
  return docs.map((d) => renderDoc(d, currentKey, mode));
}

// ─── 初始化侧边栏 ────────────────────────────────────────────

export function initSidebar(opts: SidebarOptions): { refresh: () => Promise<void> } {
  const treeEl = document.getElementById('sidebar-tree') as HTMLElement;
  const searchEl = document.getElementById('sidebar-search') as HTMLInputElement;
  const newBtn = document.getElementById('sidebar-new') as HTMLButtonElement;
  const importBtn = document.getElementById('sidebar-import') as HTMLButtonElement;

  const sidebarEl = document.getElementById('sidebar') as HTMLElement;
  const tabDraft = document.getElementById('sidebar-tab-draft') as HTMLButtonElement;
  const tabArchive = document.getElementById('sidebar-tab-archive') as HTMLButtonElement;

  let mode: SidebarMode = 'draft';
  let allDocs: SidebarDoc[] = [];
  let archiveEntries: ArchiveEntry[] = [];
  let archiveFolders: ArchiveFolder[] = [];

  const toDraftDocs = (docs: SidebarDoc[]): TreeDoc[] => docs.map((d) => ({ ...d, path: d.doc_key }));
  const toArchiveDocs = (entries: ArchiveEntry[]): TreeDoc[] =>
    entries.map((e) => ({
      id: e.id,
      doc_key: e.doc_key,
      title: e.title,
      filename: e.archive_path.slice(e.archive_path.lastIndexOf('/') + 1),
      path: e.archive_path,
      html_url: e.html_url,
      stale: e.stale,
    }));

  const paintTree = (docs: TreeDoc[], extraFolders: string[], emptyHtml: string, treeMode: SidebarMode): void => {
    const currentKey = opts.getCurrentKey();
    treeEl.innerHTML = '';
    if (docs.length === 0 && extraFolders.length === 0) {
      treeEl.innerHTML = emptyHtml;
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    const nodes = buildTree(docs, extraFolders);
    for (const n of nodes) {
      if (n.type === 'folder') ul.appendChild(renderFolder(n, currentKey, treeMode));
      else ul.appendChild(renderDoc(n.doc, currentKey, treeMode));
    }
    treeEl.appendChild(ul);
  };

  const renderCurrent = (): void => {
    if (mode === 'archive') {
      paintTree(
        toArchiveDocs(archiveEntries),
        archiveFolders.map((f) => f.path),
        '<div class="tree-empty">还没有归档。生成分享版并上传 HTML 后会出现在这里。</div>',
        'archive',
      );
    } else {
      paintTree(toDraftDocs(allDocs), [], '<div class="tree-empty">暂无文档，点「新建」开始</div>', 'draft');
    }
  };

  const refreshDraft = async (): Promise<void> => {
    const res = await fetch('/api/docs');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    allDocs = (await res.json()) as SidebarDoc[];
  };

  const refreshArchive = async (): Promise<void> => {
    const res = await fetch('/api/archive');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = (await res.json()) as { entries: ArchiveEntry[]; folders: ArchiveFolder[] };
    archiveEntries = data.entries;
    archiveFolders = data.folders;
  };

  const refresh = async (): Promise<void> => {
    try {
      if (mode === 'archive') await refreshArchive();
      else await refreshDraft();
      renderCurrent();
    } catch {
      treeEl.innerHTML = '<div class="tree-empty">加载失败</div>';
    }
  };

  const setMode = (next: SidebarMode): void => {
    mode = next;
    sidebarEl.dataset.mode = next;
    tabDraft.classList.toggle('active', next === 'draft');
    tabArchive.classList.toggle('active', next === 'archive');
    tabDraft.setAttribute('aria-selected', String(next === 'draft'));
    tabArchive.setAttribute('aria-selected', String(next === 'archive'));
    searchEl.placeholder = next === 'archive' ? '过滤归档…' : '过滤文档…';
    searchEl.setAttribute('aria-label', searchEl.placeholder);
    newBtn.title = next === 'archive' ? '新建文件夹' : '新建文档';
    newBtn.setAttribute('aria-label', newBtn.title);
    searchEl.value = '';
    void refresh();
  };

  tabDraft.addEventListener('click', () => setMode('draft'));
  tabArchive.addEventListener('click', () => setMode('archive'));

  // 搜索：有词走 /api/docs?q=（扁平结果），无词恢复树
  searchEl.addEventListener('input', async () => {
    const q = searchEl.value.trim();
    if (!q) {
      renderCurrent();
      return;
    }
    try {
      if (mode === 'archive') {
        const res = await fetch('/api/archive?q=' + encodeURIComponent(q));
        const data = (await res.json()) as { entries: ArchiveEntry[]; folders: ArchiveFolder[] };
        paintTree(
          toArchiveDocs(data.entries),
          data.folders.map((f) => f.path),
          '<div class="tree-empty">没有匹配的归档</div>',
          'archive',
        );
        return;
      }
      const res = await fetch('/api/docs?q=' + encodeURIComponent(q));
      const docs = (await res.json()) as SidebarDoc[];
      treeEl.innerHTML = '';
      const ul = document.createElement('ul');
      ul.className = 'tree-root';
      renderFlat(toDraftDocs(docs), opts.getCurrentKey(), 'draft').forEach((li) => ul.appendChild(li));
      treeEl.appendChild(ul);
    } catch {
      /* 忽略搜索失败 */
    }
  });

  newBtn.addEventListener('click', () => {
    if (mode === 'archive') void createFolder();
    else void createDoc();
  });

  // ─── 批量导入文件夹 ──────────────────────────────────
  importBtn.addEventListener('click', () => void importFolder());

  interface ImportFile {
    relPath: string;
    content: string;
  }

  function titleFromMd(md: string, filename: string): string {
    const m = md.match(/^#\s+(.+)$/m);
    return (m ? m[1].trim() : filename.replace(/\.md$/i, '')).slice(0, 120);
  }

  /** 优先用 File System Access API 选目录；不支持时回退 webkitdirectory 文件框。 */
  function pickMarkdownFiles(): Promise<ImportFile[] | null> {
    const picker = (window as any).showDirectoryPicker;
    if (typeof picker === 'function') {
      return (async () => {
        let dirHandle: any;
        try {
          dirHandle = await picker();
        } catch (e) {
          if ((e as any)?.name === 'AbortError') return null;
          throw e;
        }
        const out: ImportFile[] = [];
        const walk = async (handle: any, prefix: string): Promise<void> => {
          for await (const entry of handle.values()) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === 'directory') await walk(entry, rel);
            else if (/\.(md|markdown)$/i.test(entry.name)) {
              const file = await entry.getFile();
              out.push({ relPath: rel, content: await file.text() });
            }
          }
        };
        await walk(dirHandle, '');
        return out;
      })();
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      (input as any).webkitdirectory = true;
      input.accept = '.md,.markdown';
      input.onchange = async () => {
        const out: ImportFile[] = [];
        for (const file of Array.from(input.files ?? []) as File[]) {
          const rel = (file as any).webkitRelativePath as string;
          if (!rel || !/\.(md|markdown)$/i.test(rel)) continue;
          out.push({ relPath: rel, content: await file.text() });
        }
        resolve(out);
      };
      input.click();
    });
  }

  async function importFolder(): Promise<void> {
    let files: ImportFile[] | null;
    try {
      files = await pickMarkdownFiles();
    } catch (e) {
      opts.onStatus?.('导入失败：' + (e as Error).message, true);
      return;
    }
    if (!files || files.length === 0) return;
    const exists = new Set(allDocs.map((d) => d.doc_key));
    let added = 0;
    let skipped = 0;
    opts.onStatus?.(`正在导入 ${files.length} 篇文档…`);
    for (const f of files) {
      const docKey = f.relPath.replace(/\\/g, '/');
      if (exists.has(docKey)) {
        skipped++;
        continue;
      }
      try {
        const filename = docKey.slice(docKey.lastIndexOf('/') + 1);
        await fetch('/api/docs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            doc_key: docKey,
            title: titleFromMd(f.content, filename),
            filename,
            content: f.content,
          }),
        });
        added++;
      } catch {
        /* 单篇失败继续导入其余 */
      }
    }
    await refresh();
    const skipNote = skipped > 0 ? `，跳过 ${skipped} 篇同名` : '';
    opts.onStatus?.(`导入完成：新增 ${added} 篇${skipNote}`);
  }

  const createDoc = async (): Promise<void> => {
    const path = prompt('新文档路径（可含文件夹，如 notes/我的文档.md）', '新文档.md');
    if (!path || !path.trim()) return;
    const docKey = path.trim();
    const filename = docKey.slice(docKey.lastIndexOf('/') + 1);
    const title = filename.replace(/\.md$/i, '');
    try {
      const res = await fetch('/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_key: docKey, title, filename, content: '' }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = (await res.json()) as { id: number };
      await refresh();
      opts.onOpen(r.id);
    } catch (e) {
      alert('新建失败：' + (e as Error).message);
    }
  };

  async function readError(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as { error?: string };
      return j.error || 'HTTP ' + res.status;
    } catch {
      return 'HTTP ' + res.status;
    }
  }

  const createFolder = async (): Promise<void> => {
    const path = prompt('新文件夹路径（如 项目/2026）', '未命名文件夹');
    if (!path || !path.trim()) return;
    try {
      const res = await fetch('/api/archive/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    } catch (e) {
      alert('新建文件夹失败：' + (e as Error).message);
    }
  };

  // 点击委托：打开文档 / 折叠文件夹 / 重命名 / 删除
  treeEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const opBtn = target.closest<HTMLElement>('.tree-op');
    if (opBtn) {
      const op = opBtn.dataset.op;
      if (op === 'folder-rename' || op === 'folder-delete') {
        const folderPath = opBtn.closest<HTMLElement>('.tree-folder')?.dataset.folderPath;
        if (!folderPath) return;
        if (op === 'folder-rename') await renameFolder(folderPath);
        else await deleteFolder(folderPath);
        return;
      }
      const li = opBtn.closest<HTMLElement>('.tree-doc');
      if (!li) return;
      const id = Number(li.dataset.docId);
      if (op === 'move') {
        const entry = archiveEntries.find((d) => d.id === id);
        if (entry) await moveArchive(entry);
        return;
      }
      if (op === 'open-src') {
        opts.onOpen(id);
        return;
      }
      if (op === 'copy') {
        const url = li.dataset.htmlUrl;
        if (!url) {
          opts.onStatus?.('没有可复制的链接', true);
          return;
        }
        try {
          await navigator.clipboard.writeText(url);
          opts.onStatus?.('已复制链接');
        } catch (err) {
          opts.onStatus?.('复制失败：' + (err as Error).message, true);
        }
        return;
      }
      const doc = allDocs.find((d) => d.id === id);
      if (!doc) return;
      if (op === 'rename') await renameDoc(doc);
      else if (op === 'delete') await deleteDoc(doc);
      return;
    }
    const folderLabel = target.closest<HTMLElement>('.tree-folder-label');
    if (folderLabel) {
      folderLabel.closest('.tree-folder')?.classList.toggle('open');
      return;
    }
    const docLi = target.closest<HTMLElement>('.tree-doc');
    if (docLi && !target.closest('.tree-op')) {
      const id = Number(docLi.dataset.docId);
      if (mode === 'archive') {
        const url = docLi.dataset.htmlUrl;
        if (url) window.open(url, '_blank', 'noopener');
        else opts.onStatus?.('没有可打开的七牛链接', true);
        return;
      }
      opts.onOpen(id);
      void refresh();
    }
  });

  const renameDoc = async (doc: SidebarDoc): Promise<void> => {
    const newKey = prompt('新路径（可含文件夹）', doc.doc_key);
    if (!newKey || newKey.trim() === doc.doc_key) return;
    try {
      const res = await fetch(`/api/docs/${doc.id}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_key: newKey.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await removeHandle(doc.doc_key);
      opts.onRenamed(doc.doc_key, newKey.trim());
      await refresh();
    } catch (err) {
      alert('重命名失败：' + (err as Error).message);
    }
  };

  const deleteDoc = async (doc: SidebarDoc): Promise<void> => {
    if (!confirm(`删除「${doc.title}」？\n仅删除工作区记录，不影响磁盘原文件与图床。`)) return;
    try {
      const res = await fetch(`/api/docs/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await removeHandle(doc.doc_key);
      await refresh();
    } catch (err) {
      alert('删除失败：' + (err as Error).message);
    }
  };

  const moveArchive = async (entry: ArchiveEntry): Promise<void> => {
    const next = prompt('新的归档路径', entry.archive_path);
    if (!next || next.trim() === entry.archive_path) return;
    try {
      const res = await fetch(`/api/docs/${entry.id}/archive-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive_path: next.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    } catch (err) {
      alert('移动失败：' + (err as Error).message);
    }
  };

  const renameFolder = async (from: string): Promise<void> => {
    const to = prompt('新的文件夹路径', from);
    if (!to || to.trim() === from) return;
    try {
      const res = await fetch('/api/archive/folders/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: to.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    } catch (err) {
      alert('重命名失败：' + (err as Error).message);
    }
  };

  const deleteFolder = async (path: string): Promise<void> => {
    if (!confirm(`删除文件夹「${path}」？\n仅当其中没有归档文档时可以删除。`)) return;
    try {
      const res = await fetch('/api/archive/folders?path=' + encodeURIComponent(path), { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    } catch (err) {
      alert('删除失败：' + (err as Error).message);
    }
  };

  refresh();
  return { refresh };
}
