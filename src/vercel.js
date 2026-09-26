// Клиент Vercel REST API: команды, проекты, продакшн-деплои, домены, переменные окружения, файлы деплоя.
import { mapLimit, sleep } from './util.js';

export const VERCEL_API = process.env.VERCEL_API_URL || 'https://api.vercel.com';

export class VercelError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'VercelError';
    this.status = status;
    this.code = code;
  }
}

export class VercelClient {
  constructor(token, { baseUrl = VERCEL_API } = {}) {
    if (!token) throw new VercelError(401, 'no_token', 'Не задан токен Vercel');
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async api(pathname, { query = {}, teamId, raw = false, signal } = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (teamId) url.searchParams.set('teamId', teamId);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const timeout = AbortSignal.timeout(90_000);
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: signal ? AbortSignal.any?.([signal, timeout]) ?? signal : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 4) {
          await sleep(800 * 2 ** attempt);
          continue;
        }
        throw new VercelError(0, 'network', `Нет связи с Vercel API: ${err.cause?.message || err.message}`);
      }
      if (res.status === 429 && attempt < 6) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const wait = reset ? reset * 1000 - Date.now() : 2000 * 2 ** attempt;
        await sleep(Math.min(Math.max(wait, 1000), 60_000));
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          /* не JSON */
        }
        const code = body?.error?.code || `http_${res.status}`;
        let message = body?.error?.message || `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          if (/token/i.test(code) || /token/i.test(message) || res.status === 401) {
            message = `Vercel отклонил токен (${message}). Создайте новый токен на https://vercel.com/account/tokens и укажите его в настройках.`;
          }
        }
        throw new VercelError(res.status, code, message);
      }
      return raw ? res : res.json();
    }
  }

  async getUser() {
    const r = await this.api('/v2/user');
    return r.user || r;
  }

  async listTeams() {
    const teams = [];
    let until;
    for (let i = 0; i < 50; i++) {
      const r = await this.api('/v2/teams', { query: { limit: 100, until } });
      teams.push(...(r.teams || []));
      const next = r.pagination?.next;
      if (!next || !(r.teams || []).length) break;
      until = next;
    }
    return teams;
  }

  /** Все проекты одной области (команды или личного аккаунта). Страницы листаются по `from=pagination.next`. */
  async listProjects(teamId) {
    const byId = new Map();
    let from;
    for (let i = 0; i < 200; i++) {
      const r = await this.api('/v10/projects', { teamId, query: { limit: 100, from } });
      const before = byId.size;
      for (const p of r.projects || []) byId.set(p.id, p);
      const next = r.pagination?.next;
      if (!next || byId.size === before || String(next) === String(from)) break;
      from = next;
    }
    return [...byId.values()];
  }

  /** Проекты из всех команд пользователя и личного пространства, без повторов. */
  async listAllProjects() {
    const teams = await this.listTeams();
    const user = await this.getUser().catch(() => null);
    const scopes = teams.map((t) => ({ teamId: t.id, teamSlug: t.slug, teamName: t.name }));
    const byId = new Map();
    const errors = [];
    for (const scope of scopes) {
      try {
        for (const p of await this.listProjects(scope.teamId)) byId.set(p.id, { project: p, scope });
      } catch (err) {
        errors.push(`${scope.teamName || scope.teamSlug}: ${err.message}`);
      }
    }
    // Личное пространство (у старых аккаунтов проекты могут лежать вне команд).
    try {
      const personal = await this.listProjects(undefined);
      for (const p of personal) {
        if (byId.has(p.id)) continue;
        const team = scopes.find((s) => s.teamId === p.accountId);
        byId.set(p.id, { project: p, scope: team || { teamId: undefined, teamSlug: user?.username, teamName: user?.name || user?.username } });
      }
    } catch (err) {
      if (!scopes.length) errors.push(`личные проекты: ${err.message}`);
    }
    return { user, teams, items: [...byId.values()], errors };
  }

  async getProject(idOrName, teamId) {
    return this.api(`/v9/projects/${encodeURIComponent(idOrName)}`, { teamId });
  }

  async getDeployment(idOrUrl, teamId) {
    return this.api(`/v13/deployments/${encodeURIComponent(idOrUrl)}`, { teamId });
  }

  async latestProductionDeployment(projectId, teamId) {
    const r = await this.api('/v6/deployments', { teamId, query: { projectId, target: 'production', state: 'READY', limit: 1 } });
    return r.deployments?.[0] || null;
  }

  async listProductionDomains(projectId, teamId) {
    const r = await this.api(`/v9/projects/${encodeURIComponent(projectId)}/domains`, { teamId, query: { production: 'true', limit: 100 } });
    return (r.domains || []).filter((d) => !d.redirect).map((d) => d.name);
  }

  /**
   * Переменные окружения продакшна в расшифрованном виде — нужны, чтобы сборка совпала с Vercel
   * (например, VITE_* попадают в код при сборке). Значения только передаются процессу сборки и на диск не пишутся.
   * «Sensitive»-переменные Vercel не отдаёт никому — о них сообщаем отдельно.
   */
  async pullEnv(projectId, teamId, target = 'production') {
    const warnings = [];
    try {
      const r = await this.api(`/v3/env/pull/${encodeURIComponent(projectId)}/${encodeURIComponent(target)}`, { teamId, query: { source: 'vercel-to-yandex-cloud' } });
      const env = { ...(r.env || {}), ...(r.buildEnv || {}) };
      return { env, warnings };
    } catch (err) {
      warnings.push(`Быстрая выгрузка переменных не сработала (${err.message}), читаю по одной`);
    }
    const r = await this.api(`/v10/projects/${encodeURIComponent(projectId)}/env`, { teamId, query: { decrypt: 'true' } });
    const env = {};
    for (const e of r.envs || []) {
      const targets = Array.isArray(e.target) ? e.target : [e.target];
      if (!targets.includes(target) || e.gitBranch) continue;
      if (e.type === 'sensitive' || (e.type === 'secret' && !e.decrypted)) {
        warnings.push(`Переменная ${e.key} помечена как sensitive — Vercel не отдаёт её значение`);
        continue;
      }
      if (typeof e.value === 'string') env[e.key] = e.value;
    }
    return { env, warnings };
  }

  async listDeploymentFiles(deploymentId, teamId) {
    return this.api(`/v6/deployments/${encodeURIComponent(deploymentId)}/files`, { teamId });
  }

  async getDeploymentFile(deploymentId, fileId, teamId) {
    const res = await this.api(`/v8/deployments/${encodeURIComponent(deploymentId)}/files/${encodeURIComponent(fileId)}`, { teamId, raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        if (parsed && typeof parsed.data === 'string' && Object.keys(parsed).length <= 2) return Buffer.from(parsed.data, 'base64');
      } catch {
        /* это содержимое самого файла */
      }
    }
    return buf;
  }
}

