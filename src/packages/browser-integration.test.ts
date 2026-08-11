import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shellPath = new URL('./shell/app.js', import.meta.url);
const shellModulePath = new URL('./shell/shell.js', import.meta.url);
const homeModulePath = new URL('./home/home.js', import.meta.url);
const documentationModulePath = new URL('./documentation/documentation.js', import.meta.url);
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }
async function loadCoordinator(window, document) {
  globalThis.window = window; globalThis.document = document; globalThis.__RESONANCE_TEST__ = true;
  let source = await readFile(shellPath, 'utf8');
  source = source.replace("'/assets/shell/shell.js'", JSON.stringify(pathToFileURL(fileURLToPath(shellModulePath)).href));
  const modules = { '/assets/home/home.js': pathToFileURL(fileURLToPath(homeModulePath)).href, '/assets/documentation/documentation.js': pathToFileURL(fileURLToPath(documentationModulePath)).href };
  source = source.replace('import(packageInfo.entry)', `import(${JSON.stringify(modules)}[packageInfo.entry])`);
  const directory = await mkdtemp(`${tmpdir()}/resonance-browser-`); const filename = `${directory}/app.js`; await writeFile(filename, source);
  try { return await import(`${pathToFileURL(filename).href}?${Date.now()}`); } finally { await rm(directory, { recursive: true, force: true }); }
}
function cleanup() { delete globalThis.window; delete globalThis.document; delete globalThis.__RESONANCE_TEST__; }

test('loads browser modules and opens Home from the repository title', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><button type="button" data-shell-repository-name data-shell-home disabled>resonance</button><nav id="primary-navigation"></nav><main id="package-mount"></main></body>');
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === '/api/manifest') return response({ version: 1, navigation: [{ id: 'documentation', label: 'Documentation', order: 20, scope: 'member' }], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }, { id: 'home', entry: '/assets/home/home.js', stylesheet: '/assets/home/home.css' }, { id: 'documentation', entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' }] });
    if (url === '/api/home') return response({ html: '<h1>Fixture Home</h1>' });
    if (url === '/api/documentation/agent/state') return response({ messages: [], status: 'idle', hasSession: false, error: null });
    if (url === '/api/documentation/tree') return response({ rootName: 'fixture', documents: ['README.md'], tree: [{ type: 'file', name: 'README.md', path: 'README.md' }] });
    if (url === '/api/documentation/document?path=README.md') return response({ path: 'README.md', html: '<h1>README</h1>' });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const coordinator = await loadCoordinator(window, document);
    const application = await coordinator.startApplication({ documentRoot: document, fetchFn });
    const home = document.querySelector('[data-shell-home]');
    assert.equal(home.disabled, false);
    assert.equal(home.getAttribute('aria-current'), 'page');
    assert.equal(home.classList.contains('active'), false);
    assert.equal(document.querySelectorAll('#primary-navigation [data-package]').length, 1);
    assert.equal(document.querySelector('#primary-navigation [data-package]').dataset.package, 'documentation');
    assert.equal(document.querySelector('.nav-index').textContent, '01');
    assert.deepEqual([...document.querySelectorAll('.nav-section-label')].map((element) => element.textContent), ['Personal Workspaces']);
    assert.equal(document.querySelectorAll('#package-mount > [data-package]').length, 2);
    assert.equal(document.querySelectorAll('link[data-package-style]').length, 2);
    assert.match(document.querySelector('.package-home').innerHTML, /Fixture Home/);

    await application.activate('documentation');
    assert.equal(home.hasAttribute('aria-current'), false);
    assert.equal(document.querySelector('.package-documentation .document-sidebar .eyebrow').textContent, 'WORKSPACE');
    assert.equal(document.querySelector('.package-documentation .document-sidebar h2').textContent, 'Documentation');
    assert.match(document.querySelector('.package-documentation .document-content').innerHTML, /README/);

    home.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(home.getAttribute('aria-current'), 'page');
    assert.equal(document.querySelector('.package-home').hidden, false);
    assert.deepEqual(calls, ['/api/manifest', '/api/home', '/api/documentation/agent/state', '/api/documentation/tree', '/api/documentation/document?path=README.md', '/api/home']);
  } finally { cleanup(); }
});

