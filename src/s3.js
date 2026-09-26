// Минимальный клиент Yandex Object Storage (S3-совместимый API) с подписью AWS Signature V4.
// Работает со статическими ключами сервисного аккаунта (YC_ACCESS_KEY_ID / YC_SECRET_ACCESS_KEY).
import crypto from 'node:crypto';
import { sleep } from './util.js';

// Переопределение адреса нужно только для тестов с локальной имитацией S3.
export const YC_ENDPOINT = process.env.YC_S3_ENDPOINT || 'https://storage.yandexcloud.net';
export const YC_REGION = process.env.YC_S3_REGION || 'ru-central1';

const EMPTY_SHA256 = sha256Hex('');

export class S3Error extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** URI-кодирование по RFC 3986, как требует SigV4 (encodeURIComponent оставляет !'()*). */
export function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key) {
  return key.split('/').map(uriEncode).join('/');
}

function buildQuery(query) {
  const pairs = Object.entries(query || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return {
    canonical: pairs.map(([k, v]) => `${k}=${v}`).join('&'),
    // Пустые параметры-«подресурсы» (?website, ?acl, ?delete) пишем без «=», как это делают SDK.
    url: pairs.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&'),
  };
}

/**
 * Подписывает запрос (AWS Signature Version 4). Возвращает заголовки, которые нужно отправить.
 * `host` в отправляемые заголовки не добавляется — его выставит fetch, но он участвует в подписи.
 */
export function signV4({ method, host, canonicalUri, canonicalQuery = '', headers = {}, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const toSign = { host };
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null) toSign[k.toLowerCase()] = String(v);
  }
  toSign['x-amz-date'] = amzDate;
  toSign['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const out = {};
  for (const n of names) if (n !== 'host') out[n] = toSign[n];
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, signature, canonicalRequest, stringToSign };
}

// ---------- Простейший разбор XML-ответов S3 ----------

function xmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? xmlUnescape(m[1]) : null;
}

function errorFromResponse(res, bodyText, context) {
  const code = (bodyText && xmlValue(bodyText, 'Code')) || { 403: 'AccessDenied', 404: 'NotFound', 409: 'Conflict' }[res.status] || `HTTP${res.status}`;
  const message = (bodyText && xmlValue(bodyText, 'Message')) || code;
  return new S3Error(res.status, code, `${context}: ${message} (${code}, HTTP ${res.status})`);
}

// ---------- Клиент ----------

export class S3Client {
  constructor({ accessKeyId, secretAccessKey, endpoint = YC_ENDPOINT, region = YC_REGION, timeoutMs = 10 * 60 * 1000 }) {
    if (!accessKeyId || !secretAccessKey) throw new Error('Не заданы статические ключи доступа к Object Storage');
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.region = region;
    this.timeoutMs = timeoutMs;
    this.host = new URL(this.endpoint).host;
  }

