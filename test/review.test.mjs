import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewOnline } from '../lib/review.mjs';

const prBuddy = fileURLToPath(new URL('../bin/prbuddy.mjs', import.meta.url));
const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-code-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(file, value) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
    },
    git(...args) { return execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' }); }
  };
};

function run(entry, ...args) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}

test('review reads the Git index and never includes credential values', t => {
  const { root, put, git } = fixture(t);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'tool-test@example.invalid');
  git('config', 'user.name', 'Tool Test');
  put('App.tsx', 'export const view = (count: number) => <div>{count + 1}</div>;\n');
  put('format.ts', 'export const answer = 42;\n');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  const token = 'ghp_' + 'A1'.repeat(18);
  put('App.tsx', 'export const view = (count: number) => <div>{count + 2}</div>;\ndebugger;\nconst credential = "' + token + '";\n');
  put('format.ts', '// A note\nexport const answer=42;\n');
  git('add', '.');
  put('App.tsx', 'export const view = (count: number) => <div>{count + 1}</div>;\n');
  put('new.test.js', 'test.only("example", () => {});\n');

  const staged = run(prBuddy, '--repo', root, '--staged', '--json', '--fail-on', 'critical');
  assert.equal(staged.status, 1, staged.stderr);
  assert.ok(!staged.stdout.includes(token));
  const report = JSON.parse(staged.stdout);
  assert.ok(report.files.find(file => file.file === 'format.ts').cosmetic);
  assert.ok(report.files.find(file => file.file === 'App.tsx').changes.some(change => change.kind === 'behavior'));
  assert.deepEqual(report.findings.map(finding => finding.id).sort(), ['PRB010', 'PRB011', 'PRB101']);

  const sarif = run(prBuddy, '--repo', root, '--staged', '--sarif', '--fail-on', 'critical');
  assert.equal(sarif.status, 1, sarif.stderr);
  assert.ok(!sarif.stdout.includes(token));
  const log = JSON.parse(sarif.stdout);
  assert.equal(log.version, '2.1.0');
  const [analysis] = log.runs;
  assert.equal(analysis.results.length, report.findings.length);
  for (const result of analysis.results) {
    const finding = report.findings.find(finding => finding.id === result.ruleId);
    assert.equal(analysis.tool.driver.rules[result.ruleIndex].id, finding.id);
    const { artifactLocation, region } = result.locations[0].physicalLocation;
    assert.equal(artifactLocation.uri, 'App.tsx');
    assert.equal(artifactLocation.uriBaseId, '%SRCROOT%');
    assert.equal(region.startLine, finding.line);
  }
  assert.equal(analysis.results.find(result => result.ruleId === 'PRB010').level, 'error');
  assert.equal(run(prBuddy, '--staged', '--sarif', '--json').status, 2);

  const working = run(prBuddy, '--repo', root, '--uncommitted', '--json');
  assert.equal(working.status, 0, working.stderr);
  const workReport = JSON.parse(working.stdout);
  assert.ok(workReport.findings.some(finding => finding.id === 'PRB103'));
  assert.ok(!workReport.findings.some(finding => finding.id === 'PRB010'));
  git('commit', '-qm', 'Stage exercise');
  const committed = run(prBuddy, '--repo', root, 'HEAD~1', 'HEAD', '--json');
  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(JSON.parse(committed.stdout).findings, report.findings);
});

