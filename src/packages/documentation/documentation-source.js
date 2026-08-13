import createAgentPanel from '../../ui/agent-panel.js';

function formatTokenCount(value) { if (value >= 1000000) { const rounded = Math.floor(value / 100000) / 10; return `${rounded % 1 === 0 ? rounded : rounded.toFixed(1)}M`; } if (value >= 1000) return `${Math.floor(value / 1000)}k`; return String(Math.floor(value)); }
function formatContextUsage(context) { return context ? `${formatTokenCount(context.inputTokens)} / ${formatTokenCount(context.maxInputTokens)}` : ''; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

const COLLAPSED_FOLDERS_STORAGE_PREFIX = 'resonance:documentation:collapsed-folders:';
const AGENT_VISIBLE_STORAGE_KEY = 'resonance:documentation:agent-visible';
const SELECTED_PATH_STORAGE_KEY = 'resonance:documentation:selected-path';

function resolveDocumentLink(href, currentPath, documents) {
  if (!href || !currentPath || href.startsWith('/') || href.startsWith('#')) return null;
  let target;
  try { target = new URL(href, `https://resonance.local/${currentPath}`); } catch { return null; }
  if (target.origin !== 'https://resonance.local' || target.search || target.hash) return null;
  let documentPath;
  try { documentPath = decodeURIComponent(target.pathname.slice(1)); } catch { return null; }
  return documents.includes(documentPath) ? documentPath : null;
}
function getStorage() { try { return typeof window !== 'undefined' ? window.localStorage || null : null; } catch { return null; } }
function readCollapsedFolders(storage, key) {
  if (!storage) return new Set();
  try { const value = JSON.parse(storage.getItem(key) || '[]'); return new Set(Array.isArray(value) ? value.filter((folder) => typeof folder === 'string') : []); } catch { return new Set(); }
}
function writeCollapsedFolders(storage, key, folders) { if (!storage || !key) return; try { storage.setItem(key, JSON.stringify([...folders].sort())); } catch { /* Browser storage may be unavailable or full. */ } }
function readBoolean(storage, key, fallback) { if (!storage) return fallback; try { const value = storage.getItem(key); return value === null ? fallback : value === 'true'; } catch { return fallback; } }
function writeBoolean(storage, key, value) { if (!storage) return; try { storage.setItem(key, String(value)); } catch { /* Browser storage may be unavailable or full. */ } }
function readString(storage, key) { if (!storage) return null; try { const value = storage.getItem(key); return typeof value === 'string' && value ? value : null; } catch { return null; } }
function writeString(storage, key, value) { if (!storage) return; try { if (value) storage.setItem(key, value); else storage.removeItem(key); } catch { /* Browser storage may be unavailable or full. */ } }
function renderTree(nodes, parentPath = '', collapsedFolders = new Set()) {
  return nodes.map((node) => {
    if (node.type === 'folder') {
      const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
      const open = collapsedFolders.has(folderPath) ? '' : ' open';
      return `<details class="tree-folder" data-folder-path="${escapeHtml(folderPath)}"${open}><summary>${escapeHtml(node.name)}</summary><div class="tree-children">${renderTree(node.children, folderPath, collapsedFolders)}</div></details>`;
    }
    return `<button class="tree-file" type="button" data-path="${escapeHtml(node.path)}">${escapeHtml(node.name)}</button>`;
  }).join('');
}

export default function createDocumentationPackage({ fetchFn = fetch, eventSourceFactory = (url) => typeof window !== 'undefined' && typeof window.EventSource === 'function' ? new window.EventSource(url) : null } = {}) {
  let root;
  let repository = { documents: [] };
  let selectedPath = null;
  let highlightedText = '';
  let treeElement;
  let contentElement;
  let countElement;
  let pathElement;
  let workspace;
  let agentToggle;
  let agentUi;
  let eventSource = null;
  let active = false;
  let credentialRequired = false;
  let retryVisible = false;
  let lastPrompt = null;
  let stopPending = false;
  let chatState = { messages: [], status: 'idle', error: null, context: null };
  let collapsedFolders = new Set();
  let collapsedFoldersStorage;
  let collapsedFoldersStorageKey;
  let agentVisible = true;

  agentUi = createAgentPanel({
    prefix: 'documentation',
    label: 'AGENT / CHAT',
    ariaLabel: 'Documentation agent',
    placeholder: 'Ask about this document…',
    supportsStop: true,
    onSend: (prompt) => submitPrompt(prompt),
    onStop: () => stop(),
    onReset: () => reset(),
    onRetry: () => { if (lastPrompt) return submitPrompt(lastPrompt); },
    onCredential: (key) => saveCredentialValue(key),
    onError: (error) => { chatState.error = error?.message || String(error); renderAgent(); },
  });

  function showError(element, error) {
    element.innerHTML = '<p class="documentation-error"></p>';
    element.querySelector('.documentation-error').textContent = error?.message || String(error);
  }
  function setAgentVisible(show) {
    agentVisible = show;
    writeBoolean(collapsedFoldersStorage, AGENT_VISIBLE_STORAGE_KEY, show);
    agentUi.setVisible(show);
    workspace.classList.toggle('documentation-agent-hidden', !show);
    agentToggle.setAttribute('aria-expanded', String(show));
    const label = show ? 'Hide agent panel' : 'Show agent panel';
    agentToggle.setAttribute('aria-label', label); agentToggle.title = label;
  }
  function renderSelectionContext() {
    const auxiliary = agentUi.auxiliary;
    if (!auxiliary) return;
    auxiliary.replaceChildren();
    if (highlightedText) {
      const notice = auxiliary.ownerDocument.createElement('p');
      notice.className = 'documentation-selection-context';
      notice.textContent = `Highlighted text included (${highlightedText.length} characters).`;
      auxiliary.append(notice);
    }
  }
  function renderAgent() {
    agentUi.update({ messages: chatState.messages, status: chatState.status, error: chatState.error, stopPending, credentialRequired, retryVisible, contextUsage: formatContextUsage(chatState.context), canSend: () => Boolean(selectedPath && agentUi.prompt.trim()) });
    renderSelectionContext();
  }
  function showCredential(show = true) { credentialRequired = show; agentUi.update({ credentialRequired }); if (show) agentUi.focusCredential(); }
  function applySnapshot(snapshot, replaceMessages = false) {
    chatState = { messages: replaceMessages ? snapshot.messages || [] : (snapshot.messages?.length ? snapshot.messages : chatState.messages), status: snapshot.status || 'idle', error: snapshot.error || null, context: snapshot.context === undefined ? chatState.context : snapshot.context };
    renderAgent();
  }
  function applyMessage(message) {
    const index = chatState.messages.findIndex((item) => item.id === message.id);
    if (index < 0) chatState.messages = [...chatState.messages, message]; else chatState.messages[index] = message;
    renderAgent();
  }
  function handleEvent(event) {
    let value;
    try { value = event?.data ? JSON.parse(event.data) : event; } catch { return; }
    if (!value || typeof value.type !== 'string') return;
    if (value.type === 'snapshot') applySnapshot(value.snapshot);
    else if (value.type === 'message') applyMessage(value.message);
    else if (value.type === 'status') { chatState.status = value.status; renderAgent(); }
    else if (value.type === 'context') { chatState.context = value.context; renderAgent(); }
    else if (value.type === 'error') { chatState.error = value.message; retryVisible = Boolean(lastPrompt); renderAgent(); }
    else if (value.type === 'credential-required') showCredential(true);
    else if (value.type === 'mutation-committed') { highlightedText = ''; renderSelectionContext(); if (selectedPath) void showDocument(selectedPath).catch((error) => showError(contentElement, error)); }
    else if (value.type === 'stopped' || value.type === 'done') { stopPending = false; renderAgent(); if (selectedPath) void showDocument(selectedPath).catch((error) => showError(contentElement, error)); }
  }
  function connectEvents() {
    if (eventSource || !active) return;
    eventSource = eventSourceFactory('/api/documentation/agent/events');
    if (!eventSource) return;
    eventSource.onmessage = handleEvent;
    eventSource.onerror = () => { if (active) chatState.error = 'Connection interrupted'; renderAgent(); };
  }
  function closeEvents() { if (eventSource) eventSource.close(); eventSource = null; }
  async function showDocument(documentPath) {
    const response = await fetchFn(`/api/documentation/document?path=${encodeURIComponent(documentPath)}`);
    if (!response.ok) throw new Error('Document could not be loaded.');
    const documentData = await response.json();
    if (selectedPath !== documentData.path) highlightedText = '';
    selectedPath = documentData.path;
    writeString(collapsedFoldersStorage, SELECTED_PATH_STORAGE_KEY, selectedPath);
    pathElement.textContent = documentData.path;
    root.querySelectorAll('.tree-file').forEach((button) => button.classList.toggle('active', button.dataset.path === documentData.path));
    contentElement.innerHTML = documentData.html;
    renderAgent();
  }
  async function loadTree() {
    treeElement.innerHTML = '<p class="documentation-loading">Loading repository…</p>';
    contentElement.innerHTML = '<p class="documentation-loading">Loading repository…</p>';
    const response = await fetchFn('/api/documentation/tree');
    if (!response.ok) throw new Error('Repository tree could not be loaded.');
    repository = await response.json();
    countElement.textContent = repository.documents.length;
    collapsedFoldersStorage = getStorage();
    collapsedFoldersStorageKey = `${COLLAPSED_FOLDERS_STORAGE_PREFIX}${encodeURIComponent(repository.rootName)}`;
    collapsedFolders = readCollapsedFolders(collapsedFoldersStorage, collapsedFoldersStorageKey);
    treeElement.innerHTML = renderTree(repository.tree, '', collapsedFolders);
    const folderPaths = new Set([...treeElement.querySelectorAll('.tree-folder')].map((folder) => folder.dataset.folderPath));
    collapsedFolders = new Set([...collapsedFolders].filter((folder) => folderPaths.has(folder)));
    writeCollapsedFolders(collapsedFoldersStorage, collapsedFoldersStorageKey, collapsedFolders);
    treeElement.querySelectorAll('.tree-folder').forEach((folder) => folder.addEventListener('toggle', () => {
      const folderPath = folder.dataset.folderPath; if (!folderPath) return;
      if (folder.hasAttribute('open')) collapsedFolders.delete(folderPath); else collapsedFolders.add(folderPath);
      writeCollapsedFolders(collapsedFoldersStorage, collapsedFoldersStorageKey, collapsedFolders);
    }));
    const remembered = selectedPath && repository.documents.includes(selectedPath) ? selectedPath : null;
    const first = remembered || repository.documents.find((path) => /^readme\.md$/i.test(path)) || repository.documents[0];
    if (first) await showDocument(first);
    else { selectedPath = null; writeString(collapsedFoldersStorage, SELECTED_PATH_STORAGE_KEY, null); pathElement.textContent = 'documentation'; contentElement.innerHTML = '<p class="documentation-loading">This repository has no Markdown documents yet.</p>'; renderAgent(); }
  }
  async function json(url, options) { const response = await fetchFn(url, options); if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Documentation agent request failed.'); return response.json(); }
  async function submitPrompt(prompt = agentUi.prompt) {
    const value = prompt.trim();
    if (!value || !selectedPath || chatState.status === 'working') return;
    lastPrompt = value;
    const response = await fetchFn('/api/documentation/agent/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value, selectedPath, ...(highlightedText ? { selectedText: highlightedText } : {}) }) });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Prompt could not be submitted.');
    const result = await response.json();
    if (result.credentialRequired) showCredential(true); else { agentUi.clearPrompt(); retryVisible = false; }
    renderAgent();
  }
  async function stop() { if (chatState.status !== 'working' || stopPending) return; stopPending = true; renderAgent(); try { const result = await json('/api/documentation/agent/stop', { method: 'POST' }); if (result.state) applySnapshot(result.state, true); } finally { stopPending = false; renderAgent(); } }
  async function saveCredentialValue(apiKey) { await json('/api/documentation/agent/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }) }); showCredential(false); retryVisible = Boolean(lastPrompt); renderAgent(); }
  async function reset() { await json('/api/documentation/agent/reset', { method: 'POST' }); lastPrompt = null; retryVisible = false; stopPending = false; highlightedText = ''; agentUi.clearPrompt(); showCredential(false); chatState = { messages: [], status: 'idle', error: null, context: null }; renderAgent(); }

  return {
    mount(mountRoot) {
      root = mountRoot;
      root.innerHTML = '<section class="documentation-layout" aria-label="Documentation"><aside class="document-sidebar"><div class="document-sidebar-head"><p class="eyebrow">WORKSPACE</p><h2>Documentation</h2><p class="document-count"><span class="count">—</span> documents</p></div><nav class="document-tree" aria-label="Markdown document tree"><p class="documentation-loading">Loading repository…</p></nav></aside><article class="document-pane"><header class="document-header"><span class="section-label">DOCUMENTATION</span><span class="header-rule" aria-hidden="true"></span><span class="document-path">documentation</span><button type="button" class="documentation-agent-toggle" aria-controls="documentation-agent-panel" aria-expanded="true" aria-label="Hide agent panel" title="Hide agent panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"></path></svg></button></header><div class="document-content" aria-live="polite"><p class="documentation-loading">Loading repository…</p></div></article><div class="documentation-agent-slot"></div></section>';
      workspace = root.querySelector('.documentation-layout'); treeElement = root.querySelector('.document-tree'); contentElement = root.querySelector('.document-content'); countElement = root.querySelector('.count'); pathElement = root.querySelector('.document-path'); agentToggle = root.querySelector('.documentation-agent-toggle');
      agentUi.mount(root.querySelector('.documentation-agent-slot')); agentUi.root.id = 'documentation-agent-panel';
      setAgentVisible(true); renderAgent();
      agentToggle.addEventListener('click', () => setAgentVisible(agentUi.root.hidden));
      contentElement.addEventListener('click', async (event) => { const link = event.target?.closest?.('a[href]'); if (!link || !contentElement.contains(link)) return; const documentPath = resolveDocumentLink(link.getAttribute('href'), selectedPath, repository.documents); if (!documentPath) return; event.preventDefault(); try { await showDocument(documentPath); } catch (error) { showError(contentElement, error); } });
      treeElement.addEventListener('click', async (event) => { const button = event.target.closest('[data-path]'); if (!button || !treeElement.contains(button)) return; try { await showDocument(button.dataset.path); } catch (error) { showError(contentElement, error); } });
      contentElement.ownerDocument.addEventListener('selectionchange', () => {
        const selection = contentElement.ownerDocument.getSelection?.();
        if (!selection || !selection.rangeCount || !selection.toString().trim()) return;
        const range = selection.getRangeAt(0);
        if (!contentElement.contains(range.commonAncestorContainer)) return;
        highlightedText = selection.toString().trim().slice(0, 32 * 1024);
        renderSelectionContext();
      });
    },
    async activate() {
      active = true;
      collapsedFoldersStorage = getStorage();
      agentVisible = readBoolean(collapsedFoldersStorage, AGENT_VISIBLE_STORAGE_KEY, true);
      selectedPath = readString(collapsedFoldersStorage, SELECTED_PATH_STORAGE_KEY);
      setAgentVisible(agentVisible);
      root.hidden = false;
      connectEvents();
      try { const state = await json('/api/documentation/agent/state'); applySnapshot(state, true); await loadTree(); }
      catch (error) { showError(treeElement, error); showError(contentElement, error); throw error; }
    },
    deactivate() { active = false; closeEvents(); root.hidden = true; },
  };
}
