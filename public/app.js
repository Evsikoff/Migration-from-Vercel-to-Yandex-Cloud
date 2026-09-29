// Интерфейс программы «Vercel → Yandex Cloud».
const SESSION = document.querySelector('meta[name="session"]').content;
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const README_SA_URL = 'https://github.com/Evsikoff/Migration-from-Vercel-to-Yandex-Cloud#сервисный-аккаунт-yandex-cloud';

const state = {
  overview: null,
  jobs: [],
  filter: 'all',
  search: '',
  sort: localStorageGet('sort') || 'deploy',
  selected: new Set(),
  loading: false,
  jobsOpen: false,
  menuFor: null,
};

function localStorageGet(k) {
  try {
    return localStorage.getItem(`v2yc.${k}`);
  } catch {
    return null;
  }
}
function localStorageSet(k, v) {
  try {
    localStorage.setItem(`v2yc.${k}`, v);
  } catch {
    /* нет доступа — не страшно */
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Session': SESSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

// ---------- Форматирование ----------

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function ago(ts) {
  if (!ts) return '—';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 31) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${Math.max(m, 1)} мин`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
}

const fullDate = (ts) => (ts ? new Date(typeof ts === 'number' ? ts : Date.parse(ts)).toLocaleString('ru-RU') : '');
const shortSha = (sha) => (sha ? sha.slice(0, 7) : '');
const firstLine = (s) => String(s || '').split('\n')[0];

const ICONS = {
  ext: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5H2.5v7h7v-2M7 2.5h2.5V5M9.5 2.5 5.5 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  git: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  bucket: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11l-1.2 8.3a1.5 1.5 0 0 1-1.5 1.2H5.2a1.5 1.5 0 0 1-1.5-1.2zM2.5 4.5C2.5 3.1 5 2 8 2s5.5 1.1 5.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  caret: '<svg class="caret" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m3.5 9 3.5-3.5L10.5 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function siteLink(url, label, extraClass = '') {
  return `<a class="site ${extraClass}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}"><span>${esc(label)}</span>${ICONS.ext}</a>`;
}

// ---------- Уведомления ----------

function toast(html, kind = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- Задания ----------

const isActive = (j) => j && (j.status === 'queued' || j.status === 'running');

function jobFor(projectId) {
  let best = null;
  for (const j of state.jobs) if (j.projectId === projectId && (!best || j.createdAt > best.createdAt)) best = j;
  return best;
}

let jobsTimer = null;
async function pollJobs() {
  clearTimeout(jobsTimer);
  try {
    const { jobs } = await api('/api/jobs');
    const before = new Map(state.jobs.map((j) => [j.id, j.status]));
    state.jobs = jobs;
    const finished = jobs.filter((j) => isActive({ status: before.get(j.id) }) && !isActive(j));
    for (const j of finished) {
      if (j.status === 'done') toast(`<b>${esc(j.projectName)}</b> выложен: <a href="${esc(j.result?.websiteUrl)}" target="_blank" rel="noopener">${esc(j.result?.websiteUrl)}</a>`, 'success', 9000);
      else if (j.status === 'error') toast(`<b>${esc(j.projectName)}</b>: ${esc(j.error)}`, 'error', 12000);
    }
    if (finished.length) await loadOverview({ quiet: true });
    else renderRows();
    renderJobs();
  } catch {
    /* сервер недоступен — попробуем позже */
  }
  jobsTimer = setTimeout(pollJobs, state.jobs.some(isActive) ? 1200 : 6000);
}

async function startJobs(projectIds, bucketByProject = {}) {
  const ids = [...projectIds];
  try {
    if (ids.length === 1) {
      await api('/api/jobs', { method: 'POST', body: { projectId: ids[0], bucket: bucketByProject[ids[0]] } });
    } else {
      const r = await api('/api/jobs/bulk', { method: 'POST', body: { projectIds: ids } });
      for (const e of r.errors) toast(esc(e), 'error', 8000);
    }
    state.jobsOpen = true;
    await pollJobs();
  } catch (err) {
    toast(esc(err.message), 'error', 8000);
  }
}

// ---------- Загрузка данных ----------

async function loadOverview({ refresh = false, quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    renderRows();
  }
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  btn.disabled = true;
  try {
    state.overview = await api(`/api/overview${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    toast(esc(err.message), 'error', 8000);
  } finally {
    state.loading = false;
    btn.classList.remove('spin');
    btn.disabled = false;
    renderAll();
  }
}

// ---------- Отрисовка ----------

function renderAll() {
  renderConn();
  renderAlerts();
  renderSummary();
  renderRows();
  renderBuckets();
  renderJobs();
  const o = state.overview;
  const n = o ? o.counts.outdated + o.counts.modified : 0;
  document.title = n ? `(${n}) Vercel → Yandex Cloud` : 'Vercel → Yandex Cloud';
}

function renderConn() {
  const o = state.overview;
  const el = $('#conn');
  if (!o) {
    el.innerHTML = '<span class="chip"><span class="dot wait"></span>Подключаюсь…</span>';
    return;
  }
  const v = o.vercel;
  const vText = v.error
    ? `<b>Vercel</b><span class="dim">${esc(v.needsToken ? 'нужен токен' : 'ошибка')}</span>`
    : `<b>Vercel</b><span class="dim">${esc([v.user?.username, v.teams.map((t) => t.name).join(', '), `${o.rows.length} ${plural(o.rows.length, 'проект', 'проекта', 'проектов')}`].filter(Boolean).join(' · '))}</span>`;
  const y = o.yandex;
  const yText = y.error
    ? '<b>Yandex Cloud</b><span class="dim">ошибка</span>'
    : `<b>Yandex Cloud</b><span class="dim">${esc(y.serviceAccount || (y.accessKeyId ? `ключ ${y.accessKeyId}` : 'сервисный аккаунт'))} · ${y.bucketCount} ${plural(y.bucketCount, 'бакет', 'бакета', 'бакетов')}</span>`;
  el.innerHTML = `
    <button class="chip" type="button" data-open="settings" title="${esc(v.error || `Токен: ${v.tokenSource || ''}`)}"><span class="dot ${v.error ? 'bad' : 'ok'}"></span>${vText}</button>
    <button class="chip" type="button" data-open="settings" title="${esc(y.error || `Ключи: ${y.keySource || y.keyFile || ''}`)}"><span class="dot ${y.error ? 'bad' : 'ok'}"></span>${yText}</button>`;
}

function renderAlerts() {
  const o = state.overview;
  const el = $('#alerts');
  if (!o) {
    el.innerHTML = '';
    return;
  }
  const parts = [];
  if (o.vercel.needsToken) {
    parts.push(`
      <div class="onboarding">
        <h2>Подключите Vercel</h2>
        <p>Программе нужен токен доступа к Vercel, чтобы увидеть ваши проекты и их продакшн-деплои.</p>
        <ol>
          <li>Откройте <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener">vercel.com/account/tokens</a> и нажмите <b>Create Token</b>.</li>
          <li>Scope — ваша команда (или Full Account), срок — по желанию.</li>
          <li>Вставьте токен сюда. Он сохранится только на этом компьютере (в папке data программы).</li>
        </ol>
        <form class="row" id="tokenForm">
          <input class="input mono" id="tokenInput" type="password" placeholder="Токен Vercel" autocomplete="off" required>
          <button class="btn primary" type="submit">Подключить</button>
        </form>
      </div>`);
  } else if (o.vercel.error) {
    parts.push(`<div class="alert error"><div class="alert-body"><div class="alert-title">Vercel недоступен</div>${esc(o.vercel.error)}</div><button class="btn sm" data-open="settings">Настройки</button></div>`);
  }
  if (o.yandex.error) {
    parts.push(`<div class="alert error"><div class="alert-body"><div class="alert-title">Yandex Cloud недоступен</div>${esc(o.yandex.error)}<div><a href="${README_SA_URL}" target="_blank" rel="noopener">Как создать сервисный аккаунт и ключи</a></div></div><button class="btn sm" data-open="settings">Настройки</button></div>`);
  }
  if (o.vercel.warnings?.length) {
    parts.push(`<div class="alert warn"><div class="alert-body"><div class="alert-title">Часть данных Vercel не получена</div><details><summary>Подробнее (${o.vercel.warnings.length})</summary><ul class="list-plain">${o.vercel.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details></div></div>`);
  }
  el.innerHTML = parts.join('');
  const form = $('#tokenForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = $('#tokenInput').value.trim();
      if (!token) return;
      try {
        await api('/api/settings', { method: 'POST', body: { vercelToken: token } });
        toast('Токен сохранён, читаю проекты…');
        await loadOverview({ refresh: true });
      } catch (err) {
        toast(esc(err.message), 'error');
      }
    });
  }
}

