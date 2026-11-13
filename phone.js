// Phone page: today's ticks + each day's plan, talking to the Weekly app on the PC (app/phone.py).
import { WEEKDAYS, todayKey, weekdayOf, parseKey, dayItems, formatTime, needsSnapshot,
  templateSlots, streakFor, sortSlots } from './shared/model.js';

const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const el = id => document.getElementById(id);

// ---- where the PC is -------------------------------------------------------------
// Served by the PC itself (home Wi-Fi / tunnel): same origin. Served from the permanent page
// on GitHub Pages: the PC's current tunnel address is in backend.json, which the PC rewrites
// after every restart (app/tunnel.py).
const ON_PAGES = location.hostname.endsWith('github.io');
const BACKEND_JSON = 'https://api.github.com/repos/kcjugran/weekly/contents/backend.json';
const TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;   // the token only ever goes here

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } },
};
let base = ON_PAGES ? store.get('weekly-api') : '';
let token = store.get('weekly-session');

async function findBackend() {
  const r = await fetch(BACKEND_JSON, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error('lookup');
  const api = String((await r.json()).api || '');
  if (!TUNNEL_RE.test(api)) throw new Error('bad address');
  base = api;
  store.set('weekly-api', api);
}

let data = null;
let view = 'today';   // 'today' or a weekday ('mon'...)

function banner(text) {
  el('banner').textContent = text || '';
  el('banner').hidden = !text;
}

const OFFLINE = "Can't reach your PC. Is it on, with Weekly running?";

async function send(path, body) {
  if (ON_PAGES && !base) await findBackend();
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
}

/** One API call. Re-looks-up the PC's address once if it moved (PC restarted). */
async function call(path, body, { quiet = false } = {}) {
  let r;
  try {
    try { r = await send(path, body); }
    catch (e) {
      if (!ON_PAGES) throw e;
      await findBackend();
      r = await send(path, body);
    }
  } catch {
    banner(OFFLINE);
    throw new Error('offline');
  }
  if (r.status === 401 && !quiet) { showGate('login'); throw new Error('login'); }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (!quiet) banner(`Could not save: ${json.error || r.status}`);
    const err = new Error(json.error || String(r.status));
    err.status = r.status;
    throw err;
  }
  banner('');
  return json;
}

// ---- login (ID + password, remembered on this phone) ----------------------------
let gateMode = 'login';
function showGate(mode) {
  gateMode = mode;
  const setup = mode === 'setup';
  el('gate-title').textContent = setup ? 'Create login' : 'Log in';
  el('gate-btn').textContent = setup ? 'Create' : 'Log in';
  el('gate-switch').textContent = setup ? 'Have a login? Log in' : 'First time? Create login';
  el('g-pass').autocomplete = setup ? 'new-password' : 'current-password';
  el('setup-only').hidden = !setup;
  el('g-key').required = setup;
  el('gate-msg').textContent = '';
  el('gate').hidden = false;
  el('logout').hidden = true;
}
el('gate-switch').addEventListener('click', () => showGate(gateMode === 'setup' ? 'login' : 'setup'));
el('gate').addEventListener('submit', async e => {
  e.preventDefault();
  const setup = gateMode === 'setup';
  const body = { user: el('g-user').value.trim(), password: el('g-pass').value };
  if (setup) body.key = el('g-key').value.trim();
  el('gate-btn').disabled = true;
  el('gate-msg').textContent = '';
  try {
    const r = await call(setup ? '/api/setup' : '/api/login', body, { quiet: true });
    token = r.token;
    store.set('weekly-session', token);
    el('g-pass').value = '';
    el('g-key').value = '';
    el('gate').hidden = true;
    el('logout').hidden = false;
    await load();
  } catch (err) {
    el('gate-msg').textContent = err.message === 'offline' ? OFFLINE : err.message;
  }
  el('gate-btn').disabled = false;
});
el('logout').addEventListener('click', async () => {
  try { await call('/api/logout', {}, { quiet: true }); } catch { /* logged out here anyway */ }
  token = '';
  store.set('weekly-session', '');
  data = null;
  showGate('login');
});

// ---- rendering ------------------------------------------------------------------
function renderTabs() {
  const tabs = el('tabs');
  tabs.replaceChildren();
  const today = weekdayOf(todayKey());
  for (const v of ['today', ...WEEKDAYS]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (v === today ? ' is-today' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v === view));
    b.textContent = v === 'today' ? 'Today' : v;
    b.addEventListener('click', () => { view = v; render(); });
    tabs.append(b);
  }
}

function fillTime(row, hhmm) {
  const t = formatTime(hhmm);
  row.querySelector('.hm').textContent = t.hm;
  row.querySelector('.ap').textContent = t.ap;
  return t;
}

