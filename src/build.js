// Получение исходников продакшн-деплоя и локальная сборка так же, как её делает Vercel.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gitFromMeta } from './vercel.js';
import { exists, mapLimit, readJson, stripAnsi, walkFiles } from './util.js';

export class CancelledError extends Error {
  constructor() {
    super('Операция отменена');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

// ---------- Запуск команд ----------

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function pipeLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop();
    for (const line of parts) {
      const clean = stripAnsi(line).trimEnd();
      if (clean.trim()) onLine(clean);
    }
  });
  stream.on('end', () => {
    const clean = stripAnsi(buf).trimEnd();
    if (clean.trim()) onLine(clean);
  });
}

/** Запускает команду оболочки (cmd.exe в Windows) и пишет её вывод в лог. */
export function runCommand(command, { cwd, env, log, signal, quiet = false }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    if (!quiet) log(`> ${command}`, 'cmd');
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const output = [];
    const onLine = (level) => (line) => {
      output.push(line);
      if (output.length > 200) output.shift();
      if (!quiet) log(line, level);
    };
    pipeLines(child.stdout, onLine('out'));
    pipeLines(child.stderr, onLine('err'));
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new CancelledError());
      if (code === 0) return resolve(output);
      const err = new Error(`Команда «${command}» завершилась с кодом ${code}`);
      err.output = output;
      reject(err);
    });
  });
}

// ---------- Исходники ----------

// В Windows не запрещаем запрос учётных данных: Git Credential Manager покажет окно входа для приватного репозитория.
const GIT_ENV = process.platform === 'win32' ? {} : { GIT_TERMINAL_PROMPT: '0' };
// Git для Windows по умолчанию не работает с путями длиннее 260 символов: если программа лежит глубоко
// (например, в «Загрузках» в дважды вложенной распакованной папке), fetch падает на
// .git/objects/pack/pack-<sha>.keep с «Filename too long». core.longpaths снимает ограничение;
// через -c настройка передаётся и дочерним процессам git (submodule, lfs).
const GIT_OPTS = process.platform === 'win32' ? '-c core.longpaths=true ' : '';

async function gitCheckout({ cloneUrl, sha, ref, dir, log, signal }) {
  const env = { ...process.env, ...GIT_ENV };
  const git = (args, opts = {}) => runCommand(`git ${GIT_OPTS}${args}`, { cwd: dir, env, log, signal, ...opts });
  await fsp.mkdir(dir, { recursive: true });
  if (!(await exists(path.join(dir, '.git')))) {
    await git('init -q');
    await git(`remote add origin "${cloneUrl}"`);
  } else {
    await git(`remote set-url origin "${cloneUrl}"`);
  }
  const target = sha || ref;
  try {
    // GitHub/GitLab позволяют забрать конкретный коммит без всей истории.
    await git(`fetch --depth 1 --no-tags origin ${target}`);
  } catch (err) {
    if (err.cancelled || !sha) throw err;
    log('Не удалось скачать коммит напрямую, скачиваю историю ветки…', 'warn');
    await git(`fetch --depth 300 --no-tags origin ${ref || 'HEAD'}`);
  }
  await git(`checkout -q --force ${sha || 'FETCH_HEAD'}`);
  await git('clean -q -ffdx -e node_modules');
  if (await exists(path.join(dir, '.gitmodules'))) {
    await git('submodule update --init --recursive --depth 1');
  }
  const attrs = await fsp.readFile(path.join(dir, '.gitattributes'), 'utf8').catch(() => '');
  if (/filter=lfs/.test(attrs)) {
    await git('lfs pull').catch((err) => log(`Git LFS: ${err.message}. Установите Git LFS, если сайт использует большие файлы из LFS.`, 'warn'));
  }
}

async function downloadDeploymentFiles({ vercel, deploymentId, teamId, dir, log, signal }) {
  let tree = await vercel.listDeploymentFiles(deploymentId, teamId);
  const names = tree.map((e) => e.name);
  // Иногда дерево приходит с корнем «src» (исходники) и «out» — берём исходники.
  const srcRoot = tree.find((e) => e.name === 'src' && e.type === 'directory');
  if (srcRoot && names.every((n) => n === 'src' || n === 'out')) tree = srcRoot.children || [];
  const files = [];
  const walk = (entries, rel) => {
    for (const e of entries || []) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === 'directory') walk(e.children, p);
      else if (e.type === 'file' && e.uid) files.push({ rel: p, uid: e.uid });
    }
  };
  walk(tree, '');
  if (!files.length) throw new Error('У деплоя нет доступных файлов');
  await fsp.rm(dir, { recursive: true, force: true });
  log(`Скачиваю файлы деплоя с Vercel: ${files.length} шт.`);
  let done = 0;
  await mapLimit(files, 8, async (f) => {
    if (signal?.aborted) throw new CancelledError();
    const abs = path.join(dir, ...f.rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, await vercel.getDeploymentFile(deploymentId, f.uid, teamId));
    if (++done % 50 === 0) log(`  ${done}/${files.length}`);
  });
}

