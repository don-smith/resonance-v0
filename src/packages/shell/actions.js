export default function createActionsPackage({ fetchFn = fetch, eventSourceFactory = (url) => new EventSource(url), initialTasks = [], onTasksChanged = () => {}, onCompleted = (url) => { if (typeof window !== 'undefined' && window.location) window.location.assign(url); } } = {}) {
  let root;
  let tasks = initialTasks;
  let selectedTask = null;
  let stream = null;
  let state = { messages: [], status: 'available', preview: null, pendingConfirmation: null, validation: null, error: null };

  const request = async (url, options) => {
    const response = await fetchFn(url, options);
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Resonance Action request failed.'); }
    return response.json().catch(() => ({}));
  };
  function text(selector, value) { const element = root.querySelector(selector); if (element) element.textContent = value || ''; }
  function previewStylesheet(value) {
    return typeof value === 'string' && value.startsWith('/assets/') && !/[\s"'<>\\?#]/.test(value) ? value : null;
  }
  function previewDocument(content, stylesheet) {
    const theme = document.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'light';
    const packageStylesheet = previewStylesheet(stylesheet);
    return `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/assets/shell/shell.css"><link rel="stylesheet" href="/assets/shell/ui.css">${packageStylesheet ? `<link rel="stylesheet" href="${packageStylesheet}">` : ''}</head><body><main>${content}</main></body></html>`;
  }
  function render() {
    if (!root) return;
    const task = tasks.find((item) => item.id === selectedTask) || tasks[0];
    selectedTask = task?.id || null;
    root.innerHTML = `<div class="actions-workspace"><section class="actions-main"><header class="actions-header"><div><p class="actions-package"></p><h1 class="actions-title"></h1><p class="actions-description"></p><p class="actions-status"></p></div><div class="actions-controls"><button type="button" class="actions-run" hidden></button><button type="button" class="actions-dismiss">Dismiss</button><button type="button" class="actions-reset">New attempt</button></div></header><div class="actions-transcript"></div><div class="actions-preview" hidden></div><div class="actions-validation" hidden></div><form class="actions-composer"><textarea rows="3" placeholder="Describe what you want this action to do…"></textarea><div><button type="button" class="actions-stop" hidden>Stop</button><button type="submit" class="actions-send">Prepare</button></div></form></section></div>`;
    if (!task) { root.querySelector('.actions-main').innerHTML = '<p class="actions-empty">No Resonance Actions are currently available.</p>'; return; }
    text('.actions-package', `${task.packageLabel} · ${task.category}`); text('.actions-title', task.label); text('.actions-description', task.description || task.summary);
    renderState();
  }
  function renderState() {
    if (!root || !root.querySelector('.actions-transcript')) return;
    const task = tasks.find((item) => item.id === selectedTask) || tasks[0];
    const transcript = root.querySelector('.actions-transcript'); transcript.innerHTML = '';
    for (const message of state.messages || []) { const article = document.createElement('article'); article.className = `actions-message actions-message-${message.role}`; const heading = document.createElement('strong'); heading.textContent = message.role === 'user' ? 'You' : 'Resonance'; const body = document.createElement('p'); body.textContent = message.content; article.append(heading, body); transcript.append(article); }
    const preview = root.querySelector('.actions-preview'); preview.hidden = !state.preview; preview.innerHTML = '';
    if (state.preview) { const heading = document.createElement('h3'); heading.textContent = state.preview.title; const summary = document.createElement('p'); summary.textContent = state.preview.summary || ''; const paths = document.createElement('p'); paths.textContent = `Affected: ${state.preview.affectedPaths.join(', ')}`; preview.append(heading, summary, paths); if (state.preview.configuration) { const configuration = document.createElement('p'); configuration.textContent = `Configuration: ${JSON.stringify(state.preview.configuration)}`; preview.append(configuration); } if (state.preview.content) { if (state.preview.contentType === 'html') { const frame = document.createElement('iframe'); frame.className = 'actions-preview-frame'; frame.title = 'Rendered Task preview'; frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.srcdoc = previewDocument(state.preview.content, state.preview.stylesheet); preview.append(frame); const details = document.createElement('details'); const sourceSummary = document.createElement('summary'); sourceSummary.textContent = 'View HTML source'; const pre = document.createElement('pre'); pre.textContent = state.preview.content; details.append(sourceSummary, pre); preview.append(details); } else { const pre = document.createElement('pre'); pre.textContent = state.preview.content; preview.append(pre); } } if (state.pendingConfirmation) { const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'actions-confirm'; confirm.textContent = 'Apply changes'; confirm.addEventListener('click', confirmPreview); preview.append(confirm); } }
    const validation = root.querySelector('.actions-validation'); validation.hidden = !state.validation; if (state.validation) { validation.textContent = state.validation.message; validation.dataset.valid = String(state.validation.valid); }
    text('.actions-status', state.status === 'in-progress' ? 'Working…' : state.error || '');
    const composer = root.querySelector('.actions-composer');
    const needsFollowUp = !task?.start || Boolean(state.messages?.length) || state.status !== 'available' || Boolean(state.error);
    if (composer) { composer.hidden = !needsFollowUp; composer.querySelector('textarea').disabled = state.status === 'in-progress'; }
    const run = root.querySelector('.actions-run'); if (run) { run.hidden = !task?.start || needsFollowUp; run.textContent = task?.start?.label || ''; }
    root.querySelector('.actions-send')?.toggleAttribute('hidden', state.status === 'in-progress'); root.querySelector('.actions-stop')?.toggleAttribute('hidden', state.status !== 'in-progress');
  }
  function handleEvent(event) {
    const value = JSON.parse(event.data);
    if (value.type === 'snapshot') state = value.snapshot;
    if (value.type === 'message') { const existing = state.messages.find((item) => item.id === value.message.id); if (existing) existing.content = value.message.content; else state.messages.push(value.message); }
    if (value.type === 'status') state.status = value.status;
    if (value.type === 'preview') state.preview = value.preview;
    if (value.type === 'confirmation-required') state.pendingConfirmation = value.confirmation;
    if (value.type === 'validation') state.validation = value.validation;
    if (value.type === 'error') state.error = value.message;
    renderState();
  }
  function connect() { stream?.close(); if (!selectedTask || !eventSourceFactory) return; stream = eventSourceFactory(`/api/actions/events?task=${encodeURIComponent(selectedTask)}`); stream.onmessage = handleEvent; }
  async function loadTasks() { const result = await request('/api/actions/tasks'); tasks = result.tasks || []; onTasksChanged(tasks); if (!tasks.some((item) => item.id === selectedTask)) selectedTask = tasks[0]?.id || null; render(); connect(); if (selectedTask) state = await request(`/api/actions/state?task=${encodeURIComponent(selectedTask)}`); renderState(); }
  async function select(taskId) { if (!tasks.some((item) => item.id === taskId)) return; selectedTask = taskId; state = await request(`/api/actions/state?task=${encodeURIComponent(taskId)}`); render(); connect(); }
  async function start() { const task = tasks.find((item) => item.id === selectedTask); if (!task?.start || state.status === 'in-progress') return; await request('/api/actions/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: selectedTask, prompt: task.start.prompt }) }); }
  async function submit(event) { event.preventDefault(); const field = root.querySelector('.actions-composer textarea'); if (!selectedTask || !field.value.trim()) return; await request('/api/actions/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: selectedTask, prompt: field.value.trim() }) }); field.value = ''; }
  async function confirmPreview() { const task = tasks.find((item) => item.id === selectedTask); await request('/api/actions/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: selectedTask, confirmationId: state.pendingConfirmation.id }) }); if (task?.completedUrl) await onCompleted(task.completedUrl); else await loadTasks(); }
  async function stop() { await request('/api/actions/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: selectedTask }) }); }
  async function reset() { await request('/api/actions/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: selectedTask }) }); state = { messages: [], status: 'available', preview: null, pendingConfirmation: null, validation: null, error: null }; renderState(); }
  async function dismiss() { await request('/api/actions/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: selectedTask }) }); await loadTasks(); }
  return { mount(mountRoot) { root = mountRoot; render(); root.addEventListener('click', (event) => { if (event.target.closest('.actions-run')) start(); if (event.target.closest('.actions-stop')) stop(); if (event.target.closest('.actions-reset')) reset(); if (event.target.closest('.actions-dismiss')) dismiss(); }); root.addEventListener('submit', submit); }, async activate() { root.hidden = false; await loadTasks(); }, deactivate() { stream?.close(); root.hidden = true; }, selectTask: select };
}
