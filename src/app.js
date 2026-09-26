// Состояние приложения: настройки, клиенты Vercel и Object Storage, кэш сканирования, очередь заданий.
import { exec } from 'node:child_process';
import os from 'node:os';
import { DATA_DIR, WORK_DIR, loadConfig, loadState, loadYcCredentials, maskSecret, resolveVercelToken, saveConfig, saveState, ycEnvCandidates } from './config.js';
import { JobManager } from './jobs.js';
import { buildOverview, scanBucket, scanBuckets } from './overview.js';
import { S3Client } from './s3.js';
import { runSync } from './sync.js';
import { suggestBucketName, validateBucketName } from './util.js';
import { VercelClient, enrichSummaries, summarizeProject } from './vercel.js';

function probe(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 15_000, windowsHide: true, cwd: os.tmpdir(), env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim().split(/\r?\n/)[0] || null);
    });
  });
}

export class App {
  constructor() {
    this.config = null;
    this.state = null;
    this.tools = null;
    this.cache = { vercel: null, yandex: null, at: null };
    this.scanning = null;
    this.jobs = new JobManager({
      run: (job) => this.#runJob(job),
      concurrency: () => Number(this.config?.jobConcurrency) || 1,
      onFinished: (job) => this.#onJobFinished(job),
    });
  }

  async init() {
    this.config = await loadConfig();
    this.state = await loadState();
    this.toolsReady = this.detectTools();
    return this;
  }

  async detectTools() {
    const [git, npm, pnpm, yarn, bun] = await Promise.all(['git --version', 'npm --version', 'pnpm --version', 'yarn --version', 'bun --version'].map(probe));
    this.tools = { node: process.versions.node, git: git ? git.replace(/^git version\s*/, '') : null, npm, pnpm, yarn, bun };
    return this.tools;
  }

  // ---------- Подключения ----------

  async connections() {
    const yc = await loadYcCredentials(this.config);
    const vt = await resolveVercelToken(this.config, yc);
    return { yc, vercelToken: vt };
  }

  async clients() {
    const { yc, vercelToken } = await this.connections();
    if (!vercelToken.token) throw new Error('Не задан токен Vercel — откройте «Настройки»');
    if (yc.error) throw new Error(yc.error);
    return {
      vercel: new VercelClient(vercelToken.token),
      s3: new S3Client({ accessKeyId: yc.accessKeyId, secretAccessKey: yc.secretAccessKey }),
    };
  }

  async settings() {
    const { yc, vercelToken } = await this.connections();
    await this.toolsReady;
    return {
      config: {
        serviceAccount: this.config.serviceAccount,
        ycEnvFile: this.config.ycEnvFile,
        cleanWorkDir: this.config.cleanWorkDir,
        jobConcurrency: this.config.jobConcurrency,
        autoCheckMinutes: this.config.autoCheckMinutes,
        hasSavedVercelToken: Boolean(this.config.vercelToken),
      },
      yc: { file: yc.file || null, error: yc.error || null, accessKeyId: yc.accessKeyId ? maskSecret(yc.accessKeyId) : null, candidates: ycEnvCandidates(this.config) },
      vercel: { source: vercelToken.source, token: vercelToken.token ? maskSecret(vercelToken.token) : null },
      tools: this.tools,
      dataDir: DATA_DIR,
      workDir: WORK_DIR,
    };
  }

  async saveSettings(patch = {}) {
    const c = this.config;
    if (typeof patch.vercelToken === 'string') c.vercelToken = patch.vercelToken.trim();
    if (typeof patch.ycEnvFile === 'string') c.ycEnvFile = patch.ycEnvFile.trim().replace(/^"(.*)"$/, '$1');
    if (typeof patch.serviceAccount === 'string' && patch.serviceAccount.trim()) c.serviceAccount = patch.serviceAccount.trim();
    if (typeof patch.cleanWorkDir === 'boolean') c.cleanWorkDir = patch.cleanWorkDir;
    if (patch.jobConcurrency !== undefined) c.jobConcurrency = Math.min(4, Math.max(1, Number(patch.jobConcurrency) || 1));
    if (patch.autoCheckMinutes !== undefined) c.autoCheckMinutes = Math.min(1440, Math.max(0, Number(patch.autoCheckMinutes) || 0));
    await saveConfig(c);
    this.cache = { vercel: null, yandex: null, at: null };
    return this.settings();
  }

  // ---------- Сканирование ----------

