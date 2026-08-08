import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJUnit } from './doctor-runner.ts';

test('parses JUnit suites into grouped Doctor results', () => {
  const result = parseJUnit(`<?xml version="1.0"?><testsuites><testsuite name="server" tests="2" failures="1" time="0.12"><testcase classname="src/server.test.ts" name="serves health" time="0.01"/><testcase classname="src/server.test.ts" name="rejects failure" time="0.11"><failure message="Expected 200, received 500">Assertion stack</failure></testcase></testsuite></testsuites>`, {
    startedAt: '2026-03-10T14:22:01.000Z', completedAt: '2026-03-10T14:22:01.120Z', exitCode: 1, command: ['bun', 'test'], stdout: '', stderr: '',
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.summary, { total: 2, passed: 1, failed: 1, skipped: 0, errored: 0 });
  assert.equal(result.groups[0].name, 'src/server.test.ts');
  assert.equal(result.groups[0].tests[1].message, 'Expected 200, received 500');
  assert.equal(result.groups[0].tests[1].output, 'Assertion stack');
});

test('treats skipped and errored cases as distinct statuses', () => {
  const result = parseJUnit(`<testsuites><testsuite name="checks"><testcase classname="a.test.ts" name="skipped"><skipped/></testcase><testcase classname="a.test.ts" name="errored"><error message="process failed">details</error></testcase></testsuite></testsuites>`, {
    startedAt: '2026-03-10T14:22:01.000Z', completedAt: '2026-03-10T14:22:02.000Z', exitCode: 1, command: ['bun', 'test'], stdout: 'out', stderr: 'err',
  });

  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 0, skipped: 1, errored: 1 });
  assert.equal(result.groups[0].tests[0].status, 'skipped');
  assert.equal(result.groups[0].tests[1].status, 'errored');
});

test('does not report a passing result when the JUnit document is malformed', () => {
  const result = parseJUnit('<testsuites>', {
    startedAt: '2026-03-10T14:22:01.000Z', completedAt: '2026-03-10T14:22:02.000Z', exitCode: 0, command: ['bun', 'test'], stdout: '', stderr: '',
  });

  assert.equal(result.status, 'parse-error');
  assert.match(result.message, /JUnit/i);
});
