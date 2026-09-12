import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

export function extractZipToDir(buf: Buffer, destDir: string): string[] {
  const files: string[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = u32(buf, offset);
    if (sig !== 0x04034b50) break;
    const method = u16(buf, offset + 8);
    const nameLen = u16(buf, offset + 26);
    const extraLen = u16(buf, offset + 28);
    const flags = u16(buf, offset + 6);
    let compSize = u32(buf, offset + 18);
    let uncompSize = u32(buf, offset + 22);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    let dataStart = offset + 30 + nameLen + extraLen;
    if (flags & 0x8) {
      throw new Error('不支持 data descriptor zip');
    }
    const data = buf.subarray(dataStart, dataStart + compSize);
    offset = dataStart + compSize;
    if (!name || name.endsWith('/')) continue;
    const norm = normalize(name).replace(/^(\.\.(\/|\\|$))+/, '');
    if (norm.startsWith('..') || norm.startsWith('/')) continue;
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data);
    else throw new Error('不支持的 zip 压缩方法');
    if (uncompSize && content.length !== uncompSize && method === 0) {
      /* store */
    }
    const out = join(destDir, norm);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
    files.push(norm);
  }
  if (!files.length) throw new Error('zip 中没有文件');
  return files;
}

export function createStoreZip(entries: Record<string, string | Buffer>): Buffer {
  const chunks: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, nameBuf, data]);
    chunks.push(localFull);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralDir, end]);
}