// ---------- Нормализация данных Vercel ----------

function normalizeDeployment(d) {
  if (!d) return null;
  const meta = d.meta || {};
  const git = gitFromMeta(meta);
  return {
    id: d.id || d.uid,
    url: d.url || null,
    createdAt: d.createdAt || d.created || null,
    readyState: d.readyState || d.state || null,
    alias: Array.isArray(d.alias) ? d.alias : [],
    commitSha: git?.sha || null,
    commitRef: git?.ref || null,
    commitMessage: git?.message || null,
    source: d.source || (git ? 'git' : null),
  };
}

/** Git-информация из meta деплоя (GitHub, GitLab, Bitbucket). */
export function gitFromMeta(meta = {}) {
  if (meta.githubCommitSha || meta.githubRepo) {
    const org = meta.githubCommitOrg || meta.githubOrg || meta.githubRepoOwner;
    const repo = meta.githubCommitRepo || meta.githubRepo;
    return {
      provider: 'github',
      sha: meta.githubCommitSha,
      ref: meta.githubCommitRef,
      message: meta.githubCommitMessage,
      cloneUrl: org && repo ? `https://github.com/${org}/${repo}.git` : null,
      webUrl: org && repo ? `https://github.com/${org}/${repo}` : null,
      label: org && repo ? `${org}/${repo}` : repo,
    };
  }
  if (meta.gitlabCommitSha || meta.gitlabProjectPath) {
    const pathName = meta.gitlabProjectPath || (meta.gitlabProjectNamespace && meta.gitlabProjectName ? `${meta.gitlabProjectNamespace}/${meta.gitlabProjectName}` : null);
    return {
      provider: 'gitlab',
      sha: meta.gitlabCommitSha,
      ref: meta.gitlabCommitRef,
      message: meta.gitlabCommitMessage,
      cloneUrl: pathName ? `https://gitlab.com/${pathName}.git` : null,
      webUrl: pathName ? `https://gitlab.com/${pathName}` : null,
      label: pathName,
    };
  }
  if (meta.bitbucketCommitSha || meta.bitbucketRepoName) {
    const owner = meta.bitbucketRepoOwner || meta.bitbucketRepoWorkspaceUuid;
    const slug = meta.bitbucketRepoSlug || meta.bitbucketRepoName;
    return {
      provider: 'bitbucket',
      sha: meta.bitbucketCommitSha,
      ref: meta.bitbucketCommitRef,
      message: meta.bitbucketCommitMessage,
      cloneUrl: owner && slug ? `https://bitbucket.org/${owner}/${slug}.git` : null,
      webUrl: owner && slug ? `https://bitbucket.org/${owner}/${slug}` : null,
      label: owner && slug ? `${owner}/${slug}` : slug,
    };
  }
  return null;
}