test('renders repository and runtime metadata in the Shell frame', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><aside><p class="eyebrow">RESONANCE</p><h1><button type="button" data-shell-repository-name data-shell-home disabled>resonance</button></h1><p data-shell-repository-tagline hidden></p><p data-shell-repository-version hidden></p><nav id="primary-navigation"></nav><div class="primary-footer"><span>v<span data-shell-runtime-version>0.1.0</span></span></div></aside><main id="package-mount"></main></body>');
  const fetchFn = async (url) => {
    if (url === '/api/manifest') return response({ version: 1, repository: { name: 'fixture-app', version: '2.4.0', tagline: 'A fixture application.' }, runtime: { version: '0.1.0' }, navigation: [], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }] });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const coordinator = await loadCoordinator(window, document);
    await coordinator.startApplication({ documentRoot: document, fetchFn });
    assert.equal(document.querySelector('[data-shell-repository-name]').textContent, 'fixture-app');
    assert.equal(document.title, 'fixture-app resonance');
    assert.equal(document.querySelector('[data-shell-home]').disabled, true);
    assert.equal(document.querySelector('[data-shell-repository-version]').textContent, 'v2.4.0');
    assert.equal(document.querySelector('[data-shell-repository-tagline]').textContent, 'A fixture application.');
    assert.equal(document.querySelector('[data-shell-runtime-version]').textContent, '0.1.0');
  } finally { cleanup(); }
});

test('persists light, dark, and system theme preferences in the Shell', async () => {
  const { window, document } = parseHTML('<!doctype html><html><head></head><body><nav id="primary-navigation"></nav><div data-shell-theme-selector><button data-shell-theme="light"></button><button data-shell-theme="dark"></button><button data-shell-theme="system"></button></div><main id="package-mount"></main></body></html>');
  const values = new Map([['resonance:theme', 'system']]);
  const listeners = new Set();
  let systemIsDark = true;
  window.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  window.matchMedia = () => ({
    get matches() { return systemIsDark; },
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
  });
  const fetchFn = async (url) => {
    if (url === '/api/manifest') return response({ version: 1, navigation: [], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }] });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const coordinator = await loadCoordinator(window, document);
    const application = await coordinator.startApplication({ documentRoot: document, windowRoot: window, fetchFn });
    assert.equal(document.documentElement.dataset.themePreference, 'system');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.querySelector('[data-shell-theme="system"]').getAttribute('aria-pressed'), 'true');

    document.querySelector('[data-shell-theme="dark"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(values.get('resonance:theme'), 'dark');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.querySelector('[data-shell-theme="dark"]').getAttribute('aria-pressed'), 'true');

    document.querySelector('[data-shell-theme="light"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(values.get('resonance:theme'), 'light');
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(document.querySelector('[data-shell-theme="light"]').getAttribute('aria-pressed'), 'true');

    document.querySelector('[data-shell-theme="system"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    systemIsDark = false;
    for (const listener of listeners) listener({ matches: false });
    assert.equal(values.get('resonance:theme'), 'system');
    assert.equal(document.documentElement.dataset.theme, 'light');
    application.theme.dispose();
    assert.equal(listeners.size, 0);
  } finally { cleanup(); }
});

