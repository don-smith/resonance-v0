import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import createActionsPackage from './actions.js';

test('offers a zero-input start button and keeps follow-up chat available after starting', async () => {
  const { document } = parseHTML('<!doctype html><body><main id="actions"></main></body>');
  const calls: Array<{ taskId: string; prompt: string }> = [];
  const task = { id: 'home:create-home-page', label: 'Create Home page', packageLabel: 'Home', category: 'onboarding', description: 'Create it.', start: { label: 'Create Home page', prompt: 'Create the page.' } };
  const fetchFn = async (url: string, options?: { body?: string }) => {
    if (url === '/api/actions/tasks') return { ok: true, async json() { return { tasks: [task] }; } };
    if (url.includes('/api/actions/state')) return { ok: true, async json() { return { messages: [], status: 'available', preview: null, pendingConfirmation: null, validation: null, error: null }; } };
    if (url === '/api/actions/prompt') { calls.push(JSON.parse(options?.body || '{}')); return { ok: true, async json() { return { accepted: true }; } }; }
    return { ok: true, async json() { return {}; } };
  };
  const controller = createActionsPackage({ fetchFn, eventSourceFactory: () => ({ close() {}, onmessage: null }) });
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = document;
  try {
    controller.mount(document.querySelector('#actions'));
    await controller.activate();
    assert.equal(document.querySelector('.actions-composer').hidden, true);
    document.querySelector('.actions-run').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ taskId: 'home:create-home-page', prompt: 'Create the page.' }]);
  } finally {
    (globalThis as { document?: unknown }).document = previousDocument;
  }
});

test('renders text previews literally instead of treating them as HTML', async () => {
  const { document } = parseHTML('<!doctype html><body><main id="actions"></main></body>');
  const task = { id: 'tasks:plain-preview', label: 'Plain preview', packageLabel: 'Tasks', category: 'maintenance', description: 'Show it.', start: { label: 'Show preview', prompt: 'Show it.' } };
  const preview = { id: 'preview', title: 'Preview', content: '<em>literal source</em>', affectedPaths: ['fixture.txt'], requiresConfirmation: true };
  const state = { messages: [], status: 'available', preview, pendingConfirmation: null, validation: null, error: null };
  const fetchFn = async (url: string) => {
    if (url === '/api/actions/tasks') return { ok: true, async json() { return { tasks: [task] }; } };
    if (url.includes('/api/actions/state')) return { ok: true, async json() { return state; } };
    return { ok: true, async json() { return {}; } };
  };
  const controller = createActionsPackage({ fetchFn, eventSourceFactory: () => ({ close() {}, onmessage: null }) });
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = document;
  try {
    controller.mount(document.querySelector('#actions'));
    await controller.activate();
    assert.equal(document.querySelector('iframe'), null);
    assert.equal(document.querySelector('.actions-preview pre').textContent, '<em>literal source</em>');
  } finally {
    (globalThis as { document?: unknown }).document = previousDocument;
  }
});

test('renders HTML previews with the contributing package stylesheet', async () => {
  const { document } = parseHTML('<!doctype html><body><main id="actions"></main></body>');
  const task = { id: 'tasks:html-preview', label: 'HTML preview', packageLabel: 'Tasks', category: 'maintenance', description: 'Show it.', start: { label: 'Show preview', prompt: 'Show it.' } };
  const preview = { id: 'preview', title: 'Preview', content: '<section class="package-preview"><h1>Preview</h1></section>', contentType: 'html', stylesheet: '/assets/tasks/preview.css', affectedPaths: ['fixture.txt'], requiresConfirmation: true };
  const state = { messages: [], status: 'available', preview, pendingConfirmation: null, validation: null, error: null };
  const fetchFn = async (url: string) => {
    if (url === '/api/actions/tasks') return { ok: true, async json() { return { tasks: [task] }; } };
    if (url.includes('/api/actions/state')) return { ok: true, async json() { return state; } };
    return { ok: true, async json() { return {}; } };
  };
  const controller = createActionsPackage({ fetchFn, eventSourceFactory: () => ({ close() {}, onmessage: null }) });
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = document;
  try {
    controller.mount(document.querySelector('#actions'));
    await controller.activate();
    const frame = document.querySelector('iframe');
    assert.ok(frame);
    assert.match(frame.srcdoc, /assets\/tasks\/preview\.css/);
    assert.doesNotMatch(frame.srcdoc, /assets\/home\/home\.css/);
  } finally {
    (globalThis as { document?: unknown }).document = previousDocument;
  }
});

test('uses the shell navigation for actions and follows a completed URL', async () => {
  const { document } = parseHTML('<!doctype html><body><main id="actions"></main></body>');
  const completed: string[] = [];
  const task = { id: 'home:create-home-page', label: 'Create Home page', packageLabel: 'Home', category: 'onboarding', description: 'Create it.', completedUrl: '/', start: { label: 'Create Home page', prompt: 'Create the page.' } };
  const preview = { id: 'preview', title: 'Preview', content: '<section class="repository-home"><h1>Home</h1></section>', contentType: 'html', stylesheet: '/assets/home/home.css', affectedPaths: ['.resonance/home.html'], requiresConfirmation: true };
  const state = { messages: [], status: 'available', preview, pendingConfirmation: { id: 'confirmation', preview }, validation: null, error: null };
  const fetchFn = async (url: string) => {
    if (url === '/api/actions/tasks') return { ok: true, async json() { return { tasks: [task] }; } };
    if (url.includes('/api/actions/state')) return { ok: true, async json() { return state; } };
    if (url === '/api/actions/confirm') return { ok: true, async json() { return { message: 'Applied.' }; } };
    return { ok: true, async json() { return {}; } };
  };
  const controller = createActionsPackage({ fetchFn, eventSourceFactory: () => ({ close() {}, onmessage: null }), onCompleted: async (url) => { completed.push(url); } });
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = document;
  try {
    controller.mount(document.querySelector('#actions'));
    await controller.activate();
    assert.equal(document.querySelector('.actions-list'), null);
    document.querySelector('.actions-confirm').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(completed, ['/']);
  } finally {
    (globalThis as { document?: unknown }).document = previousDocument;
  }
});
