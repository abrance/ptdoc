import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapQdrantPoints, retrieveHits, setQdrantQueryForTests } from './qdrant-retriever.ts';

test('retriever 把 fake Qdrant 命中映射为 id/title/snippet/score', async () => {
  setQdrantQueryForTests(async () =>
    Array.from({ length: 5 }, (_, i) => ({
      id: 'p' + i,
      score: 0.9 - i * 0.1,
      payload: { title: 'T' + i, text: 'body ' + i, url: 'https://x/' + i },
    })),
  );
  const hits = await retrieveHits({ url: 'http://q', collection: 'c', topK: 5 }, 'hello');
  assert.equal(hits.length, 5);
  assert.equal(hits[0].id, 'p0');
  assert.equal(hits[0].title, 'T0');
  assert.equal(hits[0].snippet, 'body 0');
  assert.equal(typeof hits[0].score, 'number');
  setQdrantQueryForTests(null);
});

test('title 回退 path/source/url，snippet 回退 content', () => {
  const hits = mapQdrantPoints([
    { id: 1, score: 1, payload: { path: 'a.md', content: 'hello world' } },
  ]);
  assert.equal(hits[0].title, 'a.md');
  assert.equal(hits[0].snippet, 'hello world');
});

test('mapQdrantPoints 从 payload.doc_key 取 doc_key，缺失时为 undefined', () => {
  const hits = mapQdrantPoints([
    { id: 'f3256532-b37b-4214-104b-1e15a98570fb', score: 1, payload: { path: 'a.md', doc_key: 'a.md' } },
    { id: 'x', score: 0.5, payload: { path: 'b.md' } },
  ]);
  assert.equal(hits[0].doc_key, 'a.md');
  assert.equal(hits[1].doc_key, undefined);
});
