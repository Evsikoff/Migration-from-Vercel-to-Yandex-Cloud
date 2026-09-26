import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheControlFor, contentTypeFor, looseName, mapLimit, parseEnvText, suggestBucketName, validateBucketName, websiteUrl } from '../src/util.js';

test('имя бакета по имени проекта', () => {
  assert.equal(suggestBucketName('prokormi'), 'prokormi');
  assert.equal(suggestBucketName('baggage_dolly_vk'), 'baggage-dolly-vk');
  assert.equal(suggestBucketName('ls'), 'ls-site');
  assert.equal(suggestBucketName('b8b86622-c2e5-4361-97a5-664ffb9c309d'), 'b8b86622-c2e5-4361-97a5-664ffb9c309d');
  const long = suggestBucketName('a-calculator-for-the-relative-coordinates-of-a-rectangle-relative-to-an-image');
  assert.ok(long.length <= 63);
  assert.equal(validateBucketName(long), null);
  for (const n of ['prokormi', '3-dambar', 'the-calculator-coordinates-the-midpoint-of-the-sprite-relative-to-the-background', 'Mixed__Case']) {
    assert.equal(validateBucketName(suggestBucketName(n)), null, n);
  }
});

test('проверка имени бакета', () => {
  assert.equal(validateBucketName('prokormi'), null);
  assert.equal(validateBucketName('my.site.ru'), null);
  assert.ok(validateBucketName('ab'));
  assert.ok(validateBucketName('Prokormi'));
  assert.ok(validateBucketName('-abc'));
  assert.ok(validateBucketName('a..b'));
  assert.ok(validateBucketName('192.168.0.1'));
});

test('нестрогое сравнение имён и адрес сайта', () => {
  assert.equal(looseName('baggage_dolly_vk'), looseName('baggage-dolly-vk'));
  assert.equal(websiteUrl('prokormi'), 'https://prokormi.website.yandexcloud.net');
  assert.equal(websiteUrl('site.ru'), 'http://site.ru.website.yandexcloud.net');
});

test('разбор файла ключей', () => {
  const env = parseEnvText('﻿YC_ACCESS_KEY_ID=YCAJ123\r\n# comment\r\nYC_SECRET_ACCESS_KEY = "s3cr=et"\r\nexport VERCEL_TOKEN=\'tok\'\r\n\r\ngarbage line');
  assert.deepEqual(env, { YC_ACCESS_KEY_ID: 'YCAJ123', YC_SECRET_ACCESS_KEY: 's3cr=et', VERCEL_TOKEN: 'tok' });
});

test('типы содержимого и кэширование', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('assets/x.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('m/monster.glb'), 'model/gltf-binary');
  assert.equal(contentTypeFor('a/b.svg'), 'image/svg+xml; charset=utf-8');
  assert.equal(contentTypeFor('LICENSE'), 'application/octet-stream');
  assert.equal(cacheControlFor('index.html'), 'no-cache');
  assert.equal(cacheControlFor('assets/index-abc.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('sw.js'), 'no-cache');
  assert.equal(cacheControlFor('images/logo.png'), 'public, max-age=3600');
});

test('mapLimit ограничивает параллельность и останавливается на ошибке', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
  const seen = [];
  await assert.rejects(
    mapLimit([1, 2, 3, 4, 5], 1, async (x) => {
      seen.push(x);
      if (x === 2) throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(seen, [1, 2]);
});
