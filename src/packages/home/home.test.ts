import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('styles Markdown H1 headings as Home display headings', async () => {
  const css = await readFile(new URL('./home.css', import.meta.url), 'utf8');

  assert.match(css, /\.home-content h1, \.home-content h2 \{[^}]*font: 400 clamp\(42px, 6vw, 82px\)/s);
  assert.match(css, /\.home-content h2 \{[^}]*font-size: clamp\(38px, 5vw, 68px\)/s);
});

test('provides the Home curation skill and intentional generated-page styling', async () => {
  const skill = await readFile(new URL('./skills/create-home-page/SKILL.md', import.meta.url), 'utf8');
  const css = await readFile(new URL('./home.css', import.meta.url), 'utf8');

  assert.match(skill, /repository-owned \*\*HTML\*\*/);
  assert.match(skill, /not a documentation index and it is not a chat transcript/);
  assert.match(skill, /block quotes/);
  assert.match(css, /\.repository-home h1 \{/);
  assert.match(css, /\.repository-home blockquote \{/);
});
