import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/modular/sortable.esm.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, ENABLE_GOOGLE_LOGIN } from '../config.js?v=2';

/* =========================================================
   Constants
   ========================================================= */
const STATUSES = [
  { key: 'todo', label: 'לא התחיל' },
  { key: 'in_progress', label: 'בתהליך' },
  { key: 'waiting', label: 'ממתין' },
  { key: 'done', label: 'הושלם' },
];
const PRIORITIES = [
  { key: 'urgent', label: 'דחוף' },
  { key: 'high', label: 'חשוב' },
  { key: 'medium', label: 'בינוני' },
  { key: 'low', label: 'נמוך' },
];
const GROUPS = [
  { key: 'bucket', label: 'דליים' },
  { key: 'status', label: 'התקדמות' },
  { key: 'assignee', label: 'אחראי' },
  { key: 'priority', label: 'עדיפות' },
];
const COLORS = ['#4f46e5', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#7c3aed', '#475569'];
const AVATAR_COLORS = ['#4f46e5', '#0891b2', '#16a34a', '#ea580c', '#db2777', '#7c3aed', '#ca8a04', '#2563eb'];
const NONE = '__none__';

/* =========================================================
   State
   ========================================================= */
const S = {
  me: null,               // profile
  projects: [],           // [{id,name,color,...}]
  members: {},            // projectId -> [{user_id, role, profile}]
  route: { view: 'my' },  // {view:'my'} | {view:'project', id}
  buckets: [],
  tasks: [],
  groupBy: load('groupBy', 'bucket'),
  showDone: load('showDone', false),
  myShowDone: false,
  openDone: {},           // column key -> bool
  openTaskId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const modalRoot = $('#modal-root');

function load(k, d) { try { const v = localStorage.getItem('mesimot.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem('mesimot.' + k, JSON.stringify(v)); } catch {} }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), isErr ? 4500 : 2500);
}
function fail(error) { console.error(error); toast('שגיאה: ' + (error?.message || error), true); }

/* =========================================================
   Supabase
   ========================================================= */
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  app.innerHTML = `<div class="auth"><div class="auth-card">
    <h1><img src="assets/icon.svg" alt="">משימות</h1>
    <p>האפליקציה עוד לא מחוברת למסד נתונים. יש למלא את <code>SUPABASE_URL</code> ו-<code>SUPABASE_ANON_KEY</code> בקובץ <code>config.js</code>.</p>
  </div></div>`;
  throw new Error('Missing Supabase config');
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* =========================================================
   Helpers
   ========================================================= */
const todayStr = () => new Date().toLocaleDateString('en-CA');
function dueInfo(t) {
  if (!t.due_date) return null;
  const today = todayStr();
  const d = new Date(t.due_date + 'T00:00:00');
  const label = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
  if (t.status !== 'done' && t.due_date < today) return { label, cls: 'overdue' };
  if (t.status !== 'done' && t.due_date === today) return { label: 'היום', cls: 'today' };
  return { label, cls: '' };
}
function profileOf(userId) {
  for (const list of Object.values(S.members)) {
    const m = list.find(m => m.user_id === userId);
    if (m) return m.profile;
  }
  return S.me?.id === userId ? S.me : null;
}
function displayName(p) { return p ? (p.full_name || p.email.split('@')[0]) : 'לא משויך'; }
function avatar(p, cls = '') {
  if (!p) return `<span class="avatar ${cls}" style="background:#cbd2e1" title="לא משויך">?</span>`;
  const name = displayName(p);
  const color = AVATAR_COLORS[[...p.id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const inner = p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="" referrerpolicy="no-referrer">` : esc(name.trim().slice(0, 1).toUpperCase());
  return `<span class="avatar ${cls}" style="background:${color}" title="${esc(name)}">${inner}</span>`;
}
function projectById(id) { return S.projects.find(p => p.id === id); }
function isOwner(projectId) { return (S.members[projectId] || []).some(m => m.user_id === S.me.id && m.role === 'owner'); }
function posBetween(before, after) {
  if (before == null && after == null) return 1000;
  if (before == null) return after - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* =========================================================
   Auth
   ========================================================= */
function renderLogin(sent = false, email = '') {
  app.innerHTML = `<div class="auth"><div class="auth-card">
    <h1><img src="assets/icon.svg" alt="">משימות</h1>
    ${sent ? `<p>שלחנו קישור כניסה ל-<b>${esc(email)}</b>.<br>פתח את המייל ולחץ על הקישור.</p>
      <button class="btn ghost" id="back">שימוש במייל אחר</button>`
    : `<p>ניהול משימות לפרויקטים, לקוחות ושותפים.</p>
      <form id="login" style="display:grid;gap:10px">
        <input class="input" type="email" name="email" placeholder="כתובת מייל" required autocomplete="email" dir="ltr">
        <button class="btn primary" style="justify-content:center">שלחו לי קישור כניסה</button>
      </form>
      ${ENABLE_GOOGLE_LOGIN ? `<div class="divider">או</div>
      <button class="btn" id="google" style="justify-content:center">כניסה עם Google</button>` : ''}`}
  </div></div>`;
  $('#back')?.addEventListener('click', () => renderLogin());
  $('#google')?.addEventListener('click', () =>
    sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }));
  $('#login')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    e.submitter.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { e.submitter.disabled = false; return fail(error); }
    renderLogin(true, email);
  });
}

let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  if (session && !booted) { booted = true; setTimeout(() => boot(session), 0); }
  if (!session && event === 'SIGNED_OUT') { booted = false; S.me = null; renderLogin(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) renderLogin(); });

async function boot(session) {
  await sb.rpc('claim_invites').then(({ error }) => error && console.warn(error));
  const { data: me, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  if (error) return fail(error);
  S.me = me;
  if (!me.full_name && session.user.user_metadata?.full_name) {
    S.me.full_name = session.user.user_metadata.full_name;
    sb.from('profiles').update({ full_name: S.me.full_name }).eq('id', me.id).then(() => {});
  }
  await loadProjects();
  subscribeRealtime();
  window.addEventListener('hashchange', route);
  route();
  if (!S.me.full_name) setTimeout(openProfileModal, 400);
}

/* =========================================================
   Data loading
   ========================================================= */
async function loadProjects() {
  const [{ data: projects, error: e1 }, { data: members, error: e2 }] = await Promise.all([
    sb.from('projects').select('*').eq('archived', false).order('created_at'),
    sb.from('project_members').select('project_id, user_id, role, profile:profiles(id,email,full_name,avatar_url)'),
  ]);
  if (e1 || e2) return fail(e1 || e2);
  S.projects = projects;
  S.members = {};
  for (const m of members) (S.members[m.project_id] ||= []).push(m);
}

async function loadProjectData(id) {
  const [{ data: buckets, error: e1 }, { data: tasks, error: e2 }] = await Promise.all([
    sb.from('buckets').select('*').eq('project_id', id).order('position'),
    sb.from('tasks').select('*, checklist_items(id, done)').eq('project_id', id).order('position'),
  ]);
  if (e1 || e2) return fail(e1 || e2);
  S.buckets = buckets; S.tasks = tasks;
}

async function loadMyTasks() {
  const { data, error } = await sb.from('tasks').select('*, checklist_items(id, done)')
    .eq('assignee_id', S.me.id).order('due_date', { nullsFirst: false }).order('position');
  if (error) return fail(error);
  S.tasks = data;
}

/* =========================================================
   Routing & shell
   ========================================================= */
async function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m && projectById(m[1])) {
    S.route = { view: 'project', id: m[1] };
    await loadProjectData(m[1]);
  } else {
    S.route = { view: 'my' };
    if (location.hash && location.hash !== '#/my' && !location.hash.includes('access_token')) history.replaceState(null, '', '#/my');
    await loadMyTasks();
  }
  render();
}

function render() {
  const navOpen = $('.layout')?.classList.contains('nav-open');
  app.innerHTML = `<div class="layout">
    ${renderSidebar()}
    <main class="main">${S.route.view === 'project' ? renderProjectView() : renderMyView()}</main>
  </div>`;
  if (navOpen && window.innerWidth <= 820) $('.layout').classList.add('nav-open');
  if (S.route.view === 'project') wireBoard();
}

function renderSidebar() {
  const myOpen = S.route.view === 'my';
  return `<aside class="sidebar">
    <div class="brand"><img src="assets/icon.svg" alt="">משימות</div>
    <a class="nav-item ${myOpen ? 'active' : ''}" href="#/my">✓ המשימות שלי</a>
    <div class="nav-label">פרויקטים <button class="icon-btn" data-act="new-project" title="פרויקט חדש">＋</button></div>
    ${S.projects.map(p => `<a class="nav-item ${S.route.id === p.id ? 'active' : ''}" href="#/p/${p.id}">
        <span class="dot" style="background:${esc(p.color)}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
        <span class="count">${(S.members[p.id] || []).length > 1 ? '👥' : ''}</span></a>`).join('')}
    ${S.projects.length ? '' : `<button class="nav-item" data-act="new-project" style="color:var(--muted)">＋ פרויקט ראשון</button>`}
    <div class="sidebar-foot">
      ${avatar(S.me)}<div class="who" title="${esc(S.me.email)}">${esc(displayName(S.me))}</div>
      <button class="icon-btn" data-act="profile" title="פרופיל">⚙</button>
      <button class="btn ghost sm" data-act="logout">יציאה</button>
    </div>
  </aside>`;
}

/* =========================================================
   My tasks view
   ========================================================= */
function renderMyView() {
  const today = todayStr();
  const weekEnd = new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA');
  const open = S.tasks.filter(t => t.status !== 'done');
  const groups = [
    { key: 'overdue', label: 'באיחור', items: open.filter(t => t.due_date && t.due_date < today) },
    { key: 'today', label: 'היום', items: open.filter(t => t.due_date === today) },
    { key: 'week', label: 'בשבוע הקרוב', items: open.filter(t => t.due_date > today && t.due_date <= weekEnd) },
    { key: 'later', label: 'מאוחר יותר', items: open.filter(t => t.due_date > weekEnd) },
    { key: 'nodate', label: 'ללא תאריך', items: open.filter(t => !t.due_date) },
  ];
  if (S.myShowDone) groups.push({ key: 'done', label: 'הושלמו', items: S.tasks.filter(t => t.status === 'done').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).slice(0, 30) });
  const body = open.length || S.myShowDone
    ? groups.filter(g => g.items.length).map(g => `<section class="group ${g.key}">
        <h3>${g.label} <span class="n">${g.items.length}</span></h3>
        <div class="rows">${g.items.map(rowHtml).join('')}</div></section>`).join('')
    : `<div class="empty"><div class="big">🎉</div>אין משימות פתוחות שמשויכות אליך</div>`;
  return `<div class="topbar">
      <button class="icon-btn menu-btn" data-act="nav">☰</button>
      <h2>המשימות שלי</h2><div class="spacer"></div>
      <label class="check-inline"><input type="checkbox" data-act="my-done" ${S.myShowDone ? 'checked' : ''}> הצג שהושלמו</label>
    </div>
    <div class="list-view"><div class="list-wrap">${body}</div></div>`;
}

function rowHtml(t) {
  const p = projectById(t.project_id);
  const due = dueInfo(t);
  return `<div class="row ${t.status === 'done' ? 'is-done' : ''}" data-task="${t.id}">
    <button class="check ${t.status === 'done' ? 'on' : ''}" data-act="toggle-done" title="סמן כהושלם">✓</button>
    <span class="t">${esc(t.title)}</span>
    ${t.status === 'waiting' ? '<span class="chip">ממתין</span>' : ''}
    ${due ? `<span class="chip ${due.cls}">📅 ${esc(due.label)}</span>` : ''}
    ${p ? `<span class="chip proj"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>` : ''}
  </div>`;
}

/* =========================================================
   Project board view
   ========================================================= */
function columnsFor(project) {
  const tasks = S.tasks;
  const by = S.groupBy;
  if (by === 'status') return STATUSES.map(s => ({ key: s.key, label: s.label, items: tasks.filter(t => t.status === s.key), field: 'status' }));
  if (by === 'priority') return PRIORITIES.map(s => ({ key: s.key, label: s.label, items: tasks.filter(t => t.priority === s.key), field: 'priority' }));
  if (by === 'assignee') {
    const cols = [{ key: NONE, label: 'לא משויך', items: tasks.filter(t => !t.assignee_id), field: 'assignee_id' }];
    for (const m of S.members[project.id] || []) cols.push({ key: m.user_id, label: displayName(m.profile), profile: m.profile, items: tasks.filter(t => t.assignee_id === m.user_id), field: 'assignee_id' });
    return cols;
  }
  const cols = S.buckets.map(b => ({ key: b.id, label: b.name, bucket: b, items: tasks.filter(t => t.bucket_id === b.id), field: 'bucket_id' }));
  const orphan = tasks.filter(t => !t.bucket_id || !S.buckets.some(b => b.id === t.bucket_id));
  if (orphan.length) cols.unshift({ key: NONE, label: 'ללא דלי', items: orphan, field: 'bucket_id' });
  return cols;
}

function renderProjectView() {
  const p = projectById(S.route.id);
  const members = S.members[p.id] || [];
  const cols = columnsFor(p);
  return `<div class="topbar">
      <button class="icon-btn menu-btn" data-act="nav">☰</button>
      <h2><span class="dot" style="background:${esc(p.color)}"></span><span>${esc(p.name)}</span></h2>
      <button class="icon-btn" data-act="project-settings" title="הגדרות פרויקט">⋯</button>
      <div class="spacer"></div>
      <div class="toolbar">
        <button class="btn ghost sm" data-act="members" title="חברים בפרויקט">
          <span class="avatars">${members.slice(0, 4).map(m => avatar(m.profile, 'sm')).join('')}</span>
          ${isOwner(p.id) ? 'שיתוף' : ''}
        </button>
        <select class="input" data-act="group-by" aria-label="קיבוץ לפי">
          ${GROUPS.map(g => `<option value="${g.key}" ${S.groupBy === g.key ? 'selected' : ''}>קיבוץ: ${g.label}</option>`).join('')}
        </select>
        ${S.groupBy !== 'status' ? `<label class="check-inline"><input type="checkbox" data-act="show-done" ${S.showDone ? 'checked' : ''}> הושלמו</label>` : ''}
      </div>
    </div>
    <div class="board" id="board">
      ${cols.map(colHtml).join('')}
      ${S.groupBy === 'bucket' ? `<div class="new-col"><form data-form="new-bucket">
        <input class="input" name="name" placeholder="＋ דלי חדש" required>
      </form></div>` : ''}
    </div>`;
}

function colHtml(col) {
  const statusMode = S.groupBy === 'status';
  const open = statusMode ? col.items : col.items.filter(t => t.status !== 'done');
  const done = statusMode ? [] : col.items.filter(t => t.status === 'done');
  const byPos = (a, b) => a.position - b.position;
  const isBucket = !!col.bucket;
  const doneOpen = S.showDone && (S.openDone[col.key] ?? true);
  return `<section class="col" data-col="${col.key}" ${isBucket ? `data-bucket="${col.key}"` : ''}>
    <div class="col-head ${isBucket ? 'drag-handle' : ''}">
      ${col.profile ? avatar(col.profile, 'sm') : ''}
      <span class="title" ${isBucket ? 'data-act="rename-bucket"' : ''}>${esc(col.label)}</span>
      <span class="n">${open.length}</span>
      ${isBucket ? `<button class="icon-btn" data-act="bucket-menu" title="מחיקת דלי">🗑</button>` : ''}
    </div>
    <div class="add-task">
      <button class="btn sm open" data-act="add-open">＋ הוספת משימה</button>
      <form data-form="add-task" class="hidden">
        <input class="input" name="title" placeholder="שם המשימה" required autocomplete="off">
        <div style="display:flex;gap:6px"><button class="btn primary sm">הוספה</button>
        <button type="button" class="btn ghost sm" data-act="add-cancel">ביטול</button></div>
      </form>
    </div>
    <div class="col-body">
      <div class="card-list" data-list="${col.key}" data-field="${col.field}">${open.sort(byPos).map(cardHtml).join('')}</div>
      ${S.showDone && done.length ? `<button class="done-toggle" data-act="toggle-done-list">${doneOpen ? '▾' : '▸'} הושלמו (${done.length})</button>
        ${doneOpen ? `<div class="card-list done-list">${done.sort(byPos).map(cardHtml).join('')}</div>` : ''}` : ''}
    </div>
  </section>`;
}

function cardHtml(t) {
  const due = dueInfo(t);
  const items = t.checklist_items || [];
  const doneItems = items.filter(i => i.done).length;
  const assignee = t.assignee_id ? profileOf(t.assignee_id) : null;
  const pr = PRIORITIES.find(p => p.key === t.priority);
  return `<article class="card p-${t.priority} ${t.status === 'done' ? 'is-done' : ''}" data-task="${t.id}" data-pos="${t.position}">
    <div class="card-top">
      <button class="check ${t.status === 'done' ? 'on' : ''}" data-act="toggle-done" title="סמן כהושלם">✓</button>
      <div class="card-title">${esc(t.title)}</div>
    </div>
    <div class="card-meta">
      ${t.priority === 'urgent' || t.priority === 'high' ? `<span class="chip">${pr.label}</span>` : ''}
      ${S.groupBy !== 'status' && t.status !== 'todo' && t.status !== 'done' ? `<span class="chip">${STATUSES.find(s => s.key === t.status).label}</span>` : ''}
      ${due ? `<span class="chip ${due.cls}">📅 ${esc(due.label)}</span>` : ''}
      ${items.length ? `<span class="chip">☑ ${doneItems}/${items.length}</span>` : ''}
      ${t.description ? '<span title="יש תיאור">☰</span>' : ''}
      <span class="spacer"></span>
      ${assignee ? avatar(assignee, 'sm') : ''}
    </div>
  </article>`;
}

let sortables = [];
function wireBoard() {
  sortables.forEach(s => s.destroy()); sortables = [];
  for (const list of document.querySelectorAll('.card-list[data-list]')) {
    sortables.push(new Sortable(list, {
      group: 'tasks', animation: 150, delay: 180, delayOnTouchOnly: true, ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen', onEnd: onCardDrop,
    }));
  }
  const board = $('#board');
  if (S.groupBy === 'bucket' && board) {
    sortables.push(new Sortable(board, {
      animation: 150, handle: '.drag-handle', draggable: '.col[data-bucket]', delay: 180, delayOnTouchOnly: true,
      filter: '[contenteditable="true"], button', preventOnFilter: false, onEnd: onBucketDrop,
    }));
  }
}

async function onCardDrop(evt) {
  const el = evt.item;
  const id = el.dataset.task;
  const task = S.tasks.find(t => t.id === id);
  const list = evt.to;
  const field = list.dataset.field;
  const raw = list.dataset.list;
  const value = raw === NONE ? null : raw;
  const prev = el.previousElementSibling, next = el.nextElementSibling;
  const position = posBetween(prev ? +prev.dataset.pos : null, next ? +next.dataset.pos : null);
  const patch = { position };
  if (task[field] !== value && !(field === 'bucket_id' && value === null && evt.from === evt.to)) patch[field] = value;
  if (field === 'status' && value === null) delete patch.status;
  Object.assign(task, patch);
  el.dataset.pos = position;
  await updateTask(id, patch, false);
  render();
}

async function onBucketDrop(evt) {
  const cols = [...document.querySelectorAll('.col[data-bucket]')];
  const i = cols.findIndex(c => c === evt.item);
  const prev = cols[i - 1] ? S.buckets.find(b => b.id === cols[i - 1].dataset.bucket) : null;
  const next = cols[i + 1] ? S.buckets.find(b => b.id === cols[i + 1].dataset.bucket) : null;
  const b = S.buckets.find(b => b.id === evt.item.dataset.bucket);
  b.position = posBetween(prev?.position ?? null, next?.position ?? null);
  S.buckets.sort((a, b) => a.position - b.position);
  const { error } = await sb.from('buckets').update({ position: b.position }).eq('id', b.id);
  if (error) fail(error);
}

/* =========================================================
   Mutations
   ========================================================= */
async function updateTask(id, patch, rerender = true) {
  const t = S.tasks.find(t => t.id === id);
  if (t) Object.assign(t, patch);
  if (rerender) render();
  const { error } = await sb.from('tasks').update(patch).eq('id', id);
  if (error) fail(error);
}

async function toggleDone(id) {
  const t = S.tasks.find(t => t.id === id);
  if (!t) return;
  const status = t.status === 'done' ? 'todo' : 'done';
  await updateTask(id, { status });
  if (status === 'done') toast('✓ סומן כהושלם');
}

async function addTask(col, title) {
  const project = S.route.id;
  const sameCol = S.tasks.filter(t => (t[col.field] ?? NONE) === col.key && t.status !== 'done');
  const minPos = sameCol.length ? Math.min(...sameCol.map(t => t.position)) : 2000;
  const row = { project_id: project, title, position: minPos - 1000 };
  if (col.key !== NONE) row[col.field] = col.key;
  if (col.field !== 'bucket_id') row.bucket_id = S.buckets[0]?.id ?? null;
  const { data, error } = await sb.from('tasks').insert(row).select('*, checklist_items(id, done)').single();
  if (error) return fail(error);
  S.tasks.push(data);
  render();
  const form = document.querySelector(`.col[data-col="${CSS.escape(col.key)}"] form[data-form="add-task"]`);
  if (form) { form.classList.remove('hidden'); form.previousElementSibling.classList.add('hidden'); form.title.focus(); }
}

/* =========================================================
   Events
   ========================================================= */
app.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const card = e.target.closest('[data-task]');
  if (act === 'nav') return $('.layout').classList.toggle('nav-open');
  if (e.target.closest('.layout.nav-open') && !e.target.closest('.sidebar') && window.innerWidth <= 820) {
    $('.layout').classList.remove('nav-open'); return;
  }
  if (e.target.closest('.sidebar a.nav-item')) $('.layout').classList.remove('nav-open');
  switch (act) {
    case 'new-project': return openProjectModal();
    case 'project-settings': return openProjectModal(projectById(S.route.id));
    case 'members': return openMembersModal(S.route.id);
    case 'profile': return openProfileModal();
    case 'logout': return sb.auth.signOut();
    case 'toggle-done': e.stopPropagation(); return toggleDone(card.dataset.task);
    case 'add-open': {
      const wrap = e.target.closest('.add-task');
      wrap.querySelector('.open').classList.add('hidden');
      const f = wrap.querySelector('form'); f.classList.remove('hidden'); f.title.focus(); return;
    }
    case 'add-cancel': {
      const wrap = e.target.closest('.add-task');
      wrap.querySelector('form').classList.add('hidden'); wrap.querySelector('.open').classList.remove('hidden'); return;
    }
    case 'toggle-done-list': {
      const key = e.target.closest('.col').dataset.col;
      S.openDone[key] = !(S.openDone[key] ?? true); return render();
    }
    case 'rename-bucket': return startRenameBucket(e.target.closest('.title'));
    case 'bucket-menu': return deleteBucket(e.target.closest('.col').dataset.bucket);
  }
  if (card && !e.target.closest('button, input')) openTaskModal(card.dataset.task);
});

app.addEventListener('change', e => {
  const act = e.target.dataset.act;
  if (act === 'group-by') { S.groupBy = e.target.value; save('groupBy', S.groupBy); render(); }
  if (act === 'show-done') { S.showDone = e.target.checked; save('showDone', S.showDone); render(); }
  if (act === 'my-done') { S.myShowDone = e.target.checked; render(); }
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.dataset.form === 'add-task') {
    const title = f.title.value.trim(); if (!title) return;
    const key = f.closest('.col').dataset.col;
    const col = columnsFor(projectById(S.route.id)).find(c => c.key === key);
    f.title.value = '';
    return addTask(col, title);
  }
  if (f.dataset.form === 'new-bucket') {
    const name = f.name.value.trim(); if (!name) return;
    const pos = (S.buckets.at(-1)?.position ?? 0) + 1000;
    const { data, error } = await sb.from('buckets').insert({ project_id: S.route.id, name, position: pos }).select().single();
    if (error) return fail(error);
    S.buckets.push(data); render();
    $('form[data-form="new-bucket"] input')?.focus();
  }
});

app.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.closest('form[data-form="add-task"]')) {
    const wrap = e.target.closest('.add-task');
    wrap.querySelector('form').classList.add('hidden'); wrap.querySelector('.open').classList.remove('hidden');
  }
});

function startRenameBucket(el) {
  if (el.isContentEditable) return;
  const id = el.closest('.col').dataset.bucket;
  const old = el.textContent;
  el.contentEditable = 'true'; el.focus();
  document.getSelection().selectAllChildren(el);
  const finish = async (commit) => {
    el.contentEditable = 'false';
    const name = el.textContent.trim();
    if (!commit || !name || name === old) { el.textContent = old; return; }
    const b = S.buckets.find(b => b.id === id); b.name = name;
    const { error } = await sb.from('buckets').update({ name }).eq('id', id);
    if (error) fail(error);
  };
  el.addEventListener('blur', () => finish(true), { once: true });
  el.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
    if (ev.key === 'Escape') { el.textContent = old; el.blur(); }
  });
}

async function deleteBucket(id) {
  const b = S.buckets.find(b => b.id === id);
  const n = S.tasks.filter(t => t.bucket_id === id).length;
  if (!confirm(n ? `למחוק את הדלי "${b.name}"? ${n} המשימות שבו יעברו ל"ללא דלי".` : `למחוק את הדלי "${b.name}"?`)) return;
  const { error } = await sb.from('buckets').delete().eq('id', id);
  if (error) return fail(error);
  S.buckets = S.buckets.filter(x => x.id !== id);
  S.tasks.forEach(t => { if (t.bucket_id === id) t.bucket_id = null; });
  render();
}

/* =========================================================
   Modals
   ========================================================= */
function openModal(html, cls = '') {
  modalRoot.innerHTML = `<div class="overlay"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const overlay = modalRoot.firstElementChild;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
  return overlay.firstElementChild;
}
function closeModal() {
  modalRoot.innerHTML = '';
  if (S.openTaskId) { S.openTaskId = null; render(); }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalRoot.innerHTML) closeModal(); });

/* ----- task ----- */
async function openTaskModal(id) {
  const t = S.tasks.find(t => t.id === id);
  if (!t) return;
  S.openTaskId = id;
  const { data: items, error } = await sb.from('checklist_items').select('*').eq('task_id', id).order('position');
  if (error) return fail(error);
  let checklist = items;
  const project = projectById(t.project_id);
  const members = S.members[t.project_id] || [];
  const buckets = S.route.view === 'project' ? S.buckets
    : (await sb.from('buckets').select('*').eq('project_id', t.project_id).order('position')).data || [];

  const m = openModal(`
    <div class="modal-head">
      ${project ? `<span class="chip proj"><span class="dot" style="background:${esc(project.color)}"></span>${esc(project.name)}</span>` : ''}
      <span class="spacer" style="flex:1"></span>
      <button class="icon-btn" data-x title="סגירה">✕</button>
    </div>
    <input class="title-input" name="title" value="${esc(t.title)}" aria-label="שם המשימה">
    <div class="grid2">
      <label class="field">אחראי
        <select class="input" name="assignee_id"><option value="">לא משויך</option>
          ${members.map(mm => `<option value="${mm.user_id}" ${t.assignee_id === mm.user_id ? 'selected' : ''}>${esc(displayName(mm.profile))}</option>`).join('')}
        </select></label>
      <label class="field">דלי
        <select class="input" name="bucket_id"><option value="">ללא דלי</option>
          ${buckets.map(b => `<option value="${b.id}" ${t.bucket_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select></label>
      <label class="field">התקדמות
        <select class="input" name="status">${STATUSES.map(s => `<option value="${s.key}" ${t.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
      <label class="field">עדיפות
        <select class="input" name="priority">${PRIORITIES.map(s => `<option value="${s.key}" ${t.priority === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
      <label class="field">תאריך יעד
        <input class="input" type="date" name="due_date" value="${t.due_date || ''}"></label>
    </div>
    <label class="field">תיאור
      <textarea class="input" name="description" placeholder="הערות, קישורים, פרטים...">${esc(t.description || '')}</textarea></label>
    <div class="field" style="display:grid;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);font-weight:500">רשימת תיוג <span id="cl-count"></span></div>
      <div class="progress" id="cl-progress"><div></div></div>
      <div class="checklist" id="checklist"></div>
      <form id="cl-add" style="display:flex;gap:6px"><input class="input" name="text" placeholder="＋ פריט חדש" autocomplete="off"></form>
    </div>
    <div class="modal-foot">
      <span class="muted">נוצרה ${new Date(t.created_at).toLocaleDateString('he-IL')}${t.created_by && profileOf(t.created_by) ? ' ע״י ' + esc(displayName(profileOf(t.created_by))) : ''}</span>
      <button class="btn danger sm" data-del>מחיקת משימה</button>
    </div>`);

  const renderChecklist = () => {
    const done = checklist.filter(i => i.done).length;
    m.querySelector('#cl-count').textContent = checklist.length ? `${done}/${checklist.length}` : '';
    m.querySelector('#cl-progress').classList.toggle('hidden', !checklist.length);
    m.querySelector('#cl-progress > div').style.width = checklist.length ? `${(done / checklist.length) * 100}%` : '0';
    m.querySelector('#checklist').innerHTML = checklist.map(i => `<div class="cl-item ${i.done ? 'on' : ''}" data-id="${i.id}">
      <input type="checkbox" ${i.done ? 'checked' : ''}><span class="txt">${esc(i.text)}</span>
      <button class="icon-btn" data-rm title="מחיקה">✕</button></div>`).join('');
    t.checklist_items = checklist.map(i => ({ id: i.id, done: i.done }));
  };
  renderChecklist();

  m.querySelector('[data-x]').onclick = closeModal;
  const saveField = (name, value) => {
    const patch = { [name]: value === '' ? null : value };
    if (name === 'title' && !value.trim()) return;
    updateTask(t.id, patch, false);
  };
  m.addEventListener('change', e => {
    const el = e.target;
    if (el.closest('.cl-item')) {
      const item = checklist.find(i => i.id === el.closest('.cl-item').dataset.id);
      item.done = el.checked; renderChecklist();
      sb.from('checklist_items').update({ done: item.done }).eq('id', item.id).then(({ error }) => error && fail(error));
      return;
    }
    if (el.name && el.name !== 'text') saveField(el.name, el.value);
  });
  const descSave = debounce(v => saveField('description', v), 600);
  m.querySelector('[name=description]').addEventListener('input', e => descSave(e.target.value));
  m.querySelector('.title-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

  m.querySelector('#cl-add').addEventListener('submit', async e => {
    e.preventDefault();
    const text = e.target.text.value.trim(); if (!text) return;
    e.target.text.value = '';
    const position = (checklist.at(-1)?.position ?? 0) + 1000;
    const { data, error } = await sb.from('checklist_items').insert({ task_id: t.id, text, position }).select().single();
    if (error) return fail(error);
    checklist.push(data); renderChecklist();
  });
  m.querySelector('#checklist').addEventListener('click', async e => {
    if (!e.target.closest('[data-rm]')) return;
    const id = e.target.closest('.cl-item').dataset.id;
    checklist = checklist.filter(i => i.id !== id); renderChecklist();
    const { error } = await sb.from('checklist_items').delete().eq('id', id);
    if (error) fail(error);
  });
  m.querySelector('[data-del]').onclick = async () => {
    if (!confirm('למחוק את המשימה?')) return;
    const { error } = await sb.from('tasks').delete().eq('id', t.id);
    if (error) return fail(error);
    S.tasks = S.tasks.filter(x => x.id !== t.id);
    closeModal(); render(); toast('המשימה נמחקה');
  };
}

/* ----- project create / settings ----- */
function openProjectModal(p = null) {
  const owner = p ? isOwner(p.id) : true;
  const color = p?.color || COLORS[S.projects.length % COLORS.length];
  const m = openModal(`
    <div class="modal-head"><h3>${p ? 'הגדרות פרויקט' : 'פרויקט חדש'}</h3><button class="icon-btn" data-x>✕</button></div>
    <form id="pf" style="display:grid;gap:14px">
      <label class="field">שם<input class="input" name="name" value="${esc(p?.name || '')}" placeholder="למשל: לקוח X, בית, שיווק" required></label>
      <label class="field">תיאור<input class="input" name="description" value="${esc(p?.description || '')}" placeholder="אופציונלי"></label>
      <div class="field">צבע<div class="colors">${COLORS.map(c => `<label><input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
      <div class="modal-foot">
        <div style="display:flex;gap:6px">
          ${p && owner ? '<button type="button" class="btn danger sm" data-archive>העברה לארכיון</button>' : ''}
          ${p && owner ? '<button type="button" class="btn danger sm" data-delete>מחיקה</button>' : ''}
          ${p && !owner ? '<button type="button" class="btn danger sm" data-leave>יציאה מהפרויקט</button>' : ''}
        </div>
        <button class="btn primary">${p ? 'שמירה' : 'יצירה'}</button>
      </div>
    </form>`, 'sm');
  m.querySelector('[data-x]').onclick = closeModal;
  m.querySelector('[name=name]').focus();
  m.querySelector('#pf').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const row = { name: f.name.value.trim(), description: f.description.value.trim() || null, color: f.color.value };
    if (p) {
      const { error } = await sb.from('projects').update(row).eq('id', p.id);
      if (error) return fail(error);
      Object.assign(p, row); closeModal(); render();
    } else {
      const { data, error } = await sb.from('projects').insert(row).select().single();
      if (error) return fail(error);
      closeModal(); await loadProjects(); location.hash = '#/p/' + data.id;
    }
  });
  m.querySelector('[data-archive]')?.addEventListener('click', async () => {
    if (!confirm(`להעביר את "${p.name}" לארכיון? הפרויקט יוסתר מהרשימה.`)) return;
    const { error } = await sb.from('projects').update({ archived: true }).eq('id', p.id);
    if (error) return fail(error);
    closeModal(); await loadProjects(); location.hash = '#/my';
  });
  m.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (prompt(`מחיקה לצמיתות של "${p.name}" וכל המשימות שבו.\nלאישור הקלד את שם הפרויקט:`) !== p.name) return;
    const { error } = await sb.from('projects').delete().eq('id', p.id);
    if (error) return fail(error);
    closeModal(); await loadProjects(); location.hash = '#/my'; toast('הפרויקט נמחק');
  });
  m.querySelector('[data-leave]')?.addEventListener('click', async () => {
    if (!confirm(`לצאת מהפרויקט "${p.name}"?`)) return;
    const { error } = await sb.from('project_members').delete().eq('project_id', p.id).eq('user_id', S.me.id);
    if (error) return fail(error);
    closeModal(); await loadProjects(); location.hash = '#/my';
  });
}

/* ----- members & invites ----- */
async function openMembersModal(projectId) {
  const p = projectById(projectId);
  const owner = isOwner(projectId);
  const { data: invites } = await sb.from('project_invites').select('*').eq('project_id', projectId).order('created_at');
  const members = S.members[projectId] || [];
  const appUrl = location.origin + location.pathname;
  const m = openModal(`
    <div class="modal-head"><h3>שיתוף – ${esc(p.name)}</h3><button class="icon-btn" data-x>✕</button></div>
    ${owner ? `<form id="inv" style="display:flex;gap:6px">
      <input class="input" type="email" name="email" placeholder="מייל של שותף" required dir="ltr">
      <button class="btn primary">הזמנה</button></form>
      <p class="muted" style="margin:0">השותף יראה רק את הפרויקט הזה. אחרי ההזמנה שלחו לו את הקישור לאפליקציה – הוא נכנס עם אותו מייל.</p>` : ''}
    <div>
      ${members.map(mm => `<div class="member-row">${avatar(mm.profile)}
        <div class="info"><div>${esc(displayName(mm.profile))} ${mm.user_id === S.me.id ? '<span class="muted">(אני)</span>' : ''}</div><div class="e">${esc(mm.profile.email)}</div></div>
        ${mm.role === 'owner' ? '<span class="badge">מנהל</span>' : ''}
        ${owner && mm.user_id !== S.me.id ? `<button class="icon-btn" data-rm-member="${mm.user_id}" title="הסרה">✕</button>` : ''}
      </div>`).join('')}
      ${(invites || []).map(i => `<div class="member-row">${avatar(null)}
        <div class="info"><div dir="ltr" style="text-align:right">${esc(i.email)}</div><div class="e">ממתין לכניסה ראשונה</div></div>
        ${owner ? `<button class="icon-btn" data-rm-invite="${i.id}" title="ביטול הזמנה">✕</button>` : ''}
      </div>`).join('')}
    </div>
    <div class="modal-foot"><span class="muted" dir="ltr">${esc(appUrl)}</span>
      <button class="btn sm" data-copy>העתקת קישור</button></div>`, 'sm');
  m.querySelector('[data-x]').onclick = closeModal;
  m.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(appUrl).then(() => toast('הקישור הועתק'));
  m.querySelector('#inv')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    const { data, error } = await sb.rpc('invite_member', { p_project: projectId, p_email: email });
    if (error) return fail(error);
    await loadProjects();
    toast(data === 'added' ? 'נוסף לפרויקט ✓' : 'ההזמנה נשמרה – שלחו לו את הקישור');
    openMembersModal(projectId);
  });
  m.addEventListener('click', async e => {
    const rmM = e.target.closest('[data-rm-member]')?.dataset.rmMember;
    const rmI = e.target.closest('[data-rm-invite]')?.dataset.rmInvite;
    if (rmM) {
      if (!confirm('להסיר את השותף מהפרויקט?')) return;
      const { error } = await sb.from('project_members').delete().eq('project_id', projectId).eq('user_id', rmM);
      if (error) return fail(error);
      await loadProjects(); openMembersModal(projectId); render();
    }
    if (rmI) {
      const { error } = await sb.from('project_invites').delete().eq('id', rmI);
      if (error) return fail(error);
      openMembersModal(projectId);
    }
  });
}

/* ----- profile ----- */
function openProfileModal() {
  const m = openModal(`
    <div class="modal-head"><h3>הפרופיל שלי</h3><button class="icon-btn" data-x>✕</button></div>
    <form id="prof" style="display:grid;gap:14px">
      <label class="field">שם (כך השותפים יראו אותך)<input class="input" name="full_name" value="${esc(S.me.full_name || '')}" required></label>
      <div class="muted" dir="ltr" style="text-align:right">${esc(S.me.email)}</div>
      <div class="modal-foot"><span></span><button class="btn primary">שמירה</button></div>
    </form>`, 'sm');
  m.querySelector('[data-x]').onclick = closeModal;
  m.querySelector('[name=full_name]').focus();
  m.querySelector('#prof').addEventListener('submit', async e => {
    e.preventDefault();
    const full_name = e.target.full_name.value.trim();
    const { error } = await sb.from('profiles').update({ full_name }).eq('id', S.me.id);
    if (error) return fail(error);
    S.me.full_name = full_name;
    await loadProjects(); closeModal(); render();
  });
}

/* =========================================================
   Realtime – partners' changes appear live
   ========================================================= */
const refresh = debounce(async (table) => {
  if (S.openTaskId) return;                      // don't yank the open task modal
  if (table === 'project_members' || table === 'projects') {
    await loadProjects();
    if (S.route.view === 'project' && !projectById(S.route.id)) { location.hash = '#/my'; return; }
  }
  if (S.route.view === 'project') await loadProjectData(S.route.id); else await loadMyTasks();
  if (!modalRoot.innerHTML && !document.querySelector('[contenteditable="true"], .add-task form:not(.hidden)')) render();
}, 400);

function subscribeRealtime() {
  const ch = sb.channel('mesimot');
  for (const table of ['tasks', 'buckets', 'checklist_items', 'project_members', 'projects']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => refresh(table));
  }
  ch.subscribe();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh('projects'); });
}