/** Репозиторий, подключённый к проекту (project.link). */
export function repoFromLink(link) {
  if (!link) return null;
  if (link.type === 'github' && link.org && link.repo) {
    return { provider: 'github', cloneUrl: `https://github.com/${link.org}/${link.repo}.git`, webUrl: `https://github.com/${link.org}/${link.repo}`, label: `${link.org}/${link.repo}`, branch: link.productionBranch };
  }
  if (link.type === 'gitlab') {
    const url = link.projectUrl || (link.projectNamespace && link.projectName ? `https://gitlab.com/${link.projectNamespace}/${link.projectName}` : null);
    if (url) return { provider: 'gitlab', cloneUrl: `${url}.git`, webUrl: url, label: url.replace(/^https?:\/\/[^/]+\//, ''), branch: link.productionBranch };
  }
  if (link.type === 'bitbucket' && link.owner && link.slug) {
    return { provider: 'bitbucket', cloneUrl: `https://bitbucket.org/${link.owner}/${link.slug}.git`, webUrl: `https://bitbucket.org/${link.owner}/${link.slug}`, label: `${link.owner}/${link.slug}`, branch: link.productionBranch };
  }
  return null;
}

/** Выбирает «главный» адрес сайта: свой домен, затем самый короткий *.vercel.app. */
export function pickPrimaryDomain(domains) {
  const list = [...new Set((domains || []).filter(Boolean))];
  const custom = list.filter((d) => !d.endsWith('.vercel.app')).sort((a, b) => a.length - b.length);
  const vercelApp = list.filter((d) => d.endsWith('.vercel.app') && !/-git-/.test(d)).sort((a, b) => a.length - b.length);
  return custom[0] || vercelApp[0] || list[0] || null;
}

export function summarizeProject(project, scope) {
  const prodRaw = project.targets?.production?.id ? project.targets.production : (project.latestDeployments || []).find((d) => d.target === 'production' && (d.readyState || d.state) === 'READY');
  const production = normalizeDeployment(prodRaw);
  const metaRepo = gitFromMeta(prodRaw?.meta);
  const repo = repoFromLink(project.link) || (metaRepo?.webUrl ? { provider: metaRepo.provider, cloneUrl: metaRepo.cloneUrl, webUrl: metaRepo.webUrl, label: metaRepo.label } : null);
  const domains = production?.alias || [];
  return {
    id: project.id,
    name: project.name,
    framework: project.framework || null,
    teamId: scope?.teamId || (String(project.accountId || '').startsWith('team_') ? project.accountId : undefined),
    teamSlug: scope?.teamSlug || null,
    teamName: scope?.teamName || null,
    updatedAt: project.updatedAt || null,
    repo,
    production,
    domains,
    primaryDomain: pickPrimaryDomain(domains),
    dashboardUrl: scope?.teamSlug ? `https://vercel.com/${scope.teamSlug}/${project.name}` : null,
  };
}

/** Дополняет сводки проектов недостающим: продакшн-деплоем и доменами (если их нет в списке проектов). */
export async function enrichSummaries(client, summaries, { concurrency = 6 } = {}) {
  const errors = [];
  await mapLimit(summaries, concurrency, async (s) => {
    try {
      if (!s.production) {
        const d = await client.latestProductionDeployment(s.id, s.teamId);
        s.production = normalizeDeployment(d);
      }
      if (s.production && !s.domains.length) {
        s.domains = await client.listProductionDomains(s.id, s.teamId);
        s.primaryDomain = pickPrimaryDomain(s.domains);
      }
    } catch (err) {
      errors.push(`${s.name}: ${err.message}`);
    }
  });
  return errors;
}

export { normalizeDeployment };
