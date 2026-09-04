// 用 IndexedDB 持久化 File System Access API 的文件句柄。
// 浏览器出于隐私不会暴露完整磁盘路径，但可持久化 FileSystemFileHandle，
// 这样"打开过的文件"下次能直接读真实文件、无需再弹文件选择框。

const DB_NAME = 'ptdoc-fs';
const STORE = 'handles';
let idbPromise: Promise<IDBDatabase> | null = null;

function openIDB(): Promise<IDBDatabase> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'docKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

export interface StoredHandle {
  docKey: string;
  name: string;
  handle: any; // FileSystemFileHandle
  lastOpenedAt: number;
}

let currentUserId = 0;

export function setHandleUser(userId: number): void {
  currentUserId = userId;
}

function scopedKey(docKey: string): string {
  return currentUserId ? `${currentUserId}:${docKey}` : docKey;
}

/** 保存/更新某文档对应的文件句柄（按 userId:doc_key 去重）。 */
export async function saveHandle(docKey: string, name: string, handle: any): Promise<void> {
  const db = await openIDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      docKey: scopedKey(docKey),
      name,
      handle,
      lastOpenedAt: Date.now(),
    } as StoredHandle);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 取回某文档的文件句柄；不存在返回 null（此时回退到从数据库内容打开）。 */
export async function getHandle(docKey: string): Promise<any | null> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(scopedKey(docKey));
    r.onsuccess = () => resolve((r.result as StoredHandle | undefined)?.handle ?? null);
    r.onerror = () => reject(r.error);
  });
}

/** 删除某文档的文件句柄（doc_key 重命名后旧键句柄已失效，需清理）。 */
export async function removeHandle(docKey: string): Promise<void> {
  const db = await openIDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(scopedKey(docKey));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 判断运行环境是否支持 File System Access API。 */
export function supportsFileSystemAccess(): boolean {
  return typeof (window as any).showOpenFilePicker === 'function';
}
