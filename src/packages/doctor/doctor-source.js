import createAgentPanel from '../../ui/agent-panel.js';

const defaultChecks = [
  { id: 'unit-tests', label: 'Unit tests', buttonLabel: 'Run unit tests', description: 'Run the target repository unit tests and inspect their results.' },
  { id: 'static-analysis', label: 'Static analysis', buttonLabel: 'Run static analysis', description: 'Run configured linters, type checks, and other static analysis.' },
  { id: 'integration-tests', label: 'Integration tests', buttonLabel: 'Run integration tests', description: 'Run integration and end-to-end checks against the target repository.' },
  { id: 'dependency-security', label: 'Dependency security', buttonLabel: 'Scan dependencies', description: 'Review dependency vulnerabilities, freshness, and update notices.' },
];

function statusLabel(status) {
  return status === 'passed' ? 'Passed' : status === 'failed' || status === 'errored' ? 'Failed' : status === 'skipped' ? 'Skipped' : status === 'timed-out' ? 'Timed out' : status === 'cancelled' ? 'Cancelled' : status === 'parse-error' || status === 'runner-error' ? 'Runner error' : status === 'no-tests' ? 'No tests' : 'Not run';
}
function formatDuration(durationMs) { return `${(Number(durationMs || 0) / 1000).toFixed(1)}s`; }
function formatDate(value) { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return value || 'Unknown time'; } }
function appendText(documentRoot, tag, text, className) { const element = documentRoot.createElement(tag); if (className) element.className = className; element.textContent = text; return element; }

