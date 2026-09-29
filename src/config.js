// Настройки программы, поиск ключей Yandex Cloud и токена Vercel, локальное состояние синхронизаций.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText, readJson, writeJsonAtomic } from './util.js';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.V2YC_DATA_DIR ? path.resolve(process.env.V2YC_DATA_DIR) : path.join(APP_DIR, 'data');
export const WORK_DIR = path.join(DATA_DIR, 'work');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

/** Файл с ключами по умолчанию — рядом с программой (в git не попадает). */
export const DEFAULT_YC_ENV_FILE = path.join(APP_DIR, 'yc-keys.env');

const DEFAULTS = {
  vercelToken: '',
  ycEnvFile: '',
  serviceAccount: '', // имя сервисного аккаунта для подписи в интерфейсе; пусто — берётся из файла ключей
  links: {}, // projectId → имя бакета (ручные связи)
  cleanWorkDir: true, // удалять рабочую папку сборки после успешной выгрузки
  jobConcurrency: 1, // сколько проектов собирать одновременно
  autoCheckMinutes: 10, // как часто интерфейс перепроверяет актуальность (0 — не проверять)
};

export async function loadConfig() {
  const saved = (await readJson(CONFIG_FILE, {})) || {};
  return { ...DEFAULTS, ...saved, links: { ...(saved.links || {}) } };
}

export async function saveConfig(config) {
  await writeJsonAtomic(CONFIG_FILE, config);
}

// ---------- Ключи Yandex Cloud ----------

export function ycEnvCandidates(config) {
  const home = os.homedir();
  const list = [];
  if (config?.ycEnvFile) list.push(config.ycEnvFile);
  if (process.env.YC_ENV_FILE) list.push(process.env.YC_ENV_FILE);
  list.push(DEFAULT_YC_ENV_FILE, path.join(home, '.yc-keys.env'), path.join(home, 'yc-keys.env'));
  // Имена из первых версий программы — чтобы у прежних пользователей всё работало без изменений.
  list.push(path.join(home, 'Tracing', '.yc-prokormi.env'), path.join(home, '.yc-prokormi.env'));
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/** Читает текстовый файл в UTF-8 или UTF-16 (так сохраняет вывод `>` Windows PowerShell 5). */
async function readTextFile(file) {
  const buf = await fsp.readFile(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))).swap16().toString('utf16le');
  return buf.toString('utf8');
}

/**
 * Достаёт ключи из текста файла. Понимает два формата:
 *   YC_ACCESS_KEY_ID=...            — «ручной» (также AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY);
 *   YC_SECRET_ACCESS_KEY=...
 *   YC_SERVICE_ACCOUNT=имя          — необязательно, для подписи в интерфейсе;
 * и вывод команды `yc iam access-key create` как есть (строки `key_id: ...`, `secret: ...`).
 */
export function parseYcKeys(text) {
  const env = parseEnvText(text);
  const yaml = (name) => String(text).match(new RegExp(`^\\s*${name}:\\s*"?([^"\\s]+)"?\\s*$`, 'm'))?.[1];
  return {
    env,
    accessKeyId: env.YC_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || yaml('key_id'),
    secretAccessKey: env.YC_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || yaml('secret'),
    serviceAccount: env.YC_SERVICE_ACCOUNT || null,
    serviceAccountId: yaml('service_account_id') || null,
  };
}

/**
 * Ищет ключи сервисного аккаунта (статический ключ доступа). Порядок:
 * файл из настроек → файл из YC_ENV_FILE → переменные окружения YC_ACCESS_KEY_ID/YC_SECRET_ACCESS_KEY →
 * yc-keys.env рядом с программой → ~/.yc-keys.env → ~/yc-keys.env → старые имена .yc-prokormi.env.
 * В файл можно положить и VERCEL_TOKEN=...
 */
