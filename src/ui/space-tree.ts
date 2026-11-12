// ─── 空间树纯函数（可脱离 DOM 单测）──────────────────────────
// 服务端 /api/spaces/:id/tree 已按 (parent_id/folder_id, sort_order, id) 排好；
// 这里只做「按 parent 归位」，不再排序，避免前端顺序和服务端打架。

export interface SpaceRow {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  created_at?: number;
}

export interface SpaceFolderRow {
  id: number;
  space_id: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  created_at?: number;
}

export interface SpaceDocRow {
  id: number;
  doc_key: string;
  title: string;
  filename: string;
  updated_at: number;
  last_opened_at?: number;
  space_id: number | null;
  folder_id: number | null;
  sort_order: number;
}

export interface SpaceTreeData {
  space: SpaceRow;
  folders: SpaceFolderRow[];
  docs: SpaceDocRow[];
}

export type SpaceTreeNode =
  | { type: 'folder'; folder: SpaceFolderRow; children: SpaceTreeNode[] }
  | { type: 'doc'; doc: SpaceDocRow };

export interface MoveTarget {
  spaceId: number;
  folderId: number | null;
  label: string;
}

export interface PlacementAnchor {
  beforeId?: number;
  afterId?: number;
  position?: 'start' | 'end' | number;
}

/** 扁平数组按 parent_id / folder_id 归位；同级顺序沿用服务端返回顺序。 */
export function buildSpaceTree(data: SpaceTreeData): SpaceTreeNode[] {
  const roots: SpaceTreeNode[] = [];
  const folderNodes = new Map<number, Extract<SpaceTreeNode, { type: 'folder' }>>();
  for (const folder of data.folders) {
    folderNodes.set(folder.id, { type: 'folder', folder, children: [] });
  }
  for (const folder of data.folders) {
    const node = folderNodes.get(folder.id)!;
    const parent = folder.parent_id == null ? undefined : folderNodes.get(folder.parent_id);
    (parent ? parent.children : roots).push(node);
  }
  for (const doc of data.docs) {
    const node: SpaceTreeNode = { type: 'doc', doc };
    const parent = doc.folder_id == null ? undefined : folderNodes.get(doc.folder_id);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

export interface FlatRow {
  node: SpaceTreeNode;
  depth: number;
}

/** 深度优先展开，供渲染与测试核对层级。 */
export function flattenSpaceTree(nodes: SpaceTreeNode[], depth = 0): FlatRow[] {
  const out: FlatRow[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.type === 'folder') out.push(...flattenSpaceTree(node.children, depth + 1));
  }
  return out;
}

/** 某目录的全部后代目录 id（用于前端先挡「拖进自己子孙」）。 */
export function descendantFolderIds(folders: SpaceFolderRow[], rootId: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const f of folders) {
    if (f.parent_id == null) continue;
    const list = children.get(f.parent_id) ?? [];
    list.push(f.id);
    children.set(f.parent_id, list);
  }
  const out = new Set<number>();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/** 目录在树里的可读路径，如「文档 / 2026」。 */
export function folderPathLabel(folders: SpaceFolderRow[], folderId: number): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = byId.get(folderId);
  for (let guard = 0; cur && guard < 1000; guard++) {
    parts.unshift(cur.name);
    cur = cur.parent_id == null ? undefined : byId.get(cur.parent_id);
  }
  return parts.join(' / ');
}

/**
 * 「移动到…」的目标列表：所有空间根 + 所有目录。
 * 移动目录时排除自身与全部子孙，避免前端先把循环提交给服务端。
 */
export function moveTargets(
  spaces: SpaceRow[],
  trees: Record<number, SpaceTreeData>,
  kind: 'doc' | 'folder',
  nodeId: number,
): MoveTarget[] {
  let ownSpaceId: number | null = null;
  let blocked = new Set<number>();
  if (kind === 'folder') {
    for (const s of spaces) {
      const tree = trees[s.id];
      if (!tree) continue;
      if (tree.folders.some((f) => f.id === nodeId)) {
        ownSpaceId = s.id;
        blocked = new Set([nodeId, ...descendantFolderIds(tree.folders, nodeId)]);
        break;
      }
    }
  }
  const out: MoveTarget[] = [];
  for (const s of spaces) {
    const tree = trees[s.id];
    if (!tree) continue;
    out.push({ spaceId: s.id, folderId: null, label: `${s.name} /（空间根）` });
    for (const f of tree.folders) {
      if (s.id === ownSpaceId && blocked.has(f.id)) continue;
      out.push({ spaceId: s.id, folderId: f.id, label: `${s.name} / ${folderPathLabel(tree.folders, f.id)}` });
    }
  }
  return out;
}

