import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverview } from '../src/overview.js';

const prod = (id, sha, createdAt = 2000) => ({ id, commitSha: sha, createdAt });
const project = (id, name, production = prod(`dpl_${id}`, `sha_${id}`), domains = []) => ({ id, name, production, domains });
const bucket = (name, manifest = null, indexEtag = 'e1') => ({ name, manifest, indexEtag, website: true, websiteUrl: `https://${name}.website.yandexcloud.net` });
const manifest = (projectId, deploymentId, commitSha, indexEtag = 'e1') => ({ vercel: { projectId, deploymentId, commitSha, deploymentCreatedAt: 1000 }, syncedAt: '2026-09-01T00:00:00Z', indexEtag });

const byId = (o) => Object.fromEntries(o.rows.map((r) => [r.id, r]));

test('статусы: актуально, устарело, тот же коммит, изменено вне программы', () => {
  const projects = [project('a', 'alpha'), project('b', 'beta'), project('c', 'gamma'), project('d', 'delta')];
  const buckets = [
    bucket('alpha', manifest('a', 'dpl_a', 'sha_a')),
    bucket('beta', manifest('b', 'dpl_old', 'sha_old')),
    bucket('gamma', manifest('c', 'dpl_redeploy', 'sha_c')), // Vercel пересобрал тот же коммит
    bucket('delta', manifest('d', 'dpl_d', 'sha_d', 'e1'), 'e2'), // index.html перезаписан вручную
  ];
  const rows = byId(buildOverview({ projects, buckets }));
  assert.equal(rows.a.status, 'synced');
  assert.equal(rows.b.status, 'outdated');
  assert.equal(rows.c.status, 'synced');
  assert.equal(rows.d.status, 'modified');
});

test('сопоставление: ручная связь → манифест → имя → домен', () => {
  const projects = [
    project('p1', 'prokormi'),
    project('p2', 'baggage_dolly_vk'),
    project('p3', 'renamed'),
    project('p4', 'shop', undefined, ['shop.example.ru', 'shop.vercel.app']),
    project('p5', 'manual'),
    project('p6', 'nothing'),
    project('p7', 'empty', null),
  ];
  const buckets = [
    bucket('prokormi'),
    bucket('baggage-dolly-vk'),
    bucket('some-other-name', manifest('p3', 'dpl_p3', 'sha_p3')),
    bucket('renamed'), // имя совпадает, но у p3 уже есть бакет по манифесту
    bucket('shop.example.ru'),
    bucket('custom-bucket'),
  ];
  const o = buildOverview({ projects, buckets, links: { p5: 'custom-bucket' } });
  const rows = byId(o);
  assert.deepEqual([rows.p1.yandex.bucket, rows.p1.yandex.how, rows.p1.status], ['prokormi', 'name', 'unknown']);
  assert.deepEqual([rows.p2.yandex.bucket, rows.p2.yandex.how], ['baggage-dolly-vk', 'name']);
  assert.deepEqual([rows.p3.yandex.bucket, rows.p3.yandex.how, rows.p3.status], ['some-other-name', 'manifest', 'synced']);
  assert.deepEqual([rows.p4.yandex.bucket, rows.p4.yandex.how], ['shop.example.ru', 'domain']);
  assert.deepEqual([rows.p5.yandex.bucket, rows.p5.yandex.how], ['custom-bucket', 'manual']);
  assert.equal(rows.p6.yandex, null);
  assert.equal(rows.p6.status, 'missing');
  assert.equal(rows.p6.suggestedBucket, 'nothing');
  assert.equal(rows.p7.status, 'no-deploy');
  assert.deepEqual(o.unmatchedBuckets.map((b) => b.name), ['renamed']);
  assert.equal(o.counts.total, 7);
});

test('бакет с манифестом другого проекта не присваивается по имени', () => {
  const projects = [project('x', 'site'), project('y', 'other')];
  const buckets = [bucket('site', manifest('y', 'dpl_y', 'sha_y'))];
  const rows = byId(buildOverview({ projects, buckets }));
  assert.equal(rows.y.yandex.bucket, 'site');
  assert.equal(rows.x.yandex, null);
});

test('манифест пропал из бакета — используется локальная копия', () => {
  const projects = [project('a', 'renamed-project')];
  const buckets = [bucket('my-bucket', null, 'e1')];
  const syncs = { 'my-bucket': { ...manifest('a', 'dpl_a', 'sha_a'), vercel: { ...manifest('a', 'dpl_a', 'sha_a').vercel, commitMessage: 'Fix' } } };
  const row = buildOverview({ projects, buckets, syncs }).rows[0];
  assert.equal(row.yandex.bucket, 'my-bucket');
  assert.equal(row.status, 'synced');
  assert.equal(row.yandex.synced.fromLocalState, true);
  assert.equal(row.yandex.synced.commitMessage, 'Fix');
});

test('ручная связь на ещё не созданный бакет', () => {
  const rows = byId(buildOverview({ projects: [project('a', 'alpha')], buckets: [], links: { a: 'future-bucket' } }));
  assert.equal(rows.a.yandex.bucket, 'future-bucket');
  assert.equal(rows.a.yandex.exists, false);
  assert.equal(rows.a.status, 'missing');
});
