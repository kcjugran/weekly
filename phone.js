// Phone page: today's ticks + each day's plan, talking to the Weekly app on the PC (app/phone.py).
import { WEEKDAYS, todayKey, weekdayOf, parseKey, dayItems, formatTime, needsSnapshot,
  templateSlots, streakFor, sortSlots, resolveActivity } from './shared/model.js';

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

let lastLookup = 0;
async function findBackend() {
  // The PC's address only changes when it restarts; don't spend GitHub's 60/hour lookups
  // re-asking every minute while it's off.
  if (base && Date.now() - lastLookup < 90_000) throw new Error('looked up recently');
  lastLookup = Date.now();
  const r = await fetch(BACKEND_JSON, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error('lookup');
  const api = String((await r.json()).api || '');
  if (!TUNNEL_RE.test(api)) throw new Error('bad address');
  base = api;
  store.set('weekly-api', api);
}

let data = null;
let view = 'today';   // 'today' or a weekday ('mon'...)

// ---- working while the PC is off -------------------------------------------------
// The last data seen is kept on the phone, so the page still shows (and edits) the week.
// Changes the PC can't take right now wait in an outbox here and go out, in order, the next
// time the PC answers. Every change is safe to send twice (tick = set, add carries its own
// slotId, remove of a gone slot is a no-op), so a reply lost mid-send costs nothing.
const OUTBOX = 'weekly-outbox';
const CACHE = 'weekly-data';
const outbox = {
  list() { try { return JSON.parse(store.get(OUTBOX) || '[]'); } catch { return []; } },
  save(list) { store.set(OUTBOX, list.length ? JSON.stringify(list) : ''); },
};
function keep() { if (data) store.set(CACHE, JSON.stringify(data)); }
try { data = JSON.parse(store.get(CACHE) || 'null'); } catch { data = null; }

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))]   // randomUUID needs https
  .map(b => b.toString(16).padStart(2, '0')).join('');
const norm = name => name.trim().replace(/\s+/g, ' ').toLowerCase();

function banner(text) {
  el('banner').textContent = text || '';
  el('banner').hidden = !text;
}

const OFFLINE = "Can't reach your PC. Is it on, with Weekly running?";
// Cloudflare answers for a PC that's gone with 502-530 (and no CORS header, so a fetch error).
const PC_GONE = s => s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);