export default function createDoctor({ fetchFn = fetch } = {}) {
  let root;
  let workspace;
  let navigator;
  let navigation;
  let testName;
  let results;
  let agentToggle;
  let agentUi;
  let agentVisible = true;
  let selectedCheck = defaultChecks[0];
  let checks = defaultChecks.map((check) => ({ ...check, configured: false, candidate: null, lastStatus: null }));
  let storedResults = {};
  let active = false;

  function showError(error) {
    root.replaceChildren();
    const message = root.ownerDocument.createElement('p');
    message.className = 'doctor-error';
    message.setAttribute('role', 'alert');
    message.textContent = error?.message || String(error);
    root.append(message);
  }
  function selectedState() { return checks.find((check) => check.id === selectedCheck.id) || selectedCheck; }
  function setAgentVisible(show) {
    agentVisible = show;
    agentUi.setVisible(show);
    workspace.classList.toggle('doctor-agent-hidden', !show);
    agentToggle.setAttribute('aria-expanded', String(show));
    const label = show ? 'Hide agent panel' : 'Show agent panel';
    agentToggle.setAttribute('aria-label', label);
    agentToggle.title = label;
  }
  function renderNavigation() {
    navigation.replaceChildren();
    for (const check of checks) {
      const button = navigation.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = `doctor-nav-test${check.id === selectedCheck.id ? ' active' : ''}`;
      button.dataset.checkId = check.id;
      button.dataset.status = check.lastStatus || (check.configured ? 'ready' : 'not-configured');
      button.textContent = check.label;
      button.setAttribute('aria-current', check.id === selectedCheck.id ? 'page' : 'false');
      button.setAttribute('aria-label', `${check.label}: ${statusLabel(check.lastStatus)}`);
      button.addEventListener('click', () => { selectedCheck = check; renderNavigation(); renderResults(); });
      navigation.append(button);
    }
  }
  function renderSummary(documentRoot, result) {
    const summary = result.summary || {};
    const line = appendText(documentRoot, 'p', `${summary.passed || 0} passed · ${summary.failed || 0} failed · ${summary.skipped || 0} skipped · ${summary.errored || 0} errors`, 'doctor-result-summary');
    const timing = appendText(documentRoot, 'p', `${formatDuration(result.durationMs)} · last run ${formatDate(result.completedAt)}`, 'doctor-result-time');
    return [line, timing];
  }
  function renderResult(result) {
    const documentRoot = results.ownerDocument;
    const panel = documentRoot.createElement('div');
    panel.className = `doctor-result doctor-result-${result.status}`;
    panel.append(appendText(documentRoot, 'p', 'LATEST RUN', 'eyebrow'), appendText(documentRoot, 'h1', statusLabel(result.status)));
    for (const element of renderSummary(documentRoot, result)) panel.append(element);
    const rerun = documentRoot.createElement('button');
    rerun.type = 'button'; rerun.className = 'doctor-run-check'; rerun.dataset.checkRun = selectedCheck.id; rerun.textContent = selectedCheck.buttonLabel;
    panel.append(rerun);
    const groups = documentRoot.createElement('div'); groups.className = 'doctor-result-groups';
    for (const group of result.groups || []) {
      const details = documentRoot.createElement('details'); details.className = `doctor-result-group doctor-result-group-${group.status}`; details.open = group.status !== 'passed';
      const summary = documentRoot.createElement('summary'); summary.append(appendText(documentRoot, 'span', group.name, 'doctor-result-group-name'), appendText(documentRoot, 'span', statusLabel(group.status), 'doctor-result-status')); details.append(summary);
      const list = documentRoot.createElement('ul');
      for (const item of group.tests || []) {
        const row = documentRoot.createElement('li'); row.className = `doctor-result-test doctor-result-test-${item.status}`;
        row.append(appendText(documentRoot, 'span', item.name, 'doctor-result-test-name'), appendText(documentRoot, 'span', statusLabel(item.status), 'doctor-result-status'));
        if (item.message || item.output) row.append(appendText(documentRoot, 'pre', [item.message, item.output].filter(Boolean).join('\n'), 'doctor-result-failure'));
        list.append(row);
      }
      details.append(list); groups.append(details);
    }
    if (result.stdout || result.stderr) {
      const output = documentRoot.createElement('details'); output.className = 'doctor-result-output';
      output.append(appendText(documentRoot, 'summary', 'Runner output'));
      output.append(appendText(documentRoot, 'pre', [result.stdout, result.stderr].filter(Boolean).join('\n'), 'doctor-output'));
      panel.append(output);
    }
    panel.append(groups);
    results.append(panel);
  }
  function renderResults() {
    testName.textContent = selectedCheck.label;
    results.replaceChildren();
    const state = selectedState();
    const result = storedResults[selectedCheck.id];
    if (result) { renderResult(result); return; }
    const instructions = results.ownerDocument.createElement('div'); instructions.className = 'doctor-instructions';
    instructions.append(appendText(results.ownerDocument, 'p', 'CHECK', 'eyebrow'));
    if (!state.configured && state.candidate) {
      instructions.append(appendText(results.ownerDocument, 'h1', 'Set up Doctor'), appendText(results.ownerDocument, 'p', `Doctor found a Bun test command in this target repository. Confirm it before running the check.`));
      const configure = results.ownerDocument.createElement('button'); configure.type = 'button'; configure.className = 'doctor-configure-check'; configure.dataset.checkConfigure = selectedCheck.id; configure.textContent = `Use ${state.candidate.executable} ${(state.candidate.args || []).join(' ')}`; instructions.append(configure);
    } else {
      instructions.append(appendText(results.ownerDocument, 'h1', state.configured ? 'Select a test to run' : 'No test command configured'), appendText(results.ownerDocument, 'p', selectedCheck.description));
      if (state.configured) { const runButton = results.ownerDocument.createElement('button'); runButton.type = 'button'; runButton.className = 'doctor-run-check'; runButton.dataset.checkRun = selectedCheck.id; runButton.textContent = selectedCheck.buttonLabel; instructions.append(runButton); }
    }
    results.append(instructions);
  }
  function resetAgent() { agentUi.update({ status: 'idle', error: null, canSend: (prompt) => Boolean(prompt.trim()), messages: [] }); }
  async function requestJson(url, options) {
    const response = await fetchFn(url, options);
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || 'Doctor request failed.');
    return value;
  }
  async function configureCheck(checkId) {
    await requestJson('/api/doctor/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkId }) });
    await activate();
  }
  async function runCheck(checkId) {
    const button = results.querySelector('[data-check-run]'); if (button) button.disabled = true;
    results.replaceChildren(appendText(results.ownerDocument, 'p', 'RUNNING', 'eyebrow'), appendText(results.ownerDocument, 'h1', 'Running tests…'));
    try {
      const value = await requestJson('/api/doctor/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkId }) });
      storedResults[checkId] = value.result; checks = checks.map((check) => check.id === checkId ? { ...check, lastStatus: value.result.status } : check); renderNavigation(); renderResults();
    } catch (error) { showError(error); }
  }
  async function activate() {
    active = true; root.hidden = false;
    try {
      const value = await requestJson('/api/doctor');
      navigator.querySelector('h1').textContent = value.label;
      checks = Array.isArray(value.checks) && value.checks.length ? value.checks : defaultChecks.map((check) => ({ ...check, configured: true, candidate: null, lastStatus: null }));
      selectedCheck = checks.find((check) => check.id === selectedCheck.id) || checks[0];
      const resultValue = await requestJson('/api/doctor/results').catch(() => ({ results: {} }));
      storedResults = resultValue.results || {};
      renderNavigation(); renderResults();
    } catch (error) { showError(error); throw error; }
  }

  return {
    mount(mountRoot) {
      root = mountRoot;
      root.innerHTML = '<section class="doctor-workspace" aria-label="Doctor"><aside class="doctor-navigator"><p class="eyebrow">WORKSPACE</p><h1>Doctor</h1><nav class="doctor-navigation" aria-label="Doctor checks"></nav></aside><main class="doctor-center"><header class="doctor-header"><span class="doctor-test-name">Unit tests</span><button type="button" class="doctor-agent-toggle" aria-controls="doctor-agent-panel" aria-expanded="true" aria-label="Hide agent panel" title="Hide agent panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"></path></svg></button></header><div class="doctor-results" aria-live="polite"></div></main><div class="doctor-agent-slot"></div></section>';
      workspace = root.querySelector('.doctor-workspace'); navigator = root.querySelector('.doctor-navigator'); navigation = root.querySelector('.doctor-navigation'); testName = root.querySelector('.doctor-test-name'); results = root.querySelector('.doctor-results'); agentToggle = root.querySelector('.doctor-agent-toggle');
      agentUi = createAgentPanel({ prefix: 'doctor', label: 'AGENT / CHAT', ariaLabel: 'Doctor agent', placeholder: 'Ask about this check…', renderTranscript: (transcript) => transcript.replaceChildren(), onReset: resetAgent });
      agentUi.mount(root.querySelector('.doctor-agent-slot'));
      agentToggle.addEventListener('click', () => setAgentVisible(!agentVisible));
      results.addEventListener('click', (event) => { const configure = event.target.closest('[data-check-configure]'); if (configure) void configureCheck(configure.dataset.checkConfigure).catch(showError); const run = event.target.closest('[data-check-run]'); if (run) void runCheck(run.dataset.checkRun).catch(showError); });
      renderNavigation(); renderResults(); resetAgent();
    },
    activate,
    deactivate() { active = false; root.hidden = true; },
  };
}
