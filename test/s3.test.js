import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { signV4, uriEncode } from '../src/s3.js';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') };

test('SigV4: примеры из документации AWS', () => {
  const get = signV4({ ...AWS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', canonicalUri: '/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: EMPTY });
  assert.equal(get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  const list = signV4({ ...AWS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', canonicalUri: '/', canonicalQuery: 'max-keys=2&prefix=J', payloadHash: EMPTY });
  assert.equal(list.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

// Эталонные подписи получены botocore (S3SigV4Auth) для storage.yandexcloud.net / ru-central1.
const BOTOCORE = [
  { method: 'PUT', key: 'assets/app (1).js', body: 'hello', headers: { 'content-type': 'text/javascript' }, sig: 'b890fedb1935135e68d861708f653a918b34d530395009bcca898ebd6a0773d6' },
  { method: 'PUT', key: 'Логотип студии — копия.png', body: 'x', sig: '2391c9085cc78e02923222b8c32122a214a159d224abe764e4812ddc8087d771' },
  { method: 'PUT', key: "weird !'()*~ & <x>.txt", body: 'x', sig: '6d5ef7094d4e8d0c670ef97e80209a2fdd2549dbbf4f77675b5c01bab31ef16d' },
  { method: 'PUT', key: 'a+b=c;d.json', body: 'x', sig: '7512f2c9ec91dde6536779d9dc1caa63cbb75ba7e05f1c7921090a671024b119' },
  { method: 'GET', query: 'continuation-token=abc%2Bdef%3D&list-type=2&max-keys=1000', sig: 'd75ee176283baba761588f60aa46723ec0b3c80586af1447d2914c01c3cfbd31' },
  { method: 'GET', query: 'website=', sig: 'e83a7b5e9c7969f6b1483c568e84f3e93c2c72d6824053d2ffcdf35ee1ceccae' },
];

test('SigV4: совпадает с botocore для кириллицы, спецсимволов и параметров', () => {
  for (const c of BOTOCORE) {
    const canonicalUri = `/prokormi${c.key ? `/${c.key.split('/').map(uriEncode).join('/')}` : ''}`;
    const r = signV4({
      method: c.method,
      host: 'storage.yandexcloud.net',
      canonicalUri,
      canonicalQuery: c.query || '',
      headers: c.headers || {},
      payloadHash: crypto.createHash('sha256').update(c.body || '').digest('hex'),
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'ru-central1',
      date: new Date('2026-09-26T16:16:13Z'),
    });
    assert.equal(r.signature, c.sig, `${c.method} ${c.key || c.query}`);
  }
});

test('uriEncode кодирует по RFC 3986', () => {
  assert.equal(uriEncode("a b!'()*~-_.я"), 'a%20b%21%27%28%29%2A~-_.%D1%8F');
});