function showPending() {
  const n = outbox.list().length;
  if (n) banner(`PC is offline. ${n} change${n === 1 ? '' : 's'} saved on this phone, sent when it's back.`);
}

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
    r = null;
  }
  if (!r || PC_GONE(r.status)) {
    banner(OFFLINE);
    const err = new Error('offline');
    err.offline = true;
    throw err;
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

/** Send a change now, or keep it for later if the PC is off. The screen already shows it. */
async function write(path, body) {
  keep();
  if (outbox.list().length) {           // older changes are still waiting: stay behind them
    outbox.save([...outbox.list(), { path, body }]);
    showPending();
    flush().then(afterFlush);
    return;
  }
  try {
    data = await call(path, body);
    keep();
    render();
  } catch (e) {
    if (e.offline) { outbox.save([{ path, body }]); showPending(); }
    else if (e.message !== 'login') load();   // the PC refused it: show what it really has
  }
}

let flushing = null;
/** Send the waiting changes, oldest first. Stops at the first one the PC can't take yet. */
function flush() {
  if (!flushing) {
    flushing = (async () => {
      while (outbox.list().length) {
        const [op] = outbox.list();
        try {
          await call(op.path, op.body, { quiet: true });
        } catch (e) {
          if (e.status === 401) { showGate('login'); break; }
          if (e.offline || e.status === 429 || e.status >= 500) break;   // keep it for next time
          // any other 4xx: the PC refused this one change for good; drop it so the rest can go
        }
        const rest = outbox.list();
        rest.shift();
        outbox.save(rest);
      }
    })().finally(() => { flushing = null; });
  }
  return flushing;
}
async function afterFlush() {
  if (outbox.list().length) { showPending(); return; }
  await load();
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
  store.set(CACHE, '');
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
    b.textContent = v === 'today' ? 'Today' : v[0];   // M T W T F S S: all fit, no sideways scroll
    if (v !== 'today') b.setAttribute('aria-label', DAY_NAMES[v]);
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
    const more = row.querySelector('.more');
    more.setAttribute('aria-label', `Edit ${item.name}`);
    more.addEventListener('click', () => openEdit(weekdayOf(k), item.slotId));
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
    row.querySelector('.open').setAttribute('aria-label', `Edit ${name}`);
    row.querySelector('.open').addEventListener('click', () => openEdit(wd, s.slotId));
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
  renderChips(wd);
}

// One tap adds a quick pick to this day; the last chip opens the list to change them.
function renderChips(wd) {
  const chips = el('chips');
  chips.replaceChildren();
  for (const p of [...presets()].sort((a, b) => a.time.localeCompare(b.time))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    const t = formatTime(p.time);
    const name = document.createElement('span');
    name.textContent = p.name;
    const time = document.createElement('span');
    time.className = 'chip-time';
    time.textContent = `${t.hm}${t.ap === 'AM' ? 'a' : 'p'}`;
    b.append('+ ', name, time);
    b.setAttribute('aria-label', `Add ${p.name} at ${t.hm} ${t.ap} to ${DAY_NAMES[wd]}`);
    b.addEventListener('click', () => addSlot(wd, p.time, p.name));
    chips.append(b);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'chip chip-edit';
  edit.textContent = presets().length ? 'Edit picks' : '+ Quick picks';
  edit.addEventListener('click', openPicks);
  chips.append(edit);
}

function renderNames() {
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
  renderNames();
  el('add').hidden = view === 'today';
  el('chips').hidden = view === 'today';
  if (view === 'today') renderToday(); else renderPlan(view);
}

// ---- actions --------------------------------------------------------------------
async function load() {
  if (!token) return;
  await flush();
  if (outbox.list().length) { render(); showPending(); return; }   // PC still off: keep local copy
  try { data = await call('/api/data'); } catch { render(); return; }
  keep();
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
  render();   // show it now; saving follows
  await write('/api/tick', { key: k, slotId: item.slotId, done });
}

async function remove(wd, slotId, name) {
  if (!confirm(`Remove "${name}" from every ${DAY_NAMES[wd]}?`)) return;
  data.template.days[wd] = (data.template.days[wd] || []).filter(s => s.slotId !== slotId);
  render();
  await write('/api/remove', { weekday: wd, slotId });
}

el('add-time').addEventListener('input', () => { el('add-time').dataset.touched = '1'; });
function flash(text) {
  banner(text);
  setTimeout(() => { if (el('banner').textContent === text) { banner(''); showPending(); } }, 2200);
}

async function addSlot(wd, time, name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!data || !name || !/^\d\d:\d\d$/.test(time)) return;
  // Same name = same activity (shared streak); the PC makes the same call when it gets this.
  let activityId = Object.keys(data.activities).find(id => norm(data.activities[id].name) === norm(name));
  const day = data.template.days[wd] = data.template.days[wd] || [];
  if (activityId && day.some(s => s.activityId === activityId && s.time === time)) {
    flash(`${name} is already on ${DAY_NAMES[wd]} at that time`);
    return;
  }
  if (!activityId) { activityId = newId(); data.activities[activityId] = { name }; }
  const slotId = newId();
  day.push({ slotId, activityId, time });
  render();
  await write('/api/add', { weekday: wd, time, name, slotId });
}

el('add').addEventListener('submit', async e => {
  e.preventDefault();
  if (view === 'today') return;
  const name = el('add-name').value;
  const time = el('add-time').value;
  el('add-name').value = '';
  delete el('add-time').dataset.touched;
  await addSlot(view, time, name);
});

// ---- edit one activity (that weekday, every week) ---------------------------------
let editing = null;   // { wd, slotId }
function openEdit(wd, slotId) {
  const slot = (data.template.days[wd] || []).find(s => s.slotId === slotId);
  if (!slot) return;
  editing = { wd, slotId };
  el('edit-sub').textContent = `Every ${DAY_NAMES[wd]}`;
  el('edit-time').value = slot.time;
  el('edit-name').value = (data.activities[slot.activityId] || {}).name || '';
  el('edit').hidden = false;
}
function closeEdit() { editing = null; el('edit').hidden = true; }
el('edit-cancel').addEventListener('click', closeEdit);
el('edit').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editing) return;
  const { wd, slotId } = editing;
  const name = el('edit-name').value.trim().replace(/\s+/g, ' ');
  const time = el('edit-time').value;
  if (!name || !/^\d\d:\d\d$/.test(time)) return;
  closeEdit();
  const slot = (data.template.days[wd] || []).find(s => s.slotId === slotId);
  if (!slot) return;
  // Shown now with the editor's own naming rule; the PC applies the same rule when it saves.
  const r = resolveActivity(data.activities, data.template, slotId, name, newId());
  data.activities = r.activities;
  slot.activityId = r.activityId;
  slot.time = time;
  render();
  await write('/api/edit', { weekday: wd, slotId, time, name });
});
el('edit-delete').addEventListener('click', () => {
  if (!editing) return;
  const { wd, slotId } = editing;
  const slot = (data.template.days[wd] || []).find(s => s.slotId === slotId);
  const name = slot ? (data.activities[slot.activityId] || {}).name || '' : '';
  closeEdit();
  remove(wd, slotId, name);
});

