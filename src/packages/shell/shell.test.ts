import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createShell } from './shell.js';

test('renders Resonance Actions after personal workspaces', () => {
  const { document } = parseHTML('<!doctype html><body><nav id="navigation"></nav><main id="mount"></main></body>');
  const navigation = document.querySelector('#navigation');
  const shell = createShell({ documentRoot: document, navigation, mount: document.querySelector('#mount') });
  shell.renderNavigation([{ id: 'team', label: 'Team', order: 1 }, { id: 'personal', label: 'Personal', order: 2, scope: 'member' }], [{ id: 'home:create-home-page', label: 'Create Home page', packageLabel: 'Home' }]);
  assert.deepEqual([...navigation.querySelectorAll('.nav-section-label')].map((element) => element.textContent), ['Team Workspaces', 'Personal Workspaces', 'Resonance Actions']);
  const action = navigation.querySelector('[data-action-task="home:create-home-page"]');
  assert.equal(action.dataset.package, 'resonance-actions');
  assert.equal(action.textContent.includes('Create Home page'), true);
});