test('navigates relative Markdown links inside the Documentation workspace', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><nav id="primary-navigation"></nav><main id="package-mount"></main></body>');
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === '/api/manifest') return response({ version: 1, navigation: [{ id: 'documentation', label: 'Documentation', order: 20 }], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }, { id: 'documentation', entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' }] });
    if (url === '/api/documentation/agent/state') return response({ messages: [], status: 'idle', hasSession: false, error: null });
    if (url === '/api/documentation/tree') return response({ rootName: 'fixture', documents: ['README.md', 'docs/guide.md'], tree: [{ type: 'file', name: 'README.md', path: 'README.md' }, { type: 'folder', name: 'docs', children: [{ type: 'file', name: 'guide.md', path: 'docs/guide.md' }] }] });
    if (url === '/api/documentation/document?path=README.md') return response({ path: 'README.md', html: '<h1>README</h1><p><a href="docs/guide.md">Read the guide</a></p>' });
    if (url === '/api/documentation/document?path=docs%2Fguide.md') return response({ path: 'docs/guide.md', html: '<h1>Guide</h1><p><a href="../README.md">Back to README</a></p>' });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const coordinator = await loadCoordinator(window, document);
    const application = await coordinator.startApplication({ documentRoot: document, fetchFn });
    await application.activate('documentation');
    const link = document.querySelector('.package-documentation .document-content a');
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('.package-documentation .document-path').textContent, 'docs/guide.md');
    assert.match(document.querySelector('.package-documentation .document-content').textContent, /Guide/);
    assert.equal(document.querySelector('.package-documentation .tree-file[data-path="docs/guide.md"]').classList.contains('active'), true);
    assert.deepEqual(calls.slice(-1), ['/api/documentation/document?path=docs%2Fguide.md']);
    const backLink = document.querySelector('.package-documentation .document-content a');
    backLink.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('.package-documentation .document-path').textContent, 'README.md');
  } finally { cleanup(); }
});

