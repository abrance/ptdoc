import { removeHandle } from './fileHandles';
import { askConfirm, askSelect, askText } from './dialog';
import { showToast } from './toast';
import {
  applyDocPlacement,
  applyFolderPlacement,
  buildSpaceTree,
  descendantFolderIds,
  folderPathLabel,
  moveTargets,
  neighborPlacement,
  reorderSpacesList,
  type SpaceDocRow,
  type SpaceFolderRow,
  type SpaceRow,
  type SpaceTreeData,
  type SpaceTreeNode,
} from './space-tree';

// ─── 侧栏空间树（space → 目录 → 文档）──────────────────────
// 服务端 /api/spaces/:id/tree 一次返回整棵树并已排好序；这里只按 parent 归位、渲染、拖拽。

interface SidebarOptions {
  onOpen: (id: number) => void;
  getCurrentKey: () => string;
  onRenamed: (oldKey: string, newKey: string) => void;
  onStatus?: (msg: string, isError?: boolean) => void;
}

interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
}

interface DragState {
  kind: 'space' | 'folder' | 'doc';
  id: number;
}

const SPACE_KEY = 'ptdoc.current-space';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function initSidebar(opts: SidebarOptions): { refresh: () => Promise<void> } {
  const treeEl = document.getElementById('sidebar-tree') as HTMLElement;
  const searchEl = document.getElementById('sidebar-search') as HTMLInputElement;
  const newBtn = document.getElementById('sidebar-new') as HTMLButtonElement;
  const importBtn = document.getElementById('sidebar-import') as HTMLButtonElement;
  const spaceListEl = document.getElementById('space-list') as HTMLElement;
  const spaceNewBtn = document.getElementById('space-new') as HTMLButtonElement;
  const folderNewBtn = document.getElementById('folder-new') as HTMLButtonElement;

  let spaces: SpaceRow[] = [];
  let tree: SpaceTreeData | null = null;
  let currentSpaceId: number | null = null;
  let collapsed = new Set<number>();
  let drag: DragState | null = null;
  let rowMenu: HTMLElement | null = null;
  let rowMenuCleanup: (() => void) | null = null;

  /** 失败反馈：状态栏 + toast，保证操作结果看得见。 */
  function fail(msg: string): void {
    opts.onStatus?.(msg, true);
    showToast(msg, 'error');
  }

  async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  function post<T>(url: string, body: unknown): Promise<T> {
    return api<T>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ─── 空间列表 ─────────────────────────────────────────
  function pickCurrentSpace(): void {
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(SPACE_KEY) || '0');
    } catch {
      /* 隐私模式：只用内存里的选择 */
    }
    if (spaces.some((s) => s.id === saved)) {
      currentSpaceId = saved;
      return;
    }
    const def = spaces.find((s) => s.is_default === 1) ?? spaces[0];
    currentSpaceId = def ? def.id : null;
  }

  function rememberSpace(id: number): void {
    currentSpaceId = id;
    try {
      localStorage.setItem(SPACE_KEY, String(id));
    } catch {
      /* 隐私模式仅本次生效 */
    }
  }

  async function loadSpaces(): Promise<void> {
    const data = await api<{ spaces: SpaceRow[] }>('/api/spaces');
    spaces = data.spaces ?? [];
    if (!spaces.some((s) => s.id === currentSpaceId)) pickCurrentSpace();
    renderSpaces();
  }

  async function loadTree(): Promise<void> {
    if (currentSpaceId == null) {
      tree = null;
      renderTree();
      return;
    }
    tree = await api<SpaceTreeData>(`/api/spaces/${currentSpaceId}/tree`);
    renderTree();
  }

  function renderSpaces(): void {
    spaceListEl.innerHTML = '';
    for (const s of spaces) {
      const chip = document.createElement('div');
      chip.className = 'space-chip' + (s.id === currentSpaceId ? ' active' : '');
      chip.dataset.spaceId = String(s.id);
      chip.draggable = true;
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(s.id === currentSpaceId));
      chip.tabIndex = 0;
      chip.innerHTML = `
        <button class="space-chip-name" type="button" data-space-open="${s.id}" title="切换到 ${esc(s.name)}">${esc(s.name)}</button>
        <button class="space-chip-menu" type="button" data-space-menu="${s.id}" aria-label="${esc(s.name)} 的更多操作">⋯</button>`;
      spaceListEl.appendChild(chip);
    }
  }

  async function switchSpace(id: number): Promise<void> {
    if (id === currentSpaceId) return;
    rememberSpace(id);
    renderSpaces();
    try {
      await loadTree();
    } catch (e) {
      tree = null;
      renderTree();
      fail('切换空间失败：' + errorMessage(e));
    }
  }

  // ─── 树渲染 ───────────────────────────────────────────
  function isCurrentDoc(doc: SpaceDocRow): boolean {
    return doc.doc_key === opts.getCurrentKey();
  }

  function renderTree(): void {
    treeEl.innerHTML = '';
    if (!tree) {
      treeEl.innerHTML =
        spaces.length === 0
          ? '<div class="tree-empty">还没有空间</div>'
          : '<div class="tree-empty">加载中…</div>';
      return;
    }
    const nodes = buildSpaceTree(tree);
    if (nodes.length === 0) {
      treeEl.innerHTML =
        '<div class="tree-empty">这个空间还没有文档。<br />点「新建」创建，或把文档拖进来。</div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    for (const node of nodes) ul.appendChild(renderNode(node));
    treeEl.appendChild(ul);
  }

  function renderNode(node: SpaceTreeNode): HTMLLIElement {
    return node.type === 'folder' ? renderFolder(node) : renderDoc(node.doc);
  }

  function renderFolder(node: Extract<SpaceTreeNode, { type: 'folder' }>): HTMLLIElement {
    const folder = node.folder;
    const li = document.createElement('li');
    li.className = 'tree-folder' + (collapsed.has(folder.id) ? '' : ' open');
    li.dataset.folderId = String(folder.id);
    li.dataset.spaceId = String(folder.space_id);
    li.dataset.parentId = folder.parent_id == null ? '' : String(folder.parent_id);

    const row = document.createElement('div');
    row.className = 'tree-folder-row';
    row.draggable = true;
    row.tabIndex = 0;
    row.innerHTML = `
      <span class="tree-folder-label">
        <span class="tree-caret" aria-hidden="true"><svg class="icon"><use href="#i-caret"></use></svg></span>
        <svg class="icon tree-folder-icon"><use href="#i-folder"></use></svg>
        <span class="tree-name">${esc(folder.name)}</span>
      </span>
      <button class="tree-op tree-more" type="button" data-row-menu="folder" data-id="${folder.id}" aria-label="${esc(folder.name)} 的更多操作">⋯</button>`;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-row-menu]')) return;
      toggleFolder(folder.id);
    });
    li.appendChild(row);

    const ul = document.createElement('ul');
    ul.className = 'tree-children';
    for (const child of node.children) ul.appendChild(renderNode(child));
    li.appendChild(ul);
    return li;
  }

  function renderDoc(doc: SpaceDocRow): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'tree-doc' + (isCurrentDoc(doc) ? ' current' : '');
    li.dataset.docId = String(doc.id);
    li.dataset.docKey = doc.doc_key;
    li.dataset.spaceId = String(doc.space_id ?? '');
    li.dataset.folderId = doc.folder_id == null ? '' : String(doc.folder_id);
    li.draggable = true;
    li.tabIndex = 0;
    li.innerHTML = `
      <svg class="icon tree-doc-icon"><use href="#i-doc"></use></svg>
      <span class="tree-label" title="${esc(doc.doc_key)}">${esc(doc.title)}</span>
      <button class="tree-op tree-more" type="button" data-row-menu="doc" data-id="${doc.id}" aria-label="${esc(doc.title)} 的更多操作">⋯</button>`;
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-row-menu]')) return;
      opts.onOpen(doc.id);
    });
    return li;
  }

  function toggleFolder(id: number): void {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    renderTree();
  }

  /** 搜索：只在当前空间内按标题/doc_key 过滤，扁平展示。 */
  function renderSearch(q: string): void {
    if (!tree) return;
    const needle = q.trim().toLowerCase();
    treeEl.innerHTML = '';
    if (!needle) {
      renderTree();
      return;
    }
    const hits = tree.docs.filter(
      (d) => d.title.toLowerCase().includes(needle) || d.doc_key.toLowerCase().includes(needle),
    );
    if (hits.length === 0) {
      treeEl.innerHTML = '<div class="tree-empty">没有匹配的文档</div>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    for (const doc of hits) ul.appendChild(renderDoc(doc));
    treeEl.appendChild(ul);
  }

  // ─── 行菜单（触屏/键盘兜底）──────────────────────────
  function closeRowMenu(): void {
    rowMenuCleanup?.();
    rowMenuCleanup = null;
    rowMenu?.remove();
    rowMenu = null;
  }

  function openRowMenu(anchor: HTMLElement, items: MenuItem[]): void {
    closeRowMenu();
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = item.label;
      if (item.danger) btn.classList.add('is-danger');
      btn.addEventListener('click', () => {
        closeRowMenu();
        item.run();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    rowMenu = menu;

    const onPointerDown = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) closeRowMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRowMenu();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    rowMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
    (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  function docMenu(doc: SpaceDocRow, anchor: HTMLElement): void {
    openRowMenu(anchor, [
      { label: '打开', run: () => opts.onOpen(doc.id) },
      { label: '重命名', run: () => void renameDoc(doc) },
      { label: '移动到…', run: () => void moveDialog('doc', doc.id) },
      { label: '上移', run: () => void moveNeighbor('doc', doc.id, 'up') },
      { label: '下移', run: () => void moveNeighbor('doc', doc.id, 'down') },
    ]);
  }

  function folderMenu(folder: SpaceFolderRow, anchor: HTMLElement): void {
    openRowMenu(anchor, [
      { label: '新建子目录', run: () => void createFolder(folder.id) },
      { label: '在此新建文档', run: () => void createDoc(folder.id) },
      { label: '重命名', run: () => void renameFolder(folder) },
      { label: '移动到…', run: () => void moveDialog('folder', folder.id) },
      { label: '上移', run: () => void moveNeighbor('folder', folder.id, 'up') },
      { label: '下移', run: () => void moveNeighbor('folder', folder.id, 'down') },
      { label: '删除目录', run: () => void deleteFolder(folder), danger: true },
    ]);
  }

  function spaceMenu(space: SpaceRow, anchor: HTMLElement): void {
    const items: MenuItem[] = [];
    if (space.is_default !== 1) items.push({ label: '重命名空间', run: () => void renameSpace(space) });
    items.push({ label: '上移', run: () => void moveSpaceBy(space, -1) });
    items.push({ label: '下移', run: () => void moveSpaceBy(space, 1) });
    if (space.is_default !== 1) items.push({ label: '删除空间', run: () => void deleteSpace(space), danger: true });
    openRowMenu(anchor, items);
  }

  // ─── 空间操作 ─────────────────────────────────────────
  async function createSpace(): Promise<void> {
    const name = await askText({ title: '新建空间', label: '空间名称', value: '新空间', confirmLabel: '创建' });
    if (!name || !name.trim()) return;
    try {
      const created = await post<SpaceRow>('/api/spaces', { name: name.trim() });
      await loadSpaces();
      rememberSpace(created.id);
      renderSpaces();
      await loadTree();
    } catch (e) {
      fail('新建空间失败：' + errorMessage(e));
    }
  }

  async function renameSpace(space: SpaceRow): Promise<void> {
    const name = await askText({
      title: '重命名空间',
      label: '空间名称',
      value: space.name,
      confirmLabel: '重命名',
    });
    if (!name || !name.trim() || name.trim() === space.name) return;
    try {
      await api(`/api/spaces/${space.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadSpaces();
    } catch (e) {
      fail('重命名空间失败：' + errorMessage(e));
    }
  }

  async function deleteSpace(space: SpaceRow): Promise<void> {
    if (space.is_default === 1) return;
    try {
      const detail = await api<SpaceTreeData>(`/api/spaces/${space.id}/tree`);
      if (detail.docs.length === 0 && detail.folders.length === 0) {
        const ok = await askConfirm(`删除空空间「${space.name}」？`, {
          title: '删除空间',
          confirmLabel: '删除',
          danger: true,
        });
        if (!ok) return;
        await api(`/api/spaces/${space.id}`, { method: 'DELETE' });
      } else {
        const candidates = spaces.filter((s) => s.id !== space.id);
        if (candidates.length === 0) {
          fail('没有其他空间可以接收文档');
          return;
        }
        const targetValue = await askSelect({
          title: `删除空间「${space.name}」`,
          message: `空间内还有 ${detail.docs.length} 篇文档、${detail.folders.length} 个目录。文档会移到所选空间根目录，目录会一并删除。`,
          label: '把文档移到',
          options: candidates.map((s) => ({ value: String(s.id), label: s.name })),
          confirmLabel: '下一步',
        });
        if (targetValue == null) return;
        const target = candidates.find((s) => s.id === Number(targetValue));
        if (!target) return;
        const ok = await askConfirm(
          `「${space.name}」的 ${detail.docs.length} 篇文档会移到「${target.name}」根目录，${detail.folders.length} 个目录会删除。此操作不可撤销。`,
          { title: '确认删除空间', confirmLabel: '删除空间', danger: true },
        );
        if (!ok) return;
        await api(`/api/spaces/${space.id}?move_to=${target.id}`, { method: 'DELETE' });
        rememberSpace(target.id);
      }
      const deletedCurrent = currentSpaceId === space.id;
      await loadSpaces();
      if (deletedCurrent || currentSpaceId == null) {
        const fallback = spaces.find((s) => s.is_default === 1) ?? spaces[0];
        if (fallback) rememberSpace(fallback.id);
      }
      renderSpaces();
      await loadTree();
      opts.onStatus?.('已删除空间');
    } catch (e) {
      fail('删除空间失败：' + errorMessage(e));
    }
  }

  async function moveSpaceBy(space: SpaceRow, delta: -1 | 1): Promise<void> {
    const idx = spaces.findIndex((s) => s.id === space.id);
    const target = spaces[idx + delta];
    if (!target) {
      opts.onStatus?.(delta < 0 ? '已经在最前' : '已经在最后');
      return;
    }
    const next = reorderSpacesList(spaces, space.id, target.id, delta < 0 ? 'before' : 'after');
    await persistSpaceOrder(next);
  }

  async function persistSpaceOrder(next: SpaceRow[]): Promise<void> {
    const previous = spaces;
    spaces = next;
    renderSpaces();
    try {
      await post('/api/spaces/reorder', { order: next.map((s) => s.id) });
    } catch (e) {
      spaces = previous;
      renderSpaces();
      fail('空间排序失败：' + errorMessage(e));
    }
  }

  // ─── 目录 / 文档 CRUD ────────────────────────────────
  async function createFolder(parentId: number | null): Promise<void> {
    if (currentSpaceId == null) return;
    const name = await askText({
      title: parentId == null ? '新建目录' : '新建子目录',
      label: '目录名称',
      value: '新目录',
      confirmLabel: '创建',
    });
    if (!name || !name.trim()) return;
    try {
      await post(`/api/spaces/${currentSpaceId}/folders`, { name: name.trim(), parent_id: parentId });
      if (parentId != null) collapsed.delete(parentId);
      await loadTree();
      opts.onStatus?.('已创建目录');
    } catch (e) {
      fail('新建目录失败：' + errorMessage(e));
    }
  }

  async function createDoc(folderId: number | null = null): Promise<void> {
    if (currentSpaceId == null) return;
    const name = await askText({
      title: folderId == null ? '新建文档' : '在此新建文档',
      label: '文档名（如 笔记.md）',
      value: '新文档.md',
      confirmLabel: '创建',
    });
    if (!name || !name.trim()) return;
    const docKey = name.trim();
    const filename = docKey.slice(docKey.lastIndexOf('/') + 1);
    const title = filename.replace(/\.md$/i, '');
    try {
      const created = await post<{ id: number }>('/api/docs', {
        doc_key: docKey,
        title,
        filename,
        content: '',
        space_id: currentSpaceId,
        folder_id: folderId,
      });
      if (folderId != null) collapsed.delete(folderId);
      await loadTree();
      opts.onOpen(created.id);
    } catch (e) {
      fail('新建失败：' + errorMessage(e));
    }
  }

  async function renameDoc(doc: SpaceDocRow): Promise<void> {
    const newKey = await askText({
      title: '重命名文档',
      label: '新路径（可含文件夹）',
      value: doc.doc_key,
      confirmLabel: '重命名',
    });
    if (!newKey || newKey.trim() === doc.doc_key) return;
    try {
      await post(`/api/docs/${doc.id}/rename`, { new_key: newKey.trim() });
      await removeHandle(doc.doc_key);
      opts.onRenamed(doc.doc_key, newKey.trim());
      await loadTree();
    } catch (e) {
      fail('重命名失败：' + errorMessage(e));
    }
  }

  async function renameFolder(folder: SpaceFolderRow): Promise<void> {
    const name = await askText({
      title: '重命名目录',
      label: '目录名称',
      value: folder.name,
      confirmLabel: '重命名',
    });
    if (!name || !name.trim() || name.trim() === folder.name) return;
    try {
      await api(`/api/folders/${folder.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadTree();
    } catch (e) {
      fail('重命名目录失败：' + errorMessage(e));
    }
  }

  async function deleteFolder(folder: SpaceFolderRow): Promise<void> {
    const ok = await askConfirm(`删除目录「${folder.name}」？\n仅当目录为空（没有子目录和文档）时可以删除。`, {
      title: '删除目录',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/folders/${folder.id}`, { method: 'DELETE' });
      await loadTree();
      opts.onStatus?.('已删除目录');
    } catch (e) {
      fail('删除目录失败：' + errorMessage(e));
    }
  }

  // ─── 移动 / 排序 ─────────────────────────────────────
  interface MoveTarget {
    spaceId: number;
    folderId: number | null;
    beforeId?: number;
    afterId?: number;
    position?: 'start' | 'end' | number;
  }

  async function moveDoc(doc: SpaceDocRow, target: MoveTarget, optimistic: boolean): Promise<void> {
    const body: Record<string, unknown> = {
      space_id: target.spaceId,
      folder_id: target.folderId,
    };
    if (target.beforeId != null) body.before_id = target.beforeId;
    else if (target.afterId != null) body.after_id = target.afterId;
    else body.position = target.position ?? 'end';

    const snapshot = tree;
    if (optimistic && tree && target.spaceId === tree.space.id) {
      tree = applyDocPlacement(tree, doc.id, target.folderId, target);
      renderTree();
    }
    try {
      await post(`/api/docs/${doc.id}/move`, body);
      if (target.folderId != null) collapsed.delete(target.folderId);
      await loadTree();
    } catch (e) {
      if (snapshot && optimistic) {
        tree = snapshot;
        renderTree();
      }
      fail('移动失败：' + errorMessage(e));
    }
  }

  async function moveFolder(folder: SpaceFolderRow, target: MoveTarget, optimistic: boolean): Promise<void> {
    const body: Record<string, unknown> = {
      space_id: target.spaceId,
      parent_id: target.folderId,
    };
    if (target.beforeId != null) body.before_id = target.beforeId;
    else if (target.afterId != null) body.after_id = target.afterId;
    else body.position = target.position ?? 'end';

    const snapshot = tree;
    if (optimistic && tree && target.spaceId === tree.space.id) {
      tree = applyFolderPlacement(tree, folder.id, target.folderId, target);
      renderTree();
    }
    try {
      await post(`/api/folders/${folder.id}/move`, body);
      if (target.folderId != null) collapsed.delete(target.folderId);
      await loadTree();
    } catch (e) {
      if (snapshot && optimistic) {
        tree = snapshot;
        renderTree();
      }
      fail('移动失败：' + errorMessage(e));
    }
  }

  function siblingIds(kind: 'doc' | 'folder', id: number): number[] {
    if (!tree) return [];
    if (kind === 'doc') {
      const doc = tree.docs.find((d) => d.id === id);
      if (!doc) return [];
      return tree.docs.filter((d) => d.folder_id === doc.folder_id).map((d) => d.id);
    }
    const folder = tree.folders.find((f) => f.id === id);
    if (!folder) return [];
    return tree.folders.filter((f) => f.parent_id === folder.parent_id).map((f) => f.id);
  }

  async function moveNeighbor(kind: 'doc' | 'folder', id: number, dir: 'up' | 'down'): Promise<void> {
    if (!tree) return;
    const placement = neighborPlacement(siblingIds(kind, id), id, dir);
    if (!placement) {
      opts.onStatus?.(dir === 'up' ? '已经在最前' : '已经在最后');
      return;
    }
    if (kind === 'doc') {
      const doc = tree.docs.find((d) => d.id === id);
      if (!doc) return;
      await moveDoc(
        doc,
        { spaceId: tree.space.id, folderId: doc.folder_id, ...placement },
        true,
      );
    } else {
      const folder = tree.folders.find((f) => f.id === id);
      if (!folder) return;
      await moveFolder(
        folder,
        { spaceId: tree.space.id, folderId: folder.parent_id, ...placement },
        true,
      );
    }
  }

  async function loadAllTrees(): Promise<Record<number, SpaceTreeData>> {
    const entries = await Promise.all(
      spaces.map(async (s) => {
        if (tree && s.id === tree.space.id) return [s.id, tree] as const;
        return [s.id, await api<SpaceTreeData>(`/api/spaces/${s.id}/tree`)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async function moveDialog(kind: 'doc' | 'folder', id: number): Promise<void> {
    if (!tree) return;
    const node =
      kind === 'doc'
        ? tree.docs.find((d) => d.id === id)
        : tree.folders.find((f) => f.id === id);
    if (!node) return;
    const name = kind === 'doc' ? (node as SpaceDocRow).title : (node as SpaceFolderRow).name;
    try {
      const trees = await loadAllTrees();
      const targets = moveTargets(spaces, trees, kind, id);
      if (targets.length === 0) {
        fail('没有可移动的目标');
        return;
      }
      const value = await askSelect({
        title: `移动「${name}」`,
        message:
          kind === 'doc'
            ? '选空间根目录或任意目录。跨空间移动时文档会落到目标空间根目录。'
            : '选空间根目录或任意目录；自身与自己的子目录不会出现在列表里。',
        label: '目标位置',
        options: targets.map((t) => ({ value: `${t.spaceId}:${t.folderId ?? 0}`, label: t.label })),
        confirmLabel: '移动',
      });
      if (value == null) return;
      const [spaceIdRaw, folderIdRaw] = value.split(':');
      const target: MoveTarget = {
        spaceId: Number(spaceIdRaw),
        folderId: Number(folderIdRaw) === 0 ? null : Number(folderIdRaw),
        position: 'end',
      };
      if (kind === 'doc') await moveDoc(node as SpaceDocRow, target, true);
      else await moveFolder(node as SpaceFolderRow, target, true);
    } catch (e) {
      fail('移动失败：' + errorMessage(e));
    }
  }

  // ─── 拖拽 ─────────────────────────────────────────────
  function clearDrag(): void {
    drag = null;
    document.querySelectorAll('.dragging, .drop-before, .drop-after, .drop-inside').forEach((el) => {
      el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-inside');
    });
    treeEl.classList.remove('drop-root');
  }

  function clearDropMarks(): void {
    document.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after', 'drop-inside');
    });
    treeEl.classList.remove('drop-root');
  }

  function folderTargetBlocked(folderId: number | null, containerId: number | null): boolean {
    if (!drag || drag.kind !== 'folder' || !tree) return false;
    const blocked = new Set([drag.id, ...descendantFolderIds(tree.folders, drag.id)]);
    if (folderId != null && blocked.has(folderId)) return true;
    if (containerId != null && blocked.has(containerId)) return true;
    return false;
  }

  spaceListEl.addEventListener('dragstart', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.space-chip');
    if (!chip) return;
    const id = Number(chip.dataset.spaceId);
    drag = { kind: 'space', id };
    chip.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', 'space:' + id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  spaceListEl.addEventListener('dragend', clearDrag);
  spaceListEl.addEventListener('dragover', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.space-chip');
    if (!chip || !drag) return;
    e.preventDefault();
    clearDropMarks();
    if (drag.kind === 'space') {
      if (Number(chip.dataset.spaceId) === drag.id) return;
      const rect = chip.getBoundingClientRect();
      chip.classList.add(e.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
    } else {
      chip.classList.add('drop-inside');
    }
  });
  spaceListEl.addEventListener('drop', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.space-chip');
    if (!chip || !drag || !tree) return;
    e.preventDefault();
    const targetId = Number(chip.dataset.spaceId);
    const state = drag;
    clearDrag();
    if (state.kind === 'space') {
      if (targetId === state.id) return;
      const rect = chip.getBoundingClientRect();
      const where = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      const next = reorderSpacesList(spaces, state.id, targetId, where);
      void persistSpaceOrder(next);
      return;
    }
    const target = { spaceId: targetId, folderId: null, position: 'end' as const };
    if (state.kind === 'doc') {
      const doc = tree.docs.find((d) => d.id === state.id);
      if (doc) void moveDoc(doc, target, targetId === tree.space.id);
    } else {
      const folder = tree.folders.find((f) => f.id === state.id);
      if (folder) void moveFolder(folder, target, targetId === tree.space.id);
    }
  });

  treeEl.addEventListener('dragstart', (e) => {
    const target = e.target as HTMLElement;
    const docLi = target.closest<HTMLElement>('.tree-doc');
    if (docLi) {
      const id = Number(docLi.dataset.docId);
      drag = { kind: 'doc', id };
      docLi.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', 'doc:' + id);
    } else {
      const row = target.closest<HTMLElement>('.tree-folder-row');
      if (!row) return;
      const li = row.closest<HTMLElement>('.tree-folder');
      const id = Number(li?.dataset.folderId);
      drag = { kind: 'folder', id };
      row.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', 'folder:' + id);
    }
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  treeEl.addEventListener('dragend', clearDrag);
  treeEl.addEventListener('dragover', (e) => {
    if (!drag || !tree) return;
    const target = e.target as HTMLElement;
    const docLi = target.closest<HTMLElement>('.tree-doc');
    const folderRow = target.closest<HTMLElement>('.tree-folder-row');
    clearDropMarks();
    if (docLi) {
      const folderIdRaw = docLi.dataset.folderId;
      const folderId = folderIdRaw ? Number(folderIdRaw) : null;
      if (folderTargetBlocked(null, folderId)) return;
      e.preventDefault();
      const rect = docLi.getBoundingClientRect();
      docLi.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
      return;
    }
    if (folderRow) {
      const li = folderRow.closest<HTMLElement>('.tree-folder');
      const folderId = Number(li?.dataset.folderId);
      if (folderTargetBlocked(folderId, null)) return;
      e.preventDefault();
      const rect = folderRow.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      folderRow.classList.add(ratio < 0.3 ? 'drop-before' : ratio > 0.7 ? 'drop-after' : 'drop-inside');
      return;
    }
    e.preventDefault();
    treeEl.classList.add('drop-root');
  });
  treeEl.addEventListener('dragleave', (e) => {
    if (e.target === treeEl) treeEl.classList.remove('drop-root');
  });
  treeEl.addEventListener('drop', (e) => {
    if (!drag || !tree) return;
    const target = e.target as HTMLElement;
    const docLi = target.closest<HTMLElement>('.tree-doc');
    const folderRow = target.closest<HTMLElement>('.tree-folder-row');
    const state = drag;
    clearDrag();
    if (!docLi && !folderRow) {
      if (state.kind === 'doc') {
        const doc = tree.docs.find((d) => d.id === state.id);
        if (doc) void moveDoc(doc, { spaceId: tree.space.id, folderId: null, position: 'end' }, true);
      } else {
        const folder = tree.folders.find((f) => f.id === state.id);
        if (folder) void moveFolder(folder, { spaceId: tree.space.id, folderId: null, position: 'end' }, true);
      }
      return;
    }
    if (docLi) {
      const docId = Number(docLi.dataset.docId);
      const folderIdRaw = docLi.dataset.folderId;
      const folderId = folderIdRaw ? Number(folderIdRaw) : null;
      if (folderTargetBlocked(null, folderId)) return;
      const sibling = tree.docs.find((d) => d.id === docId);
      if (!sibling) return;
      const rect = docLi.getBoundingClientRect();
      const anchor = e.clientY < rect.top + rect.height / 2 ? { beforeId: docId } : { afterId: docId };
      if (state.kind === 'doc') {
        const doc = tree.docs.find((d) => d.id === state.id);
        if (doc) void moveDoc(doc, { spaceId: tree.space.id, folderId, ...anchor }, true);
      } else {
        const folder = tree.folders.find((f) => f.id === state.id);
        if (folder) void moveFolder(folder, { spaceId: tree.space.id, folderId, ...anchor }, true);
      }
      return;
    }
    if (!folderRow) return;
    const li = folderRow.closest<HTMLElement>('.tree-folder');
    const targetFolderId = Number(li?.dataset.folderId);
    if (folderTargetBlocked(targetFolderId, null)) return;
    const folder = tree.folders.find((f) => f.id === targetFolderId);
    if (!folder) return;
    const rect = folderRow.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const placement: MoveTarget =
      ratio < 0.3
        ? { spaceId: tree.space.id, folderId: folder.parent_id, beforeId: folder.id }
        : ratio > 0.7
          ? { spaceId: tree.space.id, folderId: folder.parent_id, afterId: folder.id }
          : { spaceId: tree.space.id, folderId: folder.id, position: 'end' };
    if (state.kind === 'doc') {
      const doc = tree.docs.find((d) => d.id === state.id);
      if (doc) void moveDoc(doc, placement, true);
    } else {
      const dragged = tree.folders.find((f) => f.id === state.id);
      if (dragged) void moveFolder(dragged, placement, true);
    }
  });

  // ─── 事件绑定 ─────────────────────────────────────────
  spaceListEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const menuBtn = target.closest<HTMLElement>('[data-space-menu]');
    if (menuBtn) {
      const space = spaces.find((s) => s.id === Number(menuBtn.dataset.spaceMenu));
      if (space) spaceMenu(space, menuBtn);
      return;
    }
    const openBtn = target.closest<HTMLElement>('[data-space-open]');
    if (openBtn) void switchSpace(Number(openBtn.dataset.spaceOpen));
  });
  spaceListEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.space-chip');
    if (!chip || (e.target as HTMLElement).closest('[data-space-menu]')) return;
    e.preventDefault();
    void switchSpace(Number(chip.dataset.spaceId));
  });

  treeEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-row-menu]');
    if (!btn || !tree) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.rowMenu === 'doc') {
      const doc = tree.docs.find((d) => d.id === id);
      if (doc) docMenu(doc, btn);
    } else {
      const folder = tree.folders.find((f) => f.id === id);
      if (folder) folderMenu(folder, btn);
    }
  });

  searchEl.addEventListener('input', () => renderSearch(searchEl.value));
  newBtn.addEventListener('click', () => void createDoc(null));
  folderNewBtn.addEventListener('click', () => void createFolder(null));
  spaceNewBtn.addEventListener('click', () => void createSpace());

  // ─── 批量导入文件夹（导入到当前空间根）───────────────
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
    if (currentSpaceId == null) return;
    let files: ImportFile[] | null;
    try {
      files = await pickMarkdownFiles();
    } catch (e) {
      fail('导入失败：' + errorMessage(e));
      return;
    }
    if (!files || files.length === 0) return;
    const exists = new Set((tree?.docs ?? []).map((d) => d.doc_key));
    const spaceId = currentSpaceId;
    // 目录结构按导入时的相对路径落到真实 space_folders：先查现有同名目录，缺的再建。
    const folderByPath = new Map<string, number>();
    for (const folder of tree?.folders ?? []) {
      const path = folderPathLabel(tree!.folders, folder.id);
      folderByPath.set(path.toLowerCase(), folder.id);
    }
    async function ensureFolder(segments: string[]): Promise<number | null> {
      let parentId: number | null = null;
      const parts: string[] = [];
      for (const segment of segments) {
        parts.push(segment);
        const key = parts.join(' / ').toLowerCase();
        const cached = folderByPath.get(key);
        if (cached != null) {
          parentId = cached;
          continue;
        }
        const created: SpaceFolderRow = await post<SpaceFolderRow>(`/api/spaces/${spaceId}/folders`, {
          name: segment,
          parent_id: parentId,
        });
        folderByPath.set(key, created.id);
        parentId = created.id;
      }
      return parentId;
    }
    let added = 0;
    let skipped = 0;
    let failed = 0;
    opts.onStatus?.(`正在导入 ${files.length} 篇文档…`);
    for (const f of files) {
      const docKey = f.relPath.replace(/\\/g, '/');
      if (exists.has(docKey)) {
        skipped++;
        continue;
      }
      try {
        const segments = docKey.split('/');
        const filename = segments.pop() as string;
        const folderId = segments.length > 0 ? await ensureFolder(segments) : null;
        await post('/api/docs', {
          doc_key: docKey,
          title: titleFromMd(f.content, filename),
          filename,
          content: f.content,
          space_id: spaceId,
          folder_id: folderId,
        });
        added++;
      } catch {
        failed++;
      }
    }
    await loadTree();
    const skipNote = skipped > 0 ? `，跳过 ${skipped} 篇同名` : '';
    const failNote = failed > 0 ? `，失败 ${failed} 篇` : '';
    opts.onStatus?.(`导入完成：新增 ${added} 篇${skipNote}${failNote}`);
  }

  const refresh = async (): Promise<void> => {
    try {
      await loadSpaces();
      await loadTree();
    } catch (e) {
      treeEl.innerHTML = '<div class="tree-empty">加载失败</div>';
      fail('侧栏加载失败：' + errorMessage(e));
    }
  };

  void refresh();
  return { refresh };
}