/** 上移/下移落位：返回服务端要的 before_id / after_id；已在边界返回 null。 */
export function neighborPlacement(
  orderedIds: number[],
  id: number,
  dir: 'up' | 'down',
): { beforeId?: number; afterId?: number } | null {
  const idx = orderedIds.indexOf(id);
  if (idx < 0) return null;
  if (dir === 'up') {
    if (idx === 0) return null;
    return { beforeId: orderedIds[idx - 1] };
  }
  if (idx === orderedIds.length - 1) return null;
  return { afterId: orderedIds[idx + 1] };
}

function anchorIndex(ids: number[], anchor: PlacementAnchor): number {
  if (anchor.beforeId != null) {
    const i = ids.indexOf(anchor.beforeId);
    if (i >= 0) return i;
  }
  if (anchor.afterId != null) {
    const i = ids.indexOf(anchor.afterId);
    if (i >= 0) return i + 1;
  }
  if (typeof anchor.position === 'number') {
    return Math.max(0, Math.min(ids.length, Math.trunc(anchor.position)));
  }
  if (anchor.position === 'start') return 0;
  return ids.length;
}

function renumberDocs(docs: SpaceDocRow[], folderId: number | null): void {
  let i = 0;
  for (const d of docs) if (d.folder_id === folderId) d.sort_order = i++;
}

function renumberFolders(folders: SpaceFolderRow[], parentId: number | null): void {
  let i = 0;
  for (const f of folders) if (f.parent_id === parentId) f.sort_order = i++;
}

/**
 * 本地乐观落位（文档）：同空间内换目录/排序。返回新的树数据，不修改入参。
 * 跨空间请等服务端响应，不走这里（契约 §5.6）。
 */
export function applyDocPlacement(
  data: SpaceTreeData,
  docId: number,
  targetFolderId: number | null,
  anchor: PlacementAnchor = {},
): SpaceTreeData {
  const docs = data.docs.map((d) => ({ ...d }));
  const idx = docs.findIndex((d) => d.id === docId);
  if (idx < 0) return data;
  const [doc] = docs.splice(idx, 1);
  const oldFolderId = doc.folder_id;
  doc.folder_id = targetFolderId;
  doc.space_id = data.space.id;

  const siblings = docs.filter((d) => d.folder_id === targetFolderId).map((d) => d.id);
  const insertAt = anchorIndex(siblings, anchor);
  const ordered = [...siblings.slice(0, insertAt), doc.id, ...siblings.slice(insertAt)];
  // 先插到全局数组里对应容器块内，再按容器重排 sort_order
  if (ordered.length > 1) {
    const beforeId = ordered[insertAt + 1];
    const globalAt = beforeId == null ? docs.length : docs.findIndex((d) => d.id === beforeId);
    docs.splice(globalAt < 0 ? docs.length : globalAt, 0, doc);
  } else {
    docs.push(doc);
  }
  renumberDocs(docs, targetFolderId);
  if (oldFolderId !== targetFolderId) renumberDocs(docs, oldFolderId);
  return { ...data, docs };
}

/** 本地乐观落位（目录）：同空间内换父级/排序。 */
export function applyFolderPlacement(
  data: SpaceTreeData,
  folderId: number,
  targetParentId: number | null,
  anchor: PlacementAnchor = {},
): SpaceTreeData {
  const folders = data.folders.map((f) => ({ ...f }));
  const idx = folders.findIndex((f) => f.id === folderId);
  if (idx < 0) return data;
  const blocked = new Set([folderId, ...descendantFolderIds(data.folders, folderId)]);
  if (targetParentId != null && blocked.has(targetParentId)) return data;
  const [folder] = folders.splice(idx, 1);
  const oldParentId = folder.parent_id;
  folder.parent_id = targetParentId;
  folder.space_id = data.space.id;

  const siblings = folders.filter((f) => f.parent_id === targetParentId).map((f) => f.id);
  const insertAt = anchorIndex(siblings, anchor);
  const ordered = [...siblings.slice(0, insertAt), folder.id, ...siblings.slice(insertAt)];
  const beforeId = ordered[insertAt + 1];
  const globalAt = beforeId == null ? folders.length : folders.findIndex((f) => f.id === beforeId);
  folders.splice(globalAt < 0 ? folders.length : globalAt, 0, folder);
  renumberFolders(folders, targetParentId);
  if (oldParentId !== targetParentId) renumberFolders(folders, oldParentId);
  return { ...data, folders };
}

/** 空间拖动/上移下移：把 draggedId 插到 targetId 前或后，返回新数组（含稠密 sort_order）。 */
export function reorderSpacesList(
  spaces: SpaceRow[],
  draggedId: number,
  targetId: number,
  where: 'before' | 'after',
): SpaceRow[] {
  const list = spaces.map((s) => ({ ...s }));
  const from = list.findIndex((s) => s.id === draggedId);
  if (from < 0) return spaces;
  const [dragged] = list.splice(from, 1);
  let to = list.findIndex((s) => s.id === targetId);
  if (to < 0) return spaces;
  if (where === 'after') to += 1;
  list.splice(to, 0, dragged);
  list.forEach((s, i) => (s.sort_order = i));
  return list;
}