/**
 * Кладёт исходники продакшн-деплоя в workDir/src:
 *  - git-деплой: точный коммит из репозитория (git fetch по SHA);
 *  - деплой из CLI/API: файлы, загруженные в Vercel.
 */
export async function fetchSource({ vercel, deployment, projectInfo, teamId, workDir, log, signal }) {
  const dir = path.join(workDir, 'src');
  const git = gitFromMeta(deployment.meta || {});
  if (git?.cloneUrl && git.sha) {
    log(`Репозиторий ${git.label}, коммит ${git.sha.slice(0, 7)}${git.ref ? ` (${git.ref})` : ''}`);
    await gitCheckout({ cloneUrl: git.cloneUrl, sha: git.sha, ref: git.ref, dir, log, signal });
    return { dir, kind: 'git', commitSha: git.sha };
  }
  try {
    await downloadDeploymentFiles({ vercel, deploymentId: deployment.id, teamId, dir, log, signal });
    return { dir, kind: 'files' };
  } catch (err) {
    if (err.cancelled) throw err;
    log(`Файлы деплоя недоступны: ${err.message}`, 'warn');
  }
  const repo = projectInfo?.repo;
  if (repo?.cloneUrl) {
    log(`Беру последний коммит ветки ${repo.branch || 'main'} из ${repo.label}`, 'warn');
    await fsp.rm(dir, { recursive: true, force: true });
    await gitCheckout({ cloneUrl: repo.cloneUrl, ref: repo.branch || 'main', dir, log, signal });
    return { dir, kind: 'git-branch' };
  }
  throw new Error('Не удалось получить исходники: у деплоя нет git-коммита и Vercel не отдаёт его файлы');
}

// ---------- Посторонние конфиги выше рабочей папки ----------

// Сборщики ищут конфиг PostCSS и выше проекта: Vite — до корня workspace (pnpm-workspace.yaml, lerna.json,
// package.json с workspaces), webpack — до домашней папки, Next.js — до корня диска. На Vercel выше репозитория
// пусто, а здесь программа может лежать, например, в «Загрузках» рядом с чужим postcss.config.mjs.
const POSTCSS_CONFIG_NAMES = [
  '.postcssrc', '.postcssrc.json', '.postcssrc.yaml', '.postcssrc.yml', 'postcss.config.json',
  ...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].flatMap((ext) => [`.postcssrc.${ext}`, `postcss.config.${ext}`]),
];
const POSTCSS_GUARD = '.postcssrc.json';

/**
 * Ищет конфиги PostCSS выше папки с исходниками. Если нашлись — кладёт прямо над исходниками пустой конфиг:
 * поиск остановится на нём, и проект без своего конфига соберётся как на Vercel. Возвращает найденные пути.
 */
export async function isolateFromOuterPostcss(srcDir) {
  const guardDir = path.dirname(srcDir);
  const found = [];
  for (let dir = path.dirname(guardDir); ; dir = path.dirname(dir)) {
    for (const name of POSTCSS_CONFIG_NAMES) {
      const file = path.join(dir, name);
      if ((await fsp.stat(file).catch(() => null))?.isFile()) found.push(file);
    }
    const pkgFile = path.join(dir, 'package.json');
    if ((await readJson(pkgFile, null))?.postcss != null) found.push(pkgFile);
    if (path.dirname(dir) === dir) break;
  }
  const guard = path.join(guardDir, POSTCSS_GUARD);
  if (found.length) await fsp.writeFile(guard, '{ "plugins": [] }\n');
  else await fsp.rm(guard, { force: true });
  return found;
}

// ---------- Настройки сборки ----------

