// Локальный веб-сервер: интерфейс в браузере и JSON API. Слушает только 127.0.0.1.
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { App } from './app.js';
import { APP_DIR } from './config.js';

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.PORT) || 5178;
// Защита от запросов с чужих сайтов: API принимает только запросы со сгенерированным при запуске ключом.
const SESSION = crypto.randomBytes(18).toString('hex');

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers, 'Content-Length': buf.length });
  res.end(buf);
}

const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Некорректный JSON'), { status: 400 });
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

async function main() {
  const app = await new App().init();
  let port = PORT;

  const routes = {
    'GET /api/overview': async (req, res, url) => json(res, 200, await app.overview({ refresh: url.searchParams.get('refresh') === '1' })),
    'GET /api/settings': async (req, res) => json(res, 200, await app.settings()),
    'POST /api/settings': async (req, res) => json(res, 200, await app.saveSettings(await readBody(req))),
    'POST /api/link': async (req, res) => {
      const { projectId, bucket } = await readBody(req);
      if (!projectId) return json(res, 400, { error: 'Не указан проект' });
      await app.setLink(projectId, bucket || null);
      json(res, 200, await app.overview());
    },
    'GET /api/jobs': async (req, res) => json(res, 200, { jobs: app.jobs.list(), busy: app.jobs.busy }),
    'POST /api/jobs': async (req, res) => {
      const { projectId, bucket } = await readBody(req);
      const job = await app.enqueue({ projectId, bucket });
      json(res, 200, { job: job.summary() });
    },
    'POST /api/jobs/bulk': async (req, res) => {
      const { projectIds = [] } = await readBody(req);
      const jobs = [];
      const errors = [];
      for (const projectId of projectIds) {
        try {
          jobs.push((await app.enqueue({ projectId })).summary());
        } catch (err) {
          errors.push(err.message);
        }
      }
      json(res, 200, { jobs, errors });
    },
    'POST /api/jobs/clear': async (req, res) => {
      app.jobs.clearFinished();
      json(res, 200, { jobs: app.jobs.list() });
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, 'Misdirected request');
      const url = new URL(req.url, `http://${host}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = path.join(PUBLIC_DIR, STATIC[url.pathname]);
        let body = await fsp.readFile(file);
        if (url.pathname === '/') body = Buffer.from(body.toString('utf8').replace('__SESSION__', SESSION));
        return send(res, 200, body, {
          'Content-Type': TYPES[path.extname(file)],
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        });
      }

      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-session'] !== SESSION) return json(res, 403, { error: 'Обновите страницу программы' });
        const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]+)(\/cancel)?$/);
        if (jobMatch) {
          const job = app.jobs.get(jobMatch[1]);
          if (!job) return json(res, 404, { error: 'Задание не найдено' });
          if (jobMatch[2] && req.method === 'POST') {
            app.jobs.cancel(job.id);
            return json(res, 200, { job: job.summary() });
          }
          if (!jobMatch[2] && req.method === 'GET') {
            return json(res, 200, { job: job.summary(), log: job.logFrom(Number(url.searchParams.get('from')) || 0) });
          }
        }
        const handler = routes[`${req.method} ${url.pathname}`];
        if (handler) return await handler(req, res, url);
        return json(res, 404, { error: 'Нет такого метода' });
      }
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (err) {
      json(res, err.status || 500, { error: err.message || String(err) });
    }
  });

  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 20) throw err;
      port++;
    }
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  Vercel → Yandex Cloud');
  console.log(`  Интерфейс: ${url}`);
  console.log('  Не закрывайте это окно, пока работаете с программой. Остановить — Ctrl+C.');
  console.log('');
  if (!args.has('--no-open') && !process.env.NO_OPEN) openBrowser(url);

  // Первое сканирование — сразу, чтобы к открытию страницы данные уже собирались.
  app.scan().catch(() => {});

  const shutdown = () => {
    for (const j of app.jobs.jobs) if (j.status === 'running') j.abort.abort();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`Не удалось запустить программу: ${err.message}`);
  process.exit(1);
});
