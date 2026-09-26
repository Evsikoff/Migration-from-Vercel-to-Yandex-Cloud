// Полный цикл без сети: деплой из Vercel CLI (файлы берутся через API) → бакет в имитации Object Storage.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeFixture, startMockVercel } from './helpers/mock-vercel.js';
import { startMockS3 } from './helpers/mock-s3.js';

process.env.V2YC_DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'v2yc-data-'));
const { runSync } = await import('../src/sync.js');
const { Job } = await import('../src/jobs.js');
const { S3Client } = await import('../src/s3.js');
const { VercelClient } = await import('../src/vercel.js');
const { buildOverview, scanBuckets } = await import('../src/overview.js');

function cliFixture() {
  const f = makeFixture();
  const files = {
    'index.html': '<h1>Главная</h1>',
    'about.html': '<h1>О нас</h1>',
    'css/site.css': 'body{color:red}',
    '.env': 'SECRET=do-not-publish',
    'vercel.json': JSON.stringify({ cleanUrls: true }),
  };
  const contents = {};
  const tree = [];
  const dirs = {};
  for (const [rel, body] of Object.entries(files)) {
    const uid = `uid_${Object.keys(contents).length}`;
    contents[uid] = body;
    const parts = rel.split('/');
    let level = tree;
    for (const d of parts.slice(0, -1)) {
      if (!dirs[d]) {
        dirs[d] = { name: d, type: 'directory', children: [] };
        level.push(dirs[d]);
      }
      level = dirs[d].children;
    }
    level.push({ name: parts.at(-1), type: 'file', uid, mode: 33188 });
  }
  const dep = { id: 'dpl_static_1', url: 'landing-abc.vercel.app', createdAt: 1790000000000, readyState: 'READY', alias: ['landing.vercel.app'], meta: {}, source: 'cli' };
  f.projects = [{ id: 'prj_static', name: 'landing', framework: null, accountId: f.team.id, updatedAt: 1790000000001, targets: { production: dep } }];
  f.deployments = { [dep.id]: dep };
  f.files = { [dep.id]: { tree, contents } };
  return f;
}

test('копирование статического сайта и обновление без лишних загрузок', async (t) => {
  const vercelMock = await startMockVercel(cliFixture());
  const s3Mock = await startMockS3({ pageSize: 2 });
  t.after(() => {
    vercelMock.server.close();
    s3Mock.server.close();
  });
  const vercel = new VercelClient('test-token', { baseUrl: vercelMock.url });
  const s3 = new S3Client({ accessKeyId: 'AKID', secretAccessKey: 'secret', endpoint: s3Mock.url, region: 'ru-central1' });
  const synced = {};
  const ctx = { vercel, s3, config: { cleanWorkDir: true }, tools: {}, recordSync: async (b, m) => (synced[b] = m) };

  const job = new Job({ projectId: 'prj_static', projectName: 'landing', teamId: 'team_test', bucket: 'landing', mode: 'copy' });
  await runSync(job, ctx);
  const bucket = s3Mock.buckets.get('landing');
  assert.ok(bucket, 'бакет создан');
  assert.equal(bucket.acl, 'public-read');
  assert.deepEqual(bucket.website, { index: 'index.html', error: 'index.html' });
  assert.deepEqual([...bucket.objects.keys()].sort(), ['.vercel-sync.json', 'about', 'about.html', 'css/site.css', 'index.html']);
  assert.equal(bucket.objects.get('index.html').body.toString(), '<h1>Главная</h1>');
  assert.equal(bucket.objects.get('index.html').contentType, 'text/html; charset=utf-8');
  assert.equal(bucket.objects.get('about').contentType, 'text/html; charset=utf-8');
  assert.equal(bucket.objects.get('css/site.css').cacheControl, 'public, max-age=3600');
  const manifest = JSON.parse(bucket.objects.get('.vercel-sync.json').body);
  assert.equal(manifest.vercel.deploymentId, 'dpl_static_1');
  assert.equal(manifest.indexEtag, bucket.objects.get('index.html').etag);
  assert.equal(synced.landing.vercel.projectId, 'prj_static');
  assert.equal(job.result.uploaded, 4);

  // Сверка статуса по данным из бакета.
  const project = { id: 'prj_static', name: 'landing', production: { id: 'dpl_static_1', createdAt: 1 }, domains: [] };
  let overview = buildOverview({ projects: [project], buckets: await scanBuckets(s3) });
  assert.equal(overview.rows[0].status, 'synced');
  overview = buildOverview({ projects: [{ ...project, production: { id: 'dpl_static_2', createdAt: 2 } }], buckets: await scanBuckets(s3) });
  assert.equal(overview.rows[0].status, 'outdated');

  // Повторная выгрузка: ничего не меняется; лишний файл в бакете удаляется.
  await s3.putObject('landing', 'old/garbage.txt', Buffer.from('x'));
  const again = new Job({ projectId: 'prj_static', projectName: 'landing', teamId: 'team_test', bucket: 'landing', mode: 'update' });
  await runSync(again, ctx);
  assert.equal(again.result.uploaded, 0);
  assert.equal(again.result.deleted, 1);
  assert.ok(!bucket.objects.has('old/garbage.txt'));
});

test('занятое имя бакета обнаруживается до сборки', async (t) => {
  const vercelMock = await startMockVercel(cliFixture());
  const s3Mock = await startMockS3({ foreign: ['taken-name'] });
  t.after(() => {
    vercelMock.server.close();
    s3Mock.server.close();
  });
  const ctx = {
    vercel: new VercelClient('test-token', { baseUrl: vercelMock.url }),
    s3: new S3Client({ accessKeyId: 'AKID', secretAccessKey: 'secret', endpoint: s3Mock.url }),
    config: {},
    tools: {},
    recordSync: async () => {},
  };
  const job = new Job({ projectId: 'prj_static', projectName: 'landing', teamId: 'team_test', bucket: 'taken-name', mode: 'copy' });
  await assert.rejects(runSync(job, ctx), /занято/);
  assert.ok(!vercelMock.fixture.requests.some((r) => r.includes('/files')), 'исходники не скачивались');
});