function renderToday() {
  const k = todayKey();
  const items = dayItems(data.days[k], data.template, data.activities, k, k);
  const d = parseKey(k);
  el('title').textContent = d.toLocaleDateString('en-GB', { weekday: 'long' });
  el('sub').textContent = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const counted = items.filter(i => !i.skipped);
  const done = counted.filter(i => i.done).length;
  el('count').textContent = counted.length ? `${done}/${counted.length}` : '';
  el('bar').style.transform = `scaleX(${counted.length ? done / counted.length : 0})`;

  const list = el('list');
  list.replaceChildren();
  el('empty').hidden = items.length > 0;
  el('empty').textContent = `Nothing planned today. Add some on the ${DAY_NAMES[weekdayOf(k)].slice(0, 3)} tab.`;
  const nextId = (items.find(i => !i.done && !i.skipped) || {}).slotId;
  for (const item of items) {
    const row = el('tick-tpl').content.firstElementChild.cloneNode(true);
    const hit = row.querySelector('.hit');
    const t = fillTime(row, item.time);
    row.querySelector('.name').textContent = item.name;
    const streak = streakFor(item.activityId, data, k);
    row.querySelector('.n').textContent = streak;
    row.querySelector('.streak').classList.toggle('zero', streak === 0);
    hit.setAttribute('aria-checked', String(item.done));
    hit.setAttribute('aria-label', `${t.hm} ${t.ap} ${item.name}`);
    row.classList.toggle('next', item.slotId === nextId);
    hit.addEventListener('click', () => toggle(item));
    list.append(row);
  }
}

function renderPlan(wd) {
  const slots = sortSlots(data.template.days[wd] || []);
  el('title').textContent = DAY_NAMES[wd];
  el('sub').textContent = 'Every week';
  el('count').textContent = slots.length ? String(slots.length) : '';
  el('bar').style.transform = 'scaleX(0)';
  const list = el('list');
  list.replaceChildren();
  el('empty').hidden = slots.length > 0;
  el('empty').textContent = 'Nothing planned. Add the first one below.';
  for (const s of slots) {
    const row = el('plan-tpl').content.firstElementChild.cloneNode(true);
    fillTime(row, s.time);
    const name = (data.activities[s.activityId] || {}).name || 'Removed activity';
    row.querySelector('.name').textContent = name;
    row.querySelector('.del').setAttribute('aria-label', `Remove ${name}`);
    row.querySelector('.del').addEventListener('click', () => remove(wd, s.slotId, name));
    list.append(row);
  }
  // Suggested time: an hour after the last one (the editor's rule).
  const last = slots.length ? slots[slots.length - 1].time : null;
  if (!el('add-time').dataset.touched) {
    el('add-time').value = last
      ? `${String(Math.min(+last.slice(0, 2) + 1, 23)).padStart(2, '0')}:${last.slice(3)}`
      : '09:00';
  }
  const names = el('names');
  names.replaceChildren();
  for (const n of [...new Set(Object.values(data.activities).map(a => a.name))].sort()) {
    const o = document.createElement('option');
    o.value = n;
    names.append(o);
  }
}

function render() {
  if (!data) return;
  renderTabs();
  el('add').hidden = view === 'today';
  if (view === 'today') renderToday(); else renderPlan(view);
}

// ---- actions --------------------------------------------------------------------
async function load() {
  if (!token) return;
  try { data = await call('/api/data'); } catch { return; }
  el('logout').hidden = false;
  // Same as the widget: keep today's copy of the plan so later edits never rewrite history.
  const k = todayKey();
  if (needsSnapshot(data.days[k], data.template, k, k)) {
    const slots = templateSlots(data.template, k);
    data.days[k] = { ...(data.days[k] || {}), slots };
    call('/api/slots', { key: k, slots }).catch(() => {});
  }
  render();
}

async function toggle(item) {
  const k = todayKey();
  const done = !item.done;
  const day = data.days[k] || {};
  const ticks = { ...(day.ticks || {}) };
  if (done) ticks[item.slotId] = true; else delete ticks[item.slotId];
  data.days[k] = { ...day, ticks };
  render();   // optimistic
  try { data = await call('/api/tick', { key: k, slotId: item.slotId, done }); render(); }
  catch { load(); }
}

async function remove(wd, slotId, name) {
  if (!confirm(`Remove "${name}" from ${DAY_NAMES[wd]}?`)) return;
  data.template.days[wd] = (data.template.days[wd] || []).filter(s => s.slotId !== slotId);
  render();
  try { data = await call('/api/remove', { weekday: wd, slotId }); render(); }
  catch { load(); }
}

el('add-time').addEventListener('input', () => { el('add-time').dataset.touched = '1'; });
el('add').addEventListener('submit', async e => {
  e.preventDefault();
  const name = el('add-name').value.trim();
  const time = el('add-time').value;
  if (!name || !/^\d\d:\d\d$/.test(time) || view === 'today') return;
  const btn = el('add').querySelector('button');
  btn.disabled = true;
  try {
    data = await call('/api/add', { weekday: view, time, name });
    el('add-name').value = '';
    delete el('add-time').dataset.touched;
    render();
  } catch { /* banner says why; the typed text stays */ }
  btn.disabled = false;
});

// Fresh data whenever the page comes back, and every minute while it's open.
const refresh = () => { if (!document.hidden && el('gate').hidden) load(); };
document.addEventListener('visibilitychange', refresh);
setInterval(refresh, 60_000);

async function boot() {
  if (token) return load();
  try {
    const s = await call('/api/status', null, { quiet: true });
    showGate(s.login ? 'login' : 'setup');
  } catch { showGate('login'); }
}
boot();