/** Папка результата по умолчанию для пресетов Vercel. */
export const FRAMEWORK_OUTPUT = {
  vite: 'dist', vue: 'dist', 'create-react-app': 'build', nextjs: 'out', gatsby: 'public', svelte: 'public',
  sveltekit: 'build', 'sveltekit-1': 'build', astro: 'dist', angular: 'dist', nuxtjs: '.output/public',
  remix: 'build/client', 'react-router': 'build/client', docusaurus: 'build', 'docusaurus-2': 'build',
  eleventy: '_site', hugo: 'public', jekyll: '_site', hexo: 'public', gridsome: 'dist', vuepress: 'src/.vuepress/dist',
  vitepress: 'docs/.vitepress/dist', ember: 'dist', preact: 'build', solidstart: '.output/public',
  'solidstart-1': '.output/public', parcel: 'dist', stencil: 'www', 'ionic-react': 'build', 'ionic-angular': 'www',
  polymer: 'build', umijs: 'dist', scully: 'dist/static', zola: 'public', brunch: 'public', storybook: 'storybook-static',
  sanity: 'dist', 'sanity-v3': 'dist', mkdocs: 'site',
};

const SERVER_FRAMEWORKS = {
  nextjs: 'Next.js без `output: "export"` работает на сервере — на Object Storage можно разместить только статический экспорт (next.config: output: "export").',
  nuxtjs: 'Nuxt в режиме SSR требует сервера — для статического хостинга нужна сборка `nuxt generate`.',
  sveltekit: 'SvelteKit без @sveltejs/adapter-static требует сервера.',
  'sveltekit-1': 'SvelteKit без @sveltejs/adapter-static требует сервера.',
  remix: 'Remix в режиме SSR требует сервера (нужен SPA-режим).',
  astro: 'Astro в режиме SSR требует сервера (нужен output: "static").',
};

async function detectPackageManager(dirs, pkg) {
  const declared = String(pkg?.packageManager || '').split('@')[0];
  for (const dir of dirs) {
    if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn';
    if ((await exists(path.join(dir, 'bun.lockb'))) || (await exists(path.join(dir, 'bun.lock')))) return 'bun';
    if (await exists(path.join(dir, 'package-lock.json'))) return 'npm';
  }
  return ['pnpm', 'yarn', 'bun', 'npm'].includes(declared) ? declared : 'npm';
}

