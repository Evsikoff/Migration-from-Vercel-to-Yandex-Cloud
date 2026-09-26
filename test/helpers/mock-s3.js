// Имитация Object Storage (S3 API, path-style) в памяти — для тестов без сети.
import crypto from 'node:crypto';
import http from 'node:http';

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function startMockS3({ pageSize = 1000, foreign = [] } = {}) {
  const buckets = new Map(); // name → { acl, website, objects: Map(key → { body, etag, contentType, cacheControl }) }
  const log = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').slice(1);
    const bucketName = parts[0] ? decodeURIComponent(parts[0]) : '';
    const key = parts.length > 1 ? parts.slice(1).map(decodeURIComponent).join('/') : null;
    const q = url.searchParams;
    log.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, xml = '', headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/xml', ...headers });
      res.end(req.method === 'HEAD' ? undefined : xml);
    };
    const err = (status, code, message = code) => send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error>`);

    if (!/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[^/]+\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) {
      return err(403, 'AccessDenied', 'missing or malformed signature');
    }
    if (req.headers['x-amz-content-sha256'] !== crypto.createHash('sha256').update(body).digest('hex')) return err(400, 'XAmzContentSHA256Mismatch');
    if (req.headers['content-md5'] && req.headers['content-md5'] !== crypto.createHash('md5').update(body).digest('base64')) return err(400, 'BadDigest');

    if (!bucketName) {
      if (req.method !== 'GET') return err(405, 'MethodNotAllowed');
      const list = [...buckets.keys()].map((n) => `<Bucket><Name>${n}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`).join('');
      return send(200, `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>${list}</Buckets></ListAllMyBucketsResult>`);
    }
    if (foreign.includes(bucketName)) return err(403, 'AccessDenied');
    const b = buckets.get(bucketName);

    if (key === null) {
      if (req.method === 'PUT' && q.has('acl')) {
        if (!b) return err(404, 'NoSuchBucket');
        b.acl = req.headers['x-amz-acl'];
        return send(200);
      }
      if (req.method === 'PUT' && q.has('website')) {
        if (!b) return err(404, 'NoSuchBucket');
        const x = body.toString();
        b.website = { index: x.match(/<Suffix>(.*?)<\/Suffix>/)?.[1], error: x.match(/<Key>(.*?)<\/Key>/)?.[1] };
        return send(200);
      }
      if (req.method === 'GET' && q.has('website')) {
        if (!b) return err(404, 'NoSuchBucket');
        if (!b.website) return err(404, 'NoSuchWebsiteConfiguration');
        return send(200, `<WebsiteConfiguration><IndexDocument><Suffix>${b.website.index}</Suffix></IndexDocument>${b.website.error ? `<ErrorDocument><Key>${b.website.error}</Key></ErrorDocument>` : ''}</WebsiteConfiguration>`);
      }
      if (req.method === 'PUT') {
        if (b) return err(409, 'BucketAlreadyOwnedByYou');
        buckets.set(bucketName, { acl: req.headers['x-amz-acl'] || 'private', website: null, objects: new Map() });
        return send(200);
      }
      if (req.method === 'HEAD') return b ? send(200) : send(404);
      if (req.method === 'POST' && q.has('delete')) {
        if (!b) return err(404, 'NoSuchBucket');
        for (const m of body.toString().matchAll(/<Key>([\s\S]*?)<\/Key>/g)) b.objects.delete(xmlUnesc(m[1]));
        return send(200, '<DeleteResult></DeleteResult>');
      }
      if (req.method === 'GET' && q.get('list-type') === '2') {
        if (!b) return err(404, 'NoSuchBucket');
        const keys = [...b.objects.keys()].sort();
        const start = Number(q.get('continuation-token') || 0);
        const page = keys.slice(start, start + pageSize);
        const truncated = start + pageSize < keys.length;
        const contents = page.map((k) => `<Contents><Key>${xmlEsc(k)}</Key><Size>${b.objects.get(k).body.length}</Size><ETag>&quot;${b.objects.get(k).etag}&quot;</ETag></Contents>`).join('');
        return send(200, `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`);
      }
      return err(400, 'Unsupported');
    }

    if (!b) return err(404, 'NoSuchBucket');
    if (req.method === 'PUT') {
      const etag = crypto.createHash('md5').update(body).digest('hex');
      b.objects.set(key, { body, etag, contentType: req.headers['content-type'], cacheControl: req.headers['cache-control'] });
      return send(200, '', { ETag: `"${etag}"` });
    }
    const o = b.objects.get(key);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!o) return err(404, 'NoSuchKey');
      res.writeHead(200, { ETag: `"${o.etag}"`, 'Content-Type': o.contentType || 'application/octet-stream', 'Content-Length': o.body.length, 'Cache-Control': o.cacheControl || '' });
      return res.end(req.method === 'HEAD' ? undefined : o.body);
    }
    return err(400, 'Unsupported');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, buckets, log })));
}