  async #scanVercel() {
    const { vercelToken } = await this.connections();
    if (!vercelToken.token) return { error: 'Не задан токен Vercel', needsToken: true, projects: [] };
    const client = new VercelClient(vercelToken.token);
    const { user, teams, items, errors } = await client.listAllProjects();
    const projects = items.map(({ project, scope }) => summarizeProject(project, scope));
    errors.push(...(await enrichSummaries(client, projects)));
    projects.sort((a, b) => (b.production?.createdAt || 0) - (a.production?.createdAt || 0) || a.name.localeCompare(b.name));
    return {
      user: user ? { username: user.username, name: user.name, email: user.email } : null,
      teams: teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
      tokenSource: vercelToken.source,
      projects,
      warnings: errors,
    };
  }

  async #scanYandex() {
    const { yc } = await this.connections();
    if (yc.error) return { error: yc.error, buckets: [] };
    const s3 = new S3Client({ accessKeyId: yc.accessKeyId, secretAccessKey: yc.secretAccessKey });
    return { keyFile: yc.file, buckets: await scanBuckets(s3) };
  }

  /** Перечитывает проекты Vercel и бакеты Yandex Cloud (параллельно). */
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const [v, y] = await Promise.allSettled([this.#scanVercel(), this.#scanYandex()]);
      this.cache.vercel = v.status === 'fulfilled' ? v.value : { error: v.reason?.message || String(v.reason), projects: this.cache.vercel?.projects || [] };
      this.cache.yandex = y.status === 'fulfilled' ? y.value : { error: y.reason?.message || String(y.reason), buckets: this.cache.yandex?.buckets || [] };
      this.cache.at = Date.now();
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async overview({ refresh = false } = {}) {
    if (refresh || !this.cache.at) await this.scan();
    const v = this.cache.vercel || { projects: [] };
    const y = this.cache.yandex || { buckets: [] };
    const { rows, unmatchedBuckets, counts } = buildOverview({ projects: v.projects || [], buckets: y.buckets || [], links: this.config.links, syncs: this.state.syncs });
    for (const row of rows) {
      const job = this.jobs.latestFor(row.id);
      row.job = job ? job.summary() : null;
    }
    return {
      scannedAt: this.cache.at,
      vercel: { error: v.error || null, needsToken: Boolean(v.needsToken), user: v.user || null, teams: v.teams || [], tokenSource: v.tokenSource || null, warnings: v.warnings || [] },
      yandex: { error: y.error || null, serviceAccount: this.config.serviceAccount, keyFile: y.keyFile || null, bucketCount: (y.buckets || []).length },
      counts,
      rows,
      unmatchedBuckets,
      autoCheckMinutes: this.config.autoCheckMinutes,
    };
  }

  async refreshBucket(name) {
    const { s3 } = await this.clients();
    const fresh = await scanBucket(s3, name);
    if (!this.cache.yandex) return;
    const list = this.cache.yandex.buckets || (this.cache.yandex.buckets = []);
    const i = list.findIndex((b) => b.name === name);
    if (i >= 0) list[i] = { ...list[i], ...fresh, createdAt: list[i].createdAt };
    else list.push({ ...fresh, createdAt: new Date().toISOString() });
  }

  // ---------- Связи и задания ----------

  async setLink(projectId, bucket) {
    if (bucket) {
      const err = validateBucketName(bucket);
      if (err) throw new Error(err);
      this.config.links[projectId] = bucket;
    } else {
      delete this.config.links[projectId];
    }
    await saveConfig(this.config);
  }

  async recordSync(bucket, manifest) {
    this.state.syncs[bucket] = manifest;
    await saveState(this.state);
  }

  async enqueue({ projectId, bucket }) {
    if (!this.cache.at) await this.scan();
    const row = (await this.overview()).rows.find((r) => r.id === projectId);
    if (!row) throw new Error('Проект не найден — обновите список');
    if (!row.production) throw new Error(`У проекта ${row.name} нет продакшн-деплоя на Vercel`);
    const target = (bucket || row.yandex?.bucket || row.suggestedBucket || suggestBucketName(row.name)).trim();
    const err = validateBucketName(target);
    if (err) throw new Error(`Имя бакета «${target}»: ${err}`);
    const existsNow = row.yandex?.exists && row.yandex.bucket === target;
    return this.jobs.enqueue({ projectId: row.id, projectName: row.name, teamId: row.teamId, bucket: target, mode: existsNow ? 'update' : 'copy' });
  }

  async #runJob(job) {
    const { vercel, s3 } = await this.clients();
    await this.toolsReady;
    await runSync(job, { vercel, s3, config: this.config, tools: this.tools, recordSync: (b, m) => this.recordSync(b, m) });
  }

  async #onJobFinished(job) {
    if (job.status !== 'done') return;
    await this.refreshBucket(job.bucket).catch(() => {});
  }
}
