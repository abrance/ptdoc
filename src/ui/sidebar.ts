import { removeHandle } from './fileHandles';

// ─── 文档树（按 doc_key 的 "/" 分段构建可折叠树）────────────────

interface SidebarDoc {
  id: number;
  doc_key: string;
  title: string;
  filename: string;
}

interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

type TreeNode = FolderNode | { type: 'doc'; doc: SidebarDoc };

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

function buildTree(docs: SidebarDoc[]): TreeNode[] {
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
  for (const doc of docs) {
    const segs = doc.doc_key.split('/');
    if (segs.length === 1) roots.push({ type: 'doc', doc });
    else getFolder(segs.slice(0, -1).join('/')).children.push({ type: 'doc', doc });
  }
  return roots;
}

function renderDoc(doc: SidebarDoc, currentKey: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-doc' + (doc.doc_key === currentKey ? ' current' : '');
  li.dataset.docId = String(doc.id);
  li.innerHTML = `
    <span class="tree-label" title="${esc(doc.doc_key)}">${esc(doc.title)}</span>
    <span class="tree-ops">
      <button class="tree-op" data-op="rename" title="重命名">✎</button>
      <button class="tree-op" data-op="delete" title="删除">🗑</button>
    </span>`;
  return li;
}

function renderFolder(folder: FolderNode, currentKey: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-folder open';
  li.innerHTML = `
    <span class="tree-folder-label"><span class="tree-caret">▾</span>${esc(folder.name)}</span>`;
  const ul = document.createElement('ul');
  ul.className = 'tree-children';
  for (const c of folder.children) {
    if (c.type === 'folder') ul.appendChild(renderFolder(c, currentKey));
    else ul.appendChild(renderDoc(c.doc, currentKey));
  }
  li.appendChild(ul);
  return li;
}

function renderFlat(docs: SidebarDoc[], currentKey: string): HTMLLIElement[] {
  return docs.map((d) => renderDoc(d, currentKey));
}

// ─── 初始化侧边栏 ────────────────────────────────────────────

export function initSidebar(opts: SidebarOptions): { refresh: () => Promise<void> } {
  const treeEl = document.getElementById('sidebar-tree') as HTMLElement;
  const searchEl = document.getElementById('sidebar-search') as HTMLInputElement;
  const newBtn = document.getElementById('sidebar-new') as HTMLButtonElement;
  const importBtn = document.getElementById('sidebar-import') as HTMLButtonElement;

  let allDocs: SidebarDoc[] = [];

  const render = (docs: SidebarDoc[]): void => {
    const currentKey = opts.getCurrentKey();
    treeEl.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    const nodes = buildTree(docs);
    for (const n of nodes) {
      if (n.type === 'folder') ul.appendChild(renderFolder(n, currentKey));
      else ul.appendChild(renderDoc(n.doc, currentKey));
    }
    if (docs.length === 0) {
      treeEl.innerHTML = '<div class="tree-empty">暂无文档，点 ＋ 新建</div>';
      return;
    }
    treeEl.appendChild(ul);
  };

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch('/api/docs');
      allDocs = (await res.json()) as SidebarDoc[];
      render(allDocs);
    } catch {
      treeEl.innerHTML = '<div class="tree-empty">加载失败</div>';
    }
  };

  // 搜索：有词走 /api/docs?q=（扁平结果），无词恢复树
  searchEl.addEventListener('input', async () => {
    const q = searchEl.value.trim();
    if (!q) {
      render(allDocs);
      return;
    }
    try {
      const res = await fetch('/api/docs?q=' + encodeURIComponent(q));
      const docs = (await res.json()) as SidebarDoc[];
      treeEl.innerHTML = '';
      const ul = document.createElement('ul');
      ul.className = 'tree-root';
      renderFlat(docs, opts.getCurrentKey()).forEach((li) => ul.appendChild(li));
      treeEl.appendChild(ul);
    } catch {
      /* 忽略搜索失败 */
    }
  });

  newBtn.addEventListener('click', () => createDoc());

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

  // 点击委托：打开文档 / 折叠文件夹 / 重命名 / 删除
  treeEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const opBtn = target.closest<HTMLElement>('.tree-op');
    if (opBtn) {
      const li = opBtn.closest<HTMLElement>('.tree-doc');
      if (!li) return;
      const id = Number(li.dataset.docId);
      const doc = allDocs.find((d) => d.id === id);
      if (!doc) return;
      const op = opBtn.dataset.op;
      if (op === 'rename') await renameDoc(doc);
      else if (op === 'delete') await deleteDoc(doc);
      return;
    }
    const folderLabel = target.closest<HTMLElement>('.tree-folder-label');
    if (folderLabel) {
      folderLabel.parentElement?.classList.toggle('open');
      return;
    }
    const docLi = target.closest<HTMLElement>('.tree-doc');
    if (docLi && !target.closest('.tree-op')) {
      const id = Number(docLi.dataset.docId);
      opts.onOpen(id);
      refresh();
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
      if (!res.ok) throw new Error(await res.text());
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

  refresh();
  return { refresh };
}
