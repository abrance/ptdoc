import { test } from 'node:test';
import assert from 'node:assert/strict';
import qiniu from 'qiniu';
import { makePrivateUrl } from './qiniu-uploader.ts';

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
