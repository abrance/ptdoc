import { test } from 'node:test';
import assert from 'node:assert/strict';
import qiniu from 'qiniu';
import { makePrivateUrl, resignPrivateUrls } from './qiniu-uploader.ts';

// 私有 bucket 的下载 token 格式错一次就是全站 401，所以拿 SDK 自己的算法当基准对齐。
test('makePrivateUrl 与 SDK privateDownloadUrl 完全一致', () => {
  const accessKey = 'ak-test-0123456789';
  const secretKey = 'sk-test-abcdefghij';
  const domain = 'https://cdn.example.com';
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const bucketManager = new qiniu.rs.BucketManager(mac, new qiniu.conf.Config());

  for (const key of ['archive/p/doc-a/v1-x.md', 'md-img/2026/11/123-abc.png']) {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const expected = bucketManager.privateDownloadUrl(domain, key, deadline);
    const actual = makePrivateUrl(`${domain}/${key}`, accessKey, secretKey, 3600);
    assert.equal(actual, expected, `key=${key}`);
  }
});

test('makePrivateUrl 的 token 顺序是 AccessKey:Sign', () => {
  const url = makePrivateUrl('https://cdn.example.com/a/b.md', 'myak', 'mysk', 60);
  const token = new URL(url).searchParams.get('token') ?? '';
  const [head] = token.split(':');
  assert.equal(head, 'myak');
  assert.ok(token.length > 'myak:'.length);
});

// 私有空间的图在库里是「上传当时」签的，一小时后就 401；输出前必须按当前时间重签。
test('resignPrivateUrls：私有空间重签域名下的链接，其余原样', () => {
  const cfg = {
    accessKey: 'ak-test',
    secretKey: 'sk-test',
    bucket: 'b',
    domain: 'https://cdn.example.com',
    zone: 'Zone_z2' as const,
    privateBucket: true,
    urlTtl: 600,
  };
  const oldDeadline = Math.floor(Date.now() / 1000) - 99999;
  const md = [
    `![a](https://cdn.example.com/md-img/2026/11/x.png?e=${oldDeadline}&token=STALE:SIG)`,
    `![b](https://cdn.example.com/archive-media/mermaid-abc.svg)`,
    '![c](https://other.example.com/keep.png)',
  ].join('\n');

  const nowMs = 1_760_000_000_000;
  const out = resignPrivateUrls(md, cfg, nowMs);

  const urls = [...out.matchAll(/\((https?:[^)]+)\)/g)].map((m) => m[1] as string);
  assert.equal(urls.length, 3);
  // 本域名两条都被重签：路径不变、旧 token 丢弃、deadline 是新的
  for (const u of urls.slice(0, 2)) {
    const parsed = new URL(u);
    assert.equal(parsed.searchParams.get('e'), String(Math.floor(nowMs / 1000) + cfg.urlTtl));
    assert.equal(parsed.searchParams.get('token')?.split(':')[0], 'ak-test');
    assert.ok(parsed.pathname.startsWith('/md-img/') || parsed.pathname.startsWith('/archive-media/'));
    assert.ok(!u.includes('STALE'), u);
    assert.equal(u, makePrivateUrl(`https://cdn.example.com${parsed.pathname}`, cfg.accessKey, cfg.secretKey, cfg.urlTtl, nowMs));
  }
  // 别的域名一个字节都不碰
  assert.ok(out.includes('https://other.example.com/keep.png'));
});

test('resignPrivateUrls：公开空间是恒等函数', () => {
  const cfg = {
    accessKey: 'ak-test',
    secretKey: 'sk-test',
    bucket: 'b',
    domain: 'https://cdn.example.com',
    zone: 'Zone_z2' as const,
    privateBucket: false,
    urlTtl: 3600,
  };
  const md = '![a](https://cdn.example.com/md-img/x.png)';
  assert.equal(resignPrivateUrls(md, cfg), md);
});

test('resignPrivateUrls：domain 不带协议头也能重签', () => {
  const cfg = {
    accessKey: 'ak-test',
    secretKey: 'sk-test',
    bucket: 'b',
    domain: 'cdn.example.com',
    zone: 'Zone_z2' as const,
    privateBucket: true,
    urlTtl: 60,
  };
  const out = resignPrivateUrls('![](https://cdn.example.com/a/b.png)', cfg, 1_760_000_000_000);
  assert.match(out, /^!\[\]\(https:\/\/cdn\.example\.com\/a\/b\.png\?e=\d+&token=ak-test:/);
});
