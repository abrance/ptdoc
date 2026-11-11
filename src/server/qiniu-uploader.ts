import qiniu from 'qiniu';
import type * as Qiniu from 'qiniu';
import { createHmac } from 'node:crypto';

export type QiniuZone = 'Zone_z0' | 'Zone_z1' | 'Zone_z2' | 'Zone_na0' | 'Zone_as0';

const ZONES: Record<QiniuZone, Qiniu.conf.Zone> = {
  Zone_z0: qiniu.zone.Zone_z0,
  Zone_z1: qiniu.zone.Zone_z1,
  Zone_z2: qiniu.zone.Zone_z2,
  Zone_na0: qiniu.zone.Zone_na0,
  Zone_as0: qiniu.zone.Zone_as0,
};

export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  domain: string;
  zone: QiniuZone;
  privateBucket: boolean;
  urlTtl: number;
}

export function isQiniuZone(z: string): z is QiniuZone {
  return z in ZONES;
}

function buildKey(filename: string, prefix = 'md-img'): string {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  const d = new Date();
  const ym = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}/${ym}/${stamp}${ext}`;
}

export async function uploadToQiniu(
  config: QiniuConfig,
  buffer: Buffer,
  filename: string,
  keyPrefix?: string,
): Promise<{ url: string; key: string }> {
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const putPolicy = new qiniu.rs.PutPolicy({ scope: config.bucket });
  const uploadToken = putPolicy.uploadToken(mac);
  const conf = new qiniu.conf.Config({ zone: ZONES[config.zone] });
  const formUploader = new qiniu.form_up.FormUploader(conf);
  const putExtra = new qiniu.form_up.PutExtra();
  const key = buildKey(filename, keyPrefix);
  const result = await formUploader.put(uploadToken, key, buffer, putExtra);
  if (!result.ok()) {
    const detail = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    throw new Error('七牛云上传失败：' + detail);
  }
  const domain = config.domain.replace(/\/$/, '');
  const baseUrl = `${domain}/${key}`;
  const url = config.privateBucket
    ? makePrivateUrl(baseUrl, config.accessKey, config.secretKey, config.urlTtl)
    : baseUrl;
  return { url, key };
}

/** 用调用方指定的 key 上传（归档产物需要不可变、可预测的文件名）。 */
export async function uploadToQiniuWithKey(
  config: QiniuConfig,
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<{ url: string; key: string }> {
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const putPolicy = new qiniu.rs.PutPolicy({ scope: `${config.bucket}:${key}` });
  const uploadToken = putPolicy.uploadToken(mac);
  const conf = new qiniu.conf.Config({ zone: ZONES[config.zone] });
  const formUploader = new qiniu.form_up.FormUploader(conf);
  const putExtra = new qiniu.form_up.PutExtra();
  putExtra.mimeType = contentType;
  const result = await formUploader.put(uploadToken, key, buffer, putExtra);
  if (!result.ok()) {
    const detail = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    throw new Error('七牛云上传失败：' + detail);
  }
  const domain = config.domain.replace(/\/$/, '');
  const baseUrl = `${domain}/${key}`;
  const url = config.privateBucket
    ? makePrivateUrl(baseUrl, config.accessKey, config.secretKey, config.urlTtl)
    : baseUrl;
  return { url, key };
}

export function deleteFromQiniu(config: QiniuConfig, key: string): Promise<void> {
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const conf = new qiniu.conf.Config({ zone: ZONES[config.zone] });
  const bucketManager = new qiniu.rs.BucketManager(mac, conf);
  return new Promise((resolve, reject) => {
    bucketManager.delete(config.bucket, key, (err, respBody, respInfo) => {
      if (err) return reject(err);
      if (respInfo.statusCode >= 200 && respInfo.statusCode < 300) return resolve();
      if (respInfo.statusCode === 612) return resolve();
      reject(new Error(`七牛删除失败（HTTP ${respInfo.statusCode}）：${JSON.stringify(respBody)}`));
    });
  });
}

/**
 * 真上传一个探针对象再删掉。stat 探测在 region 选错时同样返回 612（对象不存在），
 * 会误判为连通，直到首次归档才 500；写一次才真正验证 bucket / region / 写权限。
 */
export async function testQiniuBucket(config: QiniuConfig): Promise<void> {
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const conf = new qiniu.conf.Config({ zone: ZONES[config.zone] });
  const key = `__ptdoc_connectivity_probe__/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const putPolicy = new qiniu.rs.PutPolicy({ scope: `${config.bucket}:${key}` });
  const uploadToken = putPolicy.uploadToken(mac);
  const putExtra = new qiniu.form_up.PutExtra();
  putExtra.mimeType = 'text/plain';
  const result = await new qiniu.form_up.FormUploader(conf).put(
    uploadToken,
    key,
    Buffer.from('ok'),
    putExtra,
  );
  if (!result.ok()) {
    const detail =
      typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '').slice(0, 200);
    throw new Error(`七牛连通性校验失败（写探针对象）：${detail}`);
  }
  // 探针删除失败不影响配置有效性，交给 bucket 生命周期清理
  const bucketManager = new qiniu.rs.BucketManager(mac, conf);
  await new Promise<void>((resolve) => bucketManager.delete(config.bucket, key, () => resolve()));
}

export function makePrivateUrl(
  baseUrl: string,
  accessKey: string,
  secretKey: string,
  ttl: number,
  nowMs = Date.now(),
): string {
  const deadline = Math.floor(nowMs / 1000) + ttl;
  const toSign = `${baseUrl}?e=${deadline}`;
  const sign = createHmac('sha1', secretKey).update(toSign).digest('base64');
  const safe = sign.replace(/\+/g, '-').replace(/\//g, '_');
  // token 格式必须是 <AccessKey>:<Sign>，反过来七牛一律 401（与 SDK privateDownloadUrl 一致）
  return `${toSign}&token=${accessKey}:${safe}`;
}
