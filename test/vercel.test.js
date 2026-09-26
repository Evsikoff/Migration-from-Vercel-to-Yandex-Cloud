import assert from 'node:assert/strict';
import test from 'node:test';
import { VercelClient, enrichSummaries, pickPrimaryDomain, summarizeProject } from '../src/vercel.js';
import { startMockVercel } from './helpers/mock-vercel.js';

test('все проекты всех команд с постраничной выдачей и без повторов', async (t) => {
  const mock = await startMockVercel(undefined, { pageSize: 2 });
  t.after(() => mock.server.close());
  const client = new VercelClient('test-token', { baseUrl: mock.url });
  const { items, teams, errors } = await client.listAllProjects();
  assert.equal(teams.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => i.project.name).sort(), ['baggage_dolly_vk', 'muha', 'no-deploys-yet', 'prokormi']);
  assert.ok(mock.fixture.requests.filter((r) => r.startsWith('GET /v10/projects')).length >= 3, 'должно быть несколько страниц');

  const summaries = items.map(({ project, scope }) => summarizeProject(project, scope));
  const prokormi = summaries.find((s) => s.name === 'prokormi');
  assert.equal(prokormi.primaryDomain, 'prokormi.vercel.app');
  assert.equal(prokormi.production.commitSha, '06a6398d1a29dd230abb8b90239ddb497faef2aa');
  assert.equal(prokormi.repo.webUrl, 'https://github.com/Evsikoff/prokormi');
  assert.equal(prokormi.dashboardUrl, 'https://vercel.com/evsikoffs-projects/prokormi');
  assert.equal(prokormi.teamId, 'team_test');

  // У проекта без targets продакшн-деплой и домены дозапрашиваются.
  const dolly = summaries.find((s) => s.name === 'baggage_dolly_vk');
  assert.equal(dolly.production, null);
  assert.deepEqual(await enrichSummaries(client, summaries), []);
  assert.equal(dolly.production.id, 'dpl_dolly');
  assert.equal(dolly.primaryDomain, 'baggage-dolly-vk.vercel.app');
  assert.equal(summaries.find((s) => s.name === 'no-deploys-yet').production, null);
});

test('переменные окружения и понятная ошибка при неверном токене', async (t) => {
  const mock = await startMockVercel();
  t.after(() => mock.server.close());
  const { env } = await new VercelClient('test-token', { baseUrl: mock.url }).pullEnv('prj_prokormi', 'team_test');
  assert.equal(env.VITE_FROM_VERCEL, 'yes');
  await assert.rejects(new VercelClient('wrong', { baseUrl: mock.url }).listTeams(), /vercel\.com\/account\/tokens/);
});

test('главный домен: свой домен, затем короткий *.vercel.app', () => {
  assert.equal(pickPrimaryDomain(['app-git-main-team.vercel.app', 'app-team.vercel.app', 'app.vercel.app']), 'app.vercel.app');
  assert.equal(pickPrimaryDomain(['app.vercel.app', 'www.example.ru', 'example.ru']), 'example.ru');
  assert.equal(pickPrimaryDomain([]), null);
});
