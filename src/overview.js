// Сопоставление проектов Vercel с бакетами Yandex Cloud и расчёт актуальности копий.
import { readManifest } from './deploy.js';
import { looseName, mapLimit, suggestBucketName, websiteUrl } from './util.js';

/** Читает состояние одного бакета: манифест синхронизации, настройки хостинга, ETag главной страницы. */
export async function scanBucket(s3, name, createdAt = null) {
  const [manifest, website, index] = await Promise.all([
    readManifest(s3, name).catch(() => null),
    s3.getBucketWebsite(name).catch(() => undefined),
    s3.headObject(name, 'index.html').catch(() => null),
  ]);
  return {
    name,
    createdAt,
    website: website === undefined ? null : Boolean(website && !website.redirectTo),
    websiteUrl: websiteUrl(name),
    manifest,
    indexEtag: index?.etag || null,
  };
}

export async function scanBuckets(s3, { concurrency = 8 } = {}) {
  const list = await s3.listBuckets();
  return mapLimit(list, concurrency, (b) => scanBucket(s3, b.name, b.createdAt).catch((err) => ({ name: b.name, createdAt: b.createdAt, websiteUrl: websiteUrl(b.name), error: err.message })));
}

export const STATUS_LABELS = {
  synced: 'Актуально',
  outdated: 'Устарело',
  modified: 'Изменено вне программы',
  unknown: 'Версия неизвестна',
  missing: 'Нет в Yandex Cloud',
  'no-deploy': 'Нет продакшн-деплоя',
};

export function computeStatus(project, bucket, manifest) {
  const prod = project.production;
  if (!bucket || !bucket.exists) return prod ? 'missing' : 'no-deploy';
  if (!prod) return 'no-deploy';
  if (!manifest?.vercel || (manifest.vercel.projectId && manifest.vercel.projectId !== project.id)) return 'unknown';
  const sameDeployment = manifest.vercel.deploymentId === prod.id;
  const sameCommit = Boolean(manifest.vercel.commitSha && prod.commitSha && manifest.vercel.commitSha === prod.commitSha);
  if (!sameDeployment && !sameCommit) return 'outdated';
  if (manifest.indexEtag && bucket.indexEtag && manifest.indexEtag !== bucket.indexEtag) return 'modified';
  return 'synced';
}

/**
 * Сопоставляет проекты и бакеты. Приоритет: ручная связь → манифест в бакете (или локальная копия)
 * → имя бакета совпадает с именем проекта → имя бакета совпадает с доменом проекта.
 */
export function buildOverview({ projects, buckets, links = {}, syncs = {} }) {
  const byName = new Map(buckets.map((b) => [b.name, b]));
  const projectIds = new Set(projects.map((p) => p.id));
  // Манифест мог исчезнуть из бакета (например, его стёр другой скрипт выкладки) — тогда берём локальную копию.
  const manifestOf = (name) => byName.get(name)?.manifest || syncs[name] || null;
  const ownerOf = new Map(); // бакет → projectId
  const assigned = new Map(); // projectId → { bucket, how }
  const claim = (pid, bucket, how) => {
    ownerOf.set(bucket, pid);
    assigned.set(pid, { bucket, how });
  };

  for (const p of projects) {
    const name = links[p.id];
    if (name && !ownerOf.has(name)) claim(p.id, name, 'manual');
  }

  const withManifest = buckets
    .filter((b) => manifestOf(b.name)?.vercel?.projectId)
    .sort((a, b) => String(manifestOf(b.name).syncedAt || '').localeCompare(String(manifestOf(a.name).syncedAt || '')));
  for (const b of withManifest) {
    const pid = manifestOf(b.name).vercel.projectId;
    if (!projectIds.has(pid) || ownerOf.has(b.name) || assigned.has(pid)) continue;
    claim(pid, b.name, 'manifest');
  }

  // Бакет с манифестом другого существующего проекта по имени не присваиваем.
  const belongsElsewhere = (b, p) => {
    const pid = manifestOf(b.name)?.vercel?.projectId;
    return Boolean(pid && pid !== p.id && projectIds.has(pid));
  };
  const passes = [
    ['name', (p, b) => b.name === suggestBucketName(p.name)],
    ['name', (p, b) => looseName(b.name) === looseName(p.name)],
    ['domain', (p, b) => (p.domains || []).some((d) => d === b.name && !d.endsWith('.vercel.app'))],
  ];
  for (const [how, test] of passes) {
    for (const p of projects) {
      if (assigned.has(p.id)) continue;
      const b = buckets.find((x) => !ownerOf.has(x.name) && !belongsElsewhere(x, p) && test(p, x));
      if (b) claim(p.id, b.name, how);
    }
  }

  const counts = { total: projects.length, synced: 0, outdated: 0, modified: 0, unknown: 0, missing: 0, 'no-deploy': 0 };
  const rows = projects.map((p) => {
    const link = assigned.get(p.id);
    const bucket = link ? byName.get(link.bucket) : null;
    const manifest = link ? manifestOf(link.bucket) : null;
    const yandex = link
      ? {
          bucket: link.bucket,
          exists: Boolean(bucket),
          how: link.how,
          websiteUrl: websiteUrl(link.bucket),
          website: bucket?.website ?? null,
          error: bucket?.error || null,
          synced: manifest?.vercel
            ? {
                projectId: manifest.vercel.projectId,
                deploymentId: manifest.vercel.deploymentId,
                deploymentCreatedAt: manifest.vercel.deploymentCreatedAt || null,
                commitSha: manifest.vercel.commitSha || null,
                commitMessage: syncs[link.bucket]?.vercel?.deploymentId === manifest.vercel.deploymentId ? syncs[link.bucket].vercel.commitMessage || null : null,
                syncedAt: manifest.syncedAt || null,
                files: manifest.files ?? null,
                fromLocalState: !bucket?.manifest,
              }
            : null,
        }
      : null;
    const status = computeStatus(p, yandex ? { exists: yandex.exists, indexEtag: bucket?.indexEtag } : null, manifest);
    counts[status]++;
    return { ...p, yandex, status, statusLabel: STATUS_LABELS[status], suggestedBucket: suggestBucketName(p.name) };
  });

  const unmatchedBuckets = buckets
    .filter((b) => !ownerOf.has(b.name))
    .map((b) => {
      const m = manifestOf(b.name);
      return {
        name: b.name,
        createdAt: b.createdAt,
        websiteUrl: b.websiteUrl,
        website: b.website ?? null,
        error: b.error || null,
        syncedFrom: m?.vercel ? { projectId: m.vercel.projectId, projectName: m.vercel.projectName, syncedAt: m.syncedAt } : null,
      };
    });

  return { rows, unmatchedBuckets, counts };
}
