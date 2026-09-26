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

/** Путь, который указал пользователь: C:\Users\user\Tracing\.yc-prokormi.env */
export const DEFAULT_YC_ENV_FILE = 'C:\\Users\\user\\Tracing\\.yc-prokormi.env';

const DEFAULTS = {
  vercelToken: '',
  ycEnvFile: '',
  serviceAccount: 'prokormi-deployer',
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
  const list = [];
  if (config?.ycEnvFile) list.push(config.ycEnvFile);
  if (process.env.YC_ENV_FILE) list.push(process.env.YC_ENV_FILE);
  if (process.platform === 'win32') list.push(DEFAULT_YC_ENV_FILE);
  list.push(path.join(os.homedir(), 'Tracing', '.yc-prokormi.env'));
  list.push(path.join(os.homedir(), '.yc-prokormi.env'));
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/**
 * Ищет файл с ключами сервисного аккаунта. Формат:
 *   YC_ACCESS_KEY_ID=...
 *   YC_SECRET_ACCESS_KEY=...
 * (дополнительно можно положить туда VERCEL_TOKEN=...)
 */
export async function loadYcCredentials(config) {
  const tried = [];
  for (const file of ycEnvCandidates(config)) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      tried.push(file);
      continue;
    }
    const env = parseEnvText(text);
    const accessKeyId = env.YC_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.YC_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      return { file, env, error: `В файле ${file} нет YC_ACCESS_KEY_ID и/или YC_SECRET_ACCESS_KEY` };
    }
    return { file, env, accessKeyId, secretAccessKey };
  }
  return { error: `Не найден файл с ключами Yandex Cloud. Проверены: ${tried.join('; ')}`, tried };
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
