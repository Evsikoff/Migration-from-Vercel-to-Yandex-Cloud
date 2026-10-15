import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adaptCommand, buildEnvFrom, collectOutputFiles, detectBuild, isolateFromOuterPostcss, makeIgnoreMatcher, prepareCommand, resolveOutputDir, runCommand, splitEnvAssignments } from '../src/build.js';
import { exists } from '../src/util.js';

async function tree(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'v2yc-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('Vite-проект: vercel.json важнее настроек проекта', async () => {
  const dir = await tree({
    'package.json': { scripts: { build: 'vite build' } },
    'package-lock.json': '{}',
    'vercel.json': { framework: 'vite', buildCommand: 'npm run build', outputDirectory: 'dist', installCommand: 'npm ci' },
  });
  const cfg = await detectBuild(dir, { framework: 'vite', buildCommand: null, outputDirectory: 'ignored', nodeVersion: `${process.versions.node.split('.')[0]}.x` });
  assert.equal(cfg.pm, 'npm');
  assert.equal(cfg.installCommand, 'npm ci');
  assert.equal(cfg.buildCommand, 'npm run build');
  assert.equal(cfg.outputDirectory, 'dist');
  assert.deepEqual(cfg.warnings, []);
});

test('значения по умолчанию: менеджер пакетов по lock-файлу, папка по пресету', async () => {
  const dir = await tree({ 'package.json': { scripts: { build: 'react-scripts build' } }, 'pnpm-lock.yaml': '' });
  const cfg = await detectBuild(dir, { framework: 'create-react-app' });
  assert.equal(cfg.pm, 'pnpm');
  assert.equal(cfg.installCommand, 'pnpm install');
  assert.equal(cfg.buildCommand, 'pnpm run build');
  assert.equal(cfg.outputDirectory, 'build');
});

test('Root Directory, предупреждения о функциях и правилах vercel.json', async () => {
  const dir = await tree({
    'apps/web/package.json': { scripts: { build: 'x' } },
    'apps/web/api/hello.js': 'export default () => {}',
    'apps/web/vercel.json': { redirects: [{ source: '/a', destination: '/b' }] },
  });
  const cfg = await detectBuild(dir, { rootDirectory: 'apps/web' });
  assert.equal(cfg.rootDir, path.join(dir, 'apps', 'web'));
  assert.equal(cfg.warnings.length, 2);
  const spa = await tree({ 'vercel.json': { rewrites: [{ source: '/(.*)', destination: '/index.html' }] } });
  assert.deepEqual((await detectBuild(spa, {})).warnings, []);
});

test('статический сайт без сборки раздаётся из корня без служебных файлов', async () => {
  const dir = await tree({
    'index.html': '<h1>hi</h1>',
    'about.html': 'about',
    'css/site.css': 'body{}',
    '.env': 'SECRET=1',
    '.git/config': '',
    '.github/workflows/x.yml': '',
    '.well-known/security.txt': 'x',
    'node_modules/x/index.js': '',
    'vercel.json': { cleanUrls: true },
    'drafts/wip.html': 'draft',
    'notes.md': 'n',
    '.vercelignore': 'drafts\n*.md\n',
  });
  const cfg = await detectBuild(dir, {});
  assert.equal(cfg.installCommand, '');
  assert.equal(cfg.buildCommand, '');
  assert.equal(cfg.cleanUrls, true);
  const out = await resolveOutputDir(cfg, { built: false });
  assert.equal(out.isRoot, true);
  const files = (await collectOutputFiles(out, cfg)).map((f) => f.rel);
  assert.deepEqual(files, ['.well-known/security.txt', 'about.html', 'css/site.css', 'index.html']);
});

test('папка результата: public/ без сборки, Angular dist/<name>/browser, понятная ошибка для Next.js', async () => {
  const pub = await tree({ 'public/index.html': 'x', 'README.md': 'r' });
  assert.equal((await resolveOutputDir(await detectBuild(pub, {}), { built: false })).relative, 'public');

  const ng = await tree({ 'dist/my-app/browser/index.html': 'x' });
  const out = await resolveOutputDir({ rootDir: ng, outputDirectory: 'dist' }, { built: true });
  assert.equal(out.dir, path.join(ng, 'dist', 'my-app', 'browser'));

  const next = await tree({ '.next/server/app.js': '' });
  await assert.rejects(resolveOutputDir({ rootDir: next, outputDirectory: 'out', framework: 'nextjs' }, { built: true }), /output: "export"/);
});

test('.vercelignore', () => {
  const ignore = makeIgnoreMatcher('# c\ndrafts/\n*.psd\n/secret.txt\n!keep.psd\n');
  assert.equal(ignore('drafts/a.html'), true);
  assert.equal(ignore('img/a.psd'), true);
  assert.equal(ignore('keep.psd'), false);
  assert.equal(ignore('secret.txt'), true);
  assert.equal(ignore('sub/secret.txt'), false);
  assert.equal(ignore('index.html'), false);
});

