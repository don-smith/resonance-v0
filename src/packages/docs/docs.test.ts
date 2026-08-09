import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../../host.ts';
import { createApp } from '../../server.ts';
import shellPackage from '../shell/index.ts';
import { createDocsPackage, docsInput } from './index.ts';
import { parseHTML } from 'linkedom';
import createBrowser from './docs.js';
import { writeDocsDocument, type DocsAgentRuntimeFactory } from './docs-agent.ts';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = { version: 1 as const, packages: { shell: { module: 'src/packages/shell/index.ts' }, docs: { module: 'src/packages/docs/index.ts', provider: 'openai', model: 'test-model' } } };

async function withServer(root: string, runtimeFactory: DocsAgentRuntimeFactory, run: (base: string, turns: any[]) => Promise<void>) {
  const turns: any[] = [];
  const registry = createHost({ root, appRoot, config, packages: [shellPackage, createDocsPackage({ runtimeFactory })] });
  const server = await createApp({ root, appRoot, registry });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as any).port}`, turns); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('validates Docs defaults and agent-specific inputs', () => {
  assert.deepEqual(docsInput({}), { extensions: ['.md', '.markdown'], ignoredDirectories: ['.git', 'node_modules'], provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(docsInput({ provider: 'openai', model: 'gpt-test', extensions: ['.md'], ignoredDirectories: ['vendor'] }), { extensions: ['.md'], ignoredDirectories: ['vendor'], provider: 'openai', model: 'gpt-test' });
  assert.throws(() => docsInput({ provider: 'local', model: 'test' }), /provider/);
  assert.throws(() => docsInput({ provider: 'openai', model: '' }), /model/);
});

test('keeps the Docs agent toggle in the same right-side position at every breakpoint', async () => {
  const css = await readFile(new URL('./docs.css', import.meta.url), 'utf8');
  assert.deepEqual([...css.matchAll(/\.docs-agent-toggle \{[^}]*right: (\d+)px;/gs)].map((match) => match[1]), ['20', '20', '20']);
  assert.match(css, /\.tree-file:hover, \.tree-file\.active \{[^}]*background: var\(--accent-soft\);[^}]*color: var\(--ink\);/s);
  assert.match(css, /\.tree-file:hover \{[^}]*width: calc\(100% - 6px\);[^}]*margin-right: 6px;/s);
  assert.match(css, /\.tree-file\.active \{[^}]*width: calc\(100% - 6px\);[^}]*margin-right: 6px;[^}]*border-left-color: var\(--accent\);/s);
  assert.doesNotMatch(css, /\.tree-file:hover, \.tree-file\.active \{[^}]*border-left-color/s);
});

test('restores Docs navigation, selected document, and agent visibility from package-local storage', async () => {
  const { window, document } = parseHTML('<!doctype html><body></body>');
  globalThis.window = window;
  globalThis.document = document;
  const values = new Map<string, string>();
  window.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) } as any;
  const tree = { rootName: 'repository', documents: ['README.md', 'docs/guide.md'], tree: [{ type: 'file', name: 'README.md', path: 'README.md' }, { type: 'folder', name: 'docs', children: [{ type: 'file', name: 'guide.md', path: 'docs/guide.md' }] }] };
  const fetchFn = async (url: string) => {
    if (url === '/api/docs/tree') return { ok: true, async json() { return tree; } };
    if (url === '/api/docs/agent/state') return { ok: true, async json() { return { messages: [], status: 'idle', error: null }; } };
    const path = new URL(url, 'https://resonance.local').searchParams.get('path') || 'README.md';
    return { ok: true, async json() { return { path, html: `<h1>${path}</h1>` }; } };
  };
  try {
    const mount = document.createElement('section'); document.body.append(mount);
    const first = createBrowser({ fetchFn, eventSourceFactory: () => null }); first.mount(mount); await first.activate();
    const folder = mount.querySelector('.tree-folder') as HTMLDetailsElement; folder.removeAttribute('open'); folder.dispatchEvent(new window.Event('toggle'));
    (mount.querySelector('[data-path="docs/guide.md"]') as HTMLButtonElement).click();
    mount.querySelector('.docs-agent-toggle')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(values.get('resonance:docs:collapsed-folders:repository'), '["docs"]');
    assert.equal(values.get('resonance:docs:selected-path'), 'docs/guide.md');
    assert.equal(values.get('resonance:docs:agent-visible'), 'false');
    first.deactivate();
    const restoredMount = document.createElement('section'); document.body.append(restoredMount);
    const second = createBrowser({ fetchFn, eventSourceFactory: () => null }); second.mount(restoredMount); await second.activate();
    assert.equal((restoredMount.querySelector('[data-path="docs/guide.md"]') as HTMLElement).classList.contains('active'), true);
    assert.equal((restoredMount.querySelector('.tree-folder') as HTMLElement).hasAttribute('open'), false);
    assert.equal((restoredMount.querySelector('.docs-agent') as HTMLElement).hidden, true);
    second.deactivate();
  } finally { delete (globalThis as any).window; delete (globalThis as any).document; }
});

test('passes the active document and highlighted text to the agent and refreshes after an edit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resonance-docs-agent-'));
  try {
    await mkdir(path.join(root, '.resonance'), { recursive: true });
    await writeFile(path.join(root, 'README.md'), '# Notes\n\nOriginal sentence.\n');
    const turns: any[] = [];
    const runtimeFactory: DocsAgentRuntimeFactory = async (options) => ({
      async *stream(turn) {
        turns.push(turn);
        await writeDocsDocument(options.context, options.options, turn.document.path, turn.document.content.replace('Original sentence.', 'Rewritten sentence.'));
        options.onMutation([turn.document.path]);
        yield { kind: 'assistant' as const, text: 'Updated the document.' };
      },
      async dispose() {},
    });
    await withServer(root, runtimeFactory, async (base) => {
      assert.deepEqual(await fetch(`${base}/api/docs/agent/state`).then((response) => response.json()), { messages: [], status: 'idle', hasSession: false, error: null });
      const credential = await fetch(`${base}/api/docs/agent/credential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'local-key' }) });
      assert.equal(credential.status, 200);
      const prompt = await fetch(`${base}/api/docs/agent/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Reword this.', selectedPath: 'README.md', selectedText: 'Original sentence.' }) });
      assert.equal(prompt.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(turns[0].document.path, 'README.md');
      assert.equal(turns[0].selectedText, 'Original sentence.');
      assert.match(turns[0].document.content, /Original sentence/);
      assert.match(await readFile(path.join(root, 'README.md'), 'utf8'), /Rewritten sentence/);
      assert.equal((await fetch(`${base}/api/docs/agent/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Again', selectedPath: '../outside.md' }) })).status, 404);
      assert.equal((await fetch(`${base}/api/docs/agent/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Again', selectedPath: 'README.md', selectedText: 'x'.repeat(33 * 1024) }) })).status, 400);
      assert.equal((await fetch(`${base}/api/docs/tree`, { method: 'POST' })).status, 405);
    }, runtimeFactory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