const SUMMARY = [
  ['all', 'Все проекты', (c) => c.total],
  ['synced', 'Актуально', (c) => c.synced],
  ['outdated', 'Устарело', (c) => c.outdated + c.modified],
  ['missing', 'Нет в Yandex Cloud', (c) => c.missing],
  ['unknown', 'Версия неизвестна', (c) => c.unknown],
];

function renderSummary() {
  const c = state.overview?.counts;
  $('#summary').innerHTML = SUMMARY.map(
    ([key, label, get]) => `
      <button type="button" class="stat ${state.filter === key ? 'active' : ''}" data-filter="${key}">
        <div class="stat-label"><span class="swatch ${key}"></span>${label}</div>
        <div class="stat-value">${c ? get(c) : '—'}</div>
      </button>`,
  ).join('');
  const n = c ? c.outdated + c.modified : 0;
  const btn = $('#updateOutdatedBtn');
  btn.hidden = !n;
  btn.textContent = `Обновить устаревшие (${n})`;
}

const FILTERS = {
  all: () => true,
  synced: (r) => r.status === 'synced',
  outdated: (r) => r.status === 'outdated' || r.status === 'modified',
  missing: (r) => r.status === 'missing',
  unknown: (r) => r.status === 'unknown',
};
const STATUS_ORDER = { outdated: 0, modified: 1, unknown: 2, missing: 3, synced: 4, 'no-deploy': 5 };

function visibleRows() {
  const rows = state.overview?.rows || [];
  const q = state.search.trim().toLowerCase();
  const list = rows.filter((r) => {
    if (!FILTERS[state.filter](r)) return false;
    if (!q) return true;
    return [r.name, r.primaryDomain, ...(r.domains || []), r.yandex?.bucket, r.repo?.label, r.framework].some((s) => s && String(s).toLowerCase().includes(q));
  });
  const byDeploy = (a, b) => (b.production?.createdAt || 0) - (a.production?.createdAt || 0);
  if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  else if (state.sort === 'status') list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byDeploy(a, b));
  else list.sort(byDeploy);
  return list;
}

