import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHomeCredential } from './home-agent.ts';
import { validateHomeHtml } from './home-task.ts';

test('styles Markdown H1 headings as Home display headings', async () => {
  const css = await readFile(new URL('./home.css', import.meta.url), 'utf8');

  assert.match(css, /\.home-content h1, \.home-content h2 \{[^}]*font: 400 clamp\(42px, 6vw, 82px\)/s);
  assert.match(css, /\.home-content h2 \{[^}]*font-size: clamp\(38px, 5vw, 68px\)/s);
});

test('rejects agent-owned styling and requires a single Home title', () => {
  assert.throws(() => validateHomeHtml('<section class="repository-home"><style>.home-section-label { color: red; }</style><h1>Home</h1></section>'), /inline styles/i);
  assert.throws(() => validateHomeHtml('<section class="repository-home"><h2>Home</h2></section>'), /exactly one h1/i);
  assert.doesNotThrow(() => validateHomeHtml('<section class="repository-home"><h1>Home</h1><section class="home-section"><div class="home-section-label">01</div><blockquote>Quote</blockquote></section></section>'));
});

test('reads Home credentials from the application checkout', async () => {
  const applicationRoot = await mkdtemp(path.join(tmpdir(), 'resonance-home-application-'));
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'resonance-home-repository-'));
  try {
    await mkdir(path.join(applicationRoot, '.resonance'), { recursive: true });
    await writeFile(path.join(applicationRoot, '.resonance/home-agent.env'), 'OPENROUTER_API_KEY=test-key\n', { mode: 0o600 });
    await chmod(path.join(applicationRoot, '.resonance/home-agent.env'), 0o600);
    assert.equal(await readHomeCredential(applicationRoot, 'openrouter'), 'test-key');
    assert.equal(await readHomeCredential(repositoryRoot, 'openrouter'), null);
  } finally {
    await rm(applicationRoot, { recursive: true, force: true });
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('provides the Home curation skill and intentional generated-page styling', async () => {
  const skill = await readFile(new URL('./skills/create-home-page/SKILL.md', import.meta.url), 'utf8');
  const css = await readFile(new URL('./home.css', import.meta.url), 'utf8');

  assert.match(skill, /repository-owned \*\*HTML\*\*/);
  assert.match(skill, /not a documentation index and it is not a chat transcript/);
  assert.match(skill, /block quotes/);
  assert.match(css, /\.repository-home h1 \{/);
  assert.match(css, /\.repository-home blockquote \{/);
  assert.match(css, /\.repository-home \.home-section > \.home-section-label \{[^}]*grid-column: 1;/s);
  assert.match(css, /\.repository-home \.home-section > :not\(\.home-section-label\) \{[^}]*grid-column: 2;/s);
  assert.match(skill, /home\.css.*source of truth/s);
  assert.match(skill, /two direct children/s);
});
