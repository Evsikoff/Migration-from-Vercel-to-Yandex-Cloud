// Выгрузка собранного сайта в бакет Object Storage: создание бакета, хостинг, инкрементальная загрузка, манифест.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { S3Error } from './s3.js';
import { cacheControlFor, contentTypeFor, hashFile, mapLimit } from './util.js';

/** Служебный файл в бакете: какой деплой Vercel сейчас выложен. */
export const MANIFEST_KEY = '.vercel-sync.json';

/**
 * Готовит бакет к выгрузке: создаёт (публичное чтение, как у бакета prokormi), включает хостинг сайта.
 * errorDocument — index.html для SPA или 404.html, если он есть в сборке.
 */
export async function ensureBucket(s3, bucket, { state, errorDocument, log }) {
  let created = false;
  if (state === 'missing') {
    await s3.createBucket(bucket, { acl: 'public-read' });
    created = true;
    log(`Создан бакет ${bucket}`);
    try {
      await s3.putBucketAcl(bucket, 'public-read');
    } catch (err) {
      log(`Не удалось открыть публичное чтение (${err.message}). Сайт не откроется, пока в консоли Yandex Cloud не включён публичный доступ на чтение объектов бакета — или выдайте сервисному аккаунту роль storage.admin.`, 'warn');
    }
  }
  const website = await s3.getBucketWebsite(bucket).catch((err) => {
    log(`Не удалось прочитать настройки хостинга: ${err.message}`, 'warn');
    return undefined;
  });
  if (website === null || created) {
    try {
      await s3.putBucketWebsite(bucket, { index: 'index.html', error: errorDocument });
      log(`Включён хостинг сайта (главная — index.html, ошибки — ${errorDocument})`);
    } catch (err) {
      log(`Не удалось включить хостинг сайта: ${err.message}`, 'warn');
    }
  } else if (website?.redirectTo) {
    log(`Бакет настроен на переадресацию всех запросов на ${website.redirectTo} — сайт из бакета не отображается`, 'warn');
  }
  return { created };
}

/** Строит список объектов: ключ, файл, md5, тип, кэширование. cleanUrls добавляет копии страниц без «.html». */
export async function planObjects(files, { cleanUrls = false } = {}) {
  const entries = await mapLimit(files, 16, async (f) => {
    const st = await fsp.stat(f.abs);
    return {
      key: f.rel,
      abs: f.abs,
      size: st.size,
      md5: await hashFile(f.abs, 'md5'),
      contentType: contentTypeFor(f.rel),
      cacheControl: cacheControlFor(f.rel),
    };
  });
  if (cleanUrls) {
    const keys = new Set(entries.map((e) => e.key));
    for (const e of [...entries]) {
      if (!e.key.endsWith('.html') || path.posix.basename(e.key) === 'index.html') continue;
      const bare = e.key.slice(0, -5);
      if (!keys.has(bare)) entries.push({ ...e, key: bare, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' });
    }
  }
  return entries;
}

function isHtml(key) {
  return /\.html?$/.test(key) || !path.posix.extname(key);
}

/**
 * Загружает только изменившиеся файлы (сравнение md5 с ETag), затем HTML (чтобы новые страницы
 * не ссылались на ещё не загруженные ресурсы), в конце удаляет файлы, которых больше нет в сборке.
 */
export async function uploadObjects(s3, bucket, entries, { log, onProgress, signal, deleteStale = true, concurrency = 8 }) {
  log('Сравниваю с содержимым бакета…');
  const existing = new Map((await s3.listObjects(bucket, { signal })).map((o) => [o.key, o]));
  const changed = entries.filter((e) => {
    const o = existing.get(e.key);
    return !o || o.size !== e.size || o.etag !== e.md5;
  });
  const totalBytes = changed.reduce((s, e) => s + e.size, 0);
  log(`Файлов в сборке: ${entries.length}, изменилось: ${changed.length}${changed.length ? ` (${(totalBytes / 1048576).toFixed(1)} МБ)` : ''}`);

  const assets = changed.filter((e) => !isHtml(e.key));
  const pages = changed.filter((e) => isHtml(e.key)).sort((a, b) => (a.key === 'index.html') - (b.key === 'index.html'));
  let done = 0;
  let bytes = 0;
  onProgress?.({ done, total: changed.length, bytes, totalBytes });
  const put = async (e) => {
    const body = await fsp.readFile(e.abs);
    await s3.putObject(bucket, e.key, body, {
      contentType: e.contentType,
      cacheControl: e.cacheControl,
      md5Base64: Buffer.from(e.md5, 'hex').toString('base64'),
      signal,
    });
    done++;
    bytes += e.size;
    onProgress?.({ done, total: changed.length, bytes, totalBytes });
    if (changed.length <= 40 || done % 25 === 0 || done === changed.length) log(`  ↑ ${e.key}${changed.length > 40 ? ` (${done}/${changed.length})` : ''}`);
  };
  await mapLimit(assets, concurrency, put);
  await mapLimit(pages, Math.min(concurrency, 4), put);

  const keep = new Set(entries.map((e) => e.key));
  keep.add(MANIFEST_KEY);
  const stale = [...existing.keys()].filter((k) => !keep.has(k));
  if (stale.length && deleteStale) {
    log(`Удаляю устаревшие файлы: ${stale.length}`);
    await s3.deleteObjects(bucket, stale, { signal });
  }
  return { total: entries.length, uploaded: changed.length, skipped: entries.length - changed.length, deleted: deleteStale ? stale.length : 0, bytes };
}

/** Манифест хранится в самом бакете: по нему программа узнаёт, какой деплой выложен, даже на другом компьютере. */
export async function writeManifest(s3, bucket, manifest) {
  const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  await s3.putObject(bucket, MANIFEST_KEY, body, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-cache' });
}

export async function readManifest(s3, bucket) {
  let buf;
  try {
    buf = await s3.getObject(bucket, MANIFEST_KEY);
  } catch (err) {
    if (err instanceof S3Error && err.status === 403) return null;
    throw err;
  }
  if (!buf) return null;
  try {
    const m = JSON.parse(buf.toString('utf8'));
    return m && typeof m === 'object' && m.vercel ? m : null;
  } catch {
    return null;
  }
}
