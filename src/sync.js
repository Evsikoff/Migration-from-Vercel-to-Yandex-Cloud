// Полный цикл «Vercel → Yandex Cloud» для одного проекта: деплой → исходники → сборка → выгрузка → манифест.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { adaptCommand, buildEnvFrom, collectOutputFiles, detectBuild, fetchSource, isolateFromOuterPostcss, resolveOutputDir, runCommand, CancelledError } from './build.js';
import { WORK_DIR } from './config.js';
import { ensureBucket, planObjects, uploadObjects, writeManifest } from './deploy.js';
import { gitFromMeta, repoFromLink } from './vercel.js';
import { formatBytes, validateBucketName, websiteUrl } from './util.js';

const TOOL = 'vercel-to-yandex-cloud';

function fmtDate(ms) {
  return ms ? new Date(ms).toLocaleString('ru-RU') : '—';
}

/**
 * job: { projectId, teamId, bucket, mode, log(), setStage(), abort }
 * ctx: { vercel, s3, config, tools, recordSync(bucket, manifest) }
 */
export async function runSync(job, ctx) {
  const { vercel, s3, config, tools } = ctx;
  const signal = job.abort.signal;
  const log = (msg, level) => job.log(msg, level);
  const check = () => {
    if (signal.aborted) throw new CancelledError();
  };

  const nameError = validateBucketName(job.bucket);
  if (nameError) throw new Error(`Имя бакета «${job.bucket}»: ${nameError}`);

  // 1. Что сейчас в продакшне на Vercel
  job.setStage('Данные проекта на Vercel');
  const project = await vercel.getProject(job.projectId, job.teamId);
  let prodId = project.targets?.production?.id;
  if (!prodId) prodId = (await vercel.latestProductionDeployment(project.id, job.teamId))?.uid;
  if (!prodId) throw new Error('У проекта нет готового продакшн-деплоя на Vercel — копировать нечего');
  const deployment = await vercel.getDeployment(prodId, job.teamId);
  const git = gitFromMeta(deployment.meta || {});
  log(`Проект ${project.name}${project.framework ? ` (${project.framework})` : ''}, продакшн-деплой ${deployment.id} от ${fmtDate(deployment.createdAt)}`);
  if (git?.sha) log(`Коммит ${git.sha.slice(0, 7)}: ${String(git.message || '').split('\n')[0]}`);
  check();

  // 2. Бакет: проверяем заранее, чтобы не собирать зря, если имя занято
  job.setStage('Проверка бакета');
  const bucketState = await s3.bucketState(job.bucket);
  if (bucketState === 'foreign') {
    throw new Error(`Бакет «${job.bucket}» недоступен: имя занято другим владельцем или у сервисного аккаунта нет прав на него. Выберите другое имя.`);
  }
  log(bucketState === 'mine' ? `Бакет ${job.bucket} найден` : `Бакет ${job.bucket} будет создан после успешной сборки`);
  check();

  // 3. Исходники ровно того деплоя, что в продакшне
  job.setStage('Получение исходников');
  if (git?.sha && tools && !tools.git) {
    throw new Error('Не найден Git — он нужен, чтобы скачать исходники коммита. Установите Git for Windows (https://git-scm.com/download/win) и перезапустите программу.');
  }
  // Короткое имя папки: в Windows длинные пути внутри node_modules упираются в ограничение 260 символов.
  const workDir = path.join(WORK_DIR, `${project.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24)}-${project.id.slice(-6)}`);
  const source = await fetchSource({ vercel, deployment, projectInfo: { repo: repoFromLink(project.link) }, teamId: job.teamId, workDir, log, signal });
  check();

  // 4. Переменные окружения продакшна (значения не пишутся ни в лог, ни на диск)
  job.setStage('Переменные окружения');
  let vercelEnv = {};
  try {
    const pulled = await vercel.pullEnv(project.id, job.teamId, 'production');
    vercelEnv = buildEnvFrom(pulled.env);
    for (const w of pulled.warnings) log(w, 'warn');
  } catch (err) {
    log(`Не удалось получить переменные окружения: ${err.message}. Сборка пойдёт без них.`, 'warn');
  }
  const keys = Object.keys(vercelEnv);
  log(keys.length ? `Переменные для сборки (${keys.length}): ${keys.join(', ')}` : 'Переменных окружения у проекта нет');

  // 5. Сборка
  job.setStage('Сборка');
  const cfg = await detectBuild(source.dir, project);
  for (const w of cfg.warnings) log(w, 'warn');
  if (cfg.pkg || cfg.installCommand || cfg.buildCommand) {
    log(`Менеджер пакетов: ${cfg.pm}; установка: ${cfg.installCommand || '—'}; сборка: ${cfg.buildCommand || '—'}; результат: ${cfg.outputDirectory || 'определю после сборки'}`);
  } else {
    log('Статический сайт без сборки: файлы выкладываются как есть');
  }
  if (cfg.installCommand || cfg.buildCommand) {
    const outer = await isolateFromOuterPostcss(source.dir);
    if (outer.length) log(`Выше рабочей папки лежит посторонний конфиг PostCSS (${outer.join(', ')}). На Vercel его нет, поэтому сборка от него отгорожена.`, 'warn');
  }
  const baseEnv = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' };
  if (cfg.installCommand) {
    const installEnv = { ...baseEnv, ...vercelEnv };
    delete installEnv.NODE_ENV; // иначе npm не поставит devDependencies (vite и т.п.)
    await runCommand(adaptCommand(cfg.installCommand, tools, cfg.pkg), { cwd: cfg.rootDir, env: installEnv, log, signal });
  }
  check();
  if (cfg.buildCommand) {
    await runCommand(adaptCommand(cfg.buildCommand, tools, cfg.pkg), { cwd: cfg.rootDir, env: { ...baseEnv, ...vercelEnv }, log, signal });
  }
  check();
  const out = await resolveOutputDir(cfg, { built: Boolean(cfg.buildCommand) });
  const files = await collectOutputFiles(out, cfg);
  if (!files.length) throw new Error(`Папка результата «${out.relative}» пуста`);
  const hasIndex = files.some((f) => f.rel === 'index.html');
  if (!hasIndex) log('В корне результата нет index.html — главная страница сайта не откроется', 'warn');
  const has404 = files.some((f) => f.rel === '404.html');
  log(`Файлы сайта: ${out.isRoot ? 'корень проекта' : out.relative}, ${files.length} шт.`);

  // 6. Выгрузка в Object Storage
  job.setStage('Выгрузка в Object Storage');
  await ensureBucket(s3, job.bucket, { state: bucketState, errorDocument: has404 ? '404.html' : 'index.html', log });
  const entries = await planObjects(files, { cleanUrls: cfg.cleanUrls });
  const stats = await uploadObjects(s3, job.bucket, entries, {
    log,
    signal,
    onProgress: (p) => {
      job.progress = p;
    },
  });
  const index = hasIndex ? await s3.headObject(job.bucket, 'index.html').catch(() => null) : null;

  const manifest = {
    tool: TOOL,
    version: 1,
    vercel: {
      projectId: project.id,
      projectName: project.name,
      teamId: job.teamId || null,
      deploymentId: deployment.id,
      deploymentUrl: deployment.url,
      deploymentCreatedAt: deployment.createdAt || null,
      commitSha: git?.sha || null,
      commitRef: git?.ref || null,
    },
    syncedAt: new Date().toISOString(),
    files: stats.total,
    indexEtag: index?.etag || null,
  };
  await writeManifest(s3, job.bucket, manifest);
  // Локально храним и текст коммита (в публичный бакет он не попадает).
  await ctx.recordSync(job.bucket, { ...manifest, vercel: { ...manifest.vercel, commitMessage: git?.message || null } });

  const url = websiteUrl(job.bucket);
  job.result = { websiteUrl: url, ...stats };
  log(`Загружено ${stats.uploaded} (${formatBytes(stats.bytes)}), без изменений ${stats.skipped}, удалено ${stats.deleted}`);
  log(`Готово: ${url}`, 'success');

  if (config.cleanWorkDir) {
    await fsp.rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch((err) => log(`Не удалось удалить рабочую папку ${workDir}: ${err.message}`, 'warn'));
  }
}
