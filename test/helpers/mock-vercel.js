// Имитация Vercel REST API для тестов: форма ответов повторяет настоящие.
import http from 'node:http';

export function makeFixture() {
  const team = { id: 'team_test', slug: 'evsikoffs-projects', name: "Evsikoff's projects" };
  const prokormiDeployment = {
    id: 'dpl_prokormi_2',
    url: 'prokormi-8pfu80b7y-evsikoffs-projects.vercel.app',
    createdAt: 1790368442859,
    readyState: 'READY',
    target: 'production',
    alias: ['prokormi.vercel.app', 'prokormi-evsikoffs-projects.vercel.app', 'prokormi-git-main-evsikoffs-projects.vercel.app'],
    meta: {
      githubCommitRef: 'main',
      githubCommitSha: '06a6398d1a29dd230abb8b90239ddb497faef2aa',
      githubCommitMessage: 'Merge pull request #1\n\nImplement monster room navigation and task system',
      githubRepo: 'prokormi',
      githubOrg: 'Evsikoff',
    },
  };
  const projects = [
    {
      id: 'prj_prokormi',
      name: 'prokormi',
      framework: 'vite',
      accountId: team.id,
      updatedAt: 1790368488663,
      nodeVersion: '24.x',
      link: { type: 'github', org: 'Evsikoff', repo: 'prokormi', productionBranch: 'main' },
      targets: { production: prokormiDeployment },
    },
    {
      id: 'prj_dolly',
      name: 'baggage_dolly_vk',
      framework: 'vite',
      accountId: team.id,
      updatedAt: 1789298168002,
      link: { type: 'github', org: 'Evsikoff', repo: 'Baggage_dolly_vk', productionBranch: 'main' },
      // Без targets — программа должна сама запросить продакшн-деплой и домены.
    },
    { id: 'prj_empty', name: 'no-deploys-yet', framework: null, accountId: team.id, updatedAt: 1780000000000 },
    {
      id: 'prj_muha',
      name: 'muha',
      framework: 'vite',
      accountId: team.id,
      updatedAt: 1785836314453,
      targets: {
        production: { id: 'dpl_muha', url: 'muha-x.vercel.app', createdAt: 1785836300000, readyState: 'READY', alias: ['muha.vercel.app'], meta: { githubCommitSha: 'abc1234def', githubRepo: 'muha', githubOrg: 'Evsikoff' } },
      },
    },
  ];
  const deployments = {
    dpl_prokormi_2: { ...prokormiDeployment, name: 'prokormi', source: 'git' },
    dpl_dolly: { id: 'dpl_dolly', projectId: 'prj_dolly', url: 'baggagedolly-c1pqo7kg2.vercel.app', createdAt: 1789298164061, readyState: 'READY', meta: { githubCommitSha: '8651d633427dfcb2300d54c235211ae35a030821', githubRepo: 'Baggage_dolly_vk', githubOrg: 'Evsikoff' } },
  };
  return {
    team,
    projects,
    deployments,
    env: { prj_prokormi: { VITE_FROM_VERCEL: 'yes', VERCEL: '1', VERCEL_URL: 'x.vercel.app', TURBO_TOKEN: 'secret' } },
    domains: { prj_dolly: [{ name: 'baggage-dolly-vk.vercel.app', redirect: null }] },
    files: {}, // deploymentId → { tree, contents: { uid: содержимое } } — для деплоев из CLI
    requests: [],
  };
}

export function startMockVercel(fixture = makeFixture(), { token = 'test-token', pageSize = 2 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    fixture.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(403, { error: { code: 'forbidden', message: 'The request is missing an authentication token', invalidToken: true } });
    const teamId = url.searchParams.get('teamId');
    const p = url.pathname;
    let m;
    if (p === '/v2/user') return send(200, { user: { username: 'evsikoff', name: 'Evsikoff' } });
    if (p === '/v2/teams') return send(200, { teams: [fixture.team], pagination: { count: 1, next: null } });
    if (p === '/v10/projects') {
      if (!teamId) return send(403, { error: { code: 'forbidden', message: 'Not authorized' } });
      // Как у настоящего API: сортировка по updatedAt, страница начинается с элемента-границы (включительно).
      const sorted = [...fixture.projects].sort((a, b) => b.updatedAt - a.updatedAt);
      const from = Number(url.searchParams.get('from')) || Infinity;
      const page = sorted.filter((x) => x.updatedAt <= from).slice(0, pageSize);
      const last = page.at(-1);
      const more = last && sorted.some((x) => x.updatedAt < last.updatedAt);
      return send(200, { projects: page, pagination: { count: page.length, next: more ? last.updatedAt : null } });
    }
    if ((m = p.match(/^\/v9\/projects\/([^/]+)\/domains$/))) return send(200, { domains: fixture.domains[m[1]] || [], pagination: { next: null } });
    if ((m = p.match(/^\/v9\/projects\/([^/]+)$/))) {
      const proj = fixture.projects.find((x) => x.id === decodeURIComponent(m[1]) || x.name === decodeURIComponent(m[1]));
      return proj ? send(200, proj) : send(404, { error: { code: 'not_found', message: 'Project not found' } });
    }
    if (p === '/v6/deployments') {
      const pid = url.searchParams.get('projectId');
      const list = Object.values(fixture.deployments).filter((d) => d.projectId === pid);
      return send(200, { deployments: list.map((d) => ({ uid: d.id, url: d.url, created: d.createdAt, state: 'READY', meta: d.meta })), pagination: {} });
    }
    if ((m = p.match(/^\/v13\/deployments\/([^/]+)$/))) {
      const d = fixture.deployments[decodeURIComponent(m[1])];
      return d ? send(200, d) : send(404, { error: { code: 'not_found', message: 'Deployment not found' } });
    }
    if ((m = p.match(/^\/v3\/env\/pull\/([^/]+)\/production$/))) return send(200, { env: fixture.env[m[1]] || {} });
    if ((m = p.match(/^\/v6\/deployments\/([^/]+)\/files$/))) {
      const files = fixture.files?.[decodeURIComponent(m[1])];
      return files ? send(200, files.tree) : send(404, { error: { code: 'not_found', message: 'File tree not found' } });
    }
    if ((m = p.match(/^\/v8\/deployments\/([^/]+)\/files\/([^/]+)$/))) {
      const content = fixture.files?.[decodeURIComponent(m[1])]?.contents[decodeURIComponent(m[2])];
      return content ? send(200, { data: Buffer.from(content).toString('base64') }) : send(404, { error: { code: 'not_found', message: 'File not found' } });
    }
    send(404, { error: { code: 'not_found', message: `mock: ${p}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, fixture })));
}