test('review honors base configuration and reports inline suppressions in JSON and SARIF', t => {
  const { root, put, git } = fixture(t);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tool Test');
  git('config', 'user.email', 'tool-test@example.invalid');
  put('prbuddy.json', '// Base configuration\n{"ignore":["fixtures/"],"failOn":"warning","rules":{"PRB011":"info",},}\n');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  git('switch', '-qc', 'feature');
  git('switch', '-q', 'main');
  put('prbuddy.json', '{"ignore":["fixtures/"],"failOn":"warning","rules":{"PRB011":"warning"}}');
  git('add', '.');
  git('commit', '-qm', 'Update base review rules');
  git('switch', '-q', 'feature');

  put('prbuddy.json', '{"rules":{"PRB011":"off","PRB010":"off"}}');
  put('fixtures/ignored.js', 'debugger;');
  put('inline.ts', [
    'debugger; // prbuddy-ignore PRB011: local fixture',
    '// prbuddy-ignore PRB011: another fixture',
    'debugger;',
    'const fake = "// prbuddy-ignore-file PRB011: embedded in a string";',
    'debugger;',
    '// prbuddy-ignore PRB011:',
    '// prbuddy-ignore PRB011: unused',
    'const n = 1;'
  ].join('\n'));
  put('file.ts', '// prbuddy-ignore-file PRB011: local instrumentation\ndebugger;\ndebugger;\n');
  const token = 'ghp_' + 'A1'.repeat(18);
  put('file.txt', '# prbuddy-ignore-file PRB010: fixture ' + token + '\n' + token);
  const reviewed = run(prBuddy, '--repo', root, 'main', '--uncommitted', '--json');
  assert.equal(reviewed.status, 1, reviewed.stderr);
  assert.ok(!reviewed.stdout.includes(token));
  const report = JSON.parse(reviewed.stdout);
  assert.ok(!report.files.some(file => file.file.startsWith('fixtures/')));
  const debuggerFindings = report.findings.filter(finding => finding.id === 'PRB011');
  assert.deepEqual(debuggerFindings.map(finding => [finding.file, finding.line, finding.severity]), [['inline.ts', 5, 'warning']]);
  assert.deepEqual(report.findings.filter(finding => finding.id === 'PRB900').map(finding => finding.severity), ['warning', 'info']);
  assert.equal(report.suppressed.length, 6);
  const sarif = run(prBuddy, '--repo', root, 'main', '--uncommitted', '--sarif', '--fail-on', 'critical');
  assert.equal(sarif.status, 0, sarif.stderr);
  assert.ok(!sarif.stdout.includes(token));
  assert.equal(JSON.parse(sarif.stdout).runs[0].results.filter(result =>
    result.suppressions?.[0].kind === 'inSource').length, 6);
  const override = run(prBuddy, '--repo', root, 'main', '--uncommitted', '--json', '--config', path.join(root, 'prbuddy.json'));
  assert.equal(override.status, 0, override.stderr);
  assert.ok(!JSON.parse(override.stdout).findings.some(finding => finding.id === 'PRB011'));
});

test('duplicate function check uses the snapshot under review', t => {
  const { root, put, git } = fixture(t);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tool Test');
  git('config', 'user.email', 'tool-test@example.invalid');
  const body = [
    'const valid = values.filter(value => Number.isFinite(value));',
    'const rounded = valid.map(value => Math.round(value * 100) / 100);',
    'const total = rounded.reduce((sum, value) => sum + value, 0);',
    'return { count: rounded.length, total, average: rounded.length ? total / rounded.length : 0 };'
  ];
  put('src/existing.ts', 'export function summarize(values: number[]) {\n' + body.join('\n') + '\n}\n');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  put('src/new.ts', 'export function summarizeCopy(values: number[]) {\n  // same steps\n  ' + body.join('\n  ') + '\n}\n');
  put('src/helper.ts', 'export function tiny() { return 1; }\n');
  git('add', '.');
  put('src/existing.ts', 'export function summarize(values: number[]) { return values.length; }\n');

  function duplicates(...args) {
    const result = run(prBuddy, '--repo', root, '--json', ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).findings.filter(finding => finding.id === 'PRB302');
  }
  const staged = duplicates('--staged');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].file, 'src/new.ts');
  assert.match(staged[0].message, /src\/existing\.ts:1/);
  assert.deepEqual(duplicates('--uncommitted'), []);
  git('commit', '-qm', 'Add duplicate');
  assert.deepEqual(duplicates('HEAD~1', 'HEAD'), staged);
  assert.equal(staged[0].severity, 'warning');

  const adjusted = body.join('\n').replace('Math.round', 'Math.ceil').replace('total, average:', 'total, mean:');
  put('src/adjusted.ts', 'export function summarizeAdjusted(values: number[]) {\n' + adjusted + '\n}\n');
  git('add', 'src/adjusted.ts');
  const similar = duplicates('--staged');
  assert.equal(similar.length, 1);
  assert.equal(similar[0].file, 'src/adjusted.ts');
  assert.equal(similar[0].severity, 'info');
  assert.match(similar[0].message, /[89]\d% similar to summarize at src\/existing\.ts:1/);
});

