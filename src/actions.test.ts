import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHost } from './host.ts';
import type { HostRequest, HostResponse, PackageDefinition, TaskContribution } from './package-contract.ts';

function responseCapture() {
  let value: { status: number; body: unknown } | null = null;
  return { response: { json(status, body) { value = { status, body }; }, sse() { throw new Error('SSE is not used by this test.'); }, onClose() {}, get closed() { return false; } } as HostResponse, read() { return value; } };
}
function request(url: string, body?: unknown): HostRequest {
  return { url, headers: { 'content-type': 'application/json' }, readJson: async () => body, onAbort() {} };
}
function packageWithTask(task: TaskContribution): PackageDefinition {
  const metadata = { id: 'tasks', version: '1', hostVersion: '1', label: 'Tasks', order: 1 } as const;
  return { metadata, register() { return { metadata, routes: [], assets: [{ path: '/assets/tasks/app.js', file: 'src/packages/shell/app.js', contentType: 'text/javascript' }, { path: '/assets/tasks/styles.css', file: 'src/packages/shell/styles.css', contentType: 'text/css' }], navigation: [], browser: { id: 'tasks', entry: '/assets/tasks/app.js', stylesheet: '/assets/tasks/styles.css' }, tasks: [task] }; } };
}

 test('registers package-qualified Tasks and requires confirmation before applying', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resonance-actions-'));
  let applied = false;
  const task: TaskContribution = {
    id: 'prepare-repository', category: 'onboarding', label: 'Prepare repository', description: 'Prepare the fixture.', completedUrl: '/done',
    async evaluate() { return { status: applied ? 'complete' : 'available', summary: 'Fixture task.' }; },
    async prepare() { return { id: 'preview-1', title: 'Fixture preview', content: 'No mutation yet', affectedPaths: ['fixture.txt'], requiresConfirmation: true }; },
    async apply() { applied = true; return { message: 'Applied', affectedPaths: ['fixture.txt'] }; },
    async validate() { return { valid: applied, status: applied ? 'complete' : 'attention-needed', message: applied ? 'Validated.' : 'Not validated.' }; },
  };
  try {
    const registry = createHost({ root, config: { version: 1, packages: { tasks: { module: 'test.ts' } } }, packages: [packageWithTask(task)] });
    assert.equal(registry.manifest.actions?.tasks, '/api/actions/tasks');
    const list = responseCapture(); await registry.routes['GET /api/actions/tasks'].handler(request('/api/actions/tasks'), list.response, registry.context);
    assert.equal(list.read().body.tasks[0].id, 'tasks:prepare-repository');
    assert.equal(list.read().body.tasks[0].completedUrl, '/done');
    const prompt = responseCapture(); await registry.routes['POST /api/actions/prompt'].handler(request('/api/actions/prompt', { taskId: 'tasks:prepare-repository', prompt: 'Prepare it' }), prompt.response, registry.context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(applied, false);
    const state = responseCapture(); await registry.routes['GET /api/actions/state'].handler(request('/api/actions/state?task=tasks%3Aprepare-repository'), state.response, registry.context);
    const snapshot = state.read().body;
    assert.equal(snapshot.preview.content, 'No mutation yet');
    assert.ok(snapshot.pendingConfirmation.id);
    const confirm = responseCapture(); await registry.routes['POST /api/actions/confirm'].handler(request('/api/actions/confirm', { taskId: 'tasks:prepare-repository', confirmationId: snapshot.pendingConfirmation.id }), confirm.response, registry.context);
    assert.equal(applied, true);
    const after = responseCapture(); await registry.routes['GET /api/actions/tasks'].handler(request('/api/actions/tasks'), after.response, registry.context);
    assert.deepEqual(after.read().body.tasks, []);
    await registry.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects rich previews that reference an unregistered package asset', async () => {
  const task: TaskContribution = {
    id: 'invalid-preview', category: 'maintenance', label: 'Invalid preview', description: 'Fixture task.',
    async evaluate() { return { status: 'available' }; },
    async prepare() { return { id: 'preview-1', title: 'Invalid preview', content: '<h1>Preview</h1>', contentType: 'html', stylesheet: '/assets/tasks/missing.css', affectedPaths: [], requiresConfirmation: true }; },
  };
  const registry = createHost({ config: { version: 1, packages: { tasks: { module: 'test.ts' } } }, packages: [packageWithTask(task)] });
  const response = responseCapture(); await registry.routes['POST /api/actions/preview'].handler(request('/api/actions/preview', { taskId: 'tasks:invalid-preview' }), response.response, registry.context);
  assert.equal(response.read().status, 422);
  await registry.dispose();
});

test('Home Task excludes ignored documentation and applies a valid configured source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resonance-home-task-'));
  try {
    await mkdir(path.join(root, '.resonance'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, '.resonance/config.json'), JSON.stringify({ version: 1, packages: { home: { module: 'src/packages/home/index.ts', source: 'README.md' } } }));
    await writeFile(path.join(root, 'README.md'), '# Repository\n\nThe README is evidence.');
    await writeFile(path.join(root, 'docs/guide.md'), '# Guide\n\nA guide.');
    await writeFile(path.join(root, 'node_modules/ignored.md'), '# Ignore');
    const { createHomePackage } = await import('./packages/home/index.ts');
    let agentOptions;
    const homePackage = createHomePackage({
      credentialProvider: async () => 'test-key',
      runtimeFactory: async (options) => {
        agentOptions = options;
        return { async *prompt() { yield { kind: 'preview', preview: await options.preview('<section class="repository-home"><header class="home-hero"><h1>Repository</h1><p>A focused tool for useful work.</p></header><blockquote>Make the important things visible.</blockquote></section>') }; } };
      },
    });
    const registry = createHost({ root, appRoot: path.resolve('.'), config: { version: 1, packages: { home: { module: 'src/packages/home/index.ts', source: 'README.md' } } }, packages: [homePackage] });
    const list = responseCapture(); await registry.routes['GET /api/actions/tasks'].handler(request('/api/actions/tasks'), list.response, registry.context); assert.equal(list.read().body.tasks.length, 1); assert.equal(list.read().body.tasks[0].completedUrl, '/');
    const prompt = responseCapture(); await registry.routes['POST /api/actions/prompt'].handler(request('/api/actions/prompt', { taskId: 'home:create-home-page', prompt: 'Create the page.' }), prompt.response, registry.context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(agentOptions.skill, /not a documentation index/);
    assert.deepEqual(agentOptions.documents.map((document) => document.path), ['README.md', 'docs/guide.md']);
    const state = responseCapture(); await registry.routes['GET /api/actions/state'].handler(request('/api/actions/state?task=home%3Acreate-home-page'), state.response, registry.context);
    const proposal = state.read().body.preview; assert.equal(proposal.contentType, 'html'); assert.equal(proposal.stylesheet, '/assets/home/home.css'); assert.doesNotMatch(proposal.content, /docs\/guide\.md|node_modules|Source:|Author:/i);
    const confirmation = state.read().body.pendingConfirmation.id;
    const applied = responseCapture(); await registry.routes['POST /api/actions/confirm'].handler(request('/api/actions/confirm', { taskId: 'home:create-home-page', confirmationId: confirmation }), applied.response, registry.context);
    const generated = await readFile(path.join(root, '.resonance/home.html'), 'utf8');
    assert.match(generated, /<h1[^>]*>[^<]+<\/h1>/);
    assert.match(generated, /<blockquote>/);
    assert.match(generated, /class="home-hero"/);
    assert.doesNotMatch(generated, /docs\/guide|node_modules|Source:|Author:/i);
    assert.equal(JSON.parse(await readFile(path.join(root, '.resonance/config.json'), 'utf8')).packages.home.source, '.resonance/home.html');
    await registry.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