const INSTALL = { npm: 'npm install --no-audit --no-fund', pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install' };

/** Определяет команды и папку результата: vercel.json → настройки проекта → пресет фреймворка. */
export async function detectBuild(srcDir, project) {
  const rootDir = project.rootDirectory ? path.join(srcDir, ...project.rootDirectory.split(/[\\/]/)) : srcDir;
  if (!(await exists(rootDir))) throw new Error(`В репозитории нет папки «${project.rootDirectory}» (Root Directory проекта)`);
  const vercelJson = (await readJson(path.join(rootDir, 'vercel.json'), null)) || {};
  const pkg = await readJson(path.join(rootDir, 'package.json'), null);
  const pm = await detectPackageManager([...new Set([rootDir, srcDir])], pkg);
  const framework = vercelJson.framework !== undefined ? vercelJson.framework : project.framework || null;
  const warnings = [];

  const pick = (key) => (vercelJson[key] !== undefined && vercelJson[key] !== null ? vercelJson[key] : project[key] !== undefined && project[key] !== null ? project[key] : undefined);
  let installCommand = pick('installCommand');
  if (installCommand === undefined) installCommand = pkg ? INSTALL[pm] : '';
  let buildCommand = pick('buildCommand');
  if (buildCommand === undefined) buildCommand = pkg?.scripts?.build ? `${pm === 'npm' ? 'npm' : pm} run build` : '';
  const outputDirectory = pick('outputDirectory') ?? (buildCommand ? FRAMEWORK_OUTPUT[framework] : undefined) ?? null;

  if (await exists(path.join(rootDir, 'api'))) {
    const apiFiles = await walkFiles(path.join(rootDir, 'api')).catch(() => []);
    if (apiFiles.some((f) => /\.(js|mjs|cjs|ts|py|go|rb)$/.test(f.rel))) {
      warnings.push('В проекте есть серверные функции (папка api/). Они не переносятся: Object Storage раздаёт только статические файлы.');
    }
  }
  const rules = ['rewrites', 'redirects', 'headers', 'routes'].filter((k) => Array.isArray(vercelJson[k]) && vercelJson[k].length);
  const spaOnly = rules.length === 1 && rules[0] === 'rewrites' && vercelJson.rewrites.every((r) => /^\/?index\.html$/.test(String(r.destination).replace(/^\//, '')));
  if (rules.length && !spaOnly) {
    warnings.push(`Правила vercel.json (${rules.join(', ')}) не переносятся. Ошибочные адреса на Yandex отдают index.html (режим SPA).`);
  }
  const nodeMajor = String(project.nodeVersion || '').match(/^(\d+)/)?.[1];
  if (nodeMajor && nodeMajor !== process.versions.node.split('.')[0]) {
    warnings.push(`На Vercel сборка идёт на Node.js ${project.nodeVersion}, здесь — ${process.versions.node}. Обычно это не мешает.`);
  }
  return { rootDir, srcDir, vercelJson, pkg, pm, framework, installCommand, buildCommand, outputDirectory, cleanUrls: vercelJson.cleanUrls === true, warnings };
}

/** Подставляет npx, если нужного менеджера пакетов нет на компьютере. */
export function adaptCommand(command, tools, pkg) {
  if (!command) return command;
  const m = command.match(/^(pnpm|yarn)(\s|$)/);
  if (!m || tools?.[m[1]]) return command;
  const declared = String(pkg?.packageManager || '');
  const version = declared.startsWith(`${m[1]}@`) ? declared.split('@')[1].split('+')[0] : m[1] === 'yarn' ? '1' : 'latest';
  return `npx --yes ${m[1]}@${version}${command.slice(m[1].length)}`;
}

/** Находит папку с результатом сборки. Без сборки (чистый HTML) — корень проекта или public/. */
export async function resolveOutputDir(cfg, { built }) {
  const { rootDir } = cfg;
  const isDir = async (p) => (await fsp.stat(p).catch(() => null))?.isDirectory() ?? false;
  let candidates;
  if (cfg.outputDirectory) candidates = [cfg.outputDirectory];
  else if (built) candidates = ['dist', 'build', 'out', '.output/public', '_site', 'public'];
  else candidates = ['public'];
  for (const c of candidates) {
    let abs = path.join(rootDir, ...c.split(/[\\/]/));
    if (!(await isDir(abs))) continue;
    // Angular 17+: dist/<проект>/browser
    if (!(await exists(path.join(abs, 'index.html')))) {
      const inner = (await fsp.readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory());
      if (inner.length === 1) {
        const nested = path.join(abs, inner[0].name);
        if (await exists(path.join(nested, 'browser', 'index.html'))) abs = path.join(nested, 'browser');
        else if (await exists(path.join(nested, 'index.html'))) abs = nested;
      }
    }
    return { dir: abs, isRoot: false, relative: path.relative(rootDir, abs) || '.' };
  }
  if (!built) return { dir: rootDir, isRoot: true, relative: '.' };
  const hint = SERVER_FRAMEWORKS[cfg.framework];
  throw new Error(`После сборки не найдена папка с результатом (${candidates.join(', ')}).${hint ? ` ${hint}` : ''}`);
}

// ---------- Список файлов для выгрузки ----------

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

/** Простая поддержка .vercelignore: имена, каталоги, маски, шаблоны от корня. */
export function makeIgnoreMatcher(text) {
  const rules = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      let p = negate ? l.slice(1) : l;
      const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
      p = p.replace(/^\//, '').replace(/\/$/, '');
      const body = globToRegex(p);
      const re = new RegExp(anchored ? `^${body}(/.*)?$` : `(^|/)${body}(/.*)?$`);
      return { re, negate };
    });
  return (rel) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(rel)) ignored = !r.negate;
    return ignored;
  };
}

const ALWAYS_SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Файлы, которые попадут в бакет. Если сайт раздаётся из корня репозитория — без служебных файлов. */
export async function collectOutputFiles(out, cfg) {
  let ignore = () => false;
  if (out.isRoot) {
    ignore = makeIgnoreMatcher(await fsp.readFile(path.join(cfg.rootDir, '.vercelignore'), 'utf8').catch(() => ''));
  }
  const rootOnly = new Set(['node_modules', '__pycache__', 'venv', 'vercel.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']);
  return walkFiles(out.dir, {
    skip: (rel, entry) => {
      const name = entry.name;
      if (ALWAYS_SKIP.has(name)) return true;
      if (!out.isRoot) return false;
      if (name.startsWith('.') && name !== '.well-known') return true; // .git, .env, .github, .vercel …
      if (!rel.includes('/') && rootOnly.has(name)) return true;
      if (name === 'node_modules') return true;
      return ignore(rel);
    },
  });
}

/** Переменные окружения Vercel без системных VERCEL_*: иначе фреймворки соберут вывод «под Vercel», а не статику. */
export function buildEnvFrom(vercelEnv) {
  const env = {};
  for (const [k, v] of Object.entries(vercelEnv || {})) {
    if (/^(VERCEL|NOW_|TURBO_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}
