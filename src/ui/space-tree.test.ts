import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDocPlacement,
  applyFolderPlacement,
  buildSpaceTree,
  descendantFolderIds,
  flattenSpaceTree,
  moveTargets,
  neighborPlacement,
  reorderSpacesList,
  type SpaceRow,
  type SpaceTreeData,
} from './space-tree.ts';

const space: SpaceRow = { id: 2, name: '工作', is_default: 0, sort_order: 0 };
const other: SpaceRow = { id: 1, name: 'default', is_default: 1, sort_order: 0 };

function data(): SpaceTreeData {
  return {
    space,
    folders: [
      { id: 10, space_id: 2, parent_id: null, name: '文档', sort_order: 0 },
      { id: 11, space_id: 2, parent_id: 10, name: '2026', sort_order: 0 },
      { id: 12, space_id: 2, parent_id: null, name: '归档标签', sort_order: 1 },
    ],
    docs: [
      { id: 100, doc_key: 'a.md', title: 'A', filename: 'a.md', updated_at: 1, space_id: 2, folder_id: null, sort_order: 0 },
      { id: 101, doc_key: 'b.md', title: 'B', filename: 'b.md', updated_at: 1, space_id: 2, folder_id: null, sort_order: 1 },
      { id: 102, doc_key: 'c.md', title: 'C', filename: 'c.md', updated_at: 1, space_id: 2, folder_id: 10, sort_order: 0 },
      { id: 103, doc_key: 'd.md', title: 'D', filename: 'd.md', updated_at: 1, space_id: 2, folder_id: 11, sort_order: 0 },
    ],
  };
}

test('树按 parent_id/folder_id 归位，同级顺序沿用服务端返回顺序', () => {
  const roots = buildSpaceTree(data());
  assert.deepEqual(
    roots.map((n) => (n.type === 'folder' ? 'f:' + n.folder.name : 'd:' + n.doc.title)),
    ['f:文档', 'f:归档标签', 'd:A', 'd:B'],
  );
  const flat = flattenSpaceTree(roots);
  assert.deepEqual(
    flat.map((r) => (r.node.type === 'folder' ? 'f:' + r.node.folder.name : 'd:' + r.node.doc.title) + '@' + r.depth),
    ['f:文档@0', 'f:2026@1', 'd:D@2', 'd:C@1', 'f:归档标签@0', 'd:A@0', 'd:B@0'],
  );
});

test('子孙目录集合用于前端先挡成环', () => {
  assert.deepEqual([...descendantFolderIds(data().folders, 10)].sort(), [11]);
  assert.deepEqual([...descendantFolderIds(data().folders, 11)], []);
});

test('上移/下移边界与锚点', () => {
  assert.equal(neighborPlacement([1, 2, 3], 1, 'up'), null);
  assert.deepEqual(neighborPlacement([1, 2, 3], 2, 'up'), { beforeId: 1 });
  assert.deepEqual(neighborPlacement([1, 2, 3], 2, 'down'), { afterId: 3 });
  assert.equal(neighborPlacement([1, 2, 3], 3, 'down'), null);
});

test('移动目标排除目录自身与子孙，空间根始终可选', () => {
  const trees = { 2: data(), 1: { space: other, folders: [], docs: [] } };
  const targets = moveTargets([other, space], trees, 'folder', 10);
  assert.ok(targets.some((t) => t.spaceId === 1 && t.folderId === null));
  assert.ok(targets.some((t) => t.spaceId === 2 && t.folderId === 12));
  assert.ok(!targets.some((t) => t.spaceId === 2 && t.folderId === 10));
  assert.ok(!targets.some((t) => t.spaceId === 2 && t.folderId === 11));
});

test('文档本地落位：拖进目录并排到指定兄弟前', () => {
  const next = applyDocPlacement(data(), 100, 10, { beforeId: 102 });
  assert.equal(next.docs.find((d) => d.id === 100)!.folder_id, 10);
  const inFolder = next.docs.filter((d) => d.folder_id === 10).map((d) => d.id);
  assert.deepEqual(inFolder, [100, 102]);
  assert.deepEqual(
    next.docs.filter((d) => d.folder_id === null).map((d) => d.id),
    [101],
  );
});

test('目录本地落位：换父级并拒绝成环', () => {
  const moved = applyFolderPlacement(data(), 12, 10, { position: 'start' });
  assert.equal(moved.folders.find((f) => f.id === 12)!.parent_id, 10);
  const blocked = applyFolderPlacement(data(), 10, 11, { position: 'end' });
  assert.equal(blocked.folders.find((f) => f.id === 10)!.parent_id, null);
});

test('空间拖拽重排生成完整新顺序', () => {
  const list = [
    { ...other, sort_order: 0 },
    { ...space, sort_order: 1 },
    { id: 3, name: '临时', is_default: 0, sort_order: 2 },
  ];
  assert.deepEqual(
    reorderSpacesList(list, 3, 1, 'before').map((s) => s.id),
    [3, 1, 2],
  );
  assert.deepEqual(
    reorderSpacesList(list, 1, 2, 'after').map((s) => s.id),
    [2, 1, 3],
  );
});
