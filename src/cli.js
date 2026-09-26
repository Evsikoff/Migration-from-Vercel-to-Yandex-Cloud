// Консольный режим: проверка статуса и обновление устаревших копий без интерфейса
// (удобно запускать из Планировщика заданий Windows).
import { App } from './app.js';

const HELP = `Использование:
  node src/cli.js status                        — список проектов и статус их копий
  node src/cli.js update-outdated [--all]       — обновить устаревшие копии (--all: и с неизвестной версией)
  node src/cli.js sync <проект> [--bucket=имя]  — скопировать или обновить один проект`;

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const positional = args.slice(1).filter((a) => !a.startsWith('--'));

const ICON = { synced: '✓', outdated: '↻', modified: '!', unknown: '?', missing: '·', 'no-deploy': ' ' };

function printOverview(o) {
  if (o.vercel.error) console.log(`Vercel: ${o.vercel.error}`);
  if (o.yandex.error) console.log(`Yandex Cloud: ${o.yandex.error}`);
  const width = Math.min(40, Math.max(...o.rows.map((r) => r.name.length), 10));
  for (const r of o.rows) {
    const vercel = r.primaryDomain ? `https://${r.primaryDomain}` : '—';
    const yandex = r.yandex?.exists ? r.yandex.websiteUrl : '—';
    console.log(`${ICON[r.status]} ${r.name.padEnd(width)}  ${r.statusLabel.padEnd(22)}  ${vercel}  →  ${yandex}`);
  }
  const c = o.counts;
  console.log(`\nВсего ${c.total}: актуально ${c.synced}, устарело ${c.outdated + c.modified}, нет в Yandex Cloud ${c.missing}, версия неизвестна ${c.unknown}`);
}

async function runJobs(app, specs) {
  const jobs = [];
  for (const spec of specs) jobs.push(await app.enqueue(spec));
  const printed = new Map();
  let failed = 0;
  for (;;) {
    for (const job of jobs) {
      const { lines, next } = job.logFrom(printed.get(job.id) || 0);
      for (const l of lines) if (l.level !== 'out') console.log(`[${job.projectName}] ${l.msg}`);
      printed.set(job.id, next);
    }
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const job of jobs) {
    if (job.status !== 'done') failed++;
    console.log(`${job.status === 'done' ? '✓' : '✗'} ${job.projectName}: ${job.status === 'done' ? job.result.websiteUrl : job.error || job.status}`);
  }
  return failed;
}

async function main() {
  if (cmd === 'help' || flags.help) return console.log(HELP);
  const app = await new App().init();
  const o = await app.overview({ refresh: true });
  if (cmd === 'status') {
    printOverview(o);
    return;
  }
  if (o.vercel.error || o.yandex.error) {
    printOverview(o);
    process.exitCode = 2;
    return;
  }
  if (cmd === 'update-outdated') {
    const wanted = new Set(['outdated', 'modified', ...(flags.all ? ['unknown'] : [])]);
    const rows = o.rows.filter((r) => wanted.has(r.status));
    if (!rows.length) return console.log('Все копии актуальны.');
    console.log(`Обновляю: ${rows.map((r) => r.name).join(', ')}`);
    if (await runJobs(app, rows.map((r) => ({ projectId: r.id })))) process.exitCode = 1;
    return;
  }
  if (cmd === 'sync') {
    if (!positional.length) {
      console.log(HELP);
      process.exitCode = 2;
      return;
    }
    const specs = [];
    for (const name of positional) {
      const row = o.rows.find((r) => r.name === name || r.id === name);
      if (!row) {
        console.log(`Проект «${name}» не найден на Vercel`);
        process.exitCode = 2;
        return;
      }
      specs.push({ projectId: row.id, bucket: typeof flags.bucket === 'string' ? flags.bucket : undefined });
    }
    if (await runJobs(app, specs)) process.exitCode = 1;
    return;
  }
  console.log(HELP);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