function projectCell(r) {
  const nameHtml = r.dashboardUrl ? `<a href="${esc(r.dashboardUrl)}" target="_blank" rel="noopener" title="Открыть проект в Vercel">${esc(r.name)}</a>` : esc(r.name);
  const meta = [];
  if (r.repo) meta.push(`<a href="${esc(r.repo.webUrl)}" target="_blank" rel="noopener" title="Репозиторий">${ICONS.git} ${esc(r.repo.label)}</a>`);
  return `<div class="pname">${nameHtml}${r.framework ? `<span class="tag">${esc(r.framework)}</span>` : ''}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}`;
}

function vercelCell(r) {
  const p = r.production;
  if (!p) return '<span class="none">нет продакшн-деплоя</span>';
  const link = r.primaryDomain ? siteLink(`https://${r.primaryDomain}`, r.primaryDomain) : p.url ? siteLink(`https://${p.url}`, p.url) : '';
  // Служебные адреса вида проект-команда.vercel.app и ветки -git- не показываем.
  const teamAlias = r.teamSlug ? `-${r.teamSlug}.vercel.app` : null;
  const others = (r.domains || []).filter((d) => d !== r.primaryDomain && !/-git-/.test(d) && !(teamAlias && d.endsWith(teamAlias)));
  const commit = p.commitSha ? `<span class="sha" title="${esc(p.commitMessage || '')}">${esc(shortSha(p.commitSha))}</span>` : '';
  return `${link}${others.length ? ` <span class="tag" title="${esc(others.join('\n'))}">+${others.length}</span>` : ''}
    <div class="meta"><span title="${esc(fullDate(p.createdAt))}">деплой ${esc(ago(p.createdAt))}</span>${commit}</div>`;
}

const HOW = { manual: 'связан вручную', manifest: '', name: 'найден по имени', domain: 'найден по домену' };

function yandexCell(r) {
  const y = r.yandex;
  if (!y || !y.exists) {
    const planned = y?.bucket || r.suggestedBucket;
    return `<span class="none">не скопирован</span><div class="meta">${ICONS.bucket} бакет <span class="mono">${esc(planned)}</span> будет создан</div>`;
  }
  const s = y.synced;
  const meta = [`<span title="Бакет Object Storage">${ICONS.bucket} ${esc(y.bucket)}</span>`];
  if (HOW[y.how]) meta.push(`<span>${HOW[y.how]}</span>`);
  if (s) {
    meta.push(`<span title="Синхронизировано ${esc(fullDate(s.syncedAt))}">синхр. ${esc(ago(s.syncedAt))}</span>`);
    if (s.commitSha) meta.push(`<span class="sha" title="${esc(s.commitMessage || '')}">${esc(shortSha(s.commitSha))}</span>`);
  }
  const off = y.website === false ? '<div class="meta" style="color:var(--amber)">хостинг сайта выключен — включится при обновлении</div>' : '';
  return `${siteLink(y.websiteUrl, y.websiteUrl.replace(/^https?:\/\//, ''))}<div class="meta">${meta.join('')}</div>${off}`;
}

function statusCell(r, job) {
  if (isActive(job)) {
    const p = job.progress;
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : null;
    const label = job.status === 'queued' ? 'В очереди' : job.mode === 'copy' ? 'Копирование' : 'Обновление';
    return `<span class="pill running">${label}</span>
      <div class="status-note">${esc(job.stage)}${pct !== null ? ` · ${pct}%` : ''}</div>
      ${job.status === 'running' ? `<div class="progress ${pct === null ? 'indeterminate' : ''}"><div style="width:${pct ?? 0}%"></div></div>` : ''}`;
  }
  let note = '';
  const p = r.production;
  const s = r.yandex?.synced;
  switch (r.status) {
    case 'synced':
      note = s?.syncedAt ? `копия от ${ago(s.syncedAt)}` : '';
      break;
    case 'outdated':
      note = p && s?.deploymentCreatedAt ? `Vercel новее на ${span(p.createdAt - s.deploymentCreatedAt)}` : p ? `новый деплой ${ago(p.createdAt)}` : '';
      break;
    case 'modified':
      note = 'сайт в бакете изменён после синхронизации';
      break;
    case 'unknown':
      note = s?.projectId && s.projectId !== r.id ? 'в бакете копия другого проекта' : 'бакет выложен не этой программой';
      break;
    case 'missing':
      note = 'копии ещё нет';
      break;
    default:
      note = 'на Vercel нечего копировать';
  }
  let err = '';
  if (job && job.status === 'error') {
    err = `<div class="status-note err">Ошибка: ${esc(firstLine(job.error).slice(0, 160))} · <a data-act="log" data-job="${job.id}">лог</a></div>`;
  }
  return `<span class="pill ${r.status}">${esc(r.statusLabel)}</span>${note ? `<div class="status-note">${esc(note)}</div>` : ''}${err}`;
}

