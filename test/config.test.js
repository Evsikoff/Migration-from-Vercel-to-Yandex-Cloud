import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadYcCredentials, parseYcKeys } from '../src/config.js';

const ENV_KEYS = ['YC_ENV_FILE', 'YC_ACCESS_KEY_ID', 'YC_SECRET_ACCESS_KEY', 'YC_SERVICE_ACCOUNT', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function tmpFile(name, content) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'v2yc-cfg-'));
  const file = path.join(dir, name);
  await fsp.writeFile(file, content);
  return file;
}

test('ключи в формате KEY=VALUE с любым именем сервисного аккаунта', () => {
  const k = parseYcKeys('YC_ACCESS_KEY_ID=id1\nYC_SECRET_ACCESS_KEY="sec1"\nYC_SERVICE_ACCOUNT=my-site-bot\n');
  assert.deepEqual([k.accessKeyId, k.secretAccessKey, k.serviceAccount], ['id1', 'sec1', 'my-site-bot']);
  const aws = parseYcKeys('AWS_ACCESS_KEY_ID=id2\nAWS_SECRET_ACCESS_KEY=sec2\n');
  assert.deepEqual([aws.accessKeyId, aws.secretAccessKey, aws.serviceAccount], ['id2', 'sec2', null]);
});

test('ключи из вывода yc iam access-key create', () => {
  const k = parseYcKeys(`access_key:
  id: aje6t3vsbj8lp9r4vk2u
  service_account_id: ajepg0mjt06siuj65usm
  created_at: "2024-11-22T14:37:51Z"
  key_id: 0n8X6WY6S24N7OjXQ0YQ
secret: JyTRFdqw8t1kh2-OJNz4JX5ZTz9Dj1rI9hxtzMP1
`);
  assert.equal(k.accessKeyId, '0n8X6WY6S24N7OjXQ0YQ');
  assert.equal(k.secretAccessKey, 'JyTRFdqw8t1kh2-OJNz4JX5ZTz9Dj1rI9hxtzMP1');
  assert.equal(k.serviceAccountId, 'ajepg0mjt06siuj65usm');
});

test('файл из настроек, в том числе в UTF-16 (вывод PowerShell)', async () => {
  const text = 'YC_ACCESS_KEY_ID=id3\r\nYC_SECRET_ACCESS_KEY=sec3\r\n';
  const utf16 = await tmpFile('keys.env', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const r = await withEnv({}, () => loadYcCredentials({ ycEnvFile: utf16 }));
  assert.equal(r.error, undefined);
  assert.deepEqual([r.file, r.accessKeyId, r.secretAccessKey], [utf16, 'id3', 'sec3']);
});

test('файл без ключей — понятная ошибка', async () => {
  const file = await tmpFile('empty.env', '# пусто\n');
  const r = await withEnv({}, () => loadYcCredentials({ ycEnvFile: file }));
  assert.match(r.error, /нет ключей/);
});

test('переменные окружения, если файл не указан явно', async () => {
  const r = await withEnv({ YC_ACCESS_KEY_ID: 'env-id', YC_SECRET_ACCESS_KEY: 'env-sec', YC_SERVICE_ACCOUNT: 'deployer-42' }, () => loadYcCredentials({}));
  assert.deepEqual([r.accessKeyId, r.secretAccessKey, r.serviceAccount, r.file], ['env-id', 'env-sec', 'deployer-42', null]);
  // Явно указанный файл важнее переменных окружения.
  const file = await tmpFile('k.env', 'YC_ACCESS_KEY_ID=file-id\nYC_SECRET_ACCESS_KEY=file-sec\n');
  const r2 = await withEnv({ YC_ACCESS_KEY_ID: 'env-id', YC_SECRET_ACCESS_KEY: 'env-sec' }, () => loadYcCredentials({ ycEnvFile: file }));
  assert.equal(r2.accessKeyId, 'file-id');
});
