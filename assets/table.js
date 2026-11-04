/* =========================================================
   Table view – Monday-style list with typed columns,
   per-column sort, filters, custom columns and inline editing.
   Wired into app.js through createTable(ctx).
   ========================================================= */

export const FIELD_TYPES = [
  { key: 'text', label: 'טקסט' },
  { key: 'number', label: 'מספר' },
  { key: 'date', label: 'תאריך' },
  { key: 'select', label: 'תווית (בחירה)' },
  { key: 'person', label: 'אדם' },
  { key: 'checkbox', label: 'תיבת סימון' },
  { key: 'link', label: 'קישור' },
];

const STATUS_COLORS = { todo: '#94a3b8', in_progress: '#2563eb', waiting: '#d97706', done: '#16a34a' };
const PRIORITY_COLORS = { urgent: '#dc2626', high: '#ea580c', medium: '#64748b', low: '#94a3b8' };

const OPS = {
  text: [['contains', 'מכיל'], ['not_contains', 'לא מכיל'], ['empty', 'ריק'], ['not_empty', 'לא ריק']],
  number: [['eq', '='], ['gt', 'גדול מ-'], ['lt', 'קטן מ-'], ['empty', 'ריק'], ['not_empty', 'לא ריק']],
  date: [['overdue', 'באיחור'], ['today', 'היום'], ['week', '7 הימים הקרובים'], ['before', 'לפני'], ['after', 'אחרי'], ['empty', 'ריק'], ['not_empty', 'לא ריק']],
  select: [['is', 'הוא'], ['is_not', 'אינו'], ['empty', 'ריק'], ['not_empty', 'לא ריק']],
  checkbox: [['checked', 'מסומן'], ['unchecked', 'לא מסומן']],
  progress: [['complete', 'הושלמה'], ['incomplete', 'לא הושלמה'], ['empty', 'אין רשימה']],
};
const NO_VALUE = new Set(['empty', 'not_empty', 'overdue', 'today', 'week', 'checked', 'unchecked', 'complete', 'incomplete']);
const opFamily = type => ({ title: 'text', link: 'text', person: 'select' }[type] || type);

const DEFAULT_CFG = { sort: null, filters: [{ key: 'status', op: 'is_not', value: 'done' }], hidden: ['created_at'] };

