// Editorial review dashboard (browser). All text is inserted with textContent (no innerHTML of data).
import { displayStatus, filterItems, nextUnreviewed, neighbour, RECOMMENDATION_LABELS, sourceOptions, STATUS_LABELS, warningOptions } from './logic.js';

const TOKEN = document.querySelector('meta[name="review-token"]').content;
const $ = (id) => document.getElementById(id);

/** h('div', {class: 'x', onclick}, 'text', child…) — safe element builder. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-review-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.details = data.details || [];
    throw err;
  }
  return data;
}

function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 3500);
}

// ---- per-browser conveniences only (decisions live in the local database) ----
const prefs = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`review:${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`review:${k}`, JSON.stringify(v));
    } catch {
      /* private mode etc. */
    }
  },
};

const state = {
  items: [],
  filters: prefs.get('filters', { origin: '', status: '', difficulty: '', source: '', warning: '', q: '' }),
  view: prefs.get('view', 'review'),
  current: prefs.get('current', null),
  detail: null,
  busy: false,
};

const visible = () => filterItems(state.items, state.filters);

// ---------------------------------------------------------------------------
// Summary + filters
// ---------------------------------------------------------------------------

async function loadSummary() {
  const s = await api('/api/summary');
  $('reviewer').textContent = s.reviewer;
  $('s-total').textContent = s.total;
  $('s-approved').textContent = s.approved;
  $('s-investigate').textContent = s.investigate;
  $('s-rejected').textContent = s.rejected;
  $('s-unreviewed').textContent = s.unreviewed;
  $('s-progress').textContent = `${s.progressPercent}%`;
  $('s-bar').style.width = `${s.progressPercent}%`;
  const fmt = (o) => `${o.approved} approved · ${o.investigate} investigate · ${o.rejected} rejected · ${o.unreviewed} left of ${o.total}`;
  $('s-fl').textContent = fmt(s.florida);
  $('s-gta').textContent = fmt(s.gta);
  const banners = $('banners');
  banners.replaceChildren();
  if (s.master.changedSinceImport)
    banners.append(h('p', { class: 'banner warn' }, `The master file changed after it was imported for review. The dashboard keeps reviewing the imported version (sha256 ${s.master.sha256AtImport.slice(0, 12)}…).`));
  if (!s.auditLoaded) banners.append(h('p', { class: 'banner' }, 'No editorial audit file was found, so there are no suggestions. Decisions work as normal.'));
}

function fillFilterOptions() {
  const src = $('f-source');
  const keep = state.filters.source;
  src.replaceChildren(h('option', { value: '' }, 'All sources'), ...sourceOptions(state.items).map((o) => h('option', { value: o.host }, `${o.host} (${o.n})`)));
  src.value = keep;
  const w = $('f-warning');
  const keepW = state.filters.warning;
  w.replaceChildren(
    h('option', { value: '' }, 'All warnings'),
    h('option', { value: 'any' }, 'Any editorial warning'),
    h('option', { value: 'none' }, 'No warnings'),
    h('option', { value: 'rec:approve' }, 'Audit suggests approve'),
    h('option', { value: 'rec:investigate' }, 'Audit suggests investigate'),
    h('option', { value: 'rec:reject' }, 'Audit suggests reject'),
    ...warningOptions(state.items).map((o) => h('option', { value: o.code }, `${o.code} (${o.n})`)),
  );
  w.value = keepW;
  for (const [id, key] of [['f-origin', 'origin'], ['f-status', 'status'], ['f-difficulty', 'difficulty']]) $(id).value = state.filters[key];
  $('q').value = state.filters.q;
}

function bindFilters() {
  const map = { 'f-origin': 'origin', 'f-status': 'status', 'f-difficulty': 'difficulty', 'f-source': 'source', 'f-warning': 'warning' };
  for (const [id, key] of Object.entries(map))
    $(id).addEventListener('change', (e) => {
      state.filters[key] = e.target.value;
      onFiltersChanged();
    });
  $('q').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    onFiltersChanged();
  });
}

function onFiltersChanged() {
  prefs.set('filters', state.filters);
  const vis = visible();
  if (!vis.some((it) => it.eventId === state.current)) state.current = vis[0]?.eventId ?? null;
  render();
  if (state.view === 'review') loadDetail();
}

