// Minimal single-page frontend. All DOM is built with h() (textContent), so API data can never inject HTML.
(() => {
  'use strict';
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const $toast = document.getElementById('toast');

  const state = { me: null, org: null, role: null };
  let accessToken = null;                       // kept in memory only
  let refreshToken = sessionStorage.getItem('refreshToken');

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fmt = (d) => (d ? new Date(d).toLocaleString() : '');

  let toastTimer;
  function toast(msg, isError) {
    $toast.textContent = msg;
    $toast.className = `show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.className = ''; }, 6000);
  }
  function showError(e) {
    const details = Array.isArray(e.details) ? '\n' + e.details.map((d) => `- ${d.field || ''} ${d.message}`.trim()).join('\n') : '';
    toast(`${e.message}${details}${e.traceId ? `\nTrace: ${e.traceId}` : ''}`, true);
  }

  // -------------------------------------------------------------------- API
  let refreshing = null;   // single-flight: parallel 401s must share ONE refresh (tokens rotate!)
  function doRefresh() {
    if (!refreshing) refreshing = refreshOnce().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function refreshOnce() {
    if (!refreshToken) return false;
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
      if (!res.ok) throw new Error('refresh failed');
      const json = await res.json();
      accessToken = json.data.accessToken;
      refreshToken = json.data.refreshToken;
      sessionStorage.setItem('refreshToken', refreshToken);
      return true;
    } catch (_) {
      clearSession();
      return false;
    }
  }
  function clearSession() {
    accessToken = null; refreshToken = null; state.me = null; state.org = null;
    sessionStorage.removeItem('refreshToken');
  }

  async function api(path, { method = 'GET', body, auth = true, retry = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && auth && retry && refreshToken) {
      if (await doRefresh()) return api(path, { method, body, auth, retry: false });
      showAuth();
      throw Object.assign(new Error('Session expired, please log in again'), { status: 401 });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = json.error || {};
      throw Object.assign(new Error(err.message || `Request failed (${res.status})`), { details: err.details, traceId: err.traceId, status: res.status });
    }
    return json;
  }

  // ------------------------------------------------------- reusable widgets
  // form([{name,label,type,options,required}], 'Submit', async (data, formEl) => {...})
  function form(fields, submitLabel, onSubmit) {
    const f = h('form', { class: 'row' },
      fields.map((fl) => {
        let input;
        if (fl.options) input = h('select', { name: fl.name }, fl.options.map((o) => h('option', { value: o.value !== undefined ? o.value : o }, o.label !== undefined ? o.label : o)));
        else if (fl.type === 'textarea') input = h('textarea', { name: fl.name, rows: 1 });
        else input = h('input', { name: fl.name, type: fl.type || 'text', required: fl.required ? '' : false });
        return h('label', {}, fl.label, input);
      }),
      h('button', { type: 'submit' }, submitLabel));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {};
      new FormData(f).forEach((v, k) => { if (v !== '') data[k] = v; });
      try { await onSubmit(data, f); } catch (err) { showError(err); }
    });
    return f;
  }

  // Generic paginated + sortable + filterable table. The server does the real work.
  function listView({ fetcher, columns, sortBy, order = 'desc', filters = [] }) {
    const st = { page: 1, size: 10, sortBy, order, filters: {} };
    const filterBar = h('div', { class: 'row' });
    const tableBox = h('div', { class: 'table-wrap' });
    const pager = h('div', { class: 'row pager' });

    filters.forEach((f) => {
      const input = f.options
        ? h('select', {}, h('option', { value: '' }, `All ${f.label}`), f.options.map((o) => h('option', { value: o }, o)))
        : h('input', { type: 'search', placeholder: f.label });
      const handler = () => { st.filters[f.name] = input.value.trim(); st.page = 1; load(); };
      input.addEventListener(f.options ? 'change' : 'input', f.options ? handler : debounce(handler, 300));
      filterBar.append(input);
    });

    async function load() {
      const qs = new URLSearchParams({ page: st.page, size: st.size });
      if (st.sortBy) { qs.set('sortBy', st.sortBy); qs.set('order', st.order); }
      Object.entries(st.filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
      try { draw(await fetcher(`?${qs}`)); } catch (e) { showError(e); }
    }

    function draw({ data, pagination: p }) {
      const head = h('tr', {}, columns.map((c) => {
        const arrow = c.sort && st.sortBy === c.sort ? (st.order === 'asc' ? ' \u25B2' : ' \u25BC') : '';
        const th = h('th', { class: c.sort ? 'sortable' : false }, c.label + arrow);
        if (c.sort) th.addEventListener('click', () => {
          if (st.sortBy === c.sort) st.order = st.order === 'asc' ? 'desc' : 'asc';
          else { st.sortBy = c.sort; st.order = 'asc'; }
          st.page = 1; load();
        });
        return th;
      }));
      const rows = data.length
        ? data.map((r) => h('tr', {}, columns.map((c) => h('td', {}, c.render ? c.render(r) : (r[c.key] ?? '')))))
        : [h('tr', {}, h('td', { colspan: columns.length, class: 'empty' }, 'Nothing here yet.'))];
      tableBox.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, rows)));

      const sizeSel = h('select', {}, [5, 10, 25, 50].map((n) => h('option', { value: n, selected: n === st.size ? '' : false }, `${n} / page`)));
      sizeSel.addEventListener('change', () => { st.size = Number(sizeSel.value); st.page = 1; load(); });
      pager.replaceChildren(
        h('button', { class: 'secondary', disabled: p.hasPrev ? false : '', onclick: () => { st.page -= 1; load(); } }, 'Previous'),
        h('span', { class: 'muted' }, `Page ${p.page} of ${p.totalPages} (${p.totalItems} items)`),
        h('button', { class: 'secondary', disabled: p.hasNext ? false : '', onclick: () => { st.page += 1; load(); } }, 'Next'),
        sizeSel);
    }

    const root = h('div', {}, filterBar, tableBox, pager);
    root.reload = load;
    load();
    return root;
  }

  const badge = (t) => h('span', { class: 'badge' }, t);
  const canSupervise = () => state.role === 'OWNER' || state.role === 'MANAGER';

  // ------------------------------------------------------------------ views
  function renderNav() {
    $nav.replaceChildren(
      h('span', { class: 'brand' }, 'Organization Management Platform'),
      state.me ? h('span', {}, `${state.me.name} (${state.me.email})`) : null,
      state.me ? h('button', { onclick: showOrgs }, 'My organizations') : null,
      state.me ? h('button', { onclick: logout }, 'Log out') : null);
  }

  function showAuth() {
    renderNav();
    $app.replaceChildren(h('div', { class: 'grid2' },
      h('section', {}, h('h1', {}, 'Log in'),
        form([{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Password', type: 'password', required: true }], 'Log in', async (d) => {
          const res = await api('/auth/login', { method: 'POST', body: d, auth: false });
          accessToken = res.data.accessToken; refreshToken = res.data.refreshToken;
          sessionStorage.setItem('refreshToken', refreshToken);
          await loadMe(); showOrgs();
        })),
      h('section', {}, h('h1', {}, 'Register'),
        form([{ name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'password', label: 'Password (8+, letter + number)', type: 'password', required: true }, { name: 'phone', label: 'Phone (optional, stored encrypted)' }],
        'Register', async (d, f) => { await api('/auth/register', { method: 'POST', body: d, auth: false }); f.reset(); toast('Registered. You can log in now.'); }))));
  }

  async function loadMe() { state.me = (await api('/auth/me')).data; }

  async function logout() {
    try { await api('/auth/logout', { method: 'POST', body: refreshToken ? { refreshToken } : {} }); } catch (_) { /* ignore */ }
    clearSession(); showAuth();
  }

  function showOrgs() {
    state.org = null; renderNav();
    $app.replaceChildren(
      h('section', {}, h('h1', {}, 'My organizations'),
        listView({
          fetcher: (qs) => api(`/orgs${qs}`), sortBy: 'name', order: 'asc', filters: [{ name: 'search', label: 'Search name' }],
          columns: [
            { label: 'Name', sort: 'name', render: (r) => h('button', { class: 'link', onclick: () => openOrg(r.id) }, r.name) },
            { label: 'My role', sort: 'role', render: (r) => badge(r.role) },
            { label: 'Members', key: 'member_count' },
            { label: 'Joined', sort: 'joined_at', render: (r) => fmt(r.joined_at) },
          ],
        })),
      h('section', {}, h('h2', {}, 'Create an organization (you become the Owner)'),
        form([{ name: 'name', label: 'Organization name', required: true }], 'Create', async (d) => { await api('/orgs', { method: 'POST', body: d }); toast('Organization created'); showOrgs(); })));
  }

  const TABS = { Members: membersTab, Projects: projectsTab, 'My tasks': myTasksTab, 'Audit log': auditTab };

  async function openOrg(orgId, tab = 'Members') {
    try {
      const org = (await api(`/orgs/${orgId}`)).data;
      state.org = org; state.role = org.myRole;
    } catch (e) { return showError(e); }
    const content = h('div');
    const tabNames = Object.keys(TABS).filter((t) => t !== 'Audit log' || state.role === 'OWNER');
    const tabs = h('div', { class: 'tabs' }, tabNames.map((t) => h('button', { class: t === tab ? 'active' : false, onclick: () => openOrg(orgId, t) }, t)));
    const o = state.org;
    $app.replaceChildren(
      h('h1', {}, o.name, ' ', badge(`You: ${state.role}`)),
      h('p', { class: 'muted' }, `Owner: ${o.owner_name} \u2022 ${o.manager_count} managers \u2022 ${o.employee_count} employees \u2022 ${o.project_count} projects`),
      tabs, content);
    content.replaceChildren(await TABS[tab]());
  }

  // ---- members
  function membersTab() {
    const roles = state.role === 'OWNER' ? ['MANAGER', 'EMPLOYEE'] : ['EMPLOYEE'];
    const orgId = state.org.id;
    const wrap = h('section', {});
    const lv = listView({
      fetcher: (qs) => api(`/orgs/${orgId}/members${qs}`), sortBy: 'joined_at', order: 'asc',
      filters: [{ name: 'search', label: 'Search name or email' }, { name: 'role', label: 'roles', options: ['OWNER', 'MANAGER', 'EMPLOYEE'] }],
      columns: [
        { label: 'Name', sort: 'name', key: 'name' }, { label: 'Email', sort: 'email', key: 'email' },
        { label: 'Role', sort: 'role', render: (r) => badge(r.role) },
        { label: 'Reports to', render: (r) => r.reports_to_name || '' },
        { label: 'Joined', sort: 'joined_at', render: (r) => fmt(r.joined_at) },
        { label: 'Actions', render: (r) => {
          if (r.role === 'OWNER') return '';
          const box = h('div', { class: 'row' });
          if (state.role === 'OWNER') {
            const sel = h('select', {}, ['MANAGER', 'EMPLOYEE'].map((x) => h('option', { value: x, selected: x === r.role ? '' : false }, x)));
            sel.addEventListener('change', async () => {
              try { await api(`/orgs/${orgId}/members/${r.user_id}`, { method: 'PATCH', body: { role: sel.value } }); toast('Role updated'); } catch (e) { showError(e); }
              lv.reload();
            });
            box.append(sel);
          }
          if (state.role === 'OWNER' || r.role === 'EMPLOYEE') {
            box.append(h('button', { class: 'danger', onclick: async () => {
              if (!confirm(`Remove ${r.name}?`)) return;
              try { await api(`/orgs/${orgId}/members/${r.user_id}`, { method: 'DELETE' }); toast('Member removed'); } catch (e) { showError(e); }
              lv.reload();
            } }, 'Remove'));
          }
          return box;
        } },
      ],
    });
    wrap.append(h('h2', {}, 'Members'), lv);
    if (canSupervise()) {
      wrap.append(h('h2', {}, 'Add a member (they must have registered already)'),
        form([{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'role', label: 'Role', options: roles }], 'Add member',
          async (d, f) => { await api(`/orgs/${orgId}/members`, { method: 'POST', body: d }); toast('Member added'); f.reset(); lv.reload(); }));
    }
    return wrap;
  }

  // ---- projects
  function projectsTab() {
    const orgId = state.org.id;
    const wrap = h('section', {});
    const lv = listView({
      fetcher: (qs) => api(`/orgs/${orgId}/projects${qs}`), sortBy: 'created_at',
      filters: [{ name: 'search', label: 'Search name or key' }, { name: 'status', label: 'statuses', options: ['ACTIVE', 'ARCHIVED'] }],
      columns: [
        { label: 'Key', sort: 'project_key', key: 'project_key' },
        { label: 'Name', sort: 'name', render: (r) => h('button', { class: 'link', onclick: () => openProject(r.id) }, r.name) },
        { label: 'Status', sort: 'status', render: (r) => badge(r.status) },
        { label: 'Manager', key: 'manager_name' }, { label: 'Members', key: 'member_count' }, { label: 'Tasks', key: 'task_count' },
        { label: 'Created', sort: 'created_at', render: (r) => fmt(r.created_at) },
      ],
    });
    wrap.append(h('h2', {}, 'Projects'), lv);
    if (canSupervise()) {
      wrap.append(h('h2', {}, 'Create a project'),
        form([{ name: 'name', label: 'Name', required: true }, { name: 'projectKey', label: 'Key (e.g. WEB)', required: true }, { name: 'description', label: 'Description' }], 'Create project',
          async (d, f) => { await api(`/orgs/${orgId}/projects`, { method: 'POST', body: d }); toast('Project created'); f.reset(); lv.reload(); }));
    }
    return wrap;
  }

  async function openProject(projectId) {
    const orgId = state.org.id;
    let p; let members;
    try {
      p = (await api(`/orgs/${orgId}/projects/${projectId}`)).data;
      members = (await api(`/orgs/${orgId}/projects/${projectId}/members`)).data;
    } catch (e) { return showError(e); }
    const manage = state.role === 'OWNER' || p.manager_id === state.me.id;
    const reopen = () => openProject(projectId);

    const taskList = listView({
      fetcher: (qs) => api(`/orgs/${orgId}/projects/${projectId}/tasks${qs}`), sortBy: 'created_at',
      filters: [{ name: 'search', label: 'Search tasks' }, { name: 'status', label: 'statuses', options: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] }, { name: 'priority', label: 'priorities', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }],
      columns: taskColumns(() => taskList.reload(), manage),
    });

    const memberRows = members.map((m) => h('li', {}, `${m.name} (${m.role}) `,
      manage && m.user_id !== p.manager_id ? h('button', { class: 'danger', onclick: async () => {
        try { await api(`/orgs/${orgId}/projects/${projectId}/members/${m.user_id}`, { method: 'DELETE' }); reopen(); } catch (e) { showError(e); }
      } }, 'Remove') : null));

    const stats = h('p', { class: 'stats' }, Object.entries(p.taskStats).map(([k, v]) => h('span', {}, `${k}: ${v}`)));
    $app.replaceChildren(
      h('button', { class: 'secondary', onclick: () => openOrg(orgId, 'Projects') }, 'Back to projects'),
      h('h1', {}, `${p.project_key} \u2013 ${p.name} `, badge(p.status)),
      h('p', { class: 'muted' }, `Manager: ${p.manager_name} \u2022 ${p.member_count} members`), stats,
      h('section', {}, h('h2', {}, 'Members'), h('ul', {}, memberRows),
        manage ? await addProjectMemberForm(orgId, projectId, members, reopen) : null),
      h('section', {}, h('h2', {}, 'Tasks'), taskList,
        manage ? h('div', {}, h('h2', {}, 'Create a task'),
          form([{ name: 'title', label: 'Title', required: true }, { name: 'description', label: 'Description', type: 'textarea' },
            { name: 'priority', label: 'Priority', options: ['MEDIUM', 'LOW', 'HIGH', 'CRITICAL'] },
            { name: 'assigneeId', label: 'Assignee', options: [{ value: '', label: 'Unassigned' }, ...members.map((m) => ({ value: m.user_id, label: m.name }))] },
            { name: 'dueDate', label: 'Due date', type: 'date' }], 'Create task',
          async (d, f) => { await api(`/orgs/${orgId}/projects/${projectId}/tasks`, { method: 'POST', body: d }); toast('Task created'); f.reset(); reopen(); })) : null));
  }

  async function addProjectMemberForm(orgId, projectId, members, reopen) {
    const all = (await api(`/orgs/${orgId}/members?size=100&sortBy=name&order=asc`)).data;
    const inProject = new Set(members.map((m) => m.user_id));
    const candidates = all.filter((m) => !inProject.has(m.user_id));
    if (!candidates.length) return h('p', { class: 'muted' }, 'Everyone in the organization is already in this project.');
    return form([{ name: 'userId', label: 'Add member', options: candidates.map((m) => ({ value: m.user_id, label: `${m.name} (${m.role})` })) }], 'Add to project',
      async (d) => { await api(`/orgs/${orgId}/projects/${projectId}/members`, { method: 'POST', body: d }); reopen(); });
  }

  function taskColumns(reload, manage) {
    const orgId = state.org.id;
    return [
      { label: 'Key', key: 'task_key' },
      { label: 'Title', sort: 'title', key: 'title' },
      { label: 'Status', sort: 'status', render: (r) => {
        const sel = h('select', { disabled: manage || r.assignee_id === state.me.id ? false : '' },
          ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].map((s) => h('option', { value: s, selected: s === r.status ? '' : false }, s)));
        sel.addEventListener('change', async () => {
          try { await api(`/orgs/${orgId}/tasks/${r.id}`, { method: 'PATCH', body: { status: sel.value } }); toast('Status updated'); } catch (e) { showError(e); }
          reload();
        });
        return sel;
      } },
      { label: 'Priority', sort: 'priority', render: (r) => badge(r.priority) },
      { label: 'Assignee', render: (r) => r.assignee_name || 'Unassigned' },
      { label: 'Due', sort: 'due_date', render: (r) => r.due_date || '' },
      { label: 'Created', sort: 'created_at', render: (r) => fmt(r.created_at) },
      ...(manage ? [{ label: '', render: (r) => h('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Delete ${r.task_key}?`)) return;
        try { await api(`/orgs/${orgId}/tasks/${r.id}`, { method: 'DELETE' }); toast('Task deleted'); } catch (e) { showError(e); }
        reload();
      } }, 'Delete') }] : []),
    ];
  }

  // ---- my tasks (across all projects of this org)
  function myTasksTab() {
    const orgId = state.org.id;
    const lv = listView({
      fetcher: (qs) => api(`/orgs/${orgId}/tasks/mine${qs}`), sortBy: 'due_date', order: 'asc',
      filters: [{ name: 'search', label: 'Search tasks' }, { name: 'status', label: 'statuses', options: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] }, { name: 'overdue', label: 'overdue?', options: ['true'] }],
      columns: [
        { label: 'Key', key: 'task_key' }, { label: 'Title', sort: 'title', key: 'title' }, { label: 'Project', key: 'project_name' },
        ...taskColumns(() => lv.reload(), false).filter((c) => ['Status', 'Priority', 'Due'].includes(c.label)),
      ],
    });
    return h('section', {}, h('h2', {}, 'Tasks assigned to me'), lv);
  }

  // ---- audit log (OWNER only)
  function auditTab() {
    const orgId = state.org.id;
    return h('section', {}, h('h2', {}, 'Audit log'),
      listView({
        fetcher: (qs) => api(`/orgs/${orgId}/audit-logs${qs}`), sortBy: 'created_at',
        filters: [{ name: 'action', label: 'Exact action, e.g. TASK_CREATED' }, { name: 'traceId', label: 'Trace id' }],
        columns: [
          { label: 'Time', sort: 'created_at', render: (r) => fmt(r.created_at) },
          { label: 'User', render: (r) => r.user_name || 'system' },
          { label: 'Action', sort: 'action', key: 'action' },
          { label: 'Entity', render: (r) => r.entity_type || '' },
          { label: 'Trace id', render: (r) => h('code', {}, r.trace_id || '') },
        ],
      }));
  }

  // ------------------------------------------------------------------ start
  (async function init() {
    if (refreshToken && (await doRefresh())) {
      try { await loadMe(); return showOrgs(); } catch (_) { /* fall through to login */ }
    }
    showAuth();
  })();
})();