// ---- quick picks ------------------------------------------------------------------
const presets = () => (data && Array.isArray(data.presets) ? data.presets : []);
function renderPicks() {
  const list = el('picks-list');
  list.replaceChildren();
  for (const p of [...presets()].sort((a, b) => a.time.localeCompare(b.time))) {
    const row = el('plan-tpl').content.firstElementChild.cloneNode(true);
    fillTime(row, p.time);
    row.querySelector('.name').textContent = p.name;
    row.querySelector('.open').disabled = true;
    row.querySelector('.del').setAttribute('aria-label', `Remove ${p.name} from quick picks`);
    row.querySelector('.del').addEventListener('click', () => savePicks(presets().filter(x => x !== p)));
    list.append(row);
  }
}
function openPicks() { renderPicks(); el('picks').hidden = false; }
el('picks-done').addEventListener('click', () => { el('picks').hidden = true; render(); });
async function savePicks(list) {
  data.presets = list;
  renderPicks();
  render();
  await write('/api/presets', { presets: list });
}
el('picks-add').addEventListener('submit', e => {
  e.preventDefault();
  const typed = el('picks-name').value.trim().replace(/\s+/g, ' ');
  const time = el('picks-time').value;
  if (!typed || !/^\d\d:\d\d$/.test(time)) return;
  // "gym" picks your existing "Gym", spelled the way you first wrote it.
  const known = Object.values(data.activities).find(a => norm(a.name) === norm(typed));
  const name = known ? known.name : typed;
  if (presets().length >= 30) { flash('30 quick picks is the most'); return; }
  el('picks-name').value = '';
  // One pick per name: adding Gym again just changes its time.
  savePicks([...presets().filter(p => norm(p.name) !== norm(name)), { name, time }]);
});

// Fresh data whenever the page comes back, and every minute while it's open.
const refresh = () => { if (!document.hidden && el('gate').hidden) load(); };
document.addEventListener('visibilitychange', refresh);
setInterval(refresh, 60_000);

async function boot() {
  if (token) { if (data) { render(); el('logout').hidden = false; } return load(); }
  try {
    const s = await call('/api/status', null, { quiet: true });
    showGate(s.login ? 'login' : 'setup');
  } catch { showGate('login'); }
}
boot();
