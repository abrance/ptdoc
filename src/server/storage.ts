import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getServerEnv } from './env.ts';
import { HttpError } from './http.ts';
import { getStorageProfile, upsertStorageProfile, type StorageProfileRow } from './db.ts';
import { isQiniuZone, testQiniuBucket, type QiniuConfig, type QiniuZone } from './qiniu-uploader.ts';

export interface StoragePublic {
  access_key: string;
  bucket: string;
  domain: string;
  zone: string;
  private_bucket: boolean;
  url_ttl: number;
  secret_configured: boolean;
  verified: boolean;
}

export interface StorageInput {
  access_key: string;
  secret_key?: string;
  bucket: string;
  domain: string;
  zone: string;
  private_bucket: boolean;
  url_ttl: number;
}

let connectivityTester: ((cfg: QiniuConfig) => Promise<void>) | null = null;

export function setConnectivityTesterForTests(fn: ((cfg: QiniuConfig) => Promise<void>) | null): void {
  connectivityTester = fn;
}

export function encryptSecret(plain: string): string {
  const key = getServerEnv().dataKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(packed: string): string {
  const key = getServerEnv().dataKey;
  const [ivHex, tagHex, dataHex] = packed.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('存储密钥密文损坏');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function toPublicProfile(row: StorageProfileRow | undefined): StoragePublic {
  if (!row) {
    return {
      access_key: '',
      bucket: '',
      domain: '',
      zone: 'Zone_z0',
      private_bucket: false,
      url_ttl: 3600,
      secret_configured: false,
      verified: false,
    };
  }
  return {
    access_key: row.access_key,
    bucket: row.bucket,
    domain: row.domain,
    zone: row.zone,
    private_bucket: !!row.private_bucket,
    url_ttl: row.url_ttl,
    secret_configured: true,
    verified: !!row.verified_at,
  };
}

export function parseStorageInput(body: any, existing?: StorageProfileRow): QiniuConfig {
  const accessKey = String(body?.access_key || '').trim();
  const bucket = String(body?.bucket || '').trim();
  const domain = String(body?.domain || '').trim();
  const zoneRaw = String(body?.zone || 'Zone_z0').trim();
  const secretFromBody = typeof body?.secret_key === 'string' ? body.secret_key.trim() : '';
  const secretKey = secretFromBody || (existing ? decryptSecret(existing.secret_key_enc) : '');
  const urlTtl = Number(body?.url_ttl) || 3600;
  const privateBucket = body?.private_bucket === true || body?.private_bucket === 1 || body?.private_bucket === 'true';
  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new HttpError(400, '请填写 AccessKey、SecretKey、Bucket 与 Domain');
  }
  if (!isQiniuZone(zoneRaw)) {
    throw new HttpError(400, '无效的存储区域');
  }
  if (urlTtl < 60 || urlTtl > 86400 * 30) {
    throw new HttpError(400, '签名有效期需在 60 秒到 30 天之间');
  }
  return {
    accessKey,
    secretKey,
    bucket,
    domain,
    zone: zoneRaw as QiniuZone,
    privateBucket,
    urlTtl,
  };
}

export async function verifyConnectivity(cfg: QiniuConfig): Promise<void> {
  try {
    if (connectivityTester) await connectivityTester(cfg);
    else await testQiniuBucket(cfg);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    throw new HttpError(400, msg || '七牛连通性校验失败');
  }
}

export function requireUserStorage(userId: number): QiniuConfig {
  const row = getStorageProfile(userId);
  if (!row || !row.verified_at) {
    throw new HttpError(400, '请先完成对象存储配置');
  }
  return {
    accessKey: row.access_key,
    secretKey: decryptSecret(row.secret_key_enc),
    bucket: row.bucket,
    domain: row.domain,
    zone: (isQiniuZone(row.zone) ? row.zone : 'Zone_z0') as QiniuZone,
    privateBucket: !!row.private_bucket,
    urlTtl: row.url_ttl || 3600,
  };
}

export async function saveVerifiedProfile(userId: number, cfg: QiniuConfig): Promise<StoragePublic> {
  await verifyConnectivity(cfg);
  upsertStorageProfile(userId, {
    access_key: cfg.accessKey,
    secret_key_enc: encryptSecret(cfg.secretKey),
    bucket: cfg.bucket,
    domain: cfg.domain,
    zone: cfg.zone,
    private_bucket: cfg.privateBucket,
    url_ttl: cfg.urlTtl,
    verified_at: Date.now(),
  });
  return toPublicProfile(getStorageProfile(userId));
}