function actionsCell(r, job) {
  let primary;
  if (isActive(job)) primary = `<button class="btn sm" data-act="log" data-job="${job.id}">Лог</button>`;
  else if (r.status === 'missing') primary = `<button class="btn primary sm" data-act="copy" data-id="${r.id}">Скопировать</button>`;
  else if (r.status === 'outdated' || r.status === 'modified' || r.status === 'unknown') primary = `<button class="btn primary sm" data-act="update" data-id="${r.id}">Обновить</button>`;
  else if (r.status === 'synced') primary = `<button class="btn ghost sm" data-act="update" data-id="${r.id}" title="Собрать и выложить заново">Пересобрать</button>`;
  else primary = '<button class="btn ghost sm" disabled>—</button>';
  return `<div class="actions">${primary}<button class="btn icon sm ghost" data-act="menu" data-id="${r.id}" title="Ещё" aria-label="Ещё">⋯</button></div>`;
}

function renderRows() {
  const tbody = $('#rows');
  const empty = $('#empty');
  const o = state.overview;
  if (!o) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<span class="loader"></span>Читаю проекты Vercel и бакеты Yandex Cloud…';
    return;
  }
  const rows = visibleRows();
  if (state.loading && !o.rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<span class="loader"></span>Читаю проекты Vercel и бакеты Yandex Cloud…';
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const job = jobFor(r.id);
      const sel = state.selected.has(r.id);
      return `<tr class="${sel ? 'selected' : ''}" data-row="${r.id}">
        <td><input type="checkbox" data-select="${r.id}" ${sel ? 'checked' : ''} ${r.production ? '' : 'disabled'} aria-label="Выбрать ${esc(r.name)}"></td>
        <td>${projectCell(r)}</td>
        <td>${vercelCell(r)}</td>
        <td>${yandexCell(r)}</td>
        <td>${statusCell(r, job)}</td>
        <td>${actionsCell(r, job)}</td>
      </tr>`;
    })
    .join('');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.innerHTML = o.rows.length
      ? '<div class="big">Ничего не найдено</div>Измените фильтр или строку поиска.'
      : o.vercel.error
        ? '<div class="big">Проекты Vercel не загружены</div>Проверьте подключение в настройках.'
        : '<div class="big">На Vercel нет проектов</div>';
  }
  const selectable = rows.filter((r) => r.production);
  const all = $('#selectAll');
  all.checked = selectable.length > 0 && selectable.every((r) => state.selected.has(r.id));
  all.indeterminate = !all.checked && selectable.some((r) => state.selected.has(r.id));
  renderSelectionBar();
}

function renderSelectionBar() {
  const bar = $('#selectionBar');
  const rows = (state.overview?.rows || []).filter((r) => state.selected.has(r.id));
  if (!rows.length) {
    bar.hidden = true;
    return;
  }
  const copies = rows.filter((r) => r.status === 'missing').length;
  bar.hidden = false;
  bar.innerHTML = `
    <b>Выбрано: ${rows.length}</b>
    <span class="grow">${copies ? `новых копий: ${copies}, ` : ''}обновлений: ${rows.length - copies}</span>
    <button class="btn primary sm" data-act="bulk">Скопировать / обновить выбранные</button>
    <button class="btn sm ghost" data-act="clear-selection">Снять выделение</button>`;
}