export function createTable(ctx) {
  const { S, sb, esc, load, save, fail, toast, render, avatar, displayName, profileOf, projectById,
    STATUSES, PRIORITIES, COLORS, openModal, closeModal, updateTask, viewKey, todayStr } = ctx;
  const $ = (sel, root = document) => root.querySelector(sel);

  /* ---------- config (per view, per browser) ---------- */
  const cfgKey = () => 'table.' + viewKey();
  const cfg = () => {
    const c = load(cfgKey(), null);
    return c ? { ...structuredClone(DEFAULT_CFG), ...c } : structuredClone(DEFAULT_CFG);
  };
  const setCfg = c => save(cfgKey(), c);

  /* ---------- columns ---------- */
  const isProject = () => S.route.view === 'project';
  const memberOpts = pid => (S.members[pid] || []).map(m => ({ value: m.user_id, label: displayName(m.profile) }));
  function allPeople() {
    const seen = new Map();
    for (const list of Object.values(S.members)) for (const m of list) seen.set(m.user_id, { value: m.user_id, label: displayName(m.profile) });
    return [...seen.values()];
  }

  function columns() {
    const proj = isProject();
    const cols = [
      { key: 'title', label: 'משימה', type: 'title', get: t => t.title },
      { key: 'status', label: 'התקדמות', type: 'select', get: t => t.status, required: true,
        options: STATUSES.map(s => ({ value: s.key, label: s.label, color: STATUS_COLORS[s.key] })) },
      { key: 'assignee_id', label: 'אחראי', type: 'person', get: t => t.assignee_id,
        options: proj ? memberOpts(S.route.id) : allPeople(), optionsFor: t => memberOpts(t.project_id) },
      { key: 'due_date', label: 'תאריך יעד', type: 'date', get: t => t.due_date },
      { key: 'priority', label: 'עדיפות', type: 'select', get: t => t.priority, required: true,
        options: PRIORITIES.map(s => ({ value: s.key, label: s.label, color: PRIORITY_COLORS[s.key] })) },
    ];
    if (proj) cols.push({ key: 'bucket_id', label: 'דלי', type: 'select', get: t => t.bucket_id,
      options: S.buckets.map(b => ({ value: b.id, label: b.name })) });
    else cols.push({ key: 'project_id', label: 'פרויקט', type: 'select', readonly: true, get: t => t.project_id,
      options: S.projects.map(p => ({ value: p.id, label: p.name, color: p.color })) });
    cols.push({ key: 'checklist', label: 'רשימת תיוג', type: 'progress', readonly: true, get: t => {
      const items = t.checklist_items || [];
      return items.length ? { done: items.filter(i => i.done).length, total: items.length } : null;
    } });
    cols.push({ key: 'created_at', label: 'נוצרה', type: 'date', readonly: true, get: t => t.created_at?.slice(0, 10) || null });
    if (proj) for (const f of S.fields) {
      cols.push({
        key: 'f:' + f.id, label: f.name, type: f.type, field: f, get: t => t.custom?.[f.id] ?? null,
        options: f.type === 'select' ? (f.options || []).map(o => ({ value: o.id, label: o.label, color: o.color }))
          : f.type === 'person' ? memberOpts(S.route.id) : undefined,
      });
    }
    return cols;
  }

  /* ---------- filter / sort ---------- */
  const isEmpty = v => v == null || v === '' || v === false;
  function matches(t, f, col) {
    const v = col.get(t);
    const today = todayStr();
    switch (f.op) {
      case 'empty': return col.type === 'progress' ? !v : isEmpty(v);
      case 'not_empty': return !isEmpty(v);
      case 'contains': return String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
      case 'not_contains': return !String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
      case 'eq': return v != null && Number(v) === Number(f.value);
      case 'gt': return v != null && Number(v) > Number(f.value);
      case 'lt': return v != null && Number(v) < Number(f.value);
      case 'overdue': return !!v && v < today && t.status !== 'done';
      case 'today': return v === today;
      case 'week': { const end = new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA'); return !!v && v >= today && v <= end; }
      case 'before': return !!v && !!f.value && v < f.value;
      case 'after': return !!v && !!f.value && v > f.value;
      case 'is': return f.value == null || f.value === '' ? true : v === f.value;
      case 'is_not': return f.value == null || f.value === '' ? true : v !== f.value;
      case 'checked': return v === true;
      case 'unchecked': return v !== true;
      case 'complete': return !!v && v.done === v.total;
      case 'incomplete': return !!v && v.done < v.total;
      default: return true;
    }
  }

  function sortValue(col, t) {
    const v = col.get(t);
    if (isEmpty(v) && col.type !== 'checkbox') return null;
    switch (col.type) {
      case 'number': return Number(v);
      case 'checkbox': return v ? 1 : 0;
      case 'progress': return v.done / v.total;
      case 'select': { const i = (col.options || []).findIndex(o => o.value === v); return i < 0 ? 999 : i; }
      case 'person': return displayName(profileOf(v)).toLowerCase();
      default: return String(v).toLowerCase();
    }
  }

  function visibleRows(c, cols) {
    const byKey = Object.fromEntries(cols.map(col => [col.key, col]));
    let rows = S.tasks.filter(t => c.filters.every(f => !byKey[f.key] || matches(t, f, byKey[f.key])));
    if (S.search) rows = rows.filter(t => t.title.toLowerCase().includes(S.search.toLowerCase()));
    const col = c.sort && byKey[c.sort.key];
    if (col) {
      const dir = c.sort.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => {
        const x = sortValue(col, a), y = sortValue(col, b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;            // empties always last
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    } else {
      rows = rows.slice().sort((a, b) => (a.status === 'done') - (b.status === 'done') || a.position - b.position);
    }
    return rows;
  }

  /* ---------- rendering ---------- */
  function renderTable() {
    const c = cfg();
    const cols = columns();
    const visible = cols.filter(col => col.key === 'title' || !c.hidden.includes(col.key));
    const rows = visibleRows(c, cols);
    const nFilters = c.filters.length;
    const notice = isProject() && !S.fieldsReady
      ? `<div class="notice">כדי להוסיף עמודות משלך צריך להריץ פעם אחת את <code>supabase/migrations/002_custom_fields.sql</code> ב-SQL Editor של Supabase.</div>` : '';
    return `<div class="table-view">
      <div class="table-toolbar">
        <input class="input search" type="search" data-act="tbl-search" placeholder="חיפוש משימה…" value="${esc(S.search)}">
        <button class="btn sm ${S.filterOpen || nFilters ? 'active' : ''}" data-act="tbl-filter-toggle">סינון${nFilters ? ` · ${nFilters}` : ''}</button>
        <button class="btn sm" data-act="tbl-columns">עמודות</button>
        ${isProject() ? `<button class="btn sm" data-act="tbl-add-col">＋ עמודה</button>` : ''}
        <span class="spacer"></span>
        <span class="muted" id="tbl-count">${rows.length} משימות</span>
      </div>
      ${notice}
      ${S.filterOpen ? filterPanel(c, cols) : ''}
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>${visible.map(col => headCell(col, c)).join('')}</tr></thead>
          <tbody id="tbl-body">${bodyHtml(rows, visible)}</tbody>
        </table>
        ${isProject() ? `<form class="tbl-add" data-form="tbl-add"><input class="input" name="title" placeholder="＋ משימה חדשה" autocomplete="off"></form>` : ''}
      </div>
    </div>`;
  }

  function headCell(col, c) {
    const s = c.sort?.key === col.key ? (c.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="col-${col.type}" data-key="${col.key}">
      <div class="th-in"><button class="th-btn" data-act="tbl-sort" data-key="${col.key}" title="מיון">${esc(col.label)}<span class="arr">${s}</span></button>
      ${col.field ? `<button class="icon-btn th-menu" data-act="tbl-col-edit" data-key="${col.key}" title="עריכת עמודה">⋯</button>` : ''}</div></th>`;
  }

  function bodyHtml(rows, visible) {
    if (!rows.length) return `<tr><td colspan="${visible.length}" class="tbl-empty">אין משימות שמתאימות לסינון</td></tr>`;
    return rows.map(t => `<tr data-task="${t.id}" class="${t.status === 'done' ? 'is-done' : ''}">${visible.map(col => cell(col, t)).join('')}</tr>`).join('');
  }

  function selectHtml(col, v, opts, cls = '') {
    const cur = opts.find(o => o.value === v);
    const style = cur?.color ? `style="background:${cur.color};color:#fff;border-color:${cur.color}"` : '';
    return `<select class="cell-sel ${cls}" data-act="cell" data-key="${col.key}" ${style}>
      ${col.required ? '' : `<option value="">—</option>`}
      ${opts.map(o => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      ${v && !cur ? `<option value="${esc(v)}" selected>?</option>` : ''}
    </select>`;
  }

  function cell(col, t) {
    const v = col.get(t);
    if (col.type === 'title') {
      return `<td class="c-title"><div class="title-cell">
        <button class="check ${t.status === 'done' ? 'on' : ''}" data-act="toggle-done" title="סמן כהושלם">✓</button>
        <span class="t">${esc(t.title)}</span>
        ${!isProject() ? '' : (t.checklist_items?.length || t.description ? '<span class="muted">☰</span>' : '')}
      </div></td>`;
    }
    const td = inner => `<td class="no-open col-${col.type}">${inner}</td>`;
    if (col.readonly) {
      if (col.type === 'progress') return td(v ? `<div class="mini-prog"><div style="width:${(v.done / v.total) * 100}%"></div></div><span class="muted">${v.done}/${v.total}</span>` : '');
      if (col.type === 'date') return td(v ? `<span class="muted">${new Date(v + 'T00:00:00').toLocaleDateString('he-IL')}</span>` : '');
      if (col.key === 'project_id') { const p = projectById(v); return td(p ? `<a class="chip proj" href="#/p/${p.id}"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</a>` : ''); }
    }
    switch (col.type) {
      case 'select': return td(selectHtml(col, v, col.options || []));
      case 'person': {
        const opts = col.optionsFor ? col.optionsFor(t) : col.options || [];
        return td(`<div class="person-cell">${v ? avatar(profileOf(v), 'sm') : ''}${selectHtml(col, v, opts, 'plain')}</div>`);
      }
      case 'date': {
        const overdue = col.key === 'due_date' && v && v < todayStr() && t.status !== 'done';
        return td(`<input class="cell-in ${overdue ? 'overdue' : ''}" type="date" data-act="cell" data-key="${col.key}" value="${esc(v || '')}">`);
      }
      case 'number': return td(`<input class="cell-in num" type="number" step="any" data-act="cell" data-key="${col.key}" value="${v ?? ''}">`);
      case 'checkbox': return td(`<input class="cell-check" type="checkbox" data-act="cell" data-key="${col.key}" ${v ? 'checked' : ''}>`);
      case 'link': {
        const href = v && /^https?:\/\//i.test(v) ? v : v ? 'https://' + v : '';
        return td(`<div class="link-cell"><input class="cell-in" type="text" dir="ltr" data-act="cell" data-key="${col.key}" value="${esc(v || '')}" placeholder="https://">
          ${v ? `<a href="${esc(href)}" target="_blank" rel="noopener" title="פתיחה">↗</a>` : ''}</div>`);
      }
      default: return td(`<input class="cell-in" type="text" data-act="cell" data-key="${col.key}" value="${esc(v ?? '')}">`);
    }
  }

  function filterPanel(c, cols) {
    const filterable = cols.filter(col => col.type !== 'title' || true);
    const row = (f, i) => {
      const col = cols.find(x => x.key === f.key) || cols[0];
      const ops = OPS[opFamily(col.type)] || OPS.text;
      let val = '';
      if (!NO_VALUE.has(f.op)) {
        const fam = opFamily(col.type);
        if (fam === 'select') {
          const opts = col.options || [];
          val = `<select class="input" data-act="flt-val" data-i="${i}"><option value="">בחר…</option>
            ${opts.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
        } else if (fam === 'date') val = `<input class="input" type="date" data-act="flt-val" data-i="${i}" value="${esc(f.value || '')}">`;
        else if (fam === 'number') val = `<input class="input" type="number" step="any" data-act="flt-val" data-i="${i}" value="${esc(f.value ?? '')}">`;
        else val = `<input class="input" type="text" data-act="flt-val" data-i="${i}" value="${esc(f.value || '')}" placeholder="ערך">`;
      }
      return `<div class="flt-row">
        <select class="input" data-act="flt-key" data-i="${i}">${filterable.map(x => `<option value="${x.key}" ${x.key === col.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        <select class="input" data-act="flt-op" data-i="${i}">${ops.map(([k, l]) => `<option value="${k}" ${k === f.op ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${val || '<span></span>'}
        <button class="icon-btn" data-act="flt-rm" data-i="${i}" title="הסרה">✕</button>
      </div>`;
    };
    return `<div class="filter-panel">
      ${c.filters.map(row).join('') || '<div class="muted">אין תנאי סינון – מוצגות כל המשימות</div>'}
      <div class="flt-actions"><button class="btn sm" data-act="flt-add">＋ תנאי</button>
      ${c.filters.length ? '<button class="btn ghost sm" data-act="flt-clear">ניקוי הכל</button>' : ''}
      <span class="muted">כל התנאים חלים יחד</span></div>
    </div>`;
  }

  function refreshBody() {
    const c = cfg(), cols = columns();
    const visible = cols.filter(col => col.key === 'title' || !c.hidden.includes(col.key));
    const rows = visibleRows(c, cols);
    const body = $('#tbl-body'); if (body) body.innerHTML = bodyHtml(rows, visible);
    const n = $('#tbl-count'); if (n) n.textContent = `${rows.length} משימות`;
  }

  /* ---------- saving ---------- */
  function normalize(type, el) {
    if (type === 'checkbox') return el.checked;
    const raw = el.value;
    if (raw === '' || raw == null) return null;
    if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : null; }
    return type === 'text' || type === 'link' ? raw.trim() || null : raw;
  }

  async function saveCell(taskId, key, el) {
    const t = S.tasks.find(x => x.id === taskId);
    const col = columns().find(c => c.key === key);
    if (!t || !col || col.readonly) return;
    const v = normalize(col.type, el);
    if (col.field) {
      const fid = col.field.id;
      t.custom = { ...(t.custom || {}) };
      if (v == null) delete t.custom[fid]; else t.custom[fid] = v;
      render();
      const { error } = await sb.rpc('set_task_field', { p_task: taskId, p_field: fid, p_value: v });
      if (error) fail(error);
    } else {
      if (col.required && v == null) return render();
      await updateTask(taskId, { [key]: v });
      if (key === 'status' && v === 'done') toast('✓ סומן כהושלם');
    }
  }

  async function addRow(title) {
    const pos = S.tasks.length ? Math.max(...S.tasks.map(t => t.position)) + 1000 : 1000;
    const { data, error } = await sb.from('tasks')
      .insert({ project_id: S.route.id, title, bucket_id: S.buckets[0]?.id ?? null, position: pos, assignee_id: S.me.id })
      .select('*, checklist_items(id, done)').single();
    if (error) return fail(error);
    data.custom ||= {};
    S.tasks.push(data);
    render();
    $('form[data-form="tbl-add"] input')?.focus();
  }

  /* ---------- column dialogs ---------- */
  function openColumnsModal() {
    const c = cfg();
    const cols = columns().filter(col => col.key !== 'title');
    const m = openModal(`
      <div class="modal-head"><h3>עמודות מוצגות</h3><button class="icon-btn" data-x>✕</button></div>
      <div class="col-list">${cols.map(col => `<label class="check-inline col-opt">
        <input type="checkbox" value="${col.key}" ${c.hidden.includes(col.key) ? '' : 'checked'}> ${esc(col.label)}
        ${col.field ? `<span class="muted">· ${FIELD_TYPES.find(x => x.key === col.type)?.label || ''}</span>` : ''}</label>`).join('')}</div>
      <div class="modal-foot"><span class="muted">ההגדרה נשמרת בדפדפן הזה</span><button class="btn primary" data-ok>סגירה</button></div>`, 'sm');
    m.querySelector('[data-x]').onclick = closeModal;
    m.querySelector('[data-ok]').onclick = closeModal;
    m.addEventListener('change', e => {
      const cc = cfg();
      const key = e.target.value;
      cc.hidden = e.target.checked ? cc.hidden.filter(k => k !== key) : [...new Set([...cc.hidden, key])];
      setCfg(cc); render();
    });
  }

  function openFieldModal(field = null) {
    if (!S.fieldsReady) return toast('צריך להריץ קודם את migration 002 ב-Supabase', true);
    const type = field?.type || 'text';
    const m = openModal(`
      <div class="modal-head"><h3>${field ? 'עריכת עמודה' : 'עמודה חדשה'}</h3><button class="icon-btn" data-x>✕</button></div>
      <form id="ff" style="display:grid;gap:14px">
        <label class="field">שם העמודה<input class="input" name="name" value="${esc(field?.name || '')}" required placeholder="למשל: לקוח, שעות, סכום, קישור לתיקייה"></label>
        <label class="field">סוג
          <select class="input" name="type" ${field ? 'disabled' : ''}>${FIELD_TYPES.map(t => `<option value="${t.key}" ${t.key === type ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        <label class="field ${type === 'select' ? '' : 'hidden'}" id="opts-wrap">אפשרויות (שורה לכל אחת)
          <textarea class="input" name="options" placeholder="חדש&#10;בטיפול&#10;אושר">${esc((field?.options || []).map(o => o.label).join('\n'))}</textarea></label>
        <div class="modal-foot">
          ${field ? '<button type="button" class="btn danger sm" data-del>מחיקת עמודה</button>' : '<span></span>'}
          <button class="btn primary">${field ? 'שמירה' : 'הוספה'}</button>
        </div>
      </form>`, 'sm');
    m.querySelector('[data-x]').onclick = closeModal;
    m.querySelector('[name=name]').focus();
    m.querySelector('[name=type]').addEventListener('change', e =>
      m.querySelector('#opts-wrap').classList.toggle('hidden', e.target.value !== 'select'));
    m.querySelector('#ff').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const t = field?.type || f.type.value;
      const labels = f.options.value.split('\n').map(s => s.trim()).filter(Boolean);
      const prev = field?.options || [];
      const options = t === 'select' ? labels.map((label, i) => {
        const keep = prev.find(o => o.label === label);
        return keep || { id: crypto.randomUUID().slice(0, 8), label, color: COLORS[(prev.length + i) % COLORS.length] };
      }) : [];
      const row = { name: f.name.value.trim(), options };
      if (field) {
        const { error } = await sb.from('project_fields').update(row).eq('id', field.id);
        if (error) return fail(error);
        Object.assign(field, row);
      } else {
        const pos = (S.fields.at(-1)?.position ?? 0) + 1000;
        const { data, error } = await sb.from('project_fields').insert({ ...row, type: t, project_id: S.route.id, position: pos }).select().single();
        if (error) return fail(error);
        S.fields.push(data);
      }
      closeModal(); render();
    });
    m.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm(`למחוק את העמודה "${field.name}" וכל הערכים שבה?`)) return;
      const { error } = await sb.from('project_fields').delete().eq('id', field.id);
      if (error) return fail(error);
      S.fields = S.fields.filter(x => x.id !== field.id);
      const c = cfg(); c.filters = c.filters.filter(x => x.key !== 'f:' + field.id);
      if (c.sort?.key === 'f:' + field.id) c.sort = null;
      setCfg(c); closeModal(); render();
    });
  }

  /* ---------- events (delegated on #app) ---------- */
  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return false;
    const act = btn.dataset.act;
    const c = cfg();
    switch (act) {
      case 'tbl-sort': {
        const key = btn.dataset.key;
        c.sort = c.sort?.key !== key ? { key, dir: 'asc' } : c.sort.dir === 'asc' ? { key, dir: 'desc' } : null;
        setCfg(c); render(); return true;
      }
      case 'tbl-filter-toggle': S.filterOpen = !S.filterOpen; render(); return true;
      case 'tbl-columns': openColumnsModal(); return true;
      case 'tbl-add-col': openFieldModal(); return true;
      case 'tbl-col-edit': openFieldModal(S.fields.find(f => 'f:' + f.id === btn.dataset.key)); return true;
      case 'flt-add': c.filters.push({ key: 'due_date', op: 'overdue', value: null }); setCfg(c); render(); return true;
      case 'flt-clear': c.filters = []; setCfg(c); render(); return true;
      case 'flt-rm': c.filters.splice(+btn.dataset.i, 1); setCfg(c); render(); return true;
    }
    return false;
  }

  function onChange(e) {
    const el = e.target;
    const act = el.dataset.act;
    if (act === 'cell') { saveCell(el.closest('tr').dataset.task, el.dataset.key, el); return true; }
    if (act === 'flt-key' || act === 'flt-op' || act === 'flt-val') {
      const c = cfg();
      const f = c.filters[+el.dataset.i];
      if (act === 'flt-key') {
        f.key = el.value;
        const col = columns().find(x => x.key === f.key);
        f.op = (OPS[opFamily(col.type)] || OPS.text)[0][0]; f.value = null;
      } else if (act === 'flt-op') f.op = el.value;
      else f.value = el.value || null;
      setCfg(c); render(); return true;
    }
    return false;
  }

  const searchDebounced = (() => { let t; return () => { clearTimeout(t); t = setTimeout(refreshBody, 150); }; })();
  function onInput(e) {
    if (e.target.dataset.act === 'tbl-search') { S.search = e.target.value; searchDebounced(); return true; }
    return false;
  }

  function onKeydown(e) {
    const el = e.target;
    if (e.key === 'Enter' && el.classList.contains('cell-in')) { el.blur(); return true; }
    return false;
  }

  async function onSubmit(e) {
    if (e.target.dataset.form !== 'tbl-add') return false;
    const title = e.target.title.value.trim();
    if (title) { e.target.title.value = ''; await addRow(title); }
    return true;
  }

  return { renderTable, onClick, onChange, onInput, onKeydown, onSubmit };
}