export async function loadYcCredentials(config) {
  const tried = [];
  const candidates = ycEnvCandidates(config);
  const explicit = new Set([config?.ycEnvFile, process.env.YC_ENV_FILE].filter(Boolean).map((p) => path.resolve(p)));
  const fromProcessEnv = () => {
    // Только YC_*: AWS_* в окружении обычно относятся к настоящему AWS, а не к Yandex Cloud.
    const accessKeyId = process.env.YC_ACCESS_KEY_ID;
    const secretAccessKey = process.env.YC_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return null;
    return { file: null, source: 'переменные окружения', env: {}, accessKeyId, secretAccessKey, serviceAccount: process.env.YC_SERVICE_ACCOUNT || null };
  };
  let envChecked = false;
  for (const file of candidates) {
    if (!envChecked && !explicit.has(file)) {
      envChecked = true;
      const fromEnv = fromProcessEnv();
      if (fromEnv) return fromEnv;
    }
    let text;
    try {
      text = await readTextFile(file);
    } catch {
      tried.push(file);
      continue;
    }
    const keys = parseYcKeys(text);
    if (!keys.accessKeyId || !keys.secretAccessKey) {
      return { file, env: keys.env, error: `В файле ${file} нет ключей: нужны строки YC_ACCESS_KEY_ID=… и YC_SECRET_ACCESS_KEY=…` };
    }
    return { file, source: `файл ${file}`, ...keys };
  }
  if (!envChecked) {
    const fromEnv = fromProcessEnv();
    if (fromEnv) return fromEnv;
  }
  return {
    error: `Не найдены ключи сервисного аккаунта Yandex Cloud. Создайте файл ${DEFAULT_YC_ENV_FILE} со строками YC_ACCESS_KEY_ID=… и YC_SECRET_ACCESS_KEY=… (как получить ключи — в README, раздел «Сервисный аккаунт Yandex Cloud»). Проверены: ${tried.join('; ')}`,
    tried,
  };
}

// ---------- Токен Vercel ----------

function vercelCliAuthCandidates() {
  const home = os.homedir();
  const list = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(
      path.join(appData, 'xdg.data', 'com.vercel.cli', 'auth.json'),
      path.join(localAppData, 'xdg.data', 'com.vercel.cli', 'auth.json'),
      path.join(appData, 'com.vercel.cli', 'Data', 'auth.json'),
      path.join(appData, 'com.vercel.cli', 'auth.json'),
    );
  } else if (process.platform === 'darwin') {
    list.push(path.join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'));
  } else {
    list.push(path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'com.vercel.cli', 'auth.json'));
  }
  list.push(path.join(home, '.vercel', 'auth.json'), path.join(home, '.now', 'auth.json'));
  return list;
}

/** Порядок поиска: настройки программы → переменная VERCEL_TOKEN → файл ключей YC → вход в Vercel CLI. */
export async function resolveVercelToken(config, ycEnv) {
  if (config?.vercelToken) return { token: config.vercelToken, source: 'настройки программы' };
  if (process.env.VERCEL_TOKEN) return { token: process.env.VERCEL_TOKEN, source: 'переменная окружения VERCEL_TOKEN' };
  if (ycEnv?.env?.VERCEL_TOKEN) return { token: ycEnv.env.VERCEL_TOKEN, source: `файл ${ycEnv.file}` };
  for (const file of vercelCliAuthCandidates()) {
    const auth = await readJson(file);
    if (auth?.token) return { token: auth.token, source: `вход Vercel CLI (${file})` };
  }
  return { token: null, source: null };
}

// ---------- Локальное состояние (копии манифестов последних синхронизаций) ----------

export async function loadState() {
  const s = (await readJson(STATE_FILE, {})) || {};
  return { syncs: s.syncs || {}, jobs: s.jobs || [] };
}

export async function saveState(state) {
  await writeJsonAtomic(STATE_FILE, state);
}

export function maskSecret(s) {
  if (!s) return '';
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}
