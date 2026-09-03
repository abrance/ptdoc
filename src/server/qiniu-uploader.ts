import qiniu from 'qiniu';
import type * as Qiniu from 'qiniu';
import { createHmac } from 'node:crypto';

// 七牛存储区域映射：QINIU_ZONE 取值对应下表。
export type QiniuZone =
  | 'Zone_z0'
  | 'Zone_z1'
  | 'Zone_z2'
  | 'Zone_na0'
  | 'Zone_as0';

const ZONES: Record<QiniuZone, Qiniu.conf.Zone> = {
  Zone_z0: qiniu.zone.Zone_z0,
  Zone_z1: qiniu.zone.Zone_z1,
  Zone_z2: qiniu.zone.Zone_z2,
  Zone_na0: qiniu.zone.Zone_na0,
  Zone_as0: qiniu.zone.Zone_as0,
};

interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  domain: string;
  zone: QiniuZone;
  /** 是否为私有桶：是则下载 URL 需带签名，且会过期 */
  privateBucket: boolean;
  /** 私有桶签名 URL 的有效期（秒） */
  urlTtl: number;
}

let config: QiniuConfig | null = null;

/**
 * 用环境变量初始化七牛配置。在 vite.config 中于启动时调用一次。
 * 缺少必要字段时静默跳过（上传功能不可用，但站点其余部分照常工作）。
 */
export function initQiniu(env: Record<string, string | undefined>): void {
  const accessKey = env.QINIU_AK;
  const secretKey = env.QINIU_SK;
  const bucket = env.QINIU_BUCKET;
  const domain = env.QINIU_DOMAIN;
  const zone = (env.QINIU_ZONE as QiniuZone) || 'Zone_z0';
  const privateBucket = env.QINIU_PRIVATE === 'true';
  const urlTtl = Number(env.QINIU_URL_TTL) || 3600;

  if (accessKey && secretKey && bucket && domain && zone in ZONES) {
    config = { accessKey, secretKey, bucket, domain, zone, privateBucket, urlTtl };
  }
}

export function isQiniuConfigured(): boolean {
  return config !== null;
}

// ─── 你的业务逻辑：对象存储 key 的命名规则 ──────────────────────
// {prefix}/2026/08/1693200000000-a1b2c3.png —— 按年月分目录，避免单目录过杂。
function buildKey(filename: string, prefix = 'md-img'): string {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  const d = new Date();
  const ym = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}/${ym}/${stamp}${ext}`;
}

/**
 * 上传二进制到七牛云，返回可公网访问的 URL。
 * 仅在配置了 QINIU_* 时可用；否则抛出明确错误。
 * keyPrefix 用于把不同类型资源分到不同目录（如分享版 HTML 用 'share'）。
 */
export async function uploadToQiniu(
  buffer: Buffer,
  filename: string,
  keyPrefix?: string,
): Promise<{ url: string; key: string }> {
  if (!config) {
    throw new Error(
      '七牛云未配置：请在 .env 中填写 QINIU_AK / QINIU_SK / QINIU_BUCKET / QINIU_DOMAIN',
    );
  }

  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const putPolicy = new qiniu.rs.PutPolicy({ scope: config.bucket });
  const uploadToken = putPolicy.uploadToken(mac);

  const conf = new qiniu.conf.Config({ zone: ZONES[config.zone] });
  const formUploader = new qiniu.form_up.FormUploader(conf);
  const putExtra = new qiniu.form_up.PutExtra();

  const key = buildKey(filename, keyPrefix);
  const result = await formUploader.put(uploadToken, key, buffer, putExtra);

  if (!result.ok()) {
    const detail =
      typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    throw new Error('七牛云上传失败：' + detail);
  }

  const domain = config.domain.replace(/\/$/, '');
  const baseUrl = `${domain}/${key}`;
  const url = config.privateBucket
    ? makePrivateUrl(baseUrl, config.accessKey, config.secretKey, config.urlTtl)
    : baseUrl;
  return { url, key };
}

/**
 * 从七牛桶删除对象（媒体库"删除"用）。
 * 删除失败（如网络异常）会抛错，由上层保留记录并提示。
 */
export function deleteFromQiniu(key: string): Promise<void> {
  if (!config) {
    return Promise.reject(
      new Error(
        '七牛云未配置：请在 .env 中填写 QINIU_AK / QINIU_SK / QINIU_BUCKET / QINIU_DOMAIN',
      ),
    );
  }
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const conf = new qiniu.conf.Config({ zone: ZONES[config.zone] });
  const bucketManager = new qiniu.rs.BucketManager(mac, conf);
  return new Promise((resolve, reject) => {
    bucketManager.delete(config!.bucket, key, (err, respBody, respInfo) => {
      if (err) return reject(err);
      if (respInfo.statusCode >= 200 && respInfo.statusCode < 300) return resolve();
      // 612 = 资源不存在：视为已删除成功（幂等）
      if (respInfo.statusCode === 612) return resolve();
      reject(
        new Error(`七牛删除失败（HTTP ${respInfo.statusCode}）：${JSON.stringify(respBody)}`),
      );
    });
  });
}

/**
 * 生成私有桶的带签名下载 URL（Qiniu 官方算法）：
 *   <baseUrl>?e=<deadline>&token=<urlSafeBase64(HMAC-SHA1(toSign))>:<accessKey>
 * 该 URL 仅在 urlTtl 秒内有效，过期后需在渲染时重新签发。
 */
function makePrivateUrl(baseUrl: string, accessKey: string, secretKey: string, ttl: number): string {
  const deadline = Math.floor(Date.now() / 1000) + ttl;
  const toSign = `${baseUrl}?e=${deadline}`;
  const sign = createHmac('sha1', secretKey).update(toSign).digest('base64');
  const safe = sign.replace(/\+/g, '-').replace(/\//g, '_');
  return `${toSign}&token=${safe}:${accessKey}`;
}
