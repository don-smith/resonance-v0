import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('styles Markdown H1 headings as Home display headings', async () => {
  const css = await readFile(new URL('./home.css', import.meta.url), 'utf8');

  assert.match(css, /\.home-content h1, \.home-content h2 \{[^}]*font: 400 clamp\(42px, 6vw, 82px\)/s);
  assert.match(css, /\.home-content h2 \{[^}]*font-size: clamp\(38px, 5vw, 68px\)/s);
});
