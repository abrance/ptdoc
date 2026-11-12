import { removeHandle } from './fileHandles';
import { askConfirm, askText } from './dialog';

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

type TreeDoc = SidebarDoc & { path: string };
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

function renderDoc(doc: TreeDoc, currentKey: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-doc' + (doc.doc_key === currentKey ? ' current' : '');
  li.dataset.docId = String(doc.id);
  const ops = `<button class="tree-op" data-op="rename" title="重命名" aria-label="重命名"><svg class="icon"><use href="#i-pencil"></use></svg></button>
         <button class="tree-op" data-op="delete" title="删除" aria-label="删除"><svg class="icon"><use href="#i-trash"></use></svg></button>`;
  li.innerHTML = `
    <svg class="icon tree-doc-icon"><use href="#i-doc"></use></svg>
    <span class="tree-label" title="${esc(doc.doc_key)}">${esc(doc.title)}</span>
    <span class="tree-ops">
      ${ops}
    </span>`;
  return li;
}

function renderFolder(folder: FolderNode, currentKey: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'tree-folder open';
  li.dataset.folderPath = folder.path;
  li.innerHTML = `
    <div class="tree-folder-row">
      <span class="tree-folder-label">
        <span class="tree-caret" aria-hidden="true">
          <svg class="icon"><use href="#i-caret"></use></svg>
        </span>
        <svg class="icon tree-folder-icon"><use href="#i-folder"></use></svg>
        <span class="tree-name">${esc(folder.name)}</span>
      </span>
    </div>`;
  const ul = document.createElement('ul');
  ul.className = 'tree-children';
  for (const c of folder.children) {
    if (c.type === 'folder') ul.appendChild(renderFolder(c, currentKey));
    else ul.appendChild(renderDoc(c.doc, currentKey));
  }
  li.appendChild(ul);
  return li;
}

function renderFlat(docs: TreeDoc[], currentKey: string): HTMLLIElement[] {
  return docs.map((d) => renderDoc(d, currentKey));
}

// ─── 初始化侧边栏 ────────────────────────────────────────────

export function initSidebar(opts: SidebarOptions): { refresh: () => Promise<void> } {
  const treeEl = document.getElementById('sidebar-tree') as HTMLElement;
  const searchEl = document.getElementById('sidebar-search') as HTMLInputElement;
  const newBtn = document.getElementById('sidebar-new') as HTMLButtonElement;
  const importBtn = document.getElementById('sidebar-import') as HTMLButtonElement;

  let allDocs: SidebarDoc[] = [];

  const toDraftDocs = (docs: SidebarDoc[]): TreeDoc[] => docs.map((d) => ({ ...d, path: d.doc_key }));

  const paintTree = (target: HTMLElement, docs: TreeDoc[], extraFolders: string[], emptyHtml: string): void => {
    const currentKey = opts.getCurrentKey();
    target.innerHTML = '';
    if (docs.length === 0 && extraFolders.length === 0) {
      target.innerHTML = emptyHtml;
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    const nodes = buildTree(docs, extraFolders);
    for (const n of nodes) {
      if (n.type === 'folder') ul.appendChild(renderFolder(n, currentKey));
      else ul.appendChild(renderDoc(n.doc, currentKey));
    }
    target.appendChild(ul);
  };

  const paintDocs = (): void => {
    paintTree(treeEl, toDraftDocs(allDocs), [], '<div class="tree-empty">暂无文档，点「新建」开始</div>');
  };

  /** 过滤态扁平渲染：搜索结果不重建文件夹层级，直接平铺。*/
  const paintFlat = (target: HTMLElement, docs: TreeDoc[], emptyHtml: string): void => {
    target.innerHTML = '';
    if (docs.length === 0) {
      target.innerHTML = emptyHtml;
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    renderFlat(docs, opts.getCurrentKey()).forEach((li) => ul.appendChild(li));
    target.appendChild(ul);
  };

  const refreshDraft = async (): Promise<void> => {
    const res = await fetch('/api/docs');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    allDocs = (await res.json()) as SidebarDoc[];
  };

  const refreshAndPaintDocs = async (): Promise<void> => {
    try {
      await refreshDraft();
      paintDocs();
    } catch {
      treeEl.innerHTML = '<div class="tree-empty">加载失败</div>';
    }
  };

  const refresh = async (): Promise<void> => {
    await refreshAndPaintDocs();
  };

  // 搜索：过滤当前 space 下的文档，按扁平结果渲染
  searchEl.addEventListener('input', async () => {
    const q = searchEl.value.trim();
    if (!q) {
      paintDocs();
      return;
    }
    try {
      const docsRes = await fetch('/api/docs?q=' + encodeURIComponent(q));
      const docs = (await docsRes.json()) as SidebarDoc[];
      paintFlat(treeEl, toDraftDocs(docs), '<div class="tree-empty">没有匹配的文档</div>');
    } catch {
      /* 忽略搜索失败 */
    }
  });

  newBtn.addEventListener('click', () => void createDoc());

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
    const path = await askText({
      title: '新建文档',
      label: '文档路径（可含文件夹，如 notes/我的文档.md）',
      value: '新文档.md',
      confirmLabel: '创建',
    });
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
      opts.onStatus?.('新建失败：' + (e as Error).message, true);
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

  // 点击委托：打开文档 / 折叠文件夹 / 重命名 / 删除
  treeEl.addEventListener('click', async (e) => {
    await onTreeClick(e);
  });

  async function onTreeClick(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement;
    const opBtn = target.closest<HTMLElement>('.tree-op');
    if (opBtn) {
      const op = opBtn.dataset.op;
      const li = opBtn.closest<HTMLElement>('.tree-doc');
      if (!li) return;
      const id = Number(li.dataset.docId);
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
      opts.onOpen(Number(docLi.dataset.docId));
      void refresh();
    }
  }

  const renameDoc = async (doc: SidebarDoc): Promise<void> => {
    const newKey = await askText({
      title: '重命名文档',
      label: '新路径（可含文件夹）',
      value: doc.doc_key,
      confirmLabel: '重命名',
    });
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
      opts.onStatus?.('重命名失败：' + (err as Error).message, true);
    }
  };

  const deleteDoc = async (doc: SidebarDoc): Promise<void> => {
    const ok = await askConfirm(`删除「${doc.title}」？\n仅删除工作区记录，不影响磁盘原文件与图床。`, {
      title: '删除文档',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/docs/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await removeHandle(doc.doc_key);
      await refresh();
    } catch (err) {
      opts.onStatus?.('删除失败：' + (err as Error).message, true);
    }
  };

  refresh();
  return { refresh };
}