async function loadItems() {
  state.items = (await api('/api/questions')).items;
  fillFilterOptions();
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function chip(status) {
  return h('span', { class: `chip ${status}` }, STATUS_LABELS[status]);
}

function renderList() {
  const body = $('list-body');
  body.replaceChildren(
    ...visible().map((it) =>
      h(
        'tr',
        { class: it.eventId === state.current ? 'sel' : '', onclick: () => openItem(it.eventId) },
        h('td', { class: 'num' }, it.position),
        h('td', {}, chip(displayStatus(it))),
        h('td', {}, it.origin === 'FLORIDA' ? 'FL' : 'GTA'),
        h('td', { class: 'num' }, it.difficulty),
        h('td', { class: 'hl' }, it.headline, it.edited ? h('span', { class: 'tag' }, 'edited') : null),
        h('td', { class: 'src' }, it.sourceHost),
        h('td', {}, it.recommendation ? h('span', { class: `rec ${it.recommendation}` }, it.recommendation) : '', it.warningCodes.length ? h('span', { class: 'tag' }, `${it.warningCodes.length}⚑`) : null),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Review view
// ---------------------------------------------------------------------------

async function loadDetail() {
  if (!state.current) {
    state.detail = null;
    renderCard();
    return;
  }
  try {
    state.detail = await api(`/api/questions/${encodeURIComponent(state.current)}`);
  } catch (e) {
    state.detail = null;
    toast(e.message, 'err');
  }
  renderCard();
}

function openItem(id) {
  state.current = id;
  prefs.set('current', id);
  setView('review');
}

function setView(v) {
  state.view = v;
  prefs.set('view', v);
  $('list-view').hidden = v !== 'list';
  $('review-view').hidden = v !== 'review';
  $('v-review').setAttribute('aria-selected', String(v === 'review'));
  $('v-list').setAttribute('aria-selected', String(v === 'list'));
  render();
  if (v === 'review') loadDetail();
}

function render() {
  const vis = visible();
  $('count').textContent = `${vis.length} of ${state.items.length}`;
  if (state.view === 'list') renderList();
  const i = vis.findIndex((it) => it.eventId === state.current);
  $('pos').textContent = vis.length ? `${i + 1} / ${vis.length}` : '0 / 0';
  $('prev').disabled = i <= 0;
  $('next').disabled = i < 0 || i >= vis.length - 1;
}

function renderCard() {
  const card = $('card');
  const d = state.detail;
  if (!d) {
    card.replaceChildren(h('p', { class: 'empty' }, visible().length ? 'Select a question.' : 'No questions match these filters.'));
    return;
  }
  const o = d.original;
  const a = d.audit;
  const decide = (action) => () => act(action);
  const btn = (action, status, label, key) =>
    h('button', { type: 'button', class: `big ${action}${d.status === status ? ' current' : ''}`, 'aria-pressed': String(d.status === status), disabled: state.busy, onclick: decide(action) }, label, h('kbd', {}, key));
  card.replaceChildren(
    ...[
      h(
        'div',
        { class: 'card-head' },
        h('span', { class: `origin ${d.origin}` }, d.origin === 'FLORIDA' ? 'Florida' : `GTA · ${d.gameName ?? ''}`),
        chip(d.status),
        o.spoiler ? h('span', { class: 'tag' }, 'spoiler') : null,
        h('code', { class: 'id' }, d.eventId),
      ),
      h('h2', { class: 'headline' }, d.working.headline),
      h('p', { class: 'expl' }, d.working.explanation),
      h(
        'p',
        { class: 'src-line' },
        h('a', { href: o.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, `${o.publisher ?? o.sourceTitle} ↗`),
        o.publishedAt ? ` · ${o.publishedAt}` : '',
        o.location ? ` · ${o.location}` : '',
      ),
      a && (a.recommendation !== 'approve' || a.suggestedHeadline)
        ? h(
            'p',
            { class: `audit-hint ${a.recommendation}` },
            h('span', { class: `rec ${a.recommendation}` }, RECOMMENDATION_LABELS[a.recommendation]),
            ' ',
            a.warnings.filter((w) => !['SECONDARY_REPORTING', 'THEME_CLUSTER', 'SPOILER_MINOR', 'RESEARCH_FLAG', 'LEGAL_OUTCOME_UNKNOWN', 'VIOLENCE_MILD'].includes(w.code)).map((w) => w.message)[0] ?? '',
            a.suggestedHeadline ? h('span', { class: 'sugg' }, ` Suggested: “${a.suggestedHeadline}”`) : null,
          )
        : null,
      h('div', { class: 'actions' }, btn('approve', 'approved', 'Approve', 'A'), btn('investigate', 'investigate', 'Investigate', 'I'), btn('reject', 'rejected', 'Reject', 'R')),
    ].filter(Boolean),
  );
}

async function act(action) {
  const id = state.current;
  if (!id || state.busy) return;
  state.busy = true;
  try {
    await api(`/api/questions/${encodeURIComponent(id)}/${action}`, {});
    toast({ approve: 'Approved', investigate: 'Marked for investigation', reject: 'Rejected' }[action]);
    state.busy = false;
    await refresh(true);
  } catch (err) {
    state.busy = false;
    toast(err.message, 'err');
    renderCard();
  }
}

/** Reload counts + list; after a decision, move on to the next unreviewed question. */
async function refresh(advance) {
  await Promise.all([loadSummary(), loadItems()]);
  if (advance) {
    const next = nextUnreviewed(visible(), state.current) ?? nextUnreviewed(state.items, state.current);
    if (next) {
      state.current = next;
      prefs.set('current', next);
    } else toast('All questions in this view have a decision.');
  }
  render();
  await loadDetail();
}

// ---------------------------------------------------------------------------
// Exports + wiring
// ---------------------------------------------------------------------------

async function download(kind) {
  try {
    const res = await fetch(`/api/export/${kind}`, { headers: { 'x-review-token': TOKEN } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `review-${kind}.json`;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${name}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function step(n) {
  const id = neighbour(visible(), state.current, n);
  if (id) openItem(id);
}

function bind() {
  bindFilters();
  $('v-review').addEventListener('click', () => setView('review'));
  $('v-list').addEventListener('click', () => setView('list'));
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('next-unreviewed').addEventListener('click', () => {
    const id = nextUnreviewed(visible(), state.current);
    if (id) openItem(id);
    else toast('No unreviewed questions in this view.');
  });
  for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', () => download(b.dataset.export));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
    if (state.view !== 'review') return;
    const k = e.key.toLowerCase();
    if (k === 'a') act('approve');
    if (k === 'i') act('investigate');
    if (k === 'r') act('reject');
  });
}

async function boot() {
  bind();
  try {
    await Promise.all([loadSummary(), loadItems()]);
    const vis = visible();
    if (!vis.some((it) => it.eventId === state.current)) state.current = nextUnreviewed(vis, null) ?? vis[0]?.eventId ?? null;
    setView(state.view === 'list' ? 'list' : 'review');
  } catch (e) {
    $('card').replaceChildren(h('p', { class: 'empty' }, `Cannot load: ${e.message}`));
  }
}

boot();