test('pnpm/yarn через npx, если их нет на компьютере', () => {
  assert.equal(adaptCommand('pnpm install', { pnpm: null }, { packageManager: 'pnpm@9.1.0+sha256.abc' }), 'npx --yes pnpm@9.1.0 install');
  assert.equal(adaptCommand('yarn build', { yarn: null }, {}), 'npx --yes yarn@1 build');
  assert.equal(adaptCommand('pnpm install', { pnpm: '9.0.0' }, {}), 'pnpm install');
  assert.equal(adaptCommand('npm ci', {}, {}), 'npm ci');
});

test('переменные в начале команды (NAME=value команда) разбираются как в sh', () => {
  assert.deepEqual(splitEnvAssignments('LOONA_INTRO_URL=intro.mp4 npm run build'), {
    env: { LOONA_INTRO_URL: 'intro.mp4' },
    prefix: 'LOONA_INTRO_URL=intro.mp4 ',
    command: 'npm run build',
  });
  assert.deepEqual(splitEnvAssignments(`CI=false A='x y' B="q\\"z" C=a\\ b E=  vite build && cp a b`), {
    env: { CI: 'false', A: 'x y', B: 'q"z', C: 'a b', E: '' },
    prefix: `CI=false A='x y' B="q\\"z" C=a\\ b E=  `,
    command: 'vite build && cp a b',
  });
  assert.equal(splitEnvAssignments('npm run build'), null);
  assert.equal(splitEnvAssignments('A=1'), null);
  assert.equal(splitEnvAssignments('A=1 && npm run build'), null);
  assert.equal(splitEnvAssignments('A=1;npm run build'), null);
  assert.equal(splitEnvAssignments('NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096" next build'), null);
  assert.equal(splitEnvAssignments("A='open npm run build"), null);
});

test('Windows: переменные из команды передаются через окружение — cmd.exe запись NAME=value не понимает', async () => {
  assert.deepEqual(prepareCommand('CI=false pnpm build', { tools: { pnpm: null }, pkg: {}, platform: 'win32' }), {
    command: 'npx --yes pnpm@latest build',
    env: { CI: 'false' },
    display: 'CI=false npx --yes pnpm@latest build',
  });
  // В sh такая запись работает сама — команда не меняется.
  assert.deepEqual(prepareCommand('LOONA_INTRO_URL=intro.mp4 npm run build', { platform: 'linux' }), {
    command: 'LOONA_INTRO_URL=intro.mp4 npm run build',
    env: {},
    display: 'LOONA_INTRO_URL=intro.mp4 npm run build',
  });
  // Остаток команды запускается с переменной в окружении, а в логе — команда в том виде, как написана в vercel.json.
  const p = prepareCommand('V2YC_INTRO=intro.mp4 node -e "console.log(process.env.V2YC_INTRO)"', { platform: 'win32' });
  const lines = [];
  const output = await runCommand(p.command, { cwd: os.tmpdir(), env: { ...process.env, ...p.env }, display: p.display, log: (l) => lines.push(l) });
  assert.deepEqual(output, ['intro.mp4']);
  assert.equal(lines[0], '> V2YC_INTRO=intro.mp4 node -e "console.log(process.env.V2YC_INTRO)"');
});

test('системные переменные Vercel не попадают в сборку', () => {
  assert.deepEqual(buildEnvFrom({ VITE_API: 'x', VERCEL: '1', VERCEL_URL: 'u', NOW_BUILDER: '1', TURBO_TOKEN: 't', NODE_ENV: 'production' }), { VITE_API: 'x', NODE_ENV: 'production' });
});

test('посторонний конфиг PostCSS выше рабочей папки отгораживается заглушкой', async () => {
  const root = await tree({
    'postcss.config.mjs': 'export default { plugins: ["@tailwindcss/postcss"] };',
    'app/package.json': { postcss: { plugins: {} } },
    'app/data/work/job/src/package.json': { scripts: { build: 'vite build' } },
    'app/data/work/job/src/postcss.config.js': 'module.exports = {};', // свой конфиг проекта — не посторонний
  });
  const src = path.join(root, 'app', 'data', 'work', 'job', 'src');
  const guard = path.join(root, 'app', 'data', 'work', 'job', '.postcssrc.json');
  // Выше временной папки на машине с тестами может быть что-то своё — смотрим только на нашу.
  const ours = async () => (await isolateFromOuterPostcss(src)).filter((f) => f.startsWith(root));
  assert.deepEqual(await ours(), [path.join(root, 'app', 'package.json'), path.join(root, 'postcss.config.mjs')]);
  assert.deepEqual(JSON.parse(await fsp.readFile(guard, 'utf8')), { plugins: [] });
  // Своя заглушка при повторной сборке посторонней не считается, а без посторонних конфигов она убирается.
  await fsp.rm(path.join(root, 'postcss.config.mjs'));
  await fsp.rm(path.join(root, 'app', 'package.json'));
  const outside = await isolateFromOuterPostcss(src);
  assert.deepEqual(outside.filter((f) => f.startsWith(root)), []);
  assert.equal(await exists(guard), outside.length > 0);
});
