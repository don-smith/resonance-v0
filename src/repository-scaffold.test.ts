import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createArchitectureStore } from './packages/architecture/architecture-store.ts';
import { scaffoldRepositoryPackages } from './repository-scaffold.ts';
import { createTelemetry } from './telemetry.ts';

test('scaffolds minimal Backlog and empty Architecture data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resonance-scaffold-'));
  try {
    await scaffoldRepositoryPackages(root, { architecture: true, backlog: true });
    assert.equal(await readFile(path.join(root, 'backlog/todo.yaml'), 'utf8'), `version: 1\ndecisions:\n  - title: Establish the backlog\n    plan: plans/establish-backlog.md\n    status: in-planning\n    priority: P2\n`);
    assert.equal(await readFile(path.join(root, 'backlog/plans/establish-backlog.md'), 'utf8'), '# Establish the backlog\n\nUse this backlog to record repository decisions and their supporting plans.\n');
    assert.equal(await readFile(path.join(root, 'architecture/model.c4'), 'utf8'), `specification {\n  element system\n}\n\nmodel {\n}\n\nviews {\n  view systemContext {\n    include *\n  }\n}\n`);
    for (const filename of ['model.json', 'views.json', 'rules.json', 'patterns.json', 'decisions.json']) {
      assert.deepEqual(JSON.parse(await readFile(path.join(root, 'architecture', filename), 'utf8')), filename === 'model.json' ? { version: 1, entities: [], relationships: [] } : filename === 'views.json' ? { version: 1, views: [] } : { version: 1, [filename.slice(0, -5)]: [] });
    }

    const telemetry = createTelemetry({ root, console: null });
    const store = createArchitectureStore({ context: { repositoryRoot: root, appRoot: root, telemetry, resolveRepositoryPath: (relative) => relative } });
    assert.deepEqual((await store.read()).model, { version: 1, entities: [], relationships: [] });
    assert.deepEqual((await store.graph('systemContext')).nodes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not scaffold the default Architecture root for a custom artifact root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resonance-scaffold-'));
  try {
    await scaffoldRepositoryPackages(root, { architecture: { artifactRoot: 'docs/architecture' } });
    await assert.rejects(() => readFile(path.join(root, 'architecture/model.json'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not overwrite existing repository artifacts while scaffolding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resonance-scaffold-'));
  try {
    await mkdir(path.join(root, 'backlog'), { recursive: true });
    await writeFile(path.join(root, 'backlog/todo.yaml'), 'existing\n');
    await scaffoldRepositoryPackages(root, { backlog: true });
    assert.equal(await readFile(path.join(root, 'backlog/todo.yaml'), 'utf8'), 'existing\n');
    assert.equal(await readFile(path.join(root, 'backlog/plans/establish-backlog.md'), 'utf8'), '# Establish the backlog\n\nUse this backlog to record repository decisions and their supporting plans.\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