  /** Низкоуровневый запрос с подписью и повторами при сбоях сети/5xx. Возвращает { status, headers, body: Buffer }. */
  async request({ method = 'GET', bucket, key, query, headers = {}, body, signal }) {
    let canonicalUri = '/';
    if (bucket) canonicalUri = `/${bucket}${key !== undefined && key !== null ? `/${encodeKeyPath(key)}` : ''}`;
    const basePath = new URL(this.endpoint).pathname.replace(/\/+$/, '');
    const q = buildQuery(query);
    const url = `${this.endpoint}${canonicalUri}${q.url ? `?${q.url}` : ''}`;
    const payload = body === undefined || body === null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const payloadHash = payload ? sha256Hex(payload) : EMPTY_SHA256;

    for (let attempt = 0; ; attempt++) {
      const signed = signV4({
        method,
        host: this.host,
        canonicalUri: basePath + canonicalUri,
        canonicalQuery: q.canonical,
        headers,
        payloadHash,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        region: this.region,
      });
      let res;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        res = await fetch(url, {
          method,
          headers: signed.headers,
          body: payload,
          signal: signal ? AbortSignal.any?.([signal, timeout]) ?? signal : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 4) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new S3Error(0, 'NetworkError', `Нет связи с Object Storage (${this.host}): ${err.cause?.message || err.message}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if ((res.status >= 500 || res.status === 429) && attempt < 5) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      return { status: res.status, headers: res.headers, body: buf };
    }
  }

  async #call(context, opts, okStatuses = [200, 204]) {
    const res = await this.request(opts);
    if (!okStatuses.includes(res.status)) throw errorFromResponse(res, res.body.toString('utf8'), context);
    return res;
  }

  async listBuckets() {
    const res = await this.#call('Список бакетов', { method: 'GET' });
    const xml = res.body.toString('utf8');
    return xmlBlocks(xml, 'Bucket').map((b) => ({ name: xmlValue(b, 'Name'), createdAt: xmlValue(b, 'CreationDate') }));
  }

  /** 'mine' — бакет наш и доступен, 'missing' — такого имени нет, 'foreign' — имя занято (или нет прав). */
  async bucketState(bucket) {
    const res = await this.request({ method: 'HEAD', bucket });
    if (res.status === 200) return 'mine';
    if (res.status === 404) return 'missing';
    if (res.status === 403 || res.status === 301) return 'foreign';
    throw errorFromResponse(res, '', `Проверка бакета ${bucket}`);
  }

  async createBucket(bucket, { acl } = {}) {
    const headers = acl ? { 'x-amz-acl': acl } : {};
    const res = await this.request({ method: 'PUT', bucket, headers });
    if (res.status === 200) return 'created';
    const text = res.body.toString('utf8');
    const code = xmlValue(text, 'Code');
    if (res.status === 409 && code === 'BucketAlreadyOwnedByYou') return 'exists';
    if (res.status === 409) throw new S3Error(409, code || 'BucketAlreadyExists', `Имя бакета «${bucket}» уже занято в Yandex Cloud (имена бакетов глобально уникальны). Выберите другое имя.`);
    throw errorFromResponse(res, text, `Создание бакета ${bucket}`);
  }

  async putBucketAcl(bucket, acl) {
    await this.#call(`Настройка доступа к бакету ${bucket}`, { method: 'PUT', bucket, query: { acl: '' }, headers: { 'x-amz-acl': acl } });
  }

  async getBucketWebsite(bucket) {
    const res = await this.request({ method: 'GET', bucket, query: { website: '' } });
    if (res.status === 404) return null;
    if (res.status !== 200) throw errorFromResponse(res, res.body.toString('utf8'), `Настройки сайта ${bucket}`);
    const xml = res.body.toString('utf8');
    const redirect = xmlBlocks(xml, 'RedirectAllRequestsTo')[0];
    return {
      index: xmlValue(xmlBlocks(xml, 'IndexDocument')[0] || '', 'Suffix'),
      error: xmlValue(xmlBlocks(xml, 'ErrorDocument')[0] || '', 'Key'),
      redirectTo: redirect ? xmlValue(redirect, 'HostName') : null,
    };
  }

  async putBucketWebsite(bucket, { index = 'index.html', error } = {}) {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      `<IndexDocument><Suffix>${xmlEscape(index)}</Suffix></IndexDocument>` +
      (error ? `<ErrorDocument><Key>${xmlEscape(error)}</Key></ErrorDocument>` : '') +
      '</WebsiteConfiguration>';
    const buf = Buffer.from(body, 'utf8');
    await this.#call(`Включение хостинга сайта в ${bucket}`, {
      method: 'PUT',
      bucket,
      query: { website: '' },
      headers: { 'content-type': 'application/xml', 'content-md5': crypto.createHash('md5').update(buf).digest('base64') },
      body: buf,
    });
  }

  /** Все объекты бакета (с постраничной выборкой). */
  async listObjects(bucket, { prefix, signal } = {}) {
    const out = [];
    let token;
    do {
      const res = await this.#call(`Список объектов ${bucket}`, {
        method: 'GET',
        bucket,
        query: { 'list-type': '2', 'max-keys': '1000', prefix, 'continuation-token': token },
        signal,
      });
      const xml = res.body.toString('utf8');
      for (const c of xmlBlocks(xml, 'Contents')) {
        out.push({
          key: xmlValue(c, 'Key'),
          size: Number(xmlValue(c, 'Size')),
          etag: (xmlValue(c, 'ETag') || '').replace(/"/g, ''),
          lastModified: xmlValue(c, 'LastModified'),
        });
      }
      token = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextContinuationToken') : null;
    } while (token);
    return out;
  }

  async putObject(bucket, key, body, { contentType, cacheControl, md5Base64, signal } = {}) {
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    if (cacheControl) headers['cache-control'] = cacheControl;
    headers['content-md5'] = md5Base64 || crypto.createHash('md5').update(body).digest('base64');
    const res = await this.#call(`Загрузка ${key}`, { method: 'PUT', bucket, key, headers, body, signal });
    return (res.headers.get('etag') || '').replace(/"/g, '');
  }

  async getObject(bucket, key) {
    const res = await this.request({ method: 'GET', bucket, key });
    if (res.status === 404) return null;
    if (res.status !== 200) throw errorFromResponse(res, res.body.toString('utf8'), `Чтение ${bucket}/${key}`);
    return res.body;
  }

  async headObject(bucket, key) {
    const res = await this.request({ method: 'HEAD', bucket, key });
    if (res.status === 404) return null;
    if (res.status !== 200) throw errorFromResponse(res, '', `Проверка ${bucket}/${key}`);
    return {
      etag: (res.headers.get('etag') || '').replace(/"/g, ''),
      size: Number(res.headers.get('content-length')),
      lastModified: res.headers.get('last-modified'),
    };
  }

  async deleteObjects(bucket, keys, { signal } = {}) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      const body = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>' +
          chunk.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('') +
          '</Delete>',
        'utf8',
      );
      const res = await this.#call(`Удаление устаревших файлов из ${bucket}`, {
        method: 'POST',
        bucket,
        query: { delete: '' },
        headers: { 'content-type': 'application/xml', 'content-md5': crypto.createHash('md5').update(body).digest('base64') },
        body,
        signal,
      });
      const errors = xmlBlocks(res.body.toString('utf8'), 'Error');
      if (errors.length) {
        const first = errors[0];
        throw new S3Error(200, xmlValue(first, 'Code'), `Не удалось удалить ${errors.length} объект(ов), например ${xmlValue(first, 'Key')}: ${xmlValue(first, 'Message')}`);
      }
    }
  }
}