function renderBuckets() {
  const sec = $('#bucketsSection');
  const list = state.overview?.unmatchedBuckets || [];
  if (!list.length) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  sec.innerHTML = `
    <h3>Бакеты Yandex Cloud без пары на Vercel (${list.length})</h3>
    <p class="hint">Бакеты сервисного аккаунта, для которых не нашёлся проект. Если это копия проекта под другим именем — свяжите их.</p>
    <div class="bucket-list">${list
      .map(
        (b) => `
      <div class="bucket-item">
        <div class="top"><span class="name">${esc(b.name)}</span><button class="btn sm ghost" data-act="link-bucket" data-bucket="${esc(b.name)}">Связать…</button></div>
        ${b.website === false ? '<span class="none">хостинг сайта выключен</span>' : siteLink(b.websiteUrl, b.websiteUrl.replace(/^https?:\/\//, ''))}
        <div class="meta">${b.syncedFrom ? `копия проекта «${esc(b.syncedFrom.projectName || b.syncedFrom.projectId)}» (на Vercel не найден) · ` : ''}${b.createdAt ? `создан ${esc(ago(b.createdAt))}` : ''}${b.error ? ` · <span style="color:var(--red)">${esc(b.error)}</span>` : ''}</div>
      </div>`,
      )
      .join('')}</div>`;
}

function renderJobs() {
  const panel = $('#jobsPanel');
  const jobs = [...state.jobs].sort((a, b) => b.createdAt - a.createdAt);
  if (!jobs.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.classList.toggle('open', state.jobsOpen);
  const active = jobs.filter(isActive);
  const failed = jobs.filter((j) => j.status === 'error').length;
  $('#jobsToggle').innerHTML = `
    <span class="dot ${active.length ? 'wait' : failed ? 'bad' : 'ok'}"></span>
    <span class="grow">${active.length ? `Выполняется: ${active.length}` : 'Задания'}${failed ? ` · ошибок: ${failed}` : ''}</span>
    <span class="dim" style="color:var(--muted);font-weight:500">${jobs.length}</span>${ICONS.caret}`;
  $('#jobsBody').innerHTML =
    jobs
      .map((j) => {
        const p = j.progress;
        const pct = p && p.total ? Math.round((p.done / p.total) * 100) : null;
        const statusPill = {
          queued: '<span class="pill missing">в очереди</span>',
          running: '<span class="pill running">идёт</span>',
          done: '<span class="pill synced">готово</span>',
          error: '<span class="pill error">ошибка</span>',
          canceled: '<span class="pill no-deploy">отменено</span>',
        }[j.status];
        return `<div class="job">
        <div class="line1"><span class="grow">${esc(j.projectName)} → ${esc(j.bucket)}</span>${statusPill}</div>
        <div class="line2">${esc(j.status === 'error' ? firstLine(j.error) : j.stage)}${j.status === 'done' && j.result ? ` · загружено ${j.result.uploaded}, без изменений ${j.result.skipped}` : ''}</div>
        ${j.status === 'running' ? `<div class="progress ${pct === null ? 'indeterminate' : ''}"><div style="width:${pct ?? 0}%"></div></div>` : ''}
        <div class="btns">
          <button class="btn sm" data-act="log" data-job="${j.id}">Лог</button>
          ${isActive(j) ? `<button class="btn sm danger" data-act="cancel" data-job="${j.id}">Отменить</button>` : ''}
          ${j.status === 'done' && j.result?.websiteUrl ? `<a class="btn sm ghost" href="${esc(j.result.websiteUrl)}" target="_blank" rel="noopener">Открыть сайт</a>` : ''}
        </div>
      </div>`;
      })
      .join('') + (jobs.some((j) => !isActive(j)) ? '<div class="jobs-foot"><button class="btn sm ghost" data-act="clear-jobs">Очистить завершённые</button></div>' : '');
}

// ---------- Меню «Ещё» ----------

function openMenu(anchor, r) {
  const menu = $('#menu');
  const job = jobFor(r.id);
  const items = [];
  items.push(`<button data-act="link" data-id="${r.id}">Связать с другим бакетом…</button>`);
  if (r.yandex?.how === 'manual') items.push(`<button data-act="unlink" data-id="${r.id}">Убрать ручную связь</button>`);
  if (job) items.push(`<button data-act="log" data-job="${job.id}">Лог последнего задания</button>`);
  items.push('<hr>');
  if (r.dashboardUrl) items.push(`<a href="${esc(r.dashboardUrl)}" target="_blank" rel="noopener">Проект в Vercel ↗</a>`);
  if (r.repo) items.push(`<a href="${esc(r.repo.webUrl)}" target="_blank" rel="noopener">Репозиторий ↗</a>`);
  if (r.yandex?.exists) items.push(`<a href="${esc(r.yandex.websiteUrl)}" target="_blank" rel="noopener">Сайт в Yandex Cloud ↗</a>`);
  menu.innerHTML = items.join('');
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${window.scrollY + rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, window.scrollX + rect.right - w)}px`;
  state.menuFor = r.id;
}

function closeMenu() {
  $('#menu').hidden = true;
  state.menuFor = null;
}

// ---------- Диалоги ----------

function showModal(html, { wide = false, onSubmit, onClose } = {}) {
  const dlg = $('#modal');
  dlg.className = `modal${wide ? ' wide' : ''}`;
  dlg.innerHTML = html;
  const form = dlg.querySelector('form');
  if (form && onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submit = form.querySelector('[type=submit]');
      if (submit) submit.disabled = true;
      try {
        const keep = await onSubmit(form);
        if (keep !== true) dlg.close();
      } catch (err) {
        toast(esc(err.message), 'error', 8000);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.onclose = () => onClose?.();
  if (!dlg.open) dlg.showModal();
  return dlg;
}

function validateBucketName(name) {
  if (name.length < 3 || name.length > 63) return 'Длина — от 3 до 63 символов';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) return 'Только строчные латинские буквы, цифры, «-» и «.», начало и конец — буква или цифра';
  if (/\.\.|\.-|-\./.test(name)) return 'Нельзя ставить подряд точки или точку рядом с дефисом';
  return '';
}
const siteUrlFor = (b) => `${b.includes('.') ? 'http' : 'https'}://${b}.website.yandexcloud.net`;

function copyDialog(r) {
  const p = r.production;
  const initial = r.yandex?.bucket || r.suggestedBucket;
  showModal(
    `<form>
      <div class="modal-head"><h2>Скопировать «${esc(r.name)}» в Yandex Cloud</h2><p>Копия появится в Object Storage и будет отслеживаться на актуальность.</p></div>
      <div class="modal-body">
        <ol class="steps">
          <li>Возьмём текущий продакшн-деплой Vercel <b>${esc(ago(p.createdAt))}</b>${p.commitSha ? `, коммит <b class="mono">${esc(shortSha(p.commitSha))}</b> — ${esc(firstLine(p.commitMessage).slice(0, 90))}` : ''}.</li>
          <li>Соберём его на этом компьютере теми же командами и переменными окружения, что и Vercel.</li>
          <li>Создадим бакет с публичным чтением и хостингом сайта и выложим результат.</li>
        </ol>
        <label class="field"><span>Имя бакета</span>
          <input class="input mono" name="bucket" value="${esc(initial)}" autocomplete="off" spellcheck="false" required>
          <small class="err" id="bucketErr"></small>
          <small>Имена бакетов уникальны во всём Yandex Cloud. Если имя занято — программа сообщит об этом до сборки.</small>
        </label>
        <div class="field"><span>Адрес сайта</span><div class="url-preview" id="urlPreview"></div></div>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-close>Отмена</button><button class="btn primary" type="submit">Скопировать</button></div>
    </form>`,
    {
      onSubmit: async (form) => {
        const bucket = form.bucket.value.trim();
        const err = validateBucketName(bucket);
        if (err) {
          $('#bucketErr').textContent = err;
          return true;
        }
        await startJobs([r.id], { [r.id]: bucket });
      },
    },
  );
  const input = $('#modal input[name=bucket]');
  const update = () => {
    const v = input.value.trim();
    const err = validateBucketName(v);
    $('#bucketErr').textContent = err;
    input.classList.toggle('invalid', Boolean(err));
    $('#urlPreview').textContent = err ? '—' : siteUrlFor(v);
  };
  input.addEventListener('input', update);
  update();
  input.focus();
  input.select();
}

function confirmDialog({ title, text, ok = 'Продолжить', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    showModal(
      `<form>
        <div class="modal-head"><h2>${esc(title)}</h2></div>
        <div class="modal-body">${text}</div>
        <div class="modal-foot"><button class="btn" type="button" data-close>Отмена</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(ok)}</button></div>
      </form>`,
      {
        onSubmit: () => {
          result = true;
        },
        onClose: () => resolve(result),
      },
    );
  });
}

async function updateProject(r) {
  if (r.status === 'unknown' || r.status === 'modified') {
    const reason =
      r.status === 'modified'
        ? 'Сайт в бакете изменили после последней синхронизации (например, выложили вручную).'
        : 'Бакет выложен не этой программой, поэтому неизвестно, какая версия в нём сейчас.';
    const ok = await confirmDialog({
      title: `Обновить «${r.name}»?`,
      text: `<p>${reason}</p><p>Содержимое бакета <b class="mono">${esc(r.yandex.bucket)}</b> будет заменено сборкой текущего продакшн-деплоя Vercel. Файлы, которых нет в сборке, удалятся.</p>`,
      ok: 'Обновить',
    });
    if (!ok) return;
  }
  await startJobs([r.id]);
}

function allBuckets() {
  const o = state.overview;
  const map = new Map();
  for (const r of o.rows) if (r.yandex?.exists) map.set(r.yandex.bucket, r.name);
  for (const b of o.unmatchedBuckets) map.set(b.name, null);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function linkDialog(r) {
  const buckets = allBuckets();
  const current = r.yandex?.bucket || '';
  showModal(
    `<form>
      <div class="modal-head"><h2>Бакет для «${esc(r.name)}»</h2><p>Выберите существующий бакет или впишите имя нового — он будет создан при копировании.</p></div>
      <div class="modal-body">
        <label class="field"><span>Существующие бакеты</span>
          <select class="select" name="pick">
            <option value="">— выбрать —</option>
            ${buckets.map(([name, owner]) => `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}${owner && owner !== r.name ? ` (сейчас: ${esc(owner)})` : owner === r.name ? ' (текущий)' : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Или имя бакета</span><input class="input mono" name="bucket" value="${esc(current)}" autocomplete="off" spellcheck="false"><small class="err" id="bucketErr"></small></label>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-close>Отмена</button><button class="btn primary" type="submit">Связать</button></div>
    </form>`,
    {
      onSubmit: async (form) => {
        const bucket = form.bucket.value.trim();
        const err = validateBucketName(bucket);
        if (err) {
          $('#bucketErr').textContent = err;
          return true;
        }
        state.overview = await api('/api/link', { method: 'POST', body: { projectId: r.id, bucket } });
        renderAll();
        toast(`«${esc(r.name)}» связан с бакетом ${esc(bucket)}`);
      },
    },
  );
  const dlg = $('#modal');
  dlg.querySelector('select[name=pick]').addEventListener('change', (e) => {
    if (e.target.value) dlg.querySelector('input[name=bucket]').value = e.target.value;
  });
}

function linkBucketDialog(bucket) {
  const rows = [...state.overview.rows].sort((a, b) => Boolean(a.yandex?.exists) - Boolean(b.yandex?.exists) || a.name.localeCompare(b.name));
  showModal(
    `<form>
      <div class="modal-head"><h2>Связать бакет <span class="mono">${esc(bucket)}</span></h2><p>Выберите проект Vercel, копией которого является этот бакет.</p></div>
      <div class="modal-body">
        <label class="field"><span>Проект Vercel</span>
          <select class="select" name="project" required>
            <option value="">— выбрать —</option>
            ${rows.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.yandex?.exists ? ` (уже связан с ${esc(r.yandex.bucket)})` : ''}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-close>Отмена</button><button class="btn primary" type="submit">Связать</button></div>
    </form>`,
    {
      onSubmit: async (form) => {
        const projectId = form.project.value;
        if (!projectId) return true;
        state.overview = await api('/api/link', { method: 'POST', body: { projectId, bucket } });
        renderAll();
      },
    },
  );
}

async function bulkDialog(ids) {
  const rows = state.overview.rows.filter((r) => ids.includes(r.id) && r.production);
  if (!rows.length) return;
  const copies = rows.filter((r) => r.status === 'missing');
  const risky = rows.filter((r) => r.status === 'unknown' || r.status === 'modified');
  const ok = await confirmDialog({
    title: `Скопировать / обновить ${rows.length} ${plural(rows.length, 'проект', 'проекта', 'проектов')}?`,
    text: `
      ${copies.length ? `<p>Будут созданы бакеты (${copies.length}): <span class="mono">${copies.map((r) => esc(r.yandex?.bucket || r.suggestedBucket)).join(', ')}</span></p>` : ''}
      ${rows.length - copies.length ? `<p>Будут обновлены копии: ${rows.length - copies.length}.</p>` : ''}
      ${risky.length ? `<p>В ${risky.length} ${plural(risky.length, 'бакете', 'бакетах', 'бакетах')} версия неизвестна или изменена вручную — их содержимое заменится сборкой из Vercel: <span class="mono">${risky.map((r) => esc(r.yandex.bucket)).join(', ')}</span></p>` : ''}
      <p style="color:var(--muted)">Проекты собираются по очереди; ход работы — в панели «Задания» справа внизу.</p>`,
    ok: 'Запустить',
  });
  if (!ok) return;
  state.selected.clear();
  await startJobs(rows.map((r) => r.id));
}

let logTimer = null;
function logDialog(jobId) {
  clearTimeout(logTimer);
  let next = 0;
  showModal(
    `<div class="wrap">
      <div class="modal-head"><h2 id="logTitle">Лог</h2><p id="logSub"></p></div>
      <div class="modal-body"><pre class="log" id="logBox"></pre></div>
      <div class="modal-foot"><span id="logLinks" style="margin-right:auto"></span><button class="btn danger" id="logCancel" type="button" hidden>Отменить</button><button class="btn" type="button" data-close>Закрыть</button></div>
    </div>`,
    { wide: true, onClose: () => clearTimeout(logTimer) },
  );
  const box = $('#logBox');
  $('#logCancel').addEventListener('click', () => cancelJob(jobId));
  const tick = async () => {
    try {
      const { job, log } = await api(`/api/jobs/${jobId}?from=${next}`);
      $('#logTitle').textContent = `${job.projectName} → ${job.bucket}`;
      $('#logSub').textContent = `${{ queued: 'В очереди', running: job.stage, done: 'Готово', error: 'Ошибка', canceled: 'Отменено' }[job.status]} · начато ${job.startedAt ? new Date(job.startedAt).toLocaleTimeString('ru-RU') : '—'}`;
      $('#logCancel').hidden = !isActive(job);
      $('#logLinks').innerHTML = job.result?.websiteUrl ? siteLink(job.result.websiteUrl, 'Открыть сайт в Yandex Cloud') : '';
      if (log.lines.length) {
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        const frag = log.lines
          .map((l) => `<span class="t">${new Date(l.t).toLocaleTimeString('ru-RU')}</span> <span class="${esc(l.level)}">${esc(l.msg)}</span>`)
          .join('\n');
        box.insertAdjacentHTML('beforeend', (next > 0 && box.innerHTML ? '\n' : '') + frag);
        next = log.next;
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
      if (isActive(job) && $('#modal').open) logTimer = setTimeout(tick, 1000);
    } catch (err) {
      box.insertAdjacentHTML('beforeend', `\n<span class="error">${esc(err.message)}</span>`);
    }
  };
  tick();
}

async function cancelJob(id) {
  try {
    await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
    await pollJobs();
  } catch (err) {
    toast(esc(err.message), 'error');
  }
}

async function settingsDialog() {
  let s;
  try {
    s = await api('/api/settings');
  } catch (err) {
    toast(esc(err.message), 'error');
    return;
  }
  const t = s.tools || {};
  const tool = (name, v, required) => `<span class="tag" style="${!v && required ? 'color:var(--red)' : ''}">${name}: ${v ? esc(v) : 'не найден'}</span>`;
  showModal(
    `<form>
      <div class="modal-head"><h2>Настройки</h2><p>Всё хранится только на этом компьютере: <span class="mono">${esc(s.dataDir)}</span></p></div>
      <div class="modal-body">
        <label class="field"><span>Токен Vercel</span>
          <input class="input mono" name="vercelToken" type="password" autocomplete="off" placeholder="${s.vercel.token ? `сейчас: ${esc(s.vercel.token)} — вставьте новый, чтобы заменить` : 'вставьте токен'}">
          <small>${s.vercel.token ? `Используется токен из: ${esc(s.vercel.source)}.` : 'Токен не найден.'} Создать: <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener">vercel.com/account/tokens</a>.</small>
          ${s.config.hasSavedVercelToken ? '<label class="check"><input type="checkbox" name="clearToken"> удалить сохранённый токен</label>' : ''}
        </label>
        <label class="field"><span>Файл с ключами сервисного аккаунта Yandex Cloud</span>
          <input class="input mono" name="ycEnvFile" value="${esc(s.config.ycEnvFile)}" placeholder="${esc(s.yc.file || s.yc.candidates[0] || '')}" spellcheck="false">
          <small class="${s.yc.error ? 'err' : ''}">${s.yc.error ? esc(s.yc.error) : `Используются ${esc(s.yc.source)} (ключ ${esc(s.yc.accessKeyId)}).`} Формат: строки YC_ACCESS_KEY_ID=… и YC_SECRET_ACCESS_KEY=…, подойдёт и вывод <span class="mono">yc iam access-key create</span>. <a href="${README_SA_URL}" target="_blank" rel="noopener">Как создать ключи</a>.</small>
        </label>
        <label class="field"><span>Имя сервисного аккаунта</span><input class="input" name="serviceAccount" value="${esc(s.config.serviceAccount)}" placeholder="${esc(s.yc.serviceAccount || 'любое, например site-deployer')}" spellcheck="false"><small>Только для подписи в интерфейсе — можно оставить пустым. Какой аккаунт используется, определяют ключи.</small></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label class="field"><span>Сборок одновременно</span><input class="input" name="jobConcurrency" type="number" min="1" max="4" value="${esc(s.config.jobConcurrency)}"></label>
          <label class="field"><span>Перепроверять актуальность, мин</span><input class="input" name="autoCheckMinutes" type="number" min="0" max="1440" value="${esc(s.config.autoCheckMinutes)}"><small>0 — только вручную</small></label>
        </div>
        <label class="check"><input type="checkbox" name="cleanWorkDir" ${s.config.cleanWorkDir ? 'checked' : ''}><span>Удалять рабочую папку сборки после успешной выгрузки (экономит место; иначе следующая сборка быстрее)</span></label>
        <div class="field"><span>Инструменты на компьютере</span>
          <div class="tools">${tool('git', t.git, true)}${tool('node', t.node, true)}${tool('npm', t.npm, true)}${tool('pnpm', t.pnpm)}${tool('yarn', t.yarn)}${tool('bun', t.bun)}</div>
          <small>Git нужен, чтобы скачать исходники коммита. pnpm и yarn при отсутствии запускаются через npx.</small>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-close>Отмена</button><button class="btn primary" type="submit">Сохранить</button></div>
    </form>`,
    {
      onSubmit: async (form) => {
        const body = {
          ycEnvFile: form.ycEnvFile.value,
          serviceAccount: form.serviceAccount.value,
          jobConcurrency: Number(form.jobConcurrency.value),
          autoCheckMinutes: Number(form.autoCheckMinutes.value),
          cleanWorkDir: form.cleanWorkDir.checked,
        };
        if (form.vercelToken.value.trim()) body.vercelToken = form.vercelToken.value.trim();
        else if (form.clearToken?.checked) body.vercelToken = '';
        await api('/api/settings', { method: 'POST', body });
        toast('Настройки сохранены');
        loadOverview({ refresh: true });
      },
    },
  );
}

// ---------- События ----------

function rowById(id) {
  return state.overview?.rows.find((r) => r.id === id);
}

document.addEventListener('click', async (e) => {
  const openSettings = e.target.closest('[data-open="settings"]');
  if (openSettings) return settingsDialog();

  const filter = e.target.closest('[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    renderSummary();
    renderRows();
    return;
  }

  const el = e.target.closest('[data-act]');
  if (!el) {
    if (!e.target.closest('#menu')) closeMenu();
    return;
  }
  const act = el.dataset.act;
  const r = el.dataset.id ? rowById(el.dataset.id) : null;
  if (act !== 'menu') closeMenu();
  try {
    await handleAction(act, el, r);
  } catch (err) {
    toast(esc(err.message), 'error', 8000);
  }
});

async function handleAction(act, el, r) {
  switch (act) {
    case 'menu':
      if (state.menuFor === r.id && !$('#menu').hidden) closeMenu();
      else openMenu(el, r);
      break;
    case 'copy':
      copyDialog(r);
      break;
    case 'update':
      updateProject(r);
      break;
    case 'link':
      linkDialog(r);
      break;
    case 'unlink':
      state.overview = await api('/api/link', { method: 'POST', body: { projectId: r.id, bucket: null } });
      renderAll();
      break;
    case 'link-bucket':
      linkBucketDialog(el.dataset.bucket);
      break;
    case 'log':
      logDialog(el.dataset.job);
      break;
    case 'cancel':
      cancelJob(el.dataset.job);
      break;
    case 'bulk':
      bulkDialog([...state.selected]);
      break;
    case 'clear-selection':
      state.selected.clear();
      renderRows();
      break;
    case 'clear-jobs':
      await api('/api/jobs/clear', { method: 'POST' });
      await pollJobs();
      break;
    default:
  }
}

document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-select]');
  if (sel) {
    if (sel.checked) state.selected.add(sel.dataset.select);
    else state.selected.delete(sel.dataset.select);
    renderRows();
    return;
  }
  if (e.target.id === 'selectAll') {
    for (const r of visibleRows()) {
      if (!r.production) continue;
      if (e.target.checked) state.selected.add(r.id);
      else state.selected.delete(r.id);
    }
    renderRows();
  }
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderRows();
});

$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  localStorageSet('sort', state.sort);
  renderRows();
});

$('#refreshBtn').addEventListener('click', () => loadOverview({ refresh: true }));
$('#settingsBtn').addEventListener('click', () => settingsDialog());
$('#jobsToggle').addEventListener('click', () => {
  state.jobsOpen = !state.jobsOpen;
  renderJobs();
});
$('#updateOutdatedBtn').addEventListener('click', () => {
  const ids = (state.overview?.rows || []).filter((r) => r.status === 'outdated' || r.status === 'modified').map((r) => r.id);
  bulkDialog(ids);
});
window.addEventListener('resize', closeMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !$('#modal').open) {
    e.preventDefault();
    $('#search').focus();
  }
});

// Периодическая перепроверка актуальности, пока страница открыта.
setInterval(() => {
  const o = state.overview;
  const minutes = Number(o?.autoCheckMinutes) || 0;
  if (!minutes || document.hidden || state.loading || state.jobs.some(isActive)) return;
  if (Date.now() - (o.scannedAt || 0) >= minutes * 60_000) loadOverview({ refresh: true, quiet: true });
}, 30_000);

renderAll();
loadOverview().then(pollJobs);
