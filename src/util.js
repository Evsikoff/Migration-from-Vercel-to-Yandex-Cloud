import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Выполняет fn над items не более чем в `limit` параллельных потоков. Первая ошибка останавливает выдачу новых задач. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failure ||= { err };
      }
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failure) throw failure.err;
  return results;
}

/** Разбирает файл вида KEY=VALUE (как .yc-prokormi.env). Понимает BOM, комментарии, кавычки и `export`. */
export function parseEnvText(text) {
  const out = {};
  for (let line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

// ---------- Имена бакетов ----------

/** Проверяет имя бакета по правилам Object Storage. Возвращает текст ошибки или null. */
export function validateBucketName(name) {
  if (typeof name !== 'string' || name.length < 3 || name.length > 63) return 'Имя бакета должно быть длиной от 3 до 63 символов';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) return 'Допустимы строчные латинские буквы, цифры, дефис и точка; начало и конец — буква или цифра';
  if (/\.\.|\.-|-\./.test(name)) return 'Нельзя ставить подряд точки или точку рядом с дефисом';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return 'Имя не может выглядеть как IP-адрес';
  return null;
}

/** Предлагает имя бакета для проекта Vercel: prokormi → prokormi, baggage_dolly_vk → baggage-dolly-vk. */
export function suggestBucketName(projectName) {
  let s = String(projectName || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/\.-|-\./g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (s.length > 63) s = s.slice(0, 63).replace(/[-.]+$/, '');
  if (s.length < 3) s = s ? `${s}-site` : 'vercel-site';
  return s;
}

/** Ключ для «нестрогого» сравнения имён проекта и бакета: регистр и разделители не важны. */
export function looseName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function websiteUrl(bucket) {
  // Сертификат *.website.yandexcloud.net не покрывает имена с точками — для них только http.
  return `${bucket.includes('.') ? 'http' : 'https'}://${bucket}.website.yandexcloud.net`;
}

// ---------- Файлы ----------

/** Рекурсивно собирает файлы каталога. rel — путь с прямыми слэшами, как ключ объекта в бакете. */
export async function walkFiles(root, { skip } = {}) {
  const out = [];
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip && skip(relPath, entry)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        out.push({ abs, rel: relPath });
      } else if (entry.isSymbolicLink()) {
        // Ссылки на файлы берём, на каталоги — нет (защита от циклов).
        const st = await fsp.stat(abs).catch(() => null);
        if (st?.isFile()) out.push({ abs, rel: relPath });
      }
    }
  }
  await walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function hashFile(abs, algorithm = 'md5') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algorithm);
    fs.createReadStream(abs)
      .on('error', reject)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => resolve(h.digest('hex')));
  });
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(p, fallback = null) {
  try {
    return JSON.parse((await fsp.readFile(p, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/** Пишет JSON через временный файл, чтобы не оставить полузаписанный конфиг. */
export async function writeJsonAtomic(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- Типы содержимого и кэширование ----------

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.map': 'application/json', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.wasm': 'application/wasm',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.ktx2': 'image/ktx2',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain', '.bin': 'application/octet-stream',
};

const TEXTUAL = new Set(['application/json', 'application/manifest+json', 'application/xml', 'image/svg+xml', 'model/gltf+json']);

export function contentTypeFor(key) {
  const ext = path.posix.extname(key).toLowerCase();
  let type = MIME[ext];
  if (!type) return 'application/octet-stream';
  if (type.startsWith('text/') || TEXTUAL.has(type)) type += '; charset=utf-8';
  return type;
}

export function cacheControlFor(key) {
  const base = path.posix.basename(key).toLowerCase();
  if (base.endsWith('.html') || base.endsWith('.htm')) return 'no-cache';
  if (/^(sw|service-worker|workbox-[^/]*)\.js$|\.webmanifest$|^manifest\.json$/.test(base)) return 'no-cache';
  // Файлы с хэшем в имени (Vite, CRA, Next export) не меняются — кэшируем надолго.
  if (/^(assets|_next\/static|static\/(js|css|media))\//.test(key)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}