test('remembers collapsed Documentation folders in browser storage', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><nav id="primary-navigation"></nav><main id="package-mount"></main></body>');
  const values = new Map();
  window.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const fetchFn = async (url) => {
    if (url === '/api/manifest') return response({ version: 1, navigation: [{ id: 'documentation', label: 'Documentation', order: 20 }], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }, { id: 'documentation', entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' }] });
    if (url === '/api/documentation/agent/state') return response({ messages: [], status: 'idle', hasSession: false, error: null });
    if (url === '/api/documentation/tree') return response({ rootName: 'fixture', documents: ['README.md', 'docs/guide.md'], tree: [{ type: 'file', name: 'README.md', path: 'README.md' }, { type: 'folder', name: 'docs', children: [{ type: 'file', name: 'guide.md', path: 'docs/guide.md' }] }] });
    if (url === '/api/documentation/document?path=README.md') return response({ path: 'README.md', html: '<h1>README</h1>' });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const coordinator = await loadCoordinator(window, document);
    const application = await coordinator.startApplication({ documentRoot: document, fetchFn });
    let folder = document.querySelector('.package-documentation .tree-folder[data-folder-path="docs"]');
    assert.equal(folder.hasAttribute('open'), true);
    folder.removeAttribute('open');
    folder.dispatchEvent(new window.Event('toggle'));
    assert.deepEqual(JSON.parse(values.get('resonance:documentation:collapsed-folders:fixture')), ['docs']);
    await application.activate('documentation');
    folder = document.querySelector('.package-documentation .tree-folder[data-folder-path="docs"]');
    assert.equal(folder.hasAttribute('open'), false);
  } finally { cleanup(); }
});

test('leaves external, fragment, and unsupported Markdown links to the browser', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><nav id="primary-navigation"></nav><main id="package-mount"></main></body>');
  const fetchFn = async (url) => {
    if (url === '/api/manifest') return response({ version: 1, navigation: [{ id: 'documentation', label: 'Documentation', order: 20 }], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }, { id: 'documentation', entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' }] });
    if (url === '/api/documentation/agent/state') return response({ messages: [], status: 'idle', hasSession: false, error: null });
    if (url === '/api/documentation/tree') return response({ rootName: 'fixture', documents: ['README.md'], tree: [{ type: 'file', name: 'README.md', path: 'README.md' }] });
    if (url === '/api/documentation/document?path=README.md') return response({ path: 'README.md', html: '<p><a href="https://example.com">External</a><a href="README.md#section">Fragment</a><a href="image.png">Asset</a></p>' });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const coordinator = await loadCoordinator(window, document);
    const application = await coordinator.startApplication({ documentRoot: document, fetchFn });
    await application.activate('documentation');
    for (const link of document.querySelectorAll('.package-documentation .document-content a')) {
      const event = new window.Event('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
  } finally { cleanup(); }
});

test('keeps a failed package activation local to that package', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><nav id="primary-navigation"></nav><main id="package-mount"></main></body>');
  let homeCalls = 0;
  const fetchFn = async (url) => { if (url === '/api/manifest') return response({ version: 1, navigation: [{ id: 'documentation', label: 'Documentation', order: 20 }], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }, { id: 'home', entry: '/assets/home/home.js', stylesheet: '/assets/home/home.css' }, { id: 'documentation', entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' }] }); if (url === '/api/home') return homeCalls++ === 0 ? response({ html: '<h1>Home</h1>' }) : response({ error: 'missing' }, 404); if (url === '/api/documentation/agent/state') return response({ messages: [], status: 'idle', hasSession: false, error: null }); if (url === '/api/documentation/tree') return response({ rootName: 'fixture', documents: [], tree: [] }); throw new Error(`Unexpected request: ${url}`); };
  try { const coordinator = await loadCoordinator(window, document); const application = await coordinator.startApplication({ documentRoot: document, fetchFn }); await assert.rejects(() => application.activate('home'), /Home source could not be loaded/); await application.activate('documentation'); assert.match(document.querySelector('.package-documentation .document-content').textContent, /no Markdown documents/); } finally { cleanup(); }
});

test('shows the Documentation agent, sends the active document and highlighted text, and refreshes edits', async () => {
  const { window, document } = parseHTML('<!doctype html><head></head><body><nav id="primary-navigation"></nav><main id="package-mount"></main></body>');
  let stream;
  const requests = [];
  let documentVersion = 0;
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/manifest') return response({ version: 1, navigation: [{ id: 'documentation', label: 'Documentation', order: 20 }], packages: [{ id: 'shell', entry: '/assets/app.js', stylesheet: '/assets/shell/shell.css' }, { id: 'documentation', entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' }] });
    if (url === '/api/documentation/agent/state') return response({ messages: [], status: 'idle', hasSession: false, error: null });
    if (url === '/api/documentation/tree') return response({ rootName: 'fixture', documents: ['README.md'], tree: [{ type: 'file', name: 'README.md', path: 'README.md' }] });
    if (url === '/api/documentation/document?path=README.md') return response({ path: 'README.md', html: documentVersion ? '<h1>Updated</h1><p>New copy.</p>' : '<h1>README</h1><p>Highlighted copy.</p>' });
    if (url === '/api/documentation/agent/prompt') return response({ accepted: true });
    throw new Error(`Unexpected request: ${url}`);
  };
  const eventSourceFactory = (url) => { stream = { url, close() {} }; return stream; };
  try {
    const coordinator = await loadCoordinator(window, document);
    const application = await coordinator.startApplication({ documentRoot: document, windowRoot: window, fetchFn, eventSourceFactory });
    await application.activate('documentation');
    const content = document.querySelector('.package-documentation .document-content');
    const selectedNode = content.querySelector('p');
    document.getSelection = () => ({ rangeCount: 1, toString: () => 'Highlighted copy.', getRangeAt: () => ({ commonAncestorContainer: selectedNode }) });
    document.dispatchEvent(new window.Event('selectionchange'));
    assert.match(document.querySelector('.package-documentation .documentation-selection-context').textContent, /Highlighted text included/);
    const toggle = document.querySelector('.package-documentation .documentation-agent-toggle'); toggle.click();
    assert.equal(document.querySelector('.package-documentation .documentation-agent').hidden, true); toggle.click();
    const input = document.querySelector('.package-documentation .documentation-composer textarea'); input.value = 'Reword this'; input.dispatchEvent(new window.Event('input'));
    document.querySelector('.package-documentation .documentation-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = requests.find((request) => request.url === '/api/documentation/agent/prompt');
    assert.deepEqual(JSON.parse(prompt.options.body), { prompt: 'Reword this', selectedPath: 'README.md', selectedText: 'Highlighted copy.' });
    documentVersion = 1; stream.onmessage({ data: JSON.stringify({ type: 'mutation-committed', affectedPaths: ['README.md'] }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(document.querySelector('.package-documentation .document-content').textContent, /New copy/);
  } finally { cleanup(); }
});