test('unused declaration rule resolves references in the reviewed module', t => {
  const { root, put, git } = fixture(t);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tool Test');
  git('config', 'user.email', 'tool-test@example.invalid');
  put('app.tsx', 'export {};\nfunction preexisting() { return 1; }\n');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  put('app.tsx', [
    'export {};',
    'function preexisting() { return 1; }',
    'function unused() { return unused(); }',
    'function onlyShadowed() { return 2; }',
    'export function shadow(onlyShadowed: () => number) { return onlyShadowed(); }',
    'function ExportListed() { return <div />; }',
    'export { ExportListed as Listed };',
    'const Visible = () => <div />;',
    'export const App = () => <Visible />;',
    'const shorthand = () => 1;',
    'export const handlers = { shorthand };',
    'class NoReferences {}',
    'class InType {}',
    'export type Shape = InType;',
    'function _intentional() {}',
    '// prbuddy-ignore PRB301: reserved for a follow-up change',
    'function planned() {}'
  ].join('\n'));
  put('globals.js', 'function globalHelper() {}\n');
  put('common.cjs', 'function privateToCommonJs() {}\nmodule.exports = {};\n');
  put('dynamic.ts', 'export {};\nfunction dynamic() {}\neval("dynamic()");\n');
  put('app.test.ts', 'export {};\nfunction testHelper() {}\n');
  git('add', '.');
  put('app.tsx', 'export {};\nfunction unused() {}\nunused();\n');

  const staged = run(prBuddy, '--repo', root, '--staged', '--json');
  assert.equal(staged.status, 0, staged.stderr);
  const report = JSON.parse(staged.stdout);
  assert.deepEqual(report.findings.filter(finding => finding.id === 'PRB301').map(
    finding => [finding.file, finding.line]), [['app.tsx', 3], ['app.tsx', 4], ['app.tsx', 12]]);
  assert.deepEqual(report.suppressed.map(finding => [finding.id, finding.line]), [['PRB301', 17]]);
  const working = run(prBuddy, '--repo', root, '--uncommitted', '--json');
  assert.equal(working.status, 0, working.stderr);
  assert.ok(!JSON.parse(working.stdout).findings.some(finding => finding.id === 'PRB301'));
});

test('online npm checks use only new registry dependency names and preserve review configuration', async t => {
  const { root, put, git } = fixture(t);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tool Test');
  git('config', 'user.email', 'tool-test@example.invalid');
  put('package.json', JSON.stringify({ dependencies: { existing: '^1.0.0' } }));
  git('add', '.');
  git('commit', '-qm', 'Initial');
  const specs = {
    existing: '^2.0.0',
    public: '^2.0.0',
    missing: '~1.0.0',
    absentversion: '^7.0.0',
    deprecated: 'latest',
    '@scope/unavailable': '~1.0.0',
    workspace: 'workspace:*',
    local: 'file:./local',
    alias: 'npm:other@^1.0.0'
  };
  put('package.json', JSON.stringify({ dependencies: specs }, null, 2));
  put('packages/app/package.json', JSON.stringify({ dependencies: { public: '^2.0.0' } }));
  git('add', '.');
  const requests = [];
  const mockRegistry = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://registry.npmjs.org');
    const name = decodeURIComponent(endpoint.pathname.slice(1));
    requests.push(name);
    if (name === 'missing') return new Response(null, { status: 404 });
    if (name === '@scope/unavailable') return new Response(null, { status: 503 });
    return Response.json({
      name, 'dist-tags': { latest: '2.0.0' }, versions: {
        '2.0.0': name === 'deprecated' ? { deprecated: 'metadata stays out of the report' } : {}
      }
    });
  };
  const offline = run(prBuddy, '--repo', root, '--staged', '--json', '--fail-on', 'warning');
  assert.equal(offline.status, 0, offline.stderr);
  assert.ok(JSON.parse(offline.stdout).findings.every(finding => finding.severity === 'info'));

  const report = await reviewOnline(root, { staged: true }, mockRegistry);
  assert.deepEqual(requests.sort(), ['@scope/unavailable', 'absentversion', 'deprecated', 'missing', 'public']);
  assert.equal(report.findings.filter(finding => finding.severity === 'warning').length, 3);
  assert.ok(report.findings.some(finding => /missing was not found/.test(finding.message)));
  assert.ok(report.findings.some(finding => /absentversion has no published version/.test(finding.message)));
  assert.ok(report.findings.some(finding => /deprecated is deprecated/.test(finding.message)));
  assert.ok(report.findings.some(finding => /lookup was unavailable/.test(finding.message)));
  assert.ok(!JSON.stringify(report).includes('metadata stays out of the report'));
  put('prbuddy.json', '{"rules":{"PRB202":"off"}}');
  requests.length = 0;
  const disabled = await reviewOnline(root, { staged: true, configPath: path.join(root, 'prbuddy.json') }, mockRegistry);
  assert.deepEqual(requests, []);
  assert.deepEqual(disabled.findings, []);
});
